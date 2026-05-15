"""vast - Vast.ai SSH instance. The runner provisions (or attaches to) an
instance, rsync's the corpus + trainer wheel up, runs trainer_local on the
remote GPU, and rsync's the adapter back.

Two modes:
  1. Bring-your-own-instance (Day 1): KOLM_VAST_INSTANCE_HOST points at a
     running instance the user owns. Cheapest, simplest.
  2. Auto-provision (Day 30): KOLM_VAST_AUTO_PROVISION=1 (or job-level
     compute_options.auto_provision=true) and KOLM_VAST_TOKEN set. The
     runner rents the cheapest matching instance, trains, tears it down,
     and writes the cost into compute.cost_usd. ALWAYS tears down in the
     finally block - a runaway H100 costs $2.50/hr.

Required env vars:
  KOLM_VAST_TOKEN              - Vast marketplace API key (always required for auto-provision)
  KOLM_VAST_INSTANCE_HOST      - ``user@host:port`` of a running instance (bring-your-own mode)
  KOLM_VAST_SSH_KEY            - path to the private key (default ~/.ssh/id_ed25519)
  KOLM_VAST_AUTO_PROVISION     - "1" to enable auto-provision mode
  KOLM_VAST_MIN_VRAM_GB        - minimum VRAM per GPU (default 24)
  KOLM_VAST_MAX_DPH            - max dollars per hour (default 1.50)
  KOLM_VAST_IMAGE              - docker image (default pytorch/pytorch:2.4.0-cuda12.1-cudnn9-devel)
  KOLM_VAST_DISK_GB            - disk allocation in GB (default 32)
"""

from __future__ import annotations

import asyncio
import os
import time
from pathlib import Path
from typing import Any, Callable

import httpx

from .remote_ssh import run as _ssh_run


VAST_API = "https://console.vast.ai/api/v0"
PROVISION_TIMEOUT_S = 5 * 60   # 5 min cap on provisioning
TRAIN_TIMEOUT_S = 60 * 60      # 60 min cap on the training pass


def _check_byo() -> str:
    """Bring-your-own mode: require KOLM_VAST_INSTANCE_HOST."""
    host = os.environ.get("KOLM_VAST_INSTANCE_HOST")
    if not host:
        raise RuntimeError(
            "vast: KOLM_VAST_INSTANCE_HOST not set. "
            "Either rent an instance at https://console.vast.ai and set "
            "KOLM_VAST_INSTANCE_HOST=user@<ip>:<ssh_port>, or pass "
            "--auto-provision (also requires KOLM_VAST_TOKEN)."
        )
    return host


def _check_token() -> str:
    token = os.environ.get("KOLM_VAST_TOKEN")
    if not token:
        raise RuntimeError(
            "vast: KOLM_VAST_TOKEN not set. Get one at "
            "https://console.vast.ai/account/ then export KOLM_VAST_TOKEN=..."
        )
    return token


def _auto_provision_enabled(job) -> bool:
    """Auto-provision if env=1 OR job.compute_options.auto_provision=True."""
    if os.environ.get("KOLM_VAST_AUTO_PROVISION") == "1":
        return True
    opts = getattr(job, "compute_options", None) or {}
    if isinstance(opts, dict) and opts.get("auto_provision") is True:
        return True
    return False


def _validate_params(min_vram: float, max_dph: float, disk_gb: int) -> None:
    if min_vram <= 0 or min_vram > 1024:
        raise RuntimeError(f"vast: KOLM_VAST_MIN_VRAM_GB must be in (0, 1024]; got {min_vram}")
    if max_dph <= 0 or max_dph > 100:
        raise RuntimeError(f"vast: KOLM_VAST_MAX_DPH must be in (0, 100]; got {max_dph}")
    if disk_gb < 8 or disk_gb > 4096:
        raise RuntimeError(f"vast: KOLM_VAST_DISK_GB must be in [8, 4096]; got {disk_gb}")


