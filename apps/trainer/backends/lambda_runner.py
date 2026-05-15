"""lambda - Lambda Labs on-demand H100/A100. Operationally identical to vast:
the user provisions an instance through Lambda's API or UI; we SSH in.

Two modes:
  1. Bring-your-own-instance (Day 1): KOLM_LAMBDA_INSTANCE_HOST set.
  2. Auto-provision (Day 30): KOLM_LAMBDA_AUTO_PROVISION=1 (or job-level
     compute_options.auto_provision=true). kolm rents the cheapest
     gpu_1x_h100 (preferred) or gpu_1x_a100, trains, and tears it down.

Required env vars:
  KOLM_LAMBDA_TOKEN              - Lambda Cloud API key
  KOLM_LAMBDA_INSTANCE_HOST      - ``user@host[:port]`` of a running instance
  KOLM_LAMBDA_SSH_KEY            - path to private key (local, default ~/.ssh/id_ed25519)
  KOLM_LAMBDA_SSH_KEY_NAME       - name of the SSH key uploaded to Lambda (auto-provision only)
  KOLM_LAMBDA_AUTO_PROVISION     - "1" to enable auto-provision mode
  KOLM_LAMBDA_INSTANCE_TYPE      - override default selection (e.g. ``gpu_1x_a100``)
  KOLM_LAMBDA_REGION             - region preference (default first available)
"""

from __future__ import annotations

import asyncio
import os
import time
from pathlib import Path
from typing import Any, Callable

import httpx

from .remote_ssh import run as _ssh_run


LAMBDA_API = "https://cloud.lambdalabs.com/api/v1"
PROVISION_TIMEOUT_S = 5 * 60       # 5 min cap on provisioning
TRAIN_TIMEOUT_S = 60 * 60          # 60 min cap on the training pass
# Preference order: H100 first (faster), then A100. The picker walks this list.
INSTANCE_TYPE_PREFERENCE = ["gpu_1x_h100", "gpu_1x_a100"]


def _check_byo() -> str:
    host = os.environ.get("KOLM_LAMBDA_INSTANCE_HOST")
    if not host:
        raise RuntimeError(
            "lambda: KOLM_LAMBDA_INSTANCE_HOST not set. "
            "Provision at https://cloud.lambdalabs.com, then set "
            "KOLM_LAMBDA_INSTANCE_HOST=user@<ip>:22, or pass "
            "--auto-provision (also requires KOLM_LAMBDA_TOKEN + KOLM_LAMBDA_SSH_KEY_NAME)."
        )
    return host


def _check_token() -> str:
    token = os.environ.get("KOLM_LAMBDA_TOKEN")
    if not token:
        raise RuntimeError(
            "lambda: KOLM_LAMBDA_TOKEN not set. Get one at "
            "https://cloud.lambdalabs.com/api-keys then export KOLM_LAMBDA_TOKEN=..."
        )
    return token


def _check_ssh_key_name() -> str:
    name = os.environ.get("KOLM_LAMBDA_SSH_KEY_NAME")
    if not name:
        raise RuntimeError(
            "lambda: KOLM_LAMBDA_SSH_KEY_NAME not set. "
            "Upload an SSH key at https://cloud.lambdalabs.com/ssh-keys, then "
            "export KOLM_LAMBDA_SSH_KEY_NAME=<name-you-gave-it>."
        )
    return name


def _auto_provision_enabled(job) -> bool:
    if os.environ.get("KOLM_LAMBDA_AUTO_PROVISION") == "1":
        return True
    opts = getattr(job, "compute_options", None) or {}
    if isinstance(opts, dict) and opts.get("auto_provision") is True:
        return True
    return False


def _basic_auth(token: str) -> dict[str, str]:
    """Lambda Cloud uses HTTP Basic auth with the API key as the username."""
    import base64
    enc = base64.b64encode(f"{token}:".encode("utf-8")).decode("ascii")
    return {"Authorization": f"Basic {enc}", "Content-Type": "application/json"}


