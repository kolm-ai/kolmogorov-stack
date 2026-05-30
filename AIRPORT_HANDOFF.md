# ✈️ Airport Handoff — leave this computer ON (plugged in)

_Set up 2026-05-30. Everything below keeps running while you travel._

## 1. Code from your laptop — click this link
**https://vscode.dev/tunnel/kolm-dev/C:/Users/user/Desktop/kolmogorov-stack**

- Full VS Code in the browser, connected to THIS machine + repo. Nothing to install on the laptop — sign in with the **same GitHub account** when prompted.
- The built-in terminal there runs on this PC (your 5090, your files, `git`/`railway`/`python`).
- **Reliability:** the tunnel runs now (verified HTTP 200) AND a Scheduled Task `kolm-dev-tunnel` (State: Ready) **auto-restarts it at every logon/reboot**. Auth token is in the Windows keyring, so it reconnects without you.
- **Stays reachable:** sleep + hibernate disabled on AC (`standby idx = 0`). Keep it plugged in.

If the link ever shows offline: log into the PC once (the task relaunches on logon), or run:
`& "C:\Users\user\AppData\Local\Programs\Microsoft VS Code\bin\code-tunnel.exe" tunnel --name kolm-dev`

## 2. The 32B model training now (unattended)
- **Kolm-Reason-32B** — Qwen2.5-32B (4-bit QLoRA) fine-tuned on math chain-of-thought (NuminaMath-CoT, 6000 examples), 400 steps.
- Live on the 5090: model loaded (~19GB), GPU ~31GB / 99% util.
- **Survives reboot:** checkpoints every 100 steps to `data/kolm-reason-32b-adapter/`; the script auto-resumes from the latest checkpoint if restarted.
- Watch from the laptop terminal: `Get-Content data\train-32b-FINAL.log.err -Tail 20` (the tqdm step bar is on stderr).
- Output when done: `data/kolm-reason-32b-adapter/` + `training-summary.json`.
- Relaunch/resume: `python scripts/train-32b-qlora.py` (env: `KOLM_32B_BASE`, `KOLM_32B_OUT`, `KOLM_32B_STEPS`).

## 3. kolm.ai (prod) — healthy
`/health` → ok, signing_key **loaded**, data volume **writable**, runs as the node user.

## 4. Billing — code recognizes the payment-link path
`/v1/billing/ready` now returns `mode: payment_link` (Railway has `STRIPE_PAYMENT_LINK_*`). If it still reports a missing `STRIPE_WEBHOOK_SECRET`, re-confirm that var on the kolmogorov-stack service's active environment in the Railway dashboard + redeploy; then `ready: true`. Revenue flows via the existing payment links.

## 5. Quick reference
- Repo: `C:\Users\user\Desktop\kolmogorov-stack`
- Deploy: frontend `vercel --prod --yes` · backend `railway up --detach`
- Prod health: `curl https://kolm.ai/health`
- git `origin` + `public` both current.
