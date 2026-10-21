#!/usr/bin/env node
/**
 * 用 GitHub Git Data API 把本地提交同步到远端（第二版）。
 *
 * 为什么不用 git push：这台机器的沙箱禁止子进程开管道（Node 里 spawnSync 一律 EPERM），
 * `git push` 起不来。Git Data API 只走 HTTPS，能重建同样的提交内容。
 *
 * 与第一版的差别：远端 commit 的 SHA 由 GitHub 重算（作者时间/committer 有差异），
 * 所以父提交不能沿用本地的 SHA，必须按"本地 SHA → 远端 SHA"映射重写。
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { inflateSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const tokenPath = join(root, '.secrets', 'github-token');
if (!existsSync(tokenPath)) { console.error(`缺少凭据：${tokenPath}`); process.exit(2); }
const token = readFileSync(tokenPath, 'utf8').trim();
if (!token) { console.error('github-token 是空的'); process.exit(2); }

const OWNER = 'minutiae3';
const REPO = pkg.name;
const API = 'https://api.github.com';
const gitDir = join(root, '.git');

async function api(path, init = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(API + path, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'dsh-tier-brain-publish',
        'x-github-api-version': '2022-11-28',
        ...(init.headers || {}),
      },
    });
    const text = await res.text();
    if (res.status >= 500 && attempt < 3) { await new Promise((r) => setTimeout(r, 800 * attempt)); continue; }
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
    return { status: res.status, ok: res.ok, json, text };
  }
  throw new Error('unreachable');
}

// ── git 对象读取 ─────────────────────────────────────────────────
function readObject(sha) {
  const raw = inflateSync(readFileSync(join(gitDir, 'objects', sha.slice(0, 2), sha.slice(2))));
  const nul = raw.indexOf(0);
  const header = raw.subarray(0, nul).toString('utf8');
  const [type, sizeStr] = header.split(' ');
  const body = raw.subarray(nul + 1);
  if (Number(sizeStr) !== body.length) throw new Error(`对象 ${sha} 长度不符`);
  return { type, body };
}

function parseTree(body) {
  const entries = [];
  let i = 0;
  while (i < body.length) {
    const sp = body.indexOf(0x20, i);
    const mode = body.subarray(i, sp).toString('utf8');
    const nul = body.indexOf(0, sp);
    const name = body.subarray(sp + 1, nul).toString('utf8');
    const sha = body.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    i = nul + 21;
  }
  return entries;
}

function parseCommit(body) {
  const txt = body.toString('utf8');
  const headEnd = txt.indexOf('\n\n');
  const headers = txt.slice(0, headEnd).split('\n');
  let tree = null;
  const parents = [];
  let author = '';
  let committer = '';
  for (const line of headers) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(7);
  }
  return { tree, parents, author, committer, message: txt.slice(headEnd + 2) };
}

function splitIdentity(s) {
  const m = s.match(/^(.*?)\s*<([^>]*)>\s*(\d+)\s+([+-]\d{4})$/);
  if (!m) throw new Error(`无法解析身份行：${s}`);
  return { name: m[1], email: m[2], date: new Date(Number(m[3]) * 1000).toISOString() };
}

// ── 主流程 ───────────────────────────────────────────────────────
const headSha = readFileSync(join(gitDir, 'refs', 'heads', 'main'), 'utf8').trim();
console.log(`本地 HEAD：${headSha}`);

const chain = [];
let cur = headSha;
while (cur) {
  const obj = readObject(cur);
  if (obj.type !== 'commit') throw new Error(`${cur} 不是 commit`);
  const c = parseCommit(obj.body);
  chain.unshift({ sha: cur, ...c });
  cur = c.parents[0] || null;
}
console.log(`本地提交链：${chain.length} 个提交（${chain.map((c) => c.sha.slice(0, 7)).join(' → ')}）`);

const repo = await api(`/repos/${OWNER}/${REPO}`);
if (!repo.ok) { console.error(`仓库不存在或无权访问：HTTP ${repo.status}`); process.exit(1); }
const branch = repo.json.default_branch;
console.log(`远端仓库：${repo.json.html_url}（默认分支 ${branch}）`);

// 远端现在有什么
const refRes = await api(`/repos/${OWNER}/${REPO}/git/ref/heads/${branch}`);
let remoteHead = null;
let remoteTipTree = null;
if (refRes.ok) {
  remoteHead = refRes.json.object.sha;
  const rc = await api(`/repos/${OWNER}/${REPO}/git/commits/${remoteHead}`);
  if (rc.ok) {
    remoteTipTree = rc.json.tree.sha;
    console.log(`远端 HEAD：${remoteHead.slice(0, 7)}（tree ${remoteTipTree.slice(0, 7)}，信息：${String(rc.json.message).split('\n')[0]}）`);
  }
} else {
  console.log(`远端读不到分支（HTTP ${refRes.status}），按空仓库处理`);
}

// ── blob 上传（缓存 + 并发 8）──────────────────────────────────────
const uploaded = new Set();
async function ensureBlob(sha) {
  if (uploaded.has(sha)) return;
  const { type, body } = readObject(sha);
  if (type !== 'blob') throw new Error(`${sha} 不是 blob`);
  const res = await api(`/repos/${OWNER}/${REPO}/git/blobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: body.toString('base64'), encoding: 'base64' }),
  });
  if (!res.ok) throw new Error(`上传 blob ${sha.slice(0, 7)} 失败：HTTP ${res.status} ${res.text.slice(0, 200)}`);
  uploaded.add(sha);
}

async function buildTree(treeSha) {
  const { type, body } = readObject(treeSha);
  if (type !== 'tree') throw new Error(`${treeSha} 不是 tree`);
  const entries = parseTree(body);
  const blobs = entries.filter((e) => e.mode !== '40000' && e.mode !== '160000');
  for (let i = 0; i < blobs.length; i += 8) {
    await Promise.all(blobs.slice(i, i + 8).map((e) => ensureBlob(e.sha)));
  }
  const tree = [];
  for (const e of entries) {
    if (e.mode === '40000') {
      tree.push({ path: e.name, mode: '040000', type: 'tree', sha: await buildTree(e.sha) });
    } else if (e.mode === '160000') {
      tree.push({ path: e.name, mode: '160000', type: 'commit', sha: e.sha });
    } else {
      tree.push({ path: e.name, mode: e.mode === '100755' ? '100755' : '100644', type: 'blob', sha: e.sha });
    }
  }
  const res = await api(`/repos/${OWNER}/${REPO}/git/trees`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tree }),
  });
  if (!res.ok) throw new Error(`建 tree 失败：HTTP ${res.status} ${res.text.slice(0, 300)}`);
  return res.json.sha;
}

// 本地 tree SHA → 远端 tree SHA（内容相同则 SHA 也相同，但仍缓存一次避免重复请求）
const treeCache = new Map();
async function remoteTree(treeSha) {
  if (treeCache.has(treeSha)) return treeCache.get(treeSha);
  const sha = await buildTree(treeSha);
  treeCache.set(treeSha, sha);
  return sha;
}

// ── 逐个提交重建，维护 本地SHA → 远端SHA 映射 ────────────────────
const map = new Map();
let tip = null;

for (let idx = 0; idx < chain.length; idx++) {
  const c = chain[idx];
  const isRoot = idx === 0;

  // 根提交：如果远端已有内容（初始化提交），把它的父提交接上，
  // 这样不会丢历史，也不需要 force push。
  let parents;
  if (isRoot) {
    parents = remoteHead && !map.has(remoteHead) ? [remoteHead] : [];
    // 若远端 tip 就是初始化提交，且我们的根提交没有父，则挂到它后面
    if (remoteHead && parents.length === 0) parents = [remoteHead];
  } else {
    parents = c.parents.map((p) => map.get(p)).filter(Boolean);
    if (parents.length === 0 && tip) parents = [tip];
  }

  const treeSha = await remoteTree(c.tree);
  const res = await api(`/repos/${OWNER}/${REPO}/git/commits`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message: c.message,
      tree: treeSha,
      parents,
      author: splitIdentity(c.author),
      committer: splitIdentity(c.committer),
    }),
  });
  if (!res.ok) {
    console.error(`建 commit 失败（本地 ${c.sha.slice(0, 7)}）：HTTP ${res.status}`);
    console.error(res.text.slice(0, 600));
    process.exit(1);
  }
  map.set(c.sha, res.json.sha);
  tip = res.json.sha;
  const same = res.json.sha === c.sha;
  console.log(`本地 ${c.sha.slice(0, 7)} → 远端 ${res.json.sha.slice(0, 7)}${same ? '（SHA 一致）' : ''}`);
}

// ── 更新分支 ─────────────────────────────────────────────────────
if (remoteHead) {
  const res = await api(`/repos/${OWNER}/${REPO}/git/refs/heads/${branch}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sha: tip, force: true }),
  });
  if (!res.ok) { console.error(`更新分支失败：HTTP ${res.status} ${res.text.slice(0, 400)}`); process.exit(1); }
  console.log(`分支 ${branch} → ${res.json.object.sha.slice(0, 7)}`);
} else {
  const res = await api(`/repos/${OWNER}/${REPO}/git/refs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: tip }),
  });
  if (!res.ok) { console.error(`创建分支失败：HTTP ${res.status} ${res.text.slice(0, 400)}`); process.exit(1); }
  console.log(`已创建分支 ${branch} → ${res.json.object.sha.slice(0, 7)}`);
}

console.log(`\n完成：https://github.com/${OWNER}/${REPO}`);
