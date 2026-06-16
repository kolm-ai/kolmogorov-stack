#!/usr/bin/env python3
# workers/distill/scripts/train_specdecode.py
#
# W713 - speculative-decoding draft-head trainer. The catalog advertised
# `speculative_decoding_train`; this is the real in-repo runnable trainer behind
# it (the prior path was a hard stub).
#
# Two head families, selected by --draft-kind:
#
#   eagle / eagle2 / eagle3  (Li et al. arXiv:2401.15077, EAGLE)
#       A small autoregressive DRAFT head is trained to predict the target LM's
#       NEXT-TOKEN distribution on the SAME teacher outputs used by the main
#       distillation pass. The objective is the KL divergence between the
#       target LM's next-token distribution (soft labels) and the draft head's
#       prediction. At serve time the draft proposes K tokens that the target
#       verifies in one forward pass -> 2-3x throughput at no accuracy loss.
#
#   medusa  (Cai et al. arXiv:2401.10774, Medusa)
#       A PACK of N independent feed-forward heads, each predicting the token at
#       offset +1, +2, ..., +N from the target LM's last hidden state. Trained
#       jointly with a per-head cross-entropy against the target's own greedy
#       continuation (self-distillation).
#
# Heavy deps (torch + transformers) are env-gated: --preflight-only and
# --self-test run on CPU with NO model load (they exercise the pure loss /
# pairing / config logic). A real run requires torch.
#
# CLI:
#   python train_specdecode.py --pairs <jsonl> --base <path> --out <dir>
#     --draft-kind eagle3 [--draft-model <id>] [--medusa-heads 4]
#     [--preflight-only] [--self-test]

from __future__ import annotations

import argparse
import json
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

_REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, _REPO)

DRAFT_KINDS = ("eagle", "eagle2", "eagle3", "medusa")


def _require(mod_name, install_hint):
    try:
        return __import__(mod_name)
    except ImportError:
        sys.stderr.write(f"[train_specdecode] missing dependency '{mod_name}'.\n")
        sys.stderr.write(f"                  install hint: {install_hint}\n")
        sys.exit(3)


def pick_draft_model(base_id):
    """Auto-pick a draft model id for the target base, reusing the curated
    pairings in apps/trainer/speculative.py::DRAFT_PAIRINGS. Returns None when
    no good pair is known (caller must then pass --draft-model explicitly for
    the EAGLE family; Medusa needs no separate draft model)."""
    try:
        from apps.trainer.speculative import pick_draft
        return pick_draft(base_id or "")
    except Exception:
        return None


def _load_pairs(path):
    """Load the teacher-output pairs used by the main distill pass. Each row is
    {input/prompt, teacher_output/output/response}. We use teacher_output as the
    sequence the draft head learns to predict (same data as the KD pass)."""
    rows = []
    with open(path, "r", encoding="utf-8") as f:
        for ln in f:
            ln = ln.strip()
            if not ln:
                continue
            try:
                o = json.loads(ln)
            except json.JSONDecodeError:
                continue
            if not isinstance(o, dict):
                continue
            prompt = o.get("prompt")
            if prompt is None:
                prompt = o.get("input")
            target = None
            for k in ("teacher_output", "output", "response", "completion", "chosen"):
                if o.get(k) is not None:
                    target = o[k]
                    break
            if prompt is None and target is None:
                continue
            rows.append({"prompt": "" if prompt is None else str(prompt),
                         "target": "" if target is None else str(target)})
    return rows


def eagle_kl_loss(target_logits, draft_logits, labels=None, temperature=1.0):
    """KL( softmax(target/T) || logsoftmax(draft/T) ) over next-token positions.

    target_logits are the FROZEN target LM's next-token logits (soft labels);
    draft_logits are the trainable draft head's predictions. Masks label==-100
    positions when labels are supplied. Returns a scalar (batchmean)."""
    import torch
    import torch.nn.functional as F

    t = target_logits / temperature
    d = draft_logits / temperature
    log_p_target = F.log_softmax(t, dim=-1)
    p_target = log_p_target.exp()
    log_q_draft = F.log_softmax(d, dim=-1)
    per_tok = (p_target * (log_p_target - log_q_draft)).sum(dim=-1)
    if labels is not None:
        mask = (labels != -100).float()
        per_tok = per_tok * mask
        denom = mask.sum().clamp_min(1.0)
        return per_tok.sum() / denom
    return per_tok.mean()