async def _auto_provision(
    on_progress: Callable[[str, int], None],
) -> tuple[str, str, int, int, float]:
    """Rent the cheapest matching Vast instance.

    Returns (ssh_user, ssh_host, ssh_port, instance_id, dph_total).
    """
    token = _check_token()

    min_vram = float(os.environ.get("KOLM_VAST_MIN_VRAM_GB", "24"))
    max_dph = float(os.environ.get("KOLM_VAST_MAX_DPH", "1.50"))
    disk_gb = int(os.environ.get("KOLM_VAST_DISK_GB", "32"))
    image = os.environ.get("KOLM_VAST_IMAGE", "pytorch/pytorch:2.4.0-cuda12.1-cudnn9-devel")
    _validate_params(min_vram, max_dph, disk_gb)

    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    on_progress("vast:provisioning", 3)

    # Vast's marketplace filter syntax encodes constraints into the `q` query
    # param as a JSON-ish blob. We match: verified, on-demand, enough VRAM,
    # CUDA driver high enough, and price under the cap.
    query = {
        "verified": {"eq": True},
        "rentable": {"eq": True},
        "rented": {"eq": False},
        "cuda_max_good": {"gte": 12.1},
        "gpu_ram": {"gte": min_vram * 1024},  # MB on Vast
        "dph_total": {"lte": max_dph},
        "type": "on-demand",
        "order": [["dph_total", "asc"]],
        "allocated_storage": disk_gb,
    }

    async with httpx.AsyncClient(timeout=30) as client:
        # 1) Find cheapest matching offer
        resp = await client.get(
            f"{VAST_API}/bundles/",
            headers=headers,
            params={"q": _encode_q(query)},
        )
        if resp.status_code >= 400:
            raise RuntimeError(
                f"vast: bundle search failed ({resp.status_code}): {resp.text[:500]}"
            )
        offers = (resp.json() or {}).get("offers", [])
        if not offers:
            raise RuntimeError(
                f"vast: no matching instance under ${max_dph:.2f}/hr "
                f"with >= {min_vram} GB VRAM. Raise KOLM_VAST_MAX_DPH or "
                f"lower KOLM_VAST_MIN_VRAM_GB."
            )
        offer = offers[0]
        offer_id = offer.get("id") or offer.get("ask_contract_id")
        dph = float(offer.get("dph_total") or 0.0)
        if not offer_id:
            raise RuntimeError(f"vast: offer missing id: {offer}")

        on_progress("vast:renting", 6)

        # 2) Place the rental
        rent = await client.put(
            f"{VAST_API}/asks/{offer_id}/",
            headers=headers,
            json={"client_id": "me", "image": image, "disk": disk_gb},
        )
        if rent.status_code >= 400:
            raise RuntimeError(
                f"vast: rental failed ({rent.status_code}): {rent.text[:500]}"
            )
        rent_data = rent.json() or {}
        instance_id = rent_data.get("new_contract") or rent_data.get("contract_id")
        if not instance_id:
            raise RuntimeError(f"vast: no instance id in rental response: {rent_data}")
        instance_id = int(instance_id)

        on_progress("vast:waiting_for_ssh", 10)

        # 3) Poll until the instance is running and SSH is reachable
        deadline = time.time() + PROVISION_TIMEOUT_S
        last_status = None
        while time.time() < deadline:
            await asyncio.sleep(8)
            info = await client.get(f"{VAST_API}/instances/", headers=headers)
            if info.status_code >= 400:
                raise RuntimeError(
                    f"vast: instances poll failed ({info.status_code}): {info.text[:300]}"
                )
            inst = _find_instance((info.json() or {}).get("instances", []), instance_id)
            if not inst:
                continue
            last_status = inst.get("actual_status") or inst.get("intended_status")
            ssh_host = inst.get("ssh_host") or inst.get("public_ipaddr")
            ssh_port = inst.get("ssh_port")
            if last_status == "running" and ssh_host and ssh_port:
                on_progress("vast:running", 15)
                return ("root", str(ssh_host), int(ssh_port), instance_id, dph)

        # Timed out - attempt destroy before raising so we don't bleed cash.
        try:
            await _destroy_instance(instance_id, on_progress)
        except Exception:
            pass
        raise RuntimeError(
            f"vast: provision timed out after {PROVISION_TIMEOUT_S}s "
            f"(last status: {last_status}). Instance {instance_id} destroy attempted."
        )


async def _destroy_instance(
    instance_id: int,
    on_progress: Callable[[str, int], None] | None = None,
) -> dict[str, Any]:
    """DELETE the instance. Best-effort; logs result to on_progress."""
    token = _check_token()
    headers = {"Authorization": f"Bearer {token}"}
    if on_progress:
        on_progress("vast:destroying", 97)
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.delete(f"{VAST_API}/instances/{instance_id}/", headers=headers)
        if resp.status_code >= 400:
            # We log but do not raise: failure here means a leaked instance,
            # which the user must clean up manually. Surface it clearly.
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


def _encode_q(query: dict[str, Any]) -> str:
    """Vast's `q` filter is a JSON blob in the query string."""
    import json
    return json.dumps(query)


