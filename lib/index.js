/**
 * dsh-tier-brain 宿主半侧
 *
 * 职责（v0.1.0）：
 *   1. 唯一的评分入口：规则全部在 lib/scoring.js，客户端只来问，不自己算；
 *   2. POST /dsh-tier-brain/preview：发送前预览，客户端输入框上方那张卡片就靠它；
 *   3. 会话事件：记轮次、记工具失败，给下一次预览提供上下文；
 *   4. /tier 命令：需要时在聊天里看完整依据（卡片上不显示理由）；
 *   5. 每次真实发送写一条 decisions.jsonl，用于以后校准。
 *
 * 硬约束：只建议，绝不修改请求里的 model / effort，也不调用模型。
 */

import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { score, present, TIERS, peakOf } from './scoring.js';

export const name = 'dsh-tier-brain';
export const inject = ['webServer', 'commands'];

/** 唯一版本号来源，与 package.json 保持一致。 */
export const VERSION = '0.1.0';

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const DATA_DIR = join(DSH_HOME, 'tier-brain');
const LOG_FILE = join(DATA_DIR, 'decisions.jsonl');
const TASK_IDLE_MS = 30 * 60 * 1000;

/** sessionId -> { turn, failures, lastText, lastAt, lastAdvice } */
const sessions = new Map();
let latestSessionId = null;

function nowIso() {
  return new Date().toISOString();
}

function ensureDataDir() {
  try { mkdirSync(DATA_DIR, { recursive: true }); } catch { /* 落盘失败不影响主流程 */ }
}

function appendLog(record) {
  ensureDataDir();
  try { appendFileSync(LOG_FILE, JSON.stringify(record) + '\n', 'utf8'); } catch { /* 同上 */ }
}

function getState(sessionId) {
  let s = sessions.get(sessionId);
  if (!s) {
    // contextTokens：上一轮真实读入的上下文规模（来自 assistant/message 的 usage）
    // memoryChars：本会话里系统注入（记忆、压缩摘要、运行时上下文）的累计字数
    s = { turn: 0, failures: 0, lastText: '', lastAt: 0, lastAdvice: null, contextTokens: 0, cacheHitRate: null, memoryChars: 0 };
    sessions.set(sessionId, s);
  }
  if (s.lastAt && Date.now() - s.lastAt > TASK_IDLE_MS) {
    s.turn = 0;
    s.failures = 0;
  }
  return s;
}

/** 客户端每次输入都来问，所以这里必须"只看文本 + 轻量上下文"，不做重活。 */
function preview(text, sessionId) {
  const sid = typeof sessionId === 'string' && sessionId ? sessionId : latestSessionId || 'default';
  const s = getState(sid);
  const result = score(text, {
    turn: s.turn,
    failures: s.failures,
    prevTier: s.lastAdvice ? s.lastAdvice.tier : 0,
    // 上下文与记忆：上一轮真实 usage + 注入字数估算，让"长会话里的省档"不再被推荐
    contextTokens: s.contextTokens,
    memoryTokens: Math.round(s.memoryChars / 1.8),
  });
  return { sessionId: sid, result };
}

function extractUserText(event) {
  const data = (event && event.data) || {};
  if (typeof data.text === 'string' && data.text.trim()) return data.text;
  const content = data.content;
  if (Array.isArray(content)) {
    const text = content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
    if (text.trim()) return text;
  }
  return '';
}

/**
 * DSH 会把运行时上下文、记忆提醒、时间戳这些"系统注入"也当成 user/message 事件发出来。
 * 它们不是用户打的字，既不该打分，也不该进日志——2026-10-21 实测：
 * 一条 7058 字的内存提醒被记成 DOC/40 分，纯属噪声。
 */
const INJECTED_PREFIXES = [
  'Current runtime context.',
  'Time sampled while preparing',
  '<hindsight_knowledge>',
  '<hindsight_knowledge_refresh>',
  '[Compressed conversation section]',
  'Current DSH file policy',
];

function isInjected(text, event) {
  const source = event && event.data && event.data.source;
  if (source && typeof source.kind === 'string' && source.kind !== 'user') return true;
  const head = text.slice(0, 96);
  if (INJECTED_PREFIXES.some((p) => head.startsWith(p))) return true;
  if (/This repository has a Hindsight memory/.test(text.slice(0, 400))) return true;
  return false;
}

function sessionIdOf(session) {
  if (!session || typeof session !== 'object') return 'default';
  if (session.header && typeof session.header.id === 'string') return session.header.id;
  if (typeof session.id === 'string') return session.id;
  return 'default';
}