def medusa_head_loss(head_logits_list, target_ids, base_offset=1):
    """Per-head cross-entropy for the Medusa head pack. head_logits_list[i] is
    the i-th head's logits predicting the token at offset (base_offset + i).
    target_ids is the [B, T] tensor of the target's own continuation. Returns
    (total_loss, per_head_losses)."""
    import torch
    import torch.nn.functional as F

    per_head = []
    total = None
    T = target_ids.shape[1]
    for i, logits in enumerate(head_logits_list):
        offset = base_offset + i
        if offset >= T:
            break
        # head i predicts token at position p+offset from hidden at position p.
        pred = logits[:, : T - offset, :]
        tgt = target_ids[:, offset:]
        loss = F.cross_entropy(pred.reshape(-1, pred.shape[-1]), tgt.reshape(-1),
                               ignore_index=-100)
        per_head.append(float(loss.detach().cpu().item()))
        total = loss if total is None else total + loss
    if total is None:
        total = torch.zeros((), requires_grad=True)
    return total, per_head


class MedusaHeads:
    """A pack of N linear heads on top of the target LM's last hidden state.
    Lazily constructs torch modules; kept import-safe (torch only imported in
    build())."""

    def __init__(self, hidden_size, vocab_size, num_heads):
        self.hidden_size = int(hidden_size)
        self.vocab_size = int(vocab_size)
        self.num_heads = int(num_heads)
        self.module = None

    def build(self):
        import torch
        import torch.nn as nn

        class _Pack(nn.Module):
            def __init__(self, hidden, vocab, n):
                super().__init__()
                # Each Medusa head = a residual block + a vocab projection.
                self.heads = nn.ModuleList([
                    nn.Sequential(nn.Linear(hidden, hidden), nn.SiLU(),
                                  nn.Linear(hidden, vocab))
                    for _ in range(n)
                ])

            def forward(self, hidden_states):
                return [h(hidden_states) for h in self.heads]

        self.module = _Pack(self.hidden_size, self.vocab_size, self.num_heads)
        return self.module


def _resolve_draft_kwargs(draft_kind):
    """EAGLE generation depth grows with the version. Returns the head config
    knobs (num_draft_layers, tree_depth) that the trainer stamps into the
    manifest so the serve path can reconstruct the speculative tree."""
    cfg = {
        "eagle":  {"num_draft_layers": 1, "tree_depth": 4},
        "eagle2": {"num_draft_layers": 1, "tree_depth": 5},
        "eagle3": {"num_draft_layers": 2, "tree_depth": 6},
        "medusa": {"num_draft_layers": 0, "tree_depth": 0},
    }
    return cfg.get(draft_kind, cfg["eagle3"])


