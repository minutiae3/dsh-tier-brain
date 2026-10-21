/**
 * 把 decisions.jsonl 变成一张"人肉对照表"（CSV，Excel 能直接开）。
 *
 * 用法：
 *   & "D:\dsh\DeepSeek Harness.exe" test\report.mjs
 *
 * 产出：test/review.csv
 *   - 插件给了什么：档位 / 模型 / 推理等级 / 分类 / 分数
 *   - 留给你填的：实际该用哪档、这次够不够用（1=够用，0=不够）
 *
 * 填完把"实际档位"和"插件档位"两列一比，就是你这批提问的一致率；
 * "够不够用"那列才是真问题——档位选对了也可能因为别的原因不好用。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const LOG = join(DSH_HOME, 'tier-brain', 'decisions.jsonl');
const OUT = join(import.meta.dirname, 'review.csv');

const INJECTED = [
  'Current runtime context.',
  'Time sampled while preparing',
  '<hindsight_knowledge>',
  '<hindsight_knowledge_refresh>',
  '[Compressed conversation section]',
  'Current DSH file policy',
];

function isNoise(text) {
  const head = (text || '').slice(0, 96);
  if (INJECTED.some((p) => head.startsWith(p))) return true;
  return /This repository has a Hindsight memory/.test((text || '').slice(0, 400));
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
}

if (!existsSync(LOG)) {
  console.error('还没有日志：' + LOG + '\n先用几句真实提问，日志会自动生成。');
  process.exit(1);
}

const rows = [];
for (const line of readFileSync(LOG, 'utf8').split('\n')) {
  const t = line.trim();
  if (!t) continue;
  let r;
  try { r = JSON.parse(t); } catch { continue; }
  if (isNoise(r.text)) continue;
  rows.push(r);
}

const header = ['时间', '原话', '插件档位', '插件模型', '插件等级', '分类', '分数', '实际该用哪档(1/2/3)', '够不够用(1/0)', '备注'];
const lines = [header.map(csvCell).join(',')];
for (const r of rows) {
  lines.push([
    r.ts || '',
    (r.text || '').replace(/\s+/g, ' ').slice(0, 200),
    r.tier,
    r.model,
    r.effort,
    r.category,
    r.score,
    '',
    '',
    '',
  ].map(csvCell).join(','));
}

// 带 BOM，Excel 打开中文不乱码
writeFileSync(OUT, '\uFEFF' + lines.join('\r\n') + '\r\n', 'utf8');
console.log('已写出 ' + OUT + '（' + rows.length + ' 条，噪音已过滤）');
