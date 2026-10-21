/**
 * v0.3 事件链回归：会话事件 → 上下文统计 → 推荐结果。
 * 运行： ELECTRON_RUN_AS_NODE=1 "/d/dsh/DeepSeek Harness.exe" test/check-events.mjs
 * 注意：会向 ~/.dsh/tier-brain/decisions.jsonl 写测试记录。
 */
import http from 'node:http';

const base = 'file:///C:/Users/minut/OneDrive/%E6%96%87%E6%A1%A3/deepseek-harness/default-workspace/work/dsh-tier-brain/lib/index.js';
const mod = await import(base);

let route = null;
let onEvent = null;
const ctx = {
  effect: (fn) => { try { fn(); } catch { /* 忽略注册异常 */ } },
  on: (evt, fn) => { if (evt === 'session/event') onEvent = fn; return () => {}; },
  commands: { register: () => () => {} },
  webServer: { register: (r) => { route = r; return () => {}; } },
};
mod.apply(ctx);
if (!route || !onEvent) { console.log('FAIL: handlers not registered'); process.exit(1); }

const server = http.createServer((req, res) => route.handler(req, res));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const get = (p) => fetch('http://127.0.0.1:' + port + p).then((r) => r.json());
const post = (body) => fetch('http://127.0.0.1:' + port + '/dsh-tier-brain/preview', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then((r) => r.json());

let failed = 0;
const check = (label, actual, expect) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expect);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}`);
  console.log(`     期望 ${JSON.stringify(expect)} / 实际 ${JSON.stringify(actual)}`);
  if (!ok) failed += 1;
};

const session = { id: 's-ev' };
const send = (evt) => onEvent(session, evt);
const userMsg = (text, kind = 'user') => send({ type: 'user/message', data: { source: { kind }, content: [{ type: 'text', text }] } });
const usage = (u) => send({ type: 'assistant/message', data: { usage: u } });

// 4 轮，每轮读入 53K 上下文（3K 未命中 + 50K 缓存命中）
for (let i = 0; i < 4; i += 1) {
  send({ type: 'turn/start' });
  userMsg(`第 ${i} 个问题：帮我看下这个文件里的逻辑对不对`);
  usage({ inputTokens: 3000, outputTokens: 500, cacheReadTokens: 50000, cacheWriteTokens: 0, totalTokens: 53500 });
}

const st = await get('/dsh-tier-brain/state?session=s-ev');
check('上下文规模 = input + cacheRead + cacheWrite', st.contextTokens, 53000);
check('缓存命中率 = cacheRead / 读入总量', st.cacheHitRate, 0.943);

// 一条系统注入：只累计记忆字数，不参与打分
userMsg('Current runtime context. ' + 'x'.repeat(3600), 'system');
const st2 = await get('/dsh-tier-brain/state?session=s-ev');
check('系统注入累计 memoryChars', st2.memoryChars, 3625);
check('系统注入不改变上下文规模', st2.contextTokens, 53000);

// 长上下文里的短问：不再推荐 off
const advice = await post({ text: '这个文件是干什么用的', sessionId: 's-ev' });
check('长上下文短问 → T2', [advice.advice.tier, advice.advice.effort], [2, 'high']);
check('长上下文标记', advice.advice.longContext, true);

server.close();
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
