/**
 * 用真实会话回放验证 v0.3：只喂 turn/start、assistant/message 与系统注入，
 * 不喂用户原话（避免往 decisions.jsonl 写一堆历史记录）。
 * 运行： ELECTRON_RUN_AS_NODE=1 "/d/dsh/DeepSeek Harness.exe" test/replay-session.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import http from 'node:http';

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

const base = 'file:///C:/Users/minut/OneDrive/%E6%96%87%E6%A1%A3/deepseek-harness/default-workspace/work/dsh-tier-brain/lib/index.js';
const mod = await import(base);
let route = null;
let onEvent = null;
const ctx = {
  effect: (fn) => { try { fn(); } catch { /* 忽略 */ } },
  on: (evt, fn) => { if (evt === 'session/event') onEvent = fn; return () => {}; },
  commands: { register: () => () => {} },
  webServer: { register: (r) => { route = r; return () => {}; } },
};
mod.apply(ctx);

const file = newestSession();
const lines = decompressAll(fs.readFileSync(file)).split('\n').filter(Boolean);
const session = { id: 'replay' };
let replayed = 0;
let injected = 0;
let usageSeen = 0;

for (const line of lines) {
  let rec;
  try { rec = JSON.parse(line); } catch { continue; }
  const type = rec.type || (rec.event && rec.event.type);
  const data = rec.data || (rec.event && rec.event.data) || {};
  if (type === 'turn/start') { onEvent(session, { type, data }); replayed += 1; continue; }
  if (type === 'assistant/message') {
    if (data.usage) usageSeen += 1;
    onEvent(session, { type, data });
    continue;
  }
  if (type === 'user/message') {
    const kind = (data.source && data.source.kind) || 'user';
    if (kind === 'user') continue; // 不把历史原话写进日志
    injected += 1;
    onEvent(session, { type, data });
  }
}

const server = http.createServer((req, res) => route.handler(req, res));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const get = (p) => fetch('http://127.0.0.1:' + port + p).then((r) => r.json());
const post = (body) => fetch('http://127.0.0.1:' + port + '/dsh-tier-brain/preview', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then((r) => r.json());

const st = await get('/dsh-tier-brain/state?session=replay');
const shortQ = await post({ text: '这个文件是干什么用的', sessionId: 'replay' });

console.log('会话文件:', path.basename(path.dirname(file)));
console.log(`回放：turn/start ${replayed} 条、assistant/message ${usageSeen} 条带 usage、注入消息 ${injected} 条`);
console.log('上下文规模:', st.contextTokens, 'token');
console.log('缓存命中率:', st.cacheHitRate);
console.log('记忆注入:', st.memoryChars, '字 ≈', Math.round(st.memoryChars / 1.8), 'token');
console.log('同一句短问的推荐:', JSON.stringify(shortQ.advice));

server.close();
