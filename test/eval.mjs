// 评测：node test/eval.mjs [--verbose]
// 读 test/cases.jsonl（人工标注的真实用户消息），跑 lib/scoring.js，
// 输出整体准确率、开发/留出集准确率、混淆矩阵、错例。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { score } from '../lib/scoring.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(here, 'cases.jsonl');
const verbose = process.argv.includes('--verbose');

const cases = fs.readFileSync(file, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

const hash = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 2;
};

const groups = { dev: [], holdout: [], all: [] };
const confusion = {};
let hits = 0;

for (const c of cases) {
  const r = score(c.text, {});
  const ok = r.tier === c.tier;
  if (ok) hits++;
  groups.all.push({ ...c, pred: r });
  groups[hash(c.id) === 0 ? 'dev' : 'holdout'].push({ ...c, pred: r });
  const k = `${c.tier}->${r.tier}`;
  confusion[k] = (confusion[k] || 0) + 1;
}

const pct = (n, d) => ((100 * n) / d).toFixed(1) + '%';

console.log(`样本 ${cases.length}`);
for (const g of ['all', 'dev', 'holdout']) {
  const arr = groups[g];
  const ok = arr.filter((x) => x.pred.tier === x.tier).length;
  console.log(`  ${g.padEnd(8)} n=${String(arr.length).padStart(3)}  准确率 ${pct(ok, arr.length)}`);
}

const tiers = [1, 2, 3];
console.log('\n混淆矩阵（行=人工，列=预测）');
console.log('     ' + tiers.map((t) => `T${t}`.padStart(8)).join('') + '   召回');
for (const t of tiers) {
  const row = tiers.map((p) => (confusion[`${t}->${p}`] || 0));
  const total = row.reduce((a, b) => a + b, 0);
  console.log(`  T${t} ` + row.map((n) => String(n).padStart(8)).join('') + '   ' + pct(row[t - 1], total));
}

const bad = groups.all.filter((x) => x.pred.tier !== x.tier);
if (verbose) {
  console.log(`\n错例 ${bad.length}`);
  for (const b of bad) {
    const txt = b.text.replace(/\s+/g, ' ').slice(0, 90);
    console.log(`  ${b.id} 人工T${b.tier} → 预测T${b.pred.tier} [${b.pred.category} ${b.pred.score}] ${txt}`);
  }
}

const ok = groups.all.filter((x) => x.pred.tier === x.tier).length;
console.log(`\n总体准确率 ${pct(ok, cases.length)}（目标 ≥60%）`);
process.exit(ok / cases.length >= 0.6 ? 0 : 1);
