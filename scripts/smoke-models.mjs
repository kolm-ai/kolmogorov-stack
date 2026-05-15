// Smoke tests for src/models.js + src/devices.js.
// Verifies: device detect picks rtx-5090 on this box; recommend honors
// target_device + train_device; all model ids are well-formed.

import models from '../src/models.js';
import devices from '../src/devices.js';

let ok = 0, fail = 0;
const T = (name, cond, extra) => {
  if (cond) { ok++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  -- ' + extra : ''}`); }
};

console.log('1) Registry shape');
T('DEFAULT_MODEL set', models.DEFAULT_MODEL === 'Qwen/Qwen2.5-3B-Instruct');
T('all models have id + family + license', models.MODELS.every(m => m.id && m.family && m.license));
T('all use_for arrays non-empty', models.MODELS.every(m => Array.isArray(m.use_for) && m.use_for.length > 0));
T('id format is org/name', models.MODELS.every(m => m.id.includes('/')));

console.log('\n2) Device detect');
const det = await devices.detectLocal();
console.log('   ->', JSON.stringify(det));
T('detect returned an id', !!det.id);
T('detect picked rtx-5090 on this box', det.id === 'rtx-5090');

console.log('\n3) recommend({use: "default"})');
const r1 = models.recommend({ use: 'default' });
console.log('   ->', JSON.stringify(r1, null, 2));
T('pick is Qwen/Qwen2.5-3B-Instruct', r1.pick === 'Qwen/Qwen2.5-3B-Instruct');

console.log('\n4) recommend with target_device=rtx-5090 (train rig)');
const d5090 = devices.info('rtx-5090');
const r2 = models.recommend({ use: 'default', target_device: d5090 });
console.log('   ->', r2.pick, 'top:', r2.top);
T('5090 target picks a 3B-7B-class model', ['Qwen/Qwen2.5-3B-Instruct', 'Qwen/Qwen2.5-7B-Instruct'].includes(r2.pick));
T('5090 fits the pick', r2.device_fit === true);

console.log('\n5) recommend with target_device=iphone-15-pro');
const dPhone = devices.info('iphone-15-pro');
const r3 = models.recommend({ use: 'default', target_device: dPhone });
console.log('   ->', r3.pick);
T('phone target picks <=1.5B-class', ['Qwen/Qwen2.5-0.5B-Instruct', 'Qwen/Qwen2.5-1.5B-Instruct', 'google/gemma-3-1b-it', 'HuggingFaceTB/SmolLM2-1.7B-Instruct'].includes(r3.pick));

console.log('\n6) recommend permissive-only');
const r4 = models.recommend({ use: 'default', permissive: true });
console.log('   ->', r4.pick);
const pickInfo = models.info(r4.pick);
T('permissive pick has apache/mit license', ['apache-2.0', 'mit'].includes(pickInfo.license));

console.log('\n7) recommend with train_device=rtx-5090');
const r5 = models.recommend({ use: 'quality', train_device: d5090 });
console.log('   ->', r5.pick, 'device_train:', r5.device_train);
T('5090 can train 7B', r5.device_train === true);

console.log('\n8) Gemma 3 4B is in registry');
const g3 = models.info('google/gemma-3-4b-it');
T('gemma-3-4b-it exists', !!g3 && g3.params_b === 4);

console.log('\n9) fitsOn / trainOn helpers');
T('Qwen 7B fits rtx-5090 for inference', models.fitsOn('Qwen/Qwen2.5-7B-Instruct', d5090));
T('Qwen 14B fits rtx-5090 for inference', models.fitsOn('Qwen/Qwen2.5-14B-Instruct', d5090));
T('Qwen 7B trains on rtx-5090', models.trainOn('Qwen/Qwen2.5-7B-Instruct', d5090));
T('Qwen 14B does NOT train on rtx-5090 (24GB QLoRA budget)', !models.trainOn('Qwen/Qwen2.5-14B-Instruct', d5090));
T('Qwen 0.5B fits iphone-15-pro', models.fitsOn('Qwen/Qwen2.5-0.5B-Instruct', dPhone));
T('Qwen 7B does NOT fit iphone-15-pro', !models.fitsOn('Qwen/Qwen2.5-7B-Instruct', dPhone));

console.log(`\n${ok}/${ok + fail} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
