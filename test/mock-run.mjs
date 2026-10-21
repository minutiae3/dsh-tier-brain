import { apply } from '../lib/index.js';

const commands = [];
const handlers = [];

const ctx = {
  effect: (fn) => {
    const dispose = fn();
    return typeof dispose === 'function' ? dispose : () => {};
  },
  on: (type, fn) => {
    handlers.push([type, fn]);
    return () => {};
  },
  commands: {
    register: (cmd) => {
      commands.push(cmd);
      return () => {};
    },
  },
  webServer: {
    register: () => () => {},
  },
};

apply(ctx);

const session = { header: { id: 'test-session' } };
function emit(type, data) {
  for (const [name, fn] of handlers) {
    if (name === 'session/event') fn(session, { type, data });
  }
}

emit('turn/start', {});
emit('user/message', {
  text: '帮我重构这个模块的架构，设计一个并发方案，然后写一个脚本验证，最后跑一下测试',
});

const tier = commands.find((c) => c.name === 'tier');
if (!tier) throw new Error('未注册 /tier 命令');

console.log('=== 中等偏难任务 ===');
console.log(tier.handler({ rawInput: '' }).text);

console.log('\n=== 简单任务 ===');
console.log(tier.handler({ rawInput: '你好' }).text);

console.log('\n=== 强任务 ===');
console.log(
  tier.handler({
    rawInput:
      '```ts\nimport { x } from "y";\n```\n请重构整个架构，迁移数据库，排查并发问题，然后设计回滚方案，最后写批量脚本验证',
  }).text,
);

console.log('\n=== 已注册命令 ===');
console.log(commands.map((c) => '/' + c.name).join(', '));
