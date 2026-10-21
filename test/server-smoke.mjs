import http from 'node:http';
const base = 'file:///C:/Users/minut/OneDrive/%E6%96%87%E6%A1%A3/deepseek-harness/default-workspace/work/dsh-tier-brain/lib/index.js';
const mod = await import(base);
let route = null;
const ctx = {
  effect: (fn) => { try { fn(); } catch {} },
  on: () => () => {},
  commands: { register: () => () => {} },
  webServer: { register: (r) => { route = r; return () => {}; } },
};
mod.apply(ctx);
if (!route) { console.log('FAIL: no route registered'); process.exit(1); }
const server = http.createServer((req, res) => route.handler(req, res));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const post = (body) => fetch('http://127.0.0.1:' + port + '/dsh-tier-brain/preview', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then((r) => r.json());
const ping = await fetch('http://127.0.0.1:' + port + '/dsh-tier-brain/ping').then((r) => r.json());
console.log('ping:', JSON.stringify(ping));
console.log('short:', JSON.stringify(await post({ text: '你好', sessionId: 's1' })));
console.log('mid  :', JSON.stringify(await post({ text: '帮我把卡片挪到输入框下方，别挡住按钮', sessionId: 's1' })));
console.log('hard :', JSON.stringify(await post({ text: '重构评分模块，拆成纯函数并补测试', sessionId: 's1' })));
console.log('empty:', JSON.stringify(await post({ text: '   ', sessionId: 's1' })));
server.close();