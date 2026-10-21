// v0.2 自检：四档映射（T1=off、极难任务=max）与峰谷判断
import { score, present, peakOf } from '../lib/scoring.js';

const cases = [
  ['从零设计一个插件系统的整体架构，要兼顾长期维护、兼容性、边界情况和回滚，并给出权衡', 'ARCHITECTURE 高分 → 期望 T3 + max'],
  ['帮我看看有没有安全风险，做一次完整的安全审计和代码评审，把所有漏洞和边界情况列出来', 'REVIEW 高分 → 期望 T3 + max'],
  ['你好', '寒暄 → 期望 T1 + off'],
  ['缓存命中是什么意思', 'fact → 期望 T1 + off'],
  ['帮我把插件里的冗余代码清理一下，顺手补上回归测试', 'REFACTOR/中 → 期望 T2 或 T3'],
];

for (const [text, note] of cases) {
  const r = score(text);
  console.log(`${note}\n  => tier=${r.tier} ${r.model} + ${r.effort} score=${r.score} cat=${r.category}`);
}

// 峰谷：北京时间工作日 9–12、14–18 为高峰；周末与午休为空闲
const pts = [
  ['2026-10-21T10:00:00+08:00', true],  // 周三上午
  ['2026-10-21T12:30:00+08:00', false], // 周三午休
  ['2026-10-21T15:00:00+08:00', true],  // 周三下午
  ['2026-10-21T18:30:00+08:00', false], // 周三晚间
  ['2026-10-24T10:00:00+08:00', false], // 周六
  ['2026-10-26T08:59:00+08:00', false], // 周一 9 点前
];
let bad = 0;
for (const [iso, want] of pts) {
  const got = peakOf(Date.parse(iso));
  if (got !== want) bad++;
  console.log(`peak(${iso}) = ${got}  期望 ${want}  ${got === want ? 'OK' : 'MISMATCH'}`);
}

console.log('present 示例:', JSON.stringify(present(score('你好'))));
if (bad) {
  console.error(`峰谷判断有 ${bad} 处不符`);
  process.exit(1);
}
