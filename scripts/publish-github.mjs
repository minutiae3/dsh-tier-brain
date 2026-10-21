#!/usr/bin/env node
/**
 * 用 GitHub REST API 创建仓库并推送本地提交。
 *
 * 为什么不用 gh CLI：这台机器没有装 gh，也没有全局 git 凭据；
 * 直接用 REST API 建仓库，再用 http.extraheader 临时注入 token 做一次 push
 * （token 只存在于这条命令的环境变量里，不落在 .git/config）。
 *
 * 需要：.secrets/github-token（一行 classic PAT，含 repo 权限）
 * 用法：ELECTRON_RUN_AS_NODE=1 "/d/dsh/DeepSeek Harness.exe" scripts/publish-github.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const tokenPath = join(root, '.secrets', 'github-token');
if (!existsSync(tokenPath)) {
  console.error(`缺少凭据：${tokenPath}`);
  process.exit(2);
}
const token = readFileSync(tokenPath, 'utf8').trim();
if (!token) {
  console.error('github-token 是空的');
  process.exit(2);
}

const OWNER = 'minutiae3';
const REPO = pkg.name;
const API = 'https://api.github.com';

const headers = {
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'dsh-tier-brain-publish',
  'x-github-api-version': '2022-11-28',
};

async function api(path, init = {}) {
  const res = await fetch(API + path, { ...init, headers: { ...headers, ...(init.headers || {}) } });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  return { status: res.status, ok: res.ok, json, text };
}

// ── 0. 校验 token 与身份 ───────────────────────────────────────────
const me = await api('/user');
if (!me.ok) {
  console.error(`token 无效：HTTP ${me.status} ${me.text.slice(0, 300)}`);
  process.exit(1);
}
const login = me.json.login;
const scopes = (me.json && me.json.plan) ? undefined : undefined;
console.log(`身份：${login}（仓库将建在 ${OWNER} 下）`);
if (login.toLowerCase() !== OWNER.toLowerCase()) {
  console.warn(`警告：token 属于 ${login}，但目标 owner 是 ${OWNER}。若不是同一账号会 403。`);
}

// ── 1. 仓库是否已存在 ─────────────────────────────────────────────
const existing = await api(`/repos/${OWNER}/${REPO}`);
if (existing.ok) {
  console.log(`仓库已存在：${existing.json.html_url}（跳过创建）`);
} else if (existing.status === 404) {
  const created = await api('/user/repos', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: REPO,
      description: pkg.description,
      homepage: '',
      private: false,
      has_issues: true,
      has_wiki: false,
      has_projects: false,
      auto_init: false,
    }),
  });
  if (!created.ok) {
    console.error(`创建仓库失败：HTTP ${created.status}`);
    console.error(created.text.slice(0, 800));
    process.exit(1);
  }
  console.log(`已创建：${created.json.html_url}`);
} else {
  console.error(`查询仓库失败：HTTP ${existing.status} ${existing.text.slice(0, 300)}`);
  process.exit(1);
}

// ── 2. 配 remote 并推送（token 只走命令行环境，不落 config）────────
const remoteUrl = `https://github.com/${OWNER}/${REPO}.git`;
const git = (args, extraEnv = {}) =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv },
  });

try {
  const remotes = git(['remote']).split('\n').map((s) => s.trim()).filter(Boolean);
  if (!remotes.includes('origin')) {
    git(['remote', 'add', 'origin', remoteUrl]);
    console.log(`已添加 remote origin → ${remoteUrl}`);
  } else {
    const cur = git(['remote', 'get-url', 'origin']).trim();
    if (cur !== remoteUrl) {
      git(['remote', 'set-url', 'origin', remoteUrl]);
      console.log(`已更新 remote origin → ${remoteUrl}`);
    }
  }

  const branch = git(['branch', '--show-current']).trim() || 'main';
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  const out = git(
    [
      '-c', `http.extraheader=AUTHORIZATION: basic ${basic}`,
      'push', '-u', 'origin', branch,
    ],
    {},
  );
  console.log(out.trim());
  console.log(`\n推送完成：https://github.com/${OWNER}/${REPO}`);
} catch (e) {
  const stderr = e && e.stderr ? String(e.stderr) : '';
  console.error('push 失败：');
  console.error(stderr.replace(token, '***').slice(0, 1200));
  process.exit(1);
}
