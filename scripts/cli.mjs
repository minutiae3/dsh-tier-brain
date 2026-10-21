#!/usr/bin/env node
/**
 * dsh-tier-brain 命令行：不用打开 DSH 也能给一句话打分。
 *
 * 用法：
 *   dsh-tier-brain "帮我重构一下这个模块"
 *   echo "帮我把这个插件的 README 重写一遍" | dsh-tier-brain
 *   dsh-tier-brain --json "把 D 盘那个服务删了"
 *
 * 退出码：0 正常；2 没有输入。
 */
import { readFileSync } from 'node:fs';
import { score, present } from '../lib/scoring.js';

const argv = process.argv.slice(2);
const wantJson = argv.includes('--json');
const rest = argv.filter((a) => a !== '--json');

let text = rest.join(' ').trim();
if (!text && !process.stdin.isTTY) {
  try {
    text = readFileSync(0, 'utf8').trim();
  } catch {
    /* stdin 不可读就当作没输入 */
  }
}
if (!text) {
  console.error('用法：dsh-tier-brain [--json] "<一句话>"');
  console.error('   或：echo "<一句话>" | dsh-tier-brain');
  process.exit(2);
}

const result = score(text, {});
const advice = present(result);

if (wantJson) {
  console.log(JSON.stringify({ text, advice, category: result.category, score: result.score }, null, 2));
} else {
  const peak = advice.peak ? '（当前为高峰时段）' : '';
  console.log(`建议：${advice.model} · ${advice.effort}  [${advice.key}档]${peak}`);
  console.log(`类型：${result.category}　评分：${result.score}`);
  if (result.signals.length) console.log(`依据：${result.signals.join('；')}`);
}
