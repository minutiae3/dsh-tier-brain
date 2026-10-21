/**
 * 把 corpus-all.json 里还没标注的样本补标三档，追加进 cases.jsonl。
 * 运行： ELECTRON_RUN_AS_NODE=1 "/d/dsh/DeepSeek Harness.exe" test/label-new.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(fs.readFileSync(path.join(dir, 'corpus-all.json'), 'utf8'));
const casesFile = path.join(dir, 'cases.jsonl');
const cases = fs.readFileSync(casesFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
const labeled = new Set(cases.map((c) => norm(c.text)));
const missing = corpus.filter((r) => !labeled.has(norm(r.text)));

// 按 diff 顺序逐一人工标注的三档（T1 一两句不用工具；T2 要动手或分点答；T3 要设计权衡/跨文件诊断/长篇产出）
const tiers = [1, 3, 2, 3, 2, 2, 2, 1, 3, 2];
if (missing.length !== tiers.length) {
  console.error(`数量不匹配：missing=${missing.length} tiers=${tiers.length}`);
  process.exit(1);
}

const start = cases.length;
const added = missing.map((r, i) => ({
  id: `r${start + i}`,
  text: r.text,
  tier: tiers[i],
}));

fs.writeFileSync(casesFile, cases.concat(added).map((c) => JSON.stringify(c)).join('\n') + '\n', 'utf8');
console.log('新增标注:', added.length);
added.forEach((a) => console.log(`  ${a.id} T${a.tier} | ${a.text.slice(0, 60)}`));
console.log('cases.jsonl 现在共', cases.length + added.length, '条');
