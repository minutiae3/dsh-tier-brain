/**
 * 对比 corpus-all.json 与 cases.jsonl，列出还没标注的样本。
 * 运行： ELECTRON_RUN_AS_NODE=1 "/d/dsh/DeepSeek Harness.exe" test/diff-corpus.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(fs.readFileSync(path.join(dir, 'corpus-all.json'), 'utf8'));
const cases = fs.readFileSync(path.join(dir, 'cases.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
const labeled = new Map(cases.map((c) => [norm(c.text), c.tier]));

let covered = 0;
const missing = [];
for (const r of corpus) {
  const k = norm(r.text);
  if (labeled.has(k)) covered++;
  else missing.push(r);
}

console.log('语料总数:', corpus.length);
console.log('已标注:', covered);
console.log('未标注:', missing.length);
console.log('---');
missing.forEach((r, i) => {
  console.log(`[${i}] len=${r.text.length} | ${r.text.slice(0, 120)}`);
});
