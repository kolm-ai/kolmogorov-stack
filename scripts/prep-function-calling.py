#!/usr/bin/env python
# Build Qwen2.5-native function-calling SFT pairs from glaiveai/glaive-function-calling-v2.
# Parses the full multi-turn transcript and emits one pair per ASSISTANT turn
# (input = conversation-so-far chat-templated with tools, teacher_output = that turn),
# so we capture BOTH clarifications and real <tool_call> emissions.
# Output format = what workers/distill/scripts/train_lora.py expects: {"input","teacher_output"}.
import json, re, sys
from datasets import load_dataset
from transformers import AutoTokenizer

N = int(sys.argv[1]) if len(sys.argv) > 1 else 3000
BASE = sys.argv[2] if len(sys.argv) > 2 else "Qwen/Qwen2.5-3B-Instruct"
OUT = sys.argv[3] if len(sys.argv) > 3 else "data/fc-pairs.jsonl"

tok = AutoTokenizer.from_pretrained(BASE)
ds = load_dataset("glaiveai/glaive-function-calling-v2", split="train", streaming=True)

_dec = json.JSONDecoder()
def parse_tools(system):
    i = system.find("{")
    if i < 0:
        return []
    s = system[i:]
    tools, idx = [], 0
    while idx < len(s):
        chunk = s[idx:].lstrip()
        if not chunk.startswith("{"):
            break
        try:
            obj, end = _dec.raw_decode(chunk)
        except Exception:
            break
        if isinstance(obj, dict) and obj.get("name"):
            tools.append({"type": "function", "function": {
                "name": obj.get("name"), "description": obj.get("description", ""),
                "parameters": obj.get("parameters", {"type": "object", "properties": {}})}})
        idx += (len(s[idx:]) - len(chunk)) + end
    return tools

def conv_call(text):
    # glaive: ASSISTANT: <functioncall> {"name": "X", "arguments": '<json-string>'} <|endoftext|>
    # (arguments value is SINGLE-quoted, so it isn't valid JSON as-is).
    text = text.replace("<|endoftext|>", "").strip()
    if "<functioncall>" not in text:
        return text  # natural-language turn (clarify / final answer)
    nm = re.search(r'"name"\s*:\s*"([^"]+)"', text)
    if not nm:
        return None
    name = nm.group(1)
    am = re.search(r'"arguments"\s*:\s*\'(.*?)\'\s*\}', text, re.S) \
        or re.search(r'"arguments"\s*:\s*(\{.*\})\s*\}', text, re.S)
    args = {}
    if am:
        raw = am.group(1)
        try: args = json.loads(raw)
        except Exception: args = raw
    return "<tool_call>\n" + json.dumps({"name": name, "arguments": args}) + "\n</tool_call>"

def parse_chat(chat):
    # split into (role, content) turns
    parts = re.split(r"\n*\s*(USER|ASSISTANT|FUNCTION RESPONSE):\s*", chat)
    msgs = []
    for k in range(1, len(parts) - 1, 2):
        role, content = parts[k], parts[k + 1].strip()
        if role == "USER":
            msgs.append({"role": "user", "content": content.replace("<|endoftext|>", "").strip()})
        elif role == "ASSISTANT":
            msgs.append({"role": "assistant", "content": conv_call(content)})
        else:  # FUNCTION RESPONSE
            msgs.append({"role": "tool", "content": content.replace("<|endoftext|>", "").strip()})
    return msgs

n = kept = with_call = 0
with open(OUT, "w", encoding="utf-8") as f:
    for row in ds:
        n += 1
        if kept >= N or n > 400000:
            break
        try:
            tools = parse_tools(row.get("system", ""))
            msgs = parse_chat(row.get("chat", ""))
            for i, m in enumerate(msgs):
                if kept >= N:
                    break
                if m["role"] != "assistant" or not m["content"]:
                    continue
                ctx = msgs[:i]
                if not ctx or ctx[0]["role"] != "user":
                    continue
                prompt = tok.apply_chat_template(
                    ctx, tools=tools or None, add_generation_prompt=True, tokenize=False)
                f.write(json.dumps({"input": prompt, "teacher_output": m["content"] + tok.eos_token}) + "\n")
                kept += 1
                if "<tool_call>" in m["content"]:
                    with_call += 1
        except Exception:
            continue
print(f"WROTE {kept} pairs to {OUT} ({with_call} with tool_call, {kept-with_call} natural) | scanned {n}")
