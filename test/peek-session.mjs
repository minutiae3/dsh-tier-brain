// 读最近一个会话的原始事件，抽查 assistant/message 的 usage 结构，
// 并统计"用户消息 / 系统注入 / 助手输出"的字数占比。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = 'C:/Users/minut/.dsh/sessions';
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

function newestSession() {
  let best = null;
  for (const dir of fs.readdirSync(ROOT)) {
    const p = path.join(ROOT, dir);
    if (!fs.statSync(p).isDirectory()) continue;
    for (const sub of fs.readdirSync(p)) {
      const f = path.join(p, sub, 'session.v4.jsonl.zstd');
      if (!fs.existsSync(f)) continue;
      const t = fs.statSync(f).mtimeMs;
      if (!best || t > best.t) best = { f, t };
    }
  }
  return best && best.f;
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

const file = newestSession();
console.log('session:', file);
const text = decompressAll(fs.readFileSync(file));
const lines = text.split('\n').filter(Boolean);
console.log('lines:', lines.length);

let firstUsage = null;
const bySource = { user: 0, injected: 0 };
let assistantChars = 0;
let assistantCount = 0;

for (const line of lines) {
  let rec;
  try { rec = JSON.parse(line); } catch { continue; }
  const t = rec.type || (rec.event && rec.event.type);
  const d = rec.data || (rec.event && rec.event.data) || {};
  if (t === 'user/message') {
    const content = Array.isArray(d.content) ? d.content : [];
    const body = content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
    if (d.source && d.source.kind && d.source.kind !== 'user') bySource.injected += body.length;
    else bySource.user += body.length;
  } else if (t === 'assistant/message') {
    assistantCount++;
    const content = (d.message && d.message.content) || d.content || [];
    const body = content.filter((c) => c && (c.type === 'text' || c.type === 'reasoning')).map((c) => c.text || '').join('\n');
    assistantChars += body.length;
    if (!firstUsage && d.usage) firstUsage = d.usage;
  }
}

console.log('user chars:', bySource.user, ' injected chars:', bySource.injected, ' assistant chars:', assistantChars, ' assistant msgs:', assistantCount);
console.log('usage sample:', JSON.stringify(firstUsage));
