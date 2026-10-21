/**
 * 扫描 ~/.dsh/sessions 下所有会话，提取全部真实用户消息（去系统注入、去重）。
 * 运行： ELECTRON_RUN_AS_NODE=1 "/d/dsh/DeepSeek Harness.exe" test/extract-all-msgs.mjs
 * 输出：test/corpus-all.json（结构化）+ test/corpus-all.txt（可读版）
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = 'C:/Users/minut/.dsh/sessions';
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const OUT_JSON = new URL('./corpus-all.json', import.meta.url);
const OUT_TXT = new URL('./corpus-all.txt', import.meta.url);

const INJECTED_PREFIXES = [
  'Current runtime context.',
  'Time sampled while preparing',
  '<hindsight_knowledge>',
  '<hindsight_knowledge_refresh>',
  '[Compressed conversation section]',
  'Current DSH file policy',
];

function isInjected(text, kind) {
  if (kind && typeof kind === 'string' && kind !== 'user') return true;
  const head = text.slice(0, 96);
  if (INJECTED_PREFIXES.some((p) => head.startsWith(p))) return true;
  if (/This repository has a Hindsight memory/.test(text.slice(0, 400))) return true;
  return false;
}

function extractUserText(data) {
  if (typeof data.text === 'string' && data.text.trim()) return data.text;
  const content = data.content;
  if (Array.isArray(content)) {
    return content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n').trim();
  }
  return '';
}

function decompressAll(buf) {
  const starts = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) starts.push(i);
  }
  starts.push(buf.length);
  const parts = [];
  for (let k = 0; k < starts.length - 1; k++) {
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(starts[k], starts[k + 1]))); } catch { /* 跳过坏帧 */ }
  }
  return Buffer.concat(parts).toString('utf8');
}

function allSessionFiles() {
  const out = [];
  for (const dir of fs.readdirSync(ROOT)) {
    const p = path.join(ROOT, dir);
    if (!fs.statSync(p).isDirectory()) continue;
    for (const sub of fs.readdirSync(p)) {
      const f = path.join(p, sub, 'session.v4.jsonl.zstd');
      if (fs.existsSync(f)) out.push({ f, sessionId: sub, workspace: dir });
    }
  }
  return out;
}

const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();

const seen = new Map();
const rows = [];
let fileCount = 0;
let msgCount = 0;
let injectedCount = 0;

for (const { f, sessionId, workspace } of allSessionFiles()) {
  fileCount++;
  let text;
  try { text = decompressAll(fs.readFileSync(f)); } catch { continue; }
  const mtime = fs.statSync(f).mtimeMs;
  let lineNo = 0;
  for (const line of text.split('\n')) {
    lineNo++;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const type = rec.type || (rec.event && rec.event.type);
    if (type !== 'user/message') continue;
    const data = rec.data || (rec.event && rec.event.data) || {};
    const body = extractUserText(data);
    if (!body) continue;
    const kind = (data.source && data.source.kind) || 'user';
    if (isInjected(body, kind)) { injectedCount++; continue; }
    msgCount++;
    const key = norm(body);
    const rec2 = { session: sessionId, workspace, time: (data.time || rec.time || data.ts || rec.ts) || null, text: body };
    if (!seen.has(key)) {
      seen.set(key, rec2);
      rows.push(rec2);
    }
  }
}

rows.sort((a, b) => (a.time || 0) - (b.time || 0));

fs.writeFileSync(OUT_JSON, JSON.stringify(rows, null, 2), 'utf8');
const txt = rows.map((r, i) => `${String(i).padStart(3, '0')} | ${String(r.text.length).padStart(4, '0')} | ${r.session.slice(0, 8)} | ${r.text.slice(0, 160)}`).join('\n');
fs.writeFileSync(OUT_TXT, txt, 'utf8');

console.log('会话文件数:', fileCount);
console.log('用户消息总数（含重复）:', msgCount);
console.log('系统注入过滤:', injectedCount);
console.log('去重后用户消息:', rows.length);
console.log('总字数:', rows.reduce((n, r) => n + r.text.length, 0));
console.log('输出:', OUT_JSON.pathname);