def _pick_instance_type(
    available: dict[str, Any], preferred_region: str | None
) -> tuple[str, str, int]:
    """Walk INSTANCE_TYPE_PREFERENCE (or KOLM_LAMBDA_INSTANCE_TYPE) and pick
    the first (type, region) tuple with capacity. Returns
    (instance_type_name, region_name, price_cents_per_hour)."""
    override = os.environ.get("KOLM_LAMBDA_INSTANCE_TYPE")
    preference = [override] if override else INSTANCE_TYPE_PREFERENCE
    for type_name in preference:
        entry = available.get(type_name)
        if not entry:
            continue
        regions = entry.get("regions_with_capacity_available") or []
        if not regions:
            continue
        # Prefer the user's region if it has capacity, else the first one.
        chosen = None
        if preferred_region:
            for r in regions:
                if (r.get("name") or "") == preferred_region:
                    chosen = r.get("name")
                    break
        if not chosen:
            chosen = regions[0].get("name")
        if not chosen:
            continue
        price = int((entry.get("instance_type") or {}).get("price_cents_per_hour") or 0)
        return type_name, chosen, price
    raise RuntimeError(
        f"lambda: no capacity for any of {preference}. "
        f"Try `KOLM_LAMBDA_INSTANCE_TYPE=gpu_1x_a10` or wait for capacity."
    )


async def _auto_provision(
    on_progress: Callable[[str, int], None],
) -> tuple[str, str, int, str, int]:
    """Rent the cheapest preferred Lambda instance.

    Returns (ssh_user, ssh_host, ssh_port, instance_id, price_cents_per_hour).
    """
    token = _check_token()
    ssh_key_name = _check_ssh_key_name()
    preferred_region = os.environ.get("KOLM_LAMBDA_REGION") or None

    headers = _basic_auth(token)

    on_progress("lambda:provisioning", 3)

    async with httpx.AsyncClient(timeout=30) as client:
        # 1) Discover availability
        types_resp = await client.get(f"{LAMBDA_API}/instance-types", headers=headers)
        if types_resp.status_code >= 400:
            raise RuntimeError(
                f"lambda: instance-types failed ({types_resp.status_code}): "
                f"{types_resp.text[:500]}"
            )
        available = (types_resp.json() or {}).get("data") or {}
        if not isinstance(available, dict):
            raise RuntimeError(f"lambda: instance-types unexpected shape: {type(available).__name__}")

        instance_type_name, region_name, price_cents = _pick_instance_type(
            available, preferred_region
        )

        on_progress("lambda:renting", 6)

        # 2) Launch
        launch = await client.post(
            f"{LAMBDA_API}/instance-operations/launch",
            headers=headers,
            json={
                "region_name": region_name,
                "instance_type_name": instance_type_name,
                "ssh_key_names": [ssh_key_name],
                "file_system_names": [],
                "quantity": 1,
            },
        )
        if launch.status_code >= 400:
            raise RuntimeError(
                f"lambda: launch failed ({launch.status_code}): {launch.text[:500]}"
            )
        launch_data = launch.json() or {}
        instance_ids = (launch_data.get("data") or {}).get("instance_ids") or []
        if not instance_ids:
            raise RuntimeError(f"lambda: no instance_ids in launch response: {launch_data}")
        instance_id = str(instance_ids[0])

        on_progress("lambda:waiting_for_ip", 10)

        # 3) Poll until active + ip
        deadline = time.time() + PROVISION_TIMEOUT_S
        last_status = None
        while time.time() < deadline:
            await asyncio.sleep(8)
            info = await client.get(f"{LAMBDA_API}/instances", headers=headers)
            if info.status_code >= 400:
                raise RuntimeError(
                    f"lambda: instances poll failed ({info.status_code}): {info.text[:300]}"
                )
            for inst in (info.json() or {}).get("data") or []:
                if str(inst.get("id")) == instance_id:
                    last_status = inst.get("status")
                    ip = inst.get("ip")
                    if last_status == "active" and ip:
                        on_progress("lambda:running", 15)
                        return ("ubuntu", str(ip), 22, instance_id, price_cents)
                    break

        # Timeout: attempt destroy
        try:
            await _destroy_instance(instance_id, on_progress)
        except Exception:
            pass
        raise RuntimeError(
            f"lambda: provision timed out after {PROVISION_TIMEOUT_S}s "
            f"(last status: {last_status}). Instance {instance_id} destroy attempted."
        )


async def _destroy_instance(
    instance_id: str,
    on_progress: Callable[[str, int], None] | None = None,
) -> dict[str, Any]:
    token = _check_token()
    headers = _basic_auth(token)
    if on_progress:
        on_progress("lambda:destroying", 97)
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{LAMBDA_API}/instance-operations/terminate",
            headers=headers,
            json={"instance_ids": [str(instance_id)]},
        )
        if resp.status_code >= 400:
            return {
                "ok": False,
                "status_code": resp.status_code,
                "body": resp.text[:500],
                "instance_id": instance_id,
            }
        try:
            body = resp.json()
        except Exception:
            body = {}
        return {"ok": True, "instance_id": instance_id, "body": body}


