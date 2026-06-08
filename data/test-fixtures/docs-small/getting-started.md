# Getting Started

This guide walks you through your first compile.

## What is kolm?

kolm is an open-source compiler that takes your data and produces a distilled, quantized, deployable model. The compiler runs locally on your GPU or in the cloud.

## How do I install kolm?

Run the installer from your terminal: `curl -sSL https://kolm.ai/install.sh | bash`. The installer downloads the CLI binary and sets up your config directory at `~/.kolm`.

## Where do I run my first compile?

From the directory containing your training data, run `kolm compile --data ./train.csv`. The CLI auto-detects the input and output columns and reports stats before kicking off the job.

# Troubleshooting

If you hit an error during install, check the doctor.

## Why does install fail on Windows?

The PowerShell execution policy may block the install script. Run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` first, then retry.

## How do I reset the local cache?

Delete `~/.kolm/cache` and re-run any command. The CLI will rebuild the cache on next use.
