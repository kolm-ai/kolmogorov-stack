#!/usr/bin/env python
# Serve a kolm-trained model (HF base + optional LoRA adapter) as an OpenAI-compatible
# /v1/chat/completions endpoint + a mobile chat UI — AUTH-GATED and attributed to a kolm
# account. Every request must carry the tenant's kolm API key (Authorization: Bearer ks_...),
# validated against https://kolm.ai/v1/whoami; usage is attributed to that tenant.
# Pair with cloudflared / a named kolm.ai tunnel for the public phone link.
#
# Usage: python scripts/serve-trained-model.py [--base B] [--adapter DIR|none] [--quant 4bit] [--port 8799] [--name N] [--no-auth]
import json, sys, argparse, threading, re, time, urllib.request, urllib.error, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import torch
from transformers import AutoTokenizer, AutoModelForCausalLM
from peft import PeftModel

ap = argparse.ArgumentParser()
ap.add_argument("--base", default="Qwen/Qwen2.5-3B-Instruct")
ap.add_argument("--adapter", default="data/fc-qwen3b-adapter")
ap.add_argument("--port", type=int, default=8799)
ap.add_argument("--name", default="kolm-fc-qwen2.5-3b")
ap.add_argument("--quant", default="")              # "4bit" => bitsandbytes NF4
ap.add_argument("--auth-base", default="https://kolm.ai")
ap.add_argument("--no-auth", action="store_true")   # disable auth (local-only demos)
ap.add_argument("--system", default="")             # system prompt (model self-context)
ap.add_argument("--no-web", action="store_true")    # disable live web_search tool
A = ap.parse_args()
AUTH = not A.no_auth
WEB = not A.no_web
SYSTEM = A.system or (
    f"You are {A.name}, a model served locally on the operator's own GPU through kolm. "
    "You were distilled/fine-tuned with the kolm pipeline. You are good at function/tool calling, "
    "clear concise answers, and everyday assistant tasks. "
    + ("You have a live `web_search` tool: when a question needs current or factual info you don't "
       "know (news, prices, weather, recent events, specifics), call it and answer from the results — "
       "do not guess. " if WEB else "You have no internet access; say so if asked for live info. ")
    + "Be honest about uncertainty and never invent facts, prices, or sources."
)

print(f"[serve] loading {A.base} (quant={A.quant or 'bf16'}) adapter={A.adapter or 'none'} auth={'on' if AUTH else 'OFF'} ...", flush=True)
tok = AutoTokenizer.from_pretrained(A.base)
if A.quant == "4bit":
    from transformers import BitsAndBytesConfig
    bnb = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True)
    model = AutoModelForCausalLM.from_pretrained(A.base, quantization_config=bnb, device_map="cuda")
else:
    model = AutoModelForCausalLM.from_pretrained(A.base, torch_dtype=torch.bfloat16, device_map="cuda")
if A.adapter and A.adapter.lower() != "none":
    try:
        model = PeftModel.from_pretrained(model, A.adapter); print("[serve] adapter loaded", flush=True)
    except Exception as e:
        print(f"[serve] no adapter ({e}); serving base", flush=True)
else:
    print("[serve] base model (no adapter)", flush=True)
model.eval()
_lock = threading.Lock()

# ---- auth: validate the kolm API key against /v1/whoami, attribute to tenant ----
_authcache = {}  # bearer -> (tenant, expires)
def authenticate(bearer):
    if not AUTH:
        return "local"
    if not bearer or not re.match(r"^(ks_|kao_)[A-Za-z0-9_-]{6,256}$", bearer):
        return None
    c = _authcache.get(bearer)
    if c and c[1] > time.time():
        return c[0]
    try:
        req = urllib.request.Request(A.auth_base + "/v1/whoami", headers={"authorization": "Bearer " + bearer})
        with urllib.request.urlopen(req, timeout=10) as r:
            j = json.loads(r.read().decode())
        tenant = j.get("id") or j.get("tenant") or j.get("tenant_id") or "unknown"
        _authcache[bearer] = (tenant, time.time() + 300)
        return tenant
    except Exception:
        return None