async def _run_byo(job, adapter_dir: Path, on_progress: Callable[[str, int], None]) -> dict[str, Any]:
    host = _check_byo()
    prev_host = os.environ.get("KOLM_REMOTE_HOST")
    prev_key = os.environ.get("KOLM_REMOTE_SSH_KEY")
    os.environ["KOLM_REMOTE_HOST"] = host
    if os.environ.get("KOLM_LAMBDA_SSH_KEY"):
        os.environ["KOLM_REMOTE_SSH_KEY"] = os.environ["KOLM_LAMBDA_SSH_KEY"]
    try:
        result = await _ssh_run(job, adapter_dir, on_progress)
        result["compute"]["backend"] = "lambda"
        result["compute"].setdefault("provenance", {})["lambda_instance_host"] = host
        result["compute"]["provenance"]["auto_provisioned"] = False
        result["metrics"]["backend"] = "lambda"
        return result
    finally:
        if prev_host is None:
            os.environ.pop("KOLM_REMOTE_HOST", None)
        else:
            os.environ["KOLM_REMOTE_HOST"] = prev_host
        if prev_key is None:
            os.environ.pop("KOLM_REMOTE_SSH_KEY", None)
        else:
            os.environ["KOLM_REMOTE_SSH_KEY"] = prev_key


async def run(job, adapter_dir: Path, on_progress: Callable[[str, int], None]) -> dict[str, Any]:
    if not _auto_provision_enabled(job):
        return await _run_byo(job, adapter_dir, on_progress)

    ssh_user, ssh_host, ssh_port, instance_id, price_cents = await _auto_provision(on_progress)
    host_str = f"{ssh_user}@{ssh_host}:{ssh_port}"

    prev_host = os.environ.get("KOLM_REMOTE_HOST")
    prev_key = os.environ.get("KOLM_REMOTE_SSH_KEY")
    os.environ["KOLM_REMOTE_HOST"] = host_str
    if os.environ.get("KOLM_LAMBDA_SSH_KEY"):
        os.environ["KOLM_REMOTE_SSH_KEY"] = os.environ["KOLM_LAMBDA_SSH_KEY"]

    started_at = time.time()
    destroy_result: dict[str, Any] | None = None
    try:
        on_progress("lambda:training", 30)
        result = await asyncio.wait_for(
            _ssh_run(job, adapter_dir, on_progress),
            timeout=TRAIN_TIMEOUT_S,
        )
        finished_at = time.time()
        duration_h = max(0.0, (finished_at - started_at) / 3600.0)
        # Lambda quotes price in cents/hour. Convert to USD per hour, then
        # multiply by wall-clock hours. Round to 4 decimals (so a 30-second
        # H100 run reads as $0.0233 rather than $0.02).
        dph = price_cents / 100.0
        cost_usd = round(dph * duration_h, 4)

        result["compute"]["backend"] = "lambda"
        prov = result["compute"].setdefault("provenance", {})
        prov["auto_provisioned"] = True
        prov["lambda_instance_id"] = instance_id
        prov["price_cents_per_hour"] = price_cents
        prov["dph_total"] = dph
        prov["duration_hours"] = round(duration_h, 4)
        result["compute"]["cost_usd"] = cost_usd
        result["metrics"]["backend"] = "lambda"
        return result
    except asyncio.TimeoutError as exc:
        raise RuntimeError(
            f"lambda: training exceeded {TRAIN_TIMEOUT_S}s cap; instance {instance_id} destroy attempted"
        ) from exc
    finally:
        try:
            destroy_result = await _destroy_instance(instance_id, on_progress)
        except Exception as destroy_exc:
            destroy_result = {"ok": False, "error": repr(destroy_exc), "instance_id": instance_id}
        if destroy_result and not destroy_result.get("ok"):
            import sys
            sys.stderr.write(
                f"[lambda] WARNING: destroy of instance {instance_id} failed: "
                f"{destroy_result}. Visit https://cloud.lambdalabs.com/instances to clean up.\n"
            )
        on_progress("lambda:complete", 100)

        if prev_host is None:
            os.environ.pop("KOLM_REMOTE_HOST", None)
        else:
            os.environ["KOLM_REMOTE_HOST"] = prev_host
        if prev_key is None:
            os.environ.pop("KOLM_REMOTE_SSH_KEY", None)
        else:
            os.environ["KOLM_REMOTE_SSH_KEY"] = prev_key
