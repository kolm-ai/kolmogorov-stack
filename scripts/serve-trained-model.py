#!/usr/bin/env python
# Serve a kolm-trained model (HF base + LoRA adapter) as an OpenAI-compatible
# /v1/chat/completions endpoint + a mobile-friendly chat UI at /.
# Pair with `cloudflared tunnel --url http://localhost:PORT` for a phone link.
#
# Usage: python scripts/serve-trained-model.py [--base B] [--adapter DIR] [--port 8799] [--name N]
import json, sys, argparse, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import torch
from transformers import AutoTokenizer, AutoModelForCausalLM
from peft import PeftModel

ap = argparse.ArgumentParser()
ap.add_argument("--base", default="Qwen/Qwen2.5-3B-Instruct")
ap.add_argument("--adapter", default="data/fc-qwen3b-adapter")
ap.add_argument("--port", type=int, default=8799)
ap.add_argument("--name", default="kolm-fc-qwen2.5-3b")
ap.add_argument("--quant", default="")  # "4bit" for bitsandbytes NF4 (fits big models with headroom)
A = ap.parse_args()

print(f"[serve] loading {A.base} (quant={A.quant or 'bf16'}) adapter={A.adapter or 'none'} ...", flush=True)
tok = AutoTokenizer.from_pretrained(A.base)
if A.quant == "4bit":
    from transformers import BitsAndBytesConfig
    bnb = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True)
    model = AutoModelForCausalLM.from_pretrained(A.base, quantization_config=bnb, device_map="cuda")
else:
    model = AutoModelForCausalLM.from_pretrained(A.base, torch_dtype=torch.bfloat16, device_map="cuda")
if A.adapter and A.adapter.lower() != "none":
    try:
        model = PeftModel.from_pretrained(model, A.adapter)
        print("[serve] adapter loaded", flush=True)
    except Exception as e:
        print(f"[serve] no adapter ({e}); serving base", flush=True)
else:
    print("[serve] base model (no adapter)", flush=True)
model.eval()
_lock = threading.Lock()