DEFAULT_TOOLS = [
    {"type": "function", "function": {"name": "web_search", "description": "Search the live web for current/factual information (news, prices, weather, recent events, specifics). Use whenever the answer needs up-to-date or factual data.", "parameters": {"type": "object", "properties": {"query": {"type": "string", "description": "the search query"}}, "required": ["query"]}}},
    {"type": "function", "function": {"name": "get_weather", "description": "Get current weather for a city", "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}},
    {"type": "function", "function": {"name": "get_stock_price", "description": "Get the latest stock price", "parameters": {"type": "object", "properties": {"symbol": {"type": "string"}}, "required": ["symbol"]}}},
]
if A.no_web:
    DEFAULT_TOOLS = DEFAULT_TOOLS[1:]

# --- live web search: primary = kolm Grok (xAI) proxy (real web access), fallback = DDG lite ---
def _web_search(query, bearer=""):
    if bearer:
        try:
            payload = json.dumps({"vendor": "xai", "model": "grok-4", "max_tokens": 500,
                "system": "You are a web search backend. Reply with 4-6 concise factual bullet points answering the query from current web information, each with the key fact. No preamble, no caveats.",
                "messages": [{"role": "user", "content": query}]}).encode()
            req = urllib.request.Request(A.auth_base + "/v1/teacher/chat", data=payload,
                headers={"authorization": "Bearer " + bearer, "content-type": "application/json"})
            with urllib.request.urlopen(req, timeout=25) as r:
                j = json.loads(r.read().decode())
            c = (j.get("choices") or [{}])[0].get("message", {}).get("content", "")
            if c and c.strip():
                return c.strip()
        except Exception:
            pass
    try:
        data = urllib.parse.urlencode({"q": query}).encode()
        req = urllib.request.Request("https://lite.duckduckgo.com/lite/", data=data, headers={"User-Agent": "Mozilla/5.0"})
        html = urllib.request.urlopen(req, timeout=12).read().decode("utf-8", "ignore")
        cells = re.findall(r'class="result-snippet"[^>]*>(.*?)</td>', html, re.S)[:5]
        clean = lambda s: re.sub(r"<[^>]+>", "", s).strip()
        out = [clean(x) for x in cells if clean(x)]
        return "\n".join("- " + o for o in out) if out else "(no results)"
    except Exception as e:
        return f"(web_search unavailable: {e})"

def _tool_query(name, args):
    # Map any tool call to a live search query so trained weather/stock tools also return real data.
    if name == "web_search":
        return str(args.get("query", ""))
    if name == "get_weather":
        return "current weather in " + str(args.get("city", ""))
    if name == "get_stock_price":
        return str(args.get("symbol", "")) + " stock price today"
    return " ".join(str(v) for v in (args or {}).values())

_CALL_JSON = re.compile(r"<tool_call>\s*(\{.*?\})\s*(?:</tool_call>|$)", re.S)
_CALL_XML = re.compile(r"<function=([^>\s]+)>(.*?)(?:</function>|$)", re.S)
_PARAM = re.compile(r"<parameter=([^>\s]+)>\s*(.*?)\s*(?:</parameter>|$)", re.S)
def _extract_call(text):
    # Qwen2.5/FC emit JSON tool calls; Qwen3.5 emits XML (<function=..><parameter=..>).
    m = _CALL_JSON.search(text)
    if m:
        try:
            c = json.loads(m.group(1)); return c.get("name"), (c.get("arguments") or {})
        except Exception:
            pass
    m = _CALL_XML.search(text)
    if m:
        return m.group(1).strip(), {k.strip(): v.strip() for k, v in _PARAM.findall(m.group(2))}
    return None

def generate(messages, tools, max_new_tokens=512):
    try:
        prompt = tok.apply_chat_template(messages, tools=tools or None, add_generation_prompt=True, tokenize=False, enable_thinking=False)
    except TypeError:
        prompt = tok.apply_chat_template(messages, tools=tools or None, add_generation_prompt=True, tokenize=False)
    ids = tok(prompt, return_tensors="pt").to("cuda")
    with _lock, torch.no_grad():
        out = model.generate(**ids, max_new_tokens=max_new_tokens, do_sample=True, temperature=0.6, top_p=0.9,
                             pad_token_id=tok.eos_token_id, stop_strings=["</tool_call>", "</function>"], tokenizer=tok)
    text = tok.decode(out[0][ids.input_ids.shape[1]:], skip_special_tokens=True).strip()
    text = re.sub(r"<think>.*?</think>\s*", "", text, flags=re.S).strip()
    if "</think>" in text:
        text = text.split("</think>")[-1].strip()
    return text

PAGE = r"""<!doctype html><html><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1,maximum-scale=1">
<title>kolm · chat</title><style>
*{box-sizing:border-box}body{margin:0;font:16px/1.5 -apple-system,system-ui,sans-serif;background:#0b0d11;color:#e7ebf0}
header{padding:14px 16px;border-bottom:1px solid #1c2230;font-weight:600;display:flex;gap:8px;align-items:center;position:sticky;top:0;background:#0b0d11;z-index:2}
.dot{width:8px;height:8px;border-radius:50%;background:#34d399}.who{margin-left:auto;color:#7a8699;font-weight:400;font-size:12px}
#log{padding:14px;display:flex;flex-direction:column;gap:10px;padding-bottom:96px}
.msg{max-width:85%;padding:10px 13px;border-radius:14px;white-space:pre-wrap;word-break:break-word}
.u{align-self:flex-end;background:#2563eb;color:#fff;border-bottom-right-radius:4px}
.a{align-self:flex-start;background:#161b25;border:1px solid #232b3a;border-bottom-left-radius:4px}
.tool{align-self:flex-start;background:#0f1b14;border:1px solid #1f5132;color:#86efac;font-family:ui-monospace,monospace;font-size:13px}
footer{position:fixed;bottom:0;left:0;right:0;display:flex;gap:8px;padding:10px;background:#0b0d11;border-top:1px solid #1c2230}
textarea{flex:1;resize:none;background:#11151d;color:#e7ebf0;border:1px solid #232b3a;border-radius:12px;padding:11px 13px;font:16px/1.4 inherit;max-height:120px}
button{background:#2563eb;color:#fff;border:0;border-radius:12px;padding:0 18px;font-weight:600;font-size:16px}
button:disabled{opacity:.5}
#gate{position:fixed;inset:0;background:#0b0d11;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px;text-align:center;z-index:5}
#gate input{width:100%;max-width:360px;background:#11151d;color:#e7ebf0;border:1px solid #232b3a;border-radius:12px;padding:13px;font:16px monospace}
#gate .t{font-size:20px;font-weight:700}#gate .s{color:#7a8699;font-size:14px;max-width:380px}#gate .e{color:#f87171;font-size:13px;min-height:16px}
.hint{color:#7a8699;font-size:13px;padding:0 14px 8px}
.hbtn{background:#161b25;border:1px solid #232b3a;color:#e7ebf0;border-radius:9px;padding:6px 10px;font-size:13px;font-weight:600;line-height:1;cursor:pointer}
.hbtn:active{background:#1c2230}
#scrim{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:3;display:none}
#drawer{position:fixed;top:0;left:0;bottom:0;width:84%;max-width:320px;background:#0e1218;border-right:1px solid #1c2230;z-index:4;transform:translateX(-100%);transition:transform .2s ease;display:flex;flex-direction:column}
#drawer.open{transform:none}#scrim.open{display:block}
.dhead{padding:14px 16px;border-bottom:1px solid #1c2230;font-weight:600;display:flex;align-items:center;gap:8px}
.dhead .x{margin-left:auto;background:none;border:0;color:#7a8699;font-size:20px;padding:0 4px;cursor:pointer}
.dnew{margin:10px 12px;background:#2563eb;color:#fff;border:0;border-radius:10px;padding:10px;font-weight:600;font-size:15px;cursor:pointer}
#convs{flex:1;overflow-y:auto;padding:0 8px 16px}
.cv{display:flex;align-items:center;gap:8px;padding:10px 10px;border-radius:10px;cursor:pointer}
.cv:active,.cv.cur{background:#161b25}
.cv .ct{flex:1;min-width:0}.cv .cn{font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cv .cp{font-size:12px;color:#7a8699;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
.cv .cd{background:none;border:0;color:#7a8699;font-size:16px;padding:4px 6px;cursor:pointer;flex:none}
.cv .cd:active{color:#f87171}
.dempty{color:#7a8699;font-size:13px;text-align:center;padding:24px 12px}
</style></head><body>
<div id=gate>
  <div class=t>🔒 kolm · __NAME__</div>
  <div class=s>Sign in with your kolm API key to chat with this model. Access is private to your account.</div>
  <input id=key type=password placeholder="ks_..." autocomplete=off>
  <button onclick=signin()>Connect</button>
  <div class=e id=err></div>
  <div class=s style="font-size:12px">No key? Get one at kolm.ai → Account → API keys.</div>
</div>
<div id=scrim onclick=closeDrawer()></div>
<div id=drawer>
  <div class=dhead>Conversations <button class=x onclick=closeDrawer()>×</button></div>
  <button class=dnew onclick=newChat()>+ New chat</button>
  <div id=convs></div>
</div>
<header><button class=hbtn id=menu onclick=openDrawer() title="Conversations">☰</button><span class=dot></span> kolm · __NAME__ <span class=who id=who></span><button class=hbtn id=newbtn onclick=newChat() title="New chat" style="margin-left:8px">+ New</button></header>
<div id=log><div class="msg a">Connected. Ask me anything — try “weather in Tokyo?” to see a tool call, or just chat.</div></div>
<div class=hint>Private to your kolm account · trained on your GPU</div>
<footer><textarea id=t rows=1 placeholder="Message…"></textarea><button id=s onclick=send()>Send</button></footer>
<script>
const AUTHBASE="__AUTHBASE__",MODEL="__NAME__";
const log=document.getElementById('log'),t=document.getElementById('t'),s=document.getElementById('s'),gate=document.getElementById('gate'),err=document.getElementById('err'),who=document.getElementById('who');
const drawer=document.getElementById('drawer'),scrim=document.getElementById('scrim'),convsEl=document.getElementById('convs');
// Pre-auth from a CLI share link (#k=<key>): store it, then strip it from the URL bar.
try{var _h=location.hash.match(/[#&]k=([^&]+)/);if(_h){localStorage.setItem('kolm_key',decodeURIComponent(_h[1]));history.replaceState(null,document.title,location.pathname);}}catch(e){}
let KEY=localStorage.getItem('kolm_key')||'',TENANT='',msgs=[];
let CID='',TITLE='',saveTimer=0;
function showApp(tenant){gate.style.display='none';TENANT=tenant||'';who.textContent=tenant?('· '+tenant):'';renderConvs();}
async function check(k){try{const r=await fetch('/whoami',{headers:{authorization:'Bearer '+k}});if(!r.ok)return null;return (await r.json()).tenant;}catch(e){return null;}}
async function signin(){const k=document.getElementById('key').value.trim();err.textContent='';if(!k){err.textContent='Enter your kolm key';return;}const tn=await check(k);if(!tn){err.textContent='Invalid key (rejected by kolm.ai)';return;}KEY=k;localStorage.setItem('kolm_key',k);showApp(tn);pullCloud();}
(async()=>{if(KEY){const tn=await check(KEY);if(tn){showApp(tn);pullCloud();}}})();
function add(role,text){const d=document.createElement('div');const tc=role==='assistant'&&text.includes('<tool_call>');d.className='msg '+(role==='user'?'u':(tc?'tool':'a'));d.textContent=tc?('🔧 '+text.replace(/<\/?tool_call>/g,'').trim()):text;log.appendChild(d);log.scrollTop=1e9;return d;}
t.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}});

// ---- conversation history: localStorage store, keyed per tenant; cloud-synced via kolm.ai ----
function lsKey(){return 'kolm_convs_'+(TENANT||'anon');}
function store(){try{return JSON.parse(localStorage.getItem(lsKey())||'{}');}catch(e){return {};}}
function saveStore(o){try{localStorage.setItem(lsKey(),JSON.stringify(o));}catch(e){}}
function newId(){return 'cv_'+Date.now().toString(36)+Math.random().toString(36).slice(2,10);}
function newChat(){CID='';TITLE='';msgs=[];log.innerHTML='<div class="msg a">New chat. Ask me anything — try “weather in Tokyo?” to see a tool call, or just chat.</div>';closeDrawer();renderConvs();t.focus();}
function openDrawer(){renderConvs();drawer.classList.add('open');scrim.classList.add('open');}
function closeDrawer(){drawer.classList.remove('open');scrim.classList.remove('open');}
function lastUser(m){for(let i=m.length-1;i>=0;i--){if(m[i].role==='user')return m[i].content;}return '';}
function renderConvs(){const o=store();const ids=Object.keys(o).filter(k=>!o[k].deleted).sort((a,b)=>(o[b].updated_at||0)-(o[a].updated_at||0));
  if(!ids.length){convsEl.innerHTML='<div class=dempty>No conversations yet.</div>';return;}
  convsEl.innerHTML='';
  for(const id of ids){const c=o[id];const row=document.createElement('div');row.className='cv'+(id===CID?' cur':'');
    row.innerHTML='<div class=ct><div class=cn></div><div class=cp></div></div><button class=cd title=Delete>🗑</button>';
    row.querySelector('.cn').textContent=c.title||'Untitled';
    row.querySelector('.cp').textContent=(c.preview||'').slice(0,120);
    row.querySelector('.ct').onclick=()=>resume(id);
    row.querySelector('.cd').onclick=(e)=>{e.stopPropagation();delConv(id);};
    convsEl.appendChild(row);}}
function resume(id){const o=store();const c=o[id];if(!c)return;CID=id;TITLE=c.title||'';msgs=(c.messages||[]).map(m=>({role:m.role,content:m.content}));
  log.innerHTML='';if(!msgs.length){add('assistant','(empty conversation)');}
  for(const m of msgs){if(m.role==='user'||m.role==='assistant')add(m.role,m.content);}
  closeDrawer();renderConvs();}
function persistLocal(){if(!msgs.length)return;if(!CID)CID=newId();
  if(!TITLE){const fu=msgs.find(m=>m.role==='user');TITLE=(fu?fu.content:'Chat').slice(0,80);}
  const o=store();o[CID]={conversation_id:CID,title:TITLE,model:MODEL,messages:msgs,message_count:msgs.length,preview:lastUser(msgs).slice(0,120),updated_at:Date.now()};
  saveStore(o);renderConvs();}
function delConv(id){const o=store();if(o[id]){o[id]={deleted:true,updated_at:Date.now()};saveStore(o);}
  if(id===CID)newChat();else renderConvs();
  if(KEY)fetch(AUTHBASE+'/v1/conversations/'+encodeURIComponent(id),{method:'DELETE',headers:{authorization:'Bearer '+KEY}}).catch(e=>{});}
function scheduleSync(){clearTimeout(saveTimer);saveTimer=setTimeout(pushCloud,800);}
// cloud sync: upsert current conversation metadata+messages to kolm.ai (best-effort, non-blocking)
async function pushCloud(){if(!KEY||!CID||!msgs.length)return;
  try{await fetch(AUTHBASE+'/v1/conversations',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+KEY},
    body:JSON.stringify({conversation_id:CID,model:MODEL,title:TITLE,messages:msgs,device:'phone'})});}catch(e){}}
// pull cloud conversation list into local store on sign-in (metadata; full messages fetched on resume)
async function pullCloud(){if(!KEY)return;
  try{const r=await fetch(AUTHBASE+'/v1/conversations?limit=200',{headers:{authorization:'Bearer '+KEY}});if(!r.ok)return;
    const j=await r.json();const list=(j&&j.conversations)||[];if(!list.length)return;
    const o=store();for(const c of list){const ex=o[c.conversation_id];if(ex&&ex.deleted)continue;
      o[c.conversation_id]=Object.assign({},ex,{conversation_id:c.conversation_id,title:c.title,model:c.model,message_count:c.message_count,preview:c.preview,updated_at:Date.parse(c.updated_at)||(ex?ex.updated_at:Date.now()),cloud:true,messages:(ex&&ex.messages)||[]});}
    saveStore(o);renderConvs();}catch(e){}}
// fetch full messages for a cloud-only conversation when resumed and local copy is empty
async function fillCloud(id){if(!KEY)return;
  try{const r=await fetch(AUTHBASE+'/v1/conversations/'+encodeURIComponent(id),{headers:{authorization:'Bearer '+KEY}});if(!r.ok)return;
    const j=await r.json();const c=j&&j.conversation;if(!c||!c.messages)return;
    const o=store();if(o[id]&&!o[id].deleted){o[id].messages=c.messages;saveStore(o);if(id===CID)resume(id);}}catch(e){}}
const _resume=resume;resume=function(id){const o=store();const c=o[id];_resume(id);if(c&&(!c.messages||!c.messages.length)&&c.cloud)fillCloud(id);};

async function send(){const v=t.value.trim();if(!v)return;t.value='';add('user',v);msgs.push({role:'user',content:v});s.disabled=true;const d=add('assistant','…');
try{const r=await fetch('/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer '+KEY},body:JSON.stringify({messages:msgs})});
if(r.status===401){d.remove();localStorage.removeItem('kolm_key');KEY='';gate.style.display='flex';err.textContent='Session expired — sign in again';s.disabled=false;return;}
const j=await r.json();const c=(j.choices&&j.choices[0]&&j.choices[0].message&&j.choices[0].message.content)||'(no response)';d.remove();add('assistant',c);msgs.push({role:'assistant',content:c});persistLocal();scheduleSync();}
catch(e){d.textContent='error: '+e;}s.disabled=false;t.focus();}
</script></body></html>"""

class H(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json"):
        b = body.encode() if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("access-control-allow-origin", "*")
        self.send_header("access-control-allow-headers", "content-type, authorization")
        self.send_header("content-length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)
    def _bearer(self):
        m = re.match(r"^Bearer\s+(\S+)$", self.headers.get("authorization", ""), re.I)
        return m.group(1) if m else ""
    def log_message(self, *a): pass
    def do_OPTIONS(self):
        self.send_response(204); self.send_header("access-control-allow-origin", "*")
        self.send_header("access-control-allow-headers", "content-type, authorization"); self.end_headers()
    def do_GET(self):
        if self.path.startswith("/health"):
            return self._send(200, json.dumps({"ok": True, "model": A.name, "auth": AUTH}))
        if self.path.startswith("/whoami"):
            tenant = authenticate(self._bearer())
            if not tenant:
                return self._send(401, json.dumps({"ok": False, "error": "auth_required"}))
            return self._send(200, json.dumps({"ok": True, "tenant": tenant}))
        return self._send(200, PAGE.replace("__NAME__", A.name).replace("__AUTHBASE__", A.auth_base.rstrip("/")), "text/html; charset=utf-8")
    def do_POST(self):
        if not self.path.startswith("/v1/chat/completions"):
            return self._send(404, json.dumps({"error": "not_found"}))
        tenant = authenticate(self._bearer())
        if not tenant:
            return self._send(401, json.dumps({"error": "auth_required", "detail": "Authorization: Bearer <your kolm key>"}))
        try:
            n = int(self.headers.get("content-length", 0))
            body = json.loads(self.rfile.read(n) or b"{}")
            messages = body.get("messages") or [{"role": "user", "content": str(body.get("input", ""))}]
            # Inject the model's self-context system message if the caller didn't supply one.
            if SYSTEM and not (messages and messages[0].get("role") == "system"):
                messages = [{"role": "system", "content": SYSTEM}] + messages
            tools = body.get("tools", DEFAULT_TOOLS)
            mx = min(1024, int(body.get("max_tokens", 512)))
            # Agentic loop: let the model call tools; auto-execute web_search (and route
            # trained weather/stock calls through live search) so answers use real data.
            searched = []
            text = generate(messages, tools, mx)
            for _ in range(3):
                call = _extract_call(text) if WEB else None
                if not call:
                    break
                name, cargs = call
                q = _tool_query(name, cargs)
                results = _web_search(q, self._bearer())
                searched.append(q)
                messages = messages + [
                    {"role": "assistant", "content": text},
                    {"role": "tool", "content": f"web_search({q}) results:\n{results}"},
                ]
                text = generate(messages, tools, mx)
            if searched:
                text = "🔎 searched: " + "; ".join(searched) + "\n\n" + text
            print(f"[serve] tenant={tenant} searches={len(searched)} out={len(text)}c", flush=True)
            self._send(200, json.dumps({
                "id": "chatcmpl-kolm", "object": "chat.completion", "model": A.name, "tenant": tenant,
                "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
            }))
        except Exception as e:
            self._send(500, json.dumps({"error": str(e)}))

srv = ThreadingHTTPServer(("0.0.0.0", A.port), H)
print(f"[serve] READY on http://0.0.0.0:{A.port}  (model: {A.name}, auth: {'on' if AUTH else 'OFF'})", flush=True)
srv.serve_forever()