function handleSessionEvent(session, event) {
  const type = event && event.type;
  if (!type) return;
  const sessionId = sessionIdOf(session);
  const s = getState(sessionId);

  if (type === 'turn/start') {
    s.turn += 1;
    return;
  }

  if (type === 'user/message') {
    const text = extractUserText(event);
    if (!text) return;
    if (isInjected(text, event)) {
      // 系统注入（记忆、压缩摘要、运行时上下文）本身也占上下文，
      // 虽然不该打分，但要累计下来，用来判断"这个会话的记忆有多重"。
      s.memoryChars += text.length;
      return;
    }
    const { result } = preview(text, sessionId);
    s.lastText = text;
    s.lastAt = Date.now();
    s.lastAdvice = result;
    latestSessionId = sessionId;
    appendLog({
      ts: nowIso(),
      sessionId,
      turn: s.turn,
      textLen: text.length,
      text: text.slice(0, 200),
      tier: result.tier,
      model: result.model,
      effort: result.effort,
      score: result.score,
      category: result.category,
      contextTokens: s.contextTokens,
      cacheHitRate: s.cacheHitRate,
      signals: result.signals,
      applied: false,
      v: VERSION,
    });
    return;
  }

  // 每轮真实读入的上下文规模：input + cacheRead + cacheWrite。
  // 这是判断"现在这个对话已经多重"的唯一可靠数据源——
  // 用户刚打的字只占其中百分之几，记忆与历史才是大头。
  if (type === 'assistant/message') {
    const usage = (event.data && event.data.usage) || null;
    if (!usage) return;
    const input = Number(usage.inputTokens) || 0;
    const cacheRead = Number(usage.cacheReadTokens) || 0;
    const cacheWrite = Number(usage.cacheWriteTokens) || 0;
    const readIn = input + cacheRead + cacheWrite;
    if (readIn > 0) {
      s.contextTokens = readIn;
      s.cacheHitRate = Number((cacheRead / readIn).toFixed(3));
    }
    return;
  }

  if (type === 'tool/result') {
    const data = (event && event.data) || {};
    const failed = Boolean(data.error) || data.ok === false || data.status === 'error' || data.isError === true;
    if (failed) s.failures += 1;
    return;
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { req.destroy(); resolve(''); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

function renderDashboard(result, signals, state) {
  const meta = TIERS[result.tier];
  const emoji = result.tier === 1 ? '🟢' : result.tier === 2 ? '🟡' : '🔴';
  const lines = [
    '🧠 难度评估',
    `档位：${emoji} ${meta.key} — ${result.model} + ${result.effort}`,
    `难度分：${result.score}/100（分类：${result.category}）`,
    `信号：${signals.length ? signals.join('；') : '无明显信号'}`,
    `置信度：${Math.round(result.confidence * 100)}%`,
  ];
  const ctxTokens = Number(result.contextTokens) || 0;
  if (ctxTokens > 0) {
    const k = (ctxTokens / 1000).toFixed(1);
    const rate = state && typeof state.cacheHitRate === 'number'
      ? `，其中缓存命中 ${Math.round(state.cacheHitRate * 100)}%`
      : '';
    lines.push(`上下文：上一轮读入约 ${k}K token${rate}。`);
  }
  if (state && state.memoryChars > 0) {
    lines.push(`记忆注入：本会话累计约 ${(state.memoryChars / 1000).toFixed(1)}K 字（估算 ${Math.round(state.memoryChars / 1.8 / 1000)}K token）。`);
  }
  if (ctxTokens >= 48000) {
    lines.push('提示：上下文已经很长，省档省不到输入成本，答错重来要再读一遍，所以这里不再推荐省档。');
  }
  if (peakOf()) {
    lines.push('时段：现在是高峰（工作日的 9–12 点、14–18 点），同档价格是谷时的两倍，能挪就错峰。');
  }
  return lines.join('\n');
}

export function apply(ctx) {
  ctx.effect(() => ctx.on('session/event', handleSessionEvent), 'dsh-tier-brain: session events');

  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'tier',
        description: '查看当前输入会被判成哪一档（只建议，不改请求）',
        input: { hint: '[可选任务描述]' },
        handler: ({ rawInput }) => {
          const typed = typeof rawInput === 'string' ? rawInput.trim() : '';
          const text = typed || (latestSessionId ? getState(latestSessionId).lastText : '');
          if (!text) return { kind: 'error', text: '还没有可评估的消息。可以直接输入：/tier 帮我重构这个模块' };
          const { result } = preview(text, latestSessionId);
          const state = latestSessionId ? getState(latestSessionId) : null;
          return { kind: 'success', text: renderDashboard(result, result.signals, state) };
        },
      }),
    'dsh-tier-brain: /tier command',
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: '/dsh-tier-brain',
        handler: async (req, res) => {
          const url = new URL(req.url || '/', 'http://localhost');

          if (url.pathname === '/dsh-tier-brain/preview') {
            let text = url.searchParams.get('text') || '';
            let sessionId = url.searchParams.get('session') || '';
            if (req.method === 'POST') {
              try {
                const body = JSON.parse((await readBody(req)) || '{}');
                if (typeof body.text === 'string') text = body.text;
                if (typeof body.sessionId === 'string') sessionId = body.sessionId;
              } catch { /* 解析失败就用查询参数 */ }
            }
            if (!text.trim()) {
              sendJson(res, 200, { ok: true, empty: true, advice: null });
              return;
            }
            const { result, sessionId: sid } = preview(text, sessionId);
            sendJson(res, 200, { ok: true, sessionId: sid, advice: present(result), tier: present(result) });
            return;
          }

          if (url.pathname === '/dsh-tier-brain/state') {
            const sessionId = url.searchParams.get('session') || latestSessionId;
            const s = sessionId ? sessions.get(sessionId) : null;
            sendJson(res, 200, {
              ok: true,
              sessionId: sessionId || null,
              advice: s && s.lastAdvice ? present(s.lastAdvice) : null,
              contextTokens: s ? s.contextTokens : 0,
              cacheHitRate: s ? s.cacheHitRate : null,
              memoryChars: s ? s.memoryChars : 0,
            });
            return;
          }

          if (url.pathname === '/dsh-tier-brain/ping') {
            sendJson(res, 200, { ok: true, name, version: VERSION });
            return;
          }

          sendJson(res, 404, { ok: false, error: 'not found' });
        },
      }),
    'dsh-tier-brain: preview route',
  );
}
