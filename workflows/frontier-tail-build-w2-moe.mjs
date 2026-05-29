export const meta = {
  name: 'frontier-tail-build-w2-moe',
  description: 'Wave 2: complete NEXT-4 MoE-aware distill loss (distill.py) + per-expert quant grouping (quantize.py), gated + tested',
  phases: [{ title: 'Build' }, { title: 'Verify' }],
}
const ROOT = 'C:/Users/user/Desktop/kolmogorov-stack'
const R = { type:'object', additionalProperties:false, required:['owner','status','self_check'],
  properties:{ owner:{type:'string'}, status:{type:'string',enum:['complete','partial','failed']}, changes:{type:'array',items:{type:'string'}}, self_check:{type:'string'}, issues:{type:'string'} } }
const C = `Repo root: ${ROOT}. You OWN only the file named below + may CREATE one test file. Edit/create ONLY those. Write REAL working code.
CRITICAL: the existing DENSE path is proven (QAD trained on a 5090, DistiLLM-2 works) — your MoE additions MUST be ADDITIVE and GATED on
MoE-detection so the dense path is byte-for-byte unchanged when num_experts is absent. Reuse the EXISTING MoE-awareness in src/moe-support.js
/ src/forge-experts.js / src/forge-inspect.js (detection, per-expert DAQ mixed-precision profile) rather than reinventing — read them first.
A full MoE model run needs a large model (infra tail) — so validate via a SYNTHETIC config + mock (no model download). After building,
SELF-VERIFY (python -m py_compile + run your test) and report exact results. Determinism: seed param, no wall-clock in control flow. Return ONLY the object.`

const OWNERS = [
  { label: 'w2:quantize-per-expert', prompt: `${C}
OWN: workers/quantize/scripts/quantize.py (+ create tests/wave921-moe-quantize.test.js OR a python self-test inside the file gated by --self-test-moe).
GOAL (NEXT-4 core, highest value — quantizing a customer's MoE model e.g. Mixtral/Qwen-MoE/OLMoE):
Read quantize.py first (it's dense-only: int4/int8/gptq/awq/... via bitsandbytes/AutoGPTQ; takes --mixed-precision <profile.json> from W719 DAQ).
Add a MoE-aware path, GATED on detecting MoE in the model config.json (num_local_experts / num_experts / n_routed_experts / expert keys —
mirror src/moe-support.js detectMoE; you may shell out to it or replicate the key list). When MoE is detected:
 (1) Group parameters into {router/gate (always keep fp16 — sacred), shared/attn layers, per-expert FFN blocks}.
 (2) Apply the per-group precision from the --mixed-precision profile (forge's DAQ already emits router=fp16, shared=q4/iq4, experts=aggressive).
 (3) Quantize each expert block independently (so a 8x or 128x expert model quantizes expert-by-expert without loading all at once where the
     backend allows) and record per-expert bytes-before/after in the run-meta.
 (4) Emit run-meta with {moe:true, num_experts, router_precision, expert_precision, per_group_bytes, total_compression}.
Keep the dense path 100% unchanged (only branch when MoE detected). Provide a --self-test-moe flag (or the JS test) that feeds a SYNTHETIC MoE
config.json (e.g. 8 experts) + tiny fake state dict and asserts: router stays fp16, every expert is grouped + assigned the aggressive precision,
and the grouping covers all expert layers. No real model download. py_compile + run the test, report counts.` },

  { label: 'w2:distill-moe-loss', prompt: `${C}
OWN: apps/trainer/distill.py (+ create a python self-test gated by --self-test-moe, or extend its existing self-test).
GOAL (NEXT-4): make distillation MoE-aware so a MoE STUDENT trains correctly (load-balanced experts) without changing the dense KD path.
Read distill.py first (KL + CE KD, forward/reverse-KL, DistiLLM-2 SKL/SRKL; _DistillTrainer.compute_loss). Add, GATED on the student being MoE
(config has num_local_experts/num_experts/output_router_logits capable):
 (1) Detect MoE student at model-load; if MoE, set output_router_logits=True on the forward config.
 (2) In compute_loss, when MoE: add the model's router auxiliary load-balancing loss (HF MoE models expose outputs.aux_loss or router_logits ->
     compute the standard load-balance aux: mean over layers of (num_experts * sum_e f_e * P_e)) scaled by a configurable router_aux_loss_coef
     (default 0.001), ADDED to the existing KD loss. Dense students: NO change (the aux term is only added when MoE detected).
 (3) Surface moe:{num_experts, router_aux_loss_coef, aux_loss_last} in the training-summary.json when MoE.
Provide a self-test that builds a SYNTHETIC mock model output with fake router_logits over 8 experts and asserts: (a) the load-balance aux loss
is computed + >=0, (b) a perfectly-balanced router yields aux ~= 1.0*baseline (minimal), a fully-collapsed router yields a HIGHER aux (the term
penalizes imbalance), (c) the dense path (no router_logits) adds zero aux. No real model. py_compile + run, report.` },
]

phase('Build')
const built = await parallel(OWNERS.map((o)=>()=>agent(o.prompt,{label:o.label,phase:'Build',schema:R})))
const ok = built.filter(Boolean)
log(`Wave2 MoE: ${ok.map(b=>`${(b.owner||'?').split('/').pop()}=${b.status}`).join(', ')}`)

phase('Verify')
const VS={type:'object',additionalProperties:false,required:['verdict','checks'],properties:{verdict:{type:'string',enum:['green','issues']},checks:{type:'array',items:{type:'object',additionalProperties:false,required:['name','pass','detail'],properties:{name:{type:'string'},pass:{type:'boolean'},detail:{type:'string'}}}},failures:{type:'string'}}}
const verify = await agent(`Wave-2 MoE just edited workers/quantize/scripts/quantize.py + apps/trainer/distill.py (+ tests). Verify:
(1) python -m py_compile workers/quantize/scripts/quantize.py && python -m py_compile apps/trainer/distill.py (both clean);
(2) run the MoE self-tests (the --self-test-moe flags or the new test files) — report PASS/FAIL;
(3) CONFIRM the dense path is unchanged: grep that the MoE branches are gated on a num_experts/MoE detection check (an 'if moe:' style guard),
    and that distill.py's existing --self-test (dense) still passes (python apps/trainer/distill.py --self-test or --preflight if that's the flag);
(4) grep quantize.py confirms router/gate stays fp16 in the MoE path.
Report each check pass/fail with exact output. Return ONLY the object.`, {label:'w2:verify',phase:'Verify',schema:VS})
return { built: ok, verify }