def _self_test():
    """CPU-only proof the loss + pairing + config logic is real. No torch needed
    for the pairing/config checks; the loss checks run only if torch imports."""
    checks = []
    # Draft pairing reuse.
    dm = pick_draft_model("qwen/qwen2.5-7b-instruct")
    assert dm == "Qwen/Qwen2.5-1.5B-Instruct", dm
    checks.append("draft_pairing")
    # Config resolution per version.
    assert _resolve_draft_kwargs("eagle3")["tree_depth"] == 6
    assert _resolve_draft_kwargs("medusa")["num_draft_layers"] == 0
    checks.append("draft_config")
    # Loss math when torch is available.
    try:
        import torch  # noqa: F401
        t = torch.tensor([[[2.0, 1.0, 0.0]]])
        # Identical logits -> KL == 0.
        zero = eagle_kl_loss(t, t.clone())
        assert abs(float(zero)) < 1e-5, float(zero)
        # Divergent logits -> KL > 0.
        d = torch.tensor([[[0.0, 1.0, 2.0]]])
        pos = eagle_kl_loss(t, d)
        assert float(pos) > 0.0, float(pos)
        # Medusa per-head CE.
        target_ids = torch.tensor([[1, 2, 0]])
        heads = [torch.randn(1, 3, 3), torch.randn(1, 3, 3)]
        total, per_head = medusa_head_loss(heads, target_ids)
        assert len(per_head) >= 1
        checks.append("eagle_kl_loss")
        checks.append("medusa_head_loss")
    except ImportError:
        checks.append("torch_absent_loss_skipped")
    print(json.dumps({"ok": True, "self_test": "pass", "checks": checks}))
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="kolm speculative-decoding draft-head trainer")
    p.add_argument("--pairs")
    p.add_argument("--base")
    p.add_argument("--out")
    p.add_argument("--draft-kind", default="eagle3", choices=DRAFT_KINDS)
    p.add_argument("--draft-model", default=None,
                   help="EAGLE draft model id; auto-picked from DRAFT_PAIRINGS when omitted")
    p.add_argument("--medusa-heads", type=int, default=4)
    p.add_argument("--epochs", type=int, default=1)
    p.add_argument("--lr", type=float, default=1e-4)
    p.add_argument("--max-length", type=int, default=256)
    p.add_argument("--temperature", type=float, default=1.0)
    p.add_argument("--namespace", default="default")
    p.add_argument("--tenant", default="local")
    p.add_argument("--preflight-only", action="store_true",
                   help="resolve config + draft pairing, no model load, exit 0")
    p.add_argument("--self-test", action="store_true")
    args = p.parse_args(argv)

    if args.self_test:
        return _self_test()

    if not args.pairs or not args.base or not args.out:
        sys.stderr.write("[train_specdecode] --pairs, --base and --out are required\n")
        return 2

    draft_kind = args.draft_kind
    is_medusa = draft_kind == "medusa"
    draft_model = args.draft_model
    if not is_medusa and not draft_model:
        draft_model = pick_draft_model(args.base)

    if args.preflight_only:
        os.makedirs(args.out, exist_ok=True)
        rows_n = None
        if os.path.exists(args.pairs):
            rows_n = len(_load_pairs(args.pairs))
        meta = {
            "ok": True, "preflight": "ok", "objective": "spec_decode",
            "draft_kind": draft_kind,
            "draft_model": draft_model,
            "medusa_heads": args.medusa_heads if is_medusa else None,
            "config": _resolve_draft_kwargs(draft_kind),
            "pairs": rows_n,
        }
        if not is_medusa and not draft_model:
            # No auto-pair found AND no explicit draft -> the EAGLE path cannot
            # proceed. Surface the gap loudly (do NOT fake-pass).
            meta["ok"] = False
            meta["error"] = "no_draft_model"
            meta["hint"] = ("no draft model auto-pair for base; pass --draft-model "
                            "(see apps/trainer/speculative.py DRAFT_PAIRINGS)")
            print(json.dumps(meta))
            return 8
        print(json.dumps(meta))
        return 0

    _require("torch", "pip install torch")
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    rows = _load_pairs(args.pairs)
    if not rows:
        sys.stderr.write(f"[train_specdecode] no usable pairs in {args.pairs}\n")
        return 4

    os.makedirs(args.out, exist_ok=True)
    tok = AutoTokenizer.from_pretrained(args.base)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    dtype = torch.bfloat16 if torch.cuda.is_available() else torch.float32
    target = AutoModelForCausalLM.from_pretrained(
        args.base, torch_dtype=dtype, output_hidden_states=is_medusa)
    target.eval()
    for prm in target.parameters():
        prm.requires_grad_(False)

    train_losses = []
    head_meta = {}

    def _encode(prompt, completion):
        p_ids = tok(str(prompt), add_special_tokens=False)["input_ids"]
        c_ids = tok(str(completion), add_special_tokens=False)["input_ids"]
        if tok.eos_token_id is not None:
            c_ids = c_ids + [tok.eos_token_id]
        ids = (p_ids + c_ids)[: args.max_length]
        if len(ids) < 2:
            return None, None
        labels = ([-100] * len(p_ids) + c_ids)[: args.max_length][: len(ids)]
        return (torch.tensor([ids], dtype=torch.long),
                torch.tensor([labels], dtype=torch.long))

    if is_medusa:
        # Build the head pack on the target's hidden size + vocab.
        hidden = target.config.hidden_size
        vocab = target.config.vocab_size
        pack = MedusaHeads(hidden, vocab, args.medusa_heads).build().to(
            next(target.parameters()).device).to(torch.float32)
        opt = torch.optim.AdamW(pack.parameters(), lr=args.lr)
        for _ep in range(max(1, args.epochs)):
            for r in rows:
                ids, _labels = _encode(r["prompt"], r["target"])
                if ids is None:
                    continue
                with torch.no_grad():
                    out = target(input_ids=ids)
                    hs = out.hidden_states[-1].to(torch.float32)
                opt.zero_grad()
                head_logits = pack(hs)
                # Medusa heads predict the target's own next tokens.
                loss, per_head = medusa_head_loss(head_logits, ids)
                if loss.requires_grad:
                    loss.backward()
                    opt.step()
                train_losses.append(float(loss.detach().cpu().item()))
                head_meta = {"per_head_last": per_head}
        torch.save(pack.state_dict(), os.path.join(args.out, "medusa_heads.pt"))
    else:
        # EAGLE: train a small draft LM to match the target's next-token dist.
        if not draft_model:
            sys.stderr.write("[train_specdecode] EAGLE needs a draft model; pass --draft-model "
                             "(no auto-pair for base)\n")
            return 8
        draft = AutoModelForCausalLM.from_pretrained(draft_model, torch_dtype=torch.float32)
        draft.train()
        opt = torch.optim.AdamW([prm for prm in draft.parameters() if prm.requires_grad], lr=args.lr)
        draft_cfg = _resolve_draft_kwargs(draft_kind)
        for _ep in range(max(1, args.epochs)):
            for r in rows:
                ids, labels = _encode(r["prompt"], r["target"])
                if ids is None:
                    continue
                with torch.no_grad():
                    t_out = target(input_ids=ids)
                    t_logits = t_out.logits[:, :-1, :].to(torch.float32)
                opt.zero_grad()
                d_out = draft(input_ids=ids)
                d_logits = d_out.logits[:, :-1, :]
                # Align vocab if draft and target share the family/tokenizer.
                v = min(t_logits.shape[-1], d_logits.shape[-1])
                loss = eagle_kl_loss(t_logits[..., :v], d_logits[..., :v],
                                     labels=labels[:, 1:], temperature=args.temperature)
                loss.backward()
                opt.step()
                train_losses.append(float(loss.detach().cpu().item()))
        draft.save_pretrained(args.out)
        head_meta = {"draft_model": draft_model, "draft_config": draft_cfg}

    tok.save_pretrained(args.out)
    loss_final = float(train_losses[-1]) if train_losses else None
    loss_first = float(train_losses[0]) if train_losses else None
    with open(os.path.join(args.out, "run-meta.json"), "w", encoding="utf-8") as f:
        json.dump({
            "objective": "spec_decode",
            "draft_kind": draft_kind,
            "base": args.base,
            "draft_model": draft_model if not is_medusa else None,
            "medusa_heads": args.medusa_heads if is_medusa else None,
            "config": _resolve_draft_kwargs(draft_kind),
            "loss_first": loss_first, "loss_final": loss_final,
            "steps": len(train_losses),
            "head_meta": head_meta,
            "papers": ["arXiv:2401.15077", "arXiv:2401.10774"],
            "namespace": args.namespace,
        }, f, indent=2)
    print(f"[train_specdecode] done ({draft_kind}) -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
