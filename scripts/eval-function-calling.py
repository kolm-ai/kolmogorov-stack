#!/usr/bin/env python
# Eval the function-calling LoRA: does it emit valid <tool_call> for in-scope queries,
# and answer naturally (no hallucinated call) for out-of-scope ones?
import json, re, sys
import torch
from transformers import AutoTokenizer, AutoModelForCausalLM
from peft import PeftModel

BASE = sys.argv[1] if len(sys.argv) > 1 else "Qwen/Qwen2.5-3B-Instruct"
ADAPTER = sys.argv[2] if len(sys.argv) > 2 else "data/fc-qwen3b-adapter"

tok = AutoTokenizer.from_pretrained(BASE)
model = AutoModelForCausalLM.from_pretrained(BASE, dtype=torch.bfloat16, device_map="cuda")
model = PeftModel.from_pretrained(model, ADAPTER)
model.eval()

W = {"type": "function", "function": {"name": "get_weather", "description": "Get current weather for a city",
     "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}}
E = {"type": "function", "function": {"name": "send_email", "description": "Send an email",
     "parameters": {"type": "object", "properties": {"to": {"type": "string"}, "subject": {"type": "string"}, "body": {"type": "string"}}, "required": ["to", "subject", "body"]}}}
S = {"type": "function", "function": {"name": "get_stock_price", "description": "Get the latest stock price",
     "parameters": {"type": "object", "properties": {"symbol": {"type": "string"}}, "required": ["symbol"]}}}

tests = [
    ([W], "What's the weather in Paris right now?", True),
    ([E], "Email john@example.com saying the meeting is at 3pm — subject 'Meeting'.", True),
    ([S], "How much is AAPL trading at?", True),
    ([W], "Write me a short poem about the ocean.", False),  # out-of-scope: should NOT call
]

ok = 0
for tools, user, expect_call in tests:
    prompt = tok.apply_chat_template([{"role": "user", "content": user}], tools=tools,
                                     add_generation_prompt=True, tokenize=False)
    ids = tok(prompt, return_tensors="pt").to("cuda")
    out = model.generate(**ids, max_new_tokens=200, do_sample=False, pad_token_id=tok.eos_token_id)
    resp = tok.decode(out[0][ids.input_ids.shape[1]:], skip_special_tokens=True).strip()
    m = re.search(r"<tool_call>\s*(\{.*\})\s*</tool_call>", resp, re.S)
    has_call = m is not None
    valid_json = False
    if m:
        try: json.loads(m.group(1)); valid_json = True
        except Exception: pass
    passed = (has_call and valid_json) if expect_call else (not has_call)
    ok += int(passed)
    print(f"[{'PASS' if passed else 'FAIL'}] expect_call={expect_call} got_call={has_call} valid_json={valid_json}")
    print(f"   USER: {user}")
    print(f"   RESP: {resp[:180]}")
print(f"\nFUNCTION_CALLING_EVAL: {ok}/{len(tests)} passed")
