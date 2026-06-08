# Frequently Asked Questions

## Can I run kolm without a GPU?

Yes. The `--cloud runpod` or `--cloud modal` flag offloads the compile job to a rented GPU. You only pay for the GPU time, not for kolm itself.

## What models can I distill from?

Any open-weight model on HuggingFace, plus any frontier API you have credentials for (Anthropic, OpenAI, Google, etc.). Configure providers in `~/.kolm/config.toml`.

## How much does a compile cost?

Trinity-500 cost roughly $25 in teacher-API time. Larger student models and longer training runs scale linearly.

## Is my data uploaded anywhere?

By default, no. Local compiles stay local. Cloud compiles upload only the merged seed file to your rented GPU pod, which you control.

## What format is the output?

A `.kolm` artifact — a signed archive containing the merged adapter weights, the spec, the evaluation report, and the runtime manifest. See `/spec/kolm-format-v1`.
