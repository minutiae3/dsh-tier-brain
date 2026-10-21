/**
 * v0.3 回归：上下文与记忆如何改变推荐。
 * 运行： ELECTRON_RUN_AS_NODE=1 "/d/dsh/DeepSeek Harness.exe" test/check-v03.mjs
 */
import { score, present } from '../lib/scoring.js';

let failed = 0;
function check(label, actual, expect) {
  const ok = JSON.stringify(actual) === JSON.stringify(expect);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}`);
  console.log(`     期望 ${JSON.stringify(expect)} / 实际 ${JSON.stringify(actual)}`);
  if (!ok) failed += 1;
}

// 1) 新对话（无上下文）：寒暄仍然是最省的档
const fresh = score('你好', { turn: 1, contextTokens: 0 });
check('新对话寒暄 → T1 + off', [fresh.tier, fresh.effort], [1, 'off']);

// 2) 长会话里的一句短问：上下文已经 52K，不再推荐 off
const shortQ = '这个文件是干什么用的';
const longCtx = score(shortQ, { turn: 5, contextTokens: 52000 });
check('长上下文短问 → 升到 T2（不用 off）', [longCtx.tier, longCtx.effort], [2, 'high']);
check('长上下文短问带信号', longCtx.signals.includes('长上下文 → 不再用省档'), true);

// 2b) 寒暄是例外：说"谢谢"不该因为上下文长就被抬到平档
const thanks = score('谢谢', { turn: 5, contextTokens: 52000 });
check('长上下文里的寒暄仍是 T1', thanks.tier, 1);

// 3) 上下文还不够长（40K）时，不触发升档
const midCtx = score(shortQ, { turn: 5, contextTokens: 40000 });
check('40K 上下文短问 → 仍是 T1', midCtx.tier, 1);

// 4) 轮次不够（3 轮）时，即使上下文长也不升档
const early = score(shortQ, { turn: 3, contextTokens: 60000 });
check('3 轮 + 60K → 仍是 T1', early.tier, 1);

// 5) 上下文规模本身抬分：同一句中等问题，96K 比 0 分更高
const small = score('查一下这个函数在哪定义', { turn: 1, contextTokens: 0 });
const big = score('查一下这个函数在哪定义', { turn: 1, contextTokens: 100000 });
check('超长上下文加分', big.score > small.score, true);

// 6) present 暴露 longContext 给客户端
const advice = present(longCtx);
check('present.longContext', advice.longContext, true);
check('present 保留档位', [advice.tier, advice.model, advice.effort], [2, 'deepseek-flash', 'high']);
const freshAdvice = present(fresh);
check('新对话 longContext=false', freshAdvice.longContext, false);

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