DEFAULT_TOOLS = [
    {"type": "function", "function": {"name": "get_weather", "description": "Get current weather for a city", "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}},
    {"type": "function", "function": {"name": "get_stock_price", "description": "Get the latest stock price", "parameters": {"type": "object", "properties": {"symbol": {"type": "string"}}, "required": ["symbol"]}}},
]

def generate(messages, tools, max_new_tokens=256):
    prompt = tok.apply_chat_template(messages, tools=tools or None, add_generation_prompt=True, tokenize=False)
    ids = tok(prompt, return_tensors="pt").to("cuda")
    with _lock, torch.no_grad():
        out = model.generate(**ids, max_new_tokens=max_new_tokens, do_sample=True, temperature=0.6, top_p=0.9, pad_token_id=tok.eos_token_id)
    return tok.decode(out[0][ids.input_ids.shape[1]:], skip_special_tokens=True).strip()

PAGE = """<!doctype html><html><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1,maximum-scale=1">
<title>kolm · chat</title><style>
*{box-sizing:border-box}body{margin:0;font:16px/1.5 -apple-system,system-ui,sans-serif;background:#0b0d11;color:#e7ebf0}
header{padding:14px 16px;border-bottom:1px solid #1c2230;font-weight:600;display:flex;gap:8px;align-items:center;position:sticky;top:0;background:#0b0d11}
.dot{width:8px;height:8px;border-radius:50%;background:#34d399}
#log{padding:14px;display:flex;flex-direction:column;gap:10px;padding-bottom:96px}
.msg{max-width:85%;padding:10px 13px;border-radius:14px;white-space:pre-wrap;word-break:break-word}
.u{align-self:flex-end;background:#2563eb;color:#fff;border-bottom-right-radius:4px}
.a{align-self:flex-start;background:#161b25;border:1px solid #232b3a;border-bottom-left-radius:4px}
.tool{align-self:flex-start;background:#0f1b14;border:1px solid #1f5132;color:#86efac;font-family:ui-monospace,monospace;font-size:13px}
footer{position:fixed;bottom:0;left:0;right:0;display:flex;gap:8px;padding:10px;background:#0b0d11;border-top:1px solid #1c2230}
textarea{flex:1;resize:none;background:#11151d;color:#e7ebf0;border:1px solid #232b3a;border-radius:12px;padding:11px 13px;font:16px/1.4 inherit;max-height:120px}
button{background:#2563eb;color:#fff;border:0;border-radius:12px;padding:0 18px;font-weight:600;font-size:16px}
button:disabled{opacity:.5}.hint{color:#7a8699;font-size:13px;padding:0 14px 8px}
</style></head><body>
<header><span class=dot></span> kolm · __NAME__ <span style="color:#7a8699;font-weight:400;font-size:13px">(trained on your GPU)</span></header>
<div id=log><div class="msg a">Hi — I'm a function-calling model kolm trained. Ask me the weather in a city or a stock price (e.g. “weather in Tokyo”, “AAPL price”), or just chat.</div></div>
<div class=hint>Tip: try “what's the weather in Paris?” — watch the tool call.</div>
<footer><textarea id=t rows=1 placeholder="Message…" autofocus></textarea><button id=s onclick=send()>Send</button></footer>
<script>
const log=document.getElementById('log'),t=document.getElementById('t'),s=document.getElementById('s');
let msgs=[];
function add(role,text){const d=document.createElement('div');const tc=role==='assistant'&&text.includes('<tool_call>');d.className='msg '+(role==='user'?'u':(tc?'tool':'a'));d.textContent=tc?('🔧 '+text.replace(/<\\/?tool_call>/g,'').trim()):text;log.appendChild(d);log.scrollTop=1e9;return d;}
t.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}});
async function send(){const v=t.value.trim();if(!v)return;t.value='';add('user',v);msgs.push({role:'user',content:v});s.disabled=true;const d=add('assistant','…');
try{const r=await fetch('/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messages:msgs})});const j=await r.json();const c=(j.choices&&j.choices[0]&&j.choices[0].message&&j.choices[0].message.content)||'(no response)';d.remove();add('assistant',c);msgs.push({role:'assistant',content:c});}
catch(e){d.textContent='error: '+e;}s.disabled=false;t.focus();}
</script></body></html>"""

class H(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json"):
        b = body.encode() if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("access-control-allow-origin", "*")
        self.send_header("content-length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)
    def log_message(self, *a): pass
    def do_OPTIONS(self):
        self.send_response(204); self.send_header("access-control-allow-origin", "*")
        self.send_header("access-control-allow-headers", "content-type"); self.end_headers()
    def do_GET(self):
        if self.path.startswith("/health"):
            return self._send(200, json.dumps({"ok": True, "model": A.name}))
        return self._send(200, PAGE.replace("__NAME__", A.name), "text/html; charset=utf-8")
    def do_POST(self):
        if not self.path.startswith("/v1/chat/completions"):
            return self._send(404, json.dumps({"error": "not_found"}))
        try:
            n = int(self.headers.get("content-length", 0))
            body = json.loads(self.rfile.read(n) or b"{}")
            messages = body.get("messages") or [{"role": "user", "content": str(body.get("input", ""))}]
            tools = body.get("tools", DEFAULT_TOOLS)
            mx = min(512, int(body.get("max_tokens", 256)))
            text = generate(messages, tools, mx)
            self._send(200, json.dumps({
                "id": "chatcmpl-kolm", "object": "chat.completion", "model": A.name,
                "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
            }))
        except Exception as e:
            self._send(500, json.dumps({"error": str(e)}))

srv = ThreadingHTTPServer(("0.0.0.0", A.port), H)
print(f"[serve] READY on http://0.0.0.0:{A.port}  (model: {A.name})", flush=True)
srv.serve_forever()