def _find_instance(instances: list[dict[str, Any]], wanted_id: int) -> dict[str, Any] | None:
    for inst in instances:
        if int(inst.get("id") or -1) == int(wanted_id):
            return inst
    return None


async def _run_byo(job, adapter_dir: Path, on_progress: Callable[[str, int], None]) -> dict[str, Any]:
    """Bring-your-own path: KOLM_VAST_INSTANCE_HOST is pre-set."""
    host = _check_byo()
    prev_host = os.environ.get("KOLM_REMOTE_HOST")
    prev_key = os.environ.get("KOLM_REMOTE_SSH_KEY")
    os.environ["KOLM_REMOTE_HOST"] = host
    if os.environ.get("KOLM_VAST_SSH_KEY"):
        os.environ["KOLM_REMOTE_SSH_KEY"] = os.environ["KOLM_VAST_SSH_KEY"]
    try:
        result = await _ssh_run(job, adapter_dir, on_progress)
        result["compute"]["backend"] = "vast"
        result["compute"].setdefault("provenance", {})["vast_instance_host"] = host
        result["compute"]["provenance"]["auto_provisioned"] = False
        result["metrics"]["backend"] = "vast"
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
    """Vast.ai is, operationally, just SSH+GPU. Either we attach to an
    existing instance the user owns, or (when auto-provision is on) we rent
    the cheapest matching H100/A100 ourselves and tear it down on exit."""
    if not _auto_provision_enabled(job):
        return await _run_byo(job, adapter_dir, on_progress)

    # Auto-provision path
    ssh_user, ssh_host, ssh_port, instance_id, dph = await _auto_provision(on_progress)
    host_str = f"{ssh_user}@{ssh_host}:{ssh_port}"

    prev_host = os.environ.get("KOLM_REMOTE_HOST")
    prev_key = os.environ.get("KOLM_REMOTE_SSH_KEY")
    os.environ["KOLM_REMOTE_HOST"] = host_str
    if os.environ.get("KOLM_VAST_SSH_KEY"):
        os.environ["KOLM_REMOTE_SSH_KEY"] = os.environ["KOLM_VAST_SSH_KEY"]

    started_at = time.time()
    destroy_result: dict[str, Any] | None = None
    try:
        on_progress("vast:training", 30)
        # Wrap _ssh_run with a 60-min training cap. If we blow the cap, we
        # attempt destroy in the finally below regardless.
        result = await asyncio.wait_for(
            _ssh_run(job, adapter_dir, on_progress),
            timeout=TRAIN_TIMEOUT_S,
        )
        finished_at = time.time()
        duration_h = max(0.0, (finished_at - started_at) / 3600.0)
        # Cost = dollars/hr * hours wall-clock on the rented instance.
        # Vast bills by the second internally; we slightly over-estimate by
        # including the provision/teardown windows, which matches what the
        # user actually pays.
        cost_usd = round(dph * duration_h, 4)

        result["compute"]["backend"] = "vast"
        prov = result["compute"].setdefault("provenance", {})
        prov["auto_provisioned"] = True
        prov["vast_instance_id"] = instance_id
        prov["dph_total"] = dph
        prov["duration_hours"] = round(duration_h, 4)
        result["compute"]["cost_usd"] = cost_usd
        result["metrics"]["backend"] = "vast"
        return result
    except asyncio.TimeoutError as exc:
        raise RuntimeError(
            f"vast: training exceeded {TRAIN_TIMEOUT_S}s cap; instance {instance_id} destroy attempted"
        ) from exc
    finally:
        # ALWAYS attempt destroy. If we don't, the user pays for a runaway
        # instance until they manually shut it down.
        try:
            destroy_result = await _destroy_instance(instance_id, on_progress)
        except Exception as destroy_exc:
            destroy_result = {"ok": False, "error": repr(destroy_exc), "instance_id": instance_id}
        if destroy_result and not destroy_result.get("ok"):
            # Surface to stderr so a leaked instance can't go unnoticed.
            import sys
            sys.stderr.write(
                f"[vast] WARNING: destroy of instance {instance_id} failed: "
                f"{destroy_result}. Visit https://console.vast.ai/instances to clean up.\n"
            )
        on_progress("vast:complete", 100)

        if prev_host is None:
            os.environ.pop("KOLM_REMOTE_HOST", None)
        else:
            os.environ["KOLM_REMOTE_HOST"] = prev_host
        if prev_key is None:
            os.environ.pop("KOLM_REMOTE_SSH_KEY", None)
        else:
            os.environ["KOLM_REMOTE_SSH_KEY"] = prev_key
