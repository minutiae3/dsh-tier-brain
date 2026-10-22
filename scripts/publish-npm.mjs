#!/usr/bin/env node
/**
 * 用 npm registry HTTP API 发布当前包。
 *
 * 为什么不用 `npm publish`：这台机器没有装 Node/npm，只有 DSH 自带的 Electron Node；
 * registry 的发布协议本身就是一次 PUT，直接发即可，不依赖 npm CLI。
 *
 * 需要：../.secrets/npm-token（一行 Automation token）
 * 用法：ELECTRON_RUN_AS_NODE=1 "/d/dsh/DeepSeek Harness.exe" scripts/publish-npm.mjs
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const tgzName = `${pkg.name}-${pkg.version}.tgz`;
const tgzPath = join(root, tgzName);

let token;
try {
  token = readFileSync(join(root, '.secrets', 'npm-token'), 'utf8').trim();
} catch {
  console.error(`缺少凭据：${join(root, '.secrets', 'npm-token')}`);
  process.exit(2);
}
if (!token) {
  console.error('npm-token 是空的');
  process.exit(2);
}

const buf = readFileSync(tgzPath);
const shasum = createHash('sha1').update(buf).digest('hex');
const integrity = 'sha512-' + createHash('sha512').update(buf).digest('base64');

const versionMeta = {
  ...pkg,
  _id: `${pkg.name}@${pkg.version}`,
  dist: {
    shasum,
    integrity,
    tarball: `https://registry.npmjs.org/${pkg.name}/-/${tgzName}`,
  },
};

// readme 让 npm 页面直接显示 README（不发的话包页面是空的）
let readme = '';
try {
  readme = readFileSync(join(root, 'README.md'), 'utf8');
} catch {
  /* 没有 README 就不带 */
}

const body = {
  // 注意：npm 要求 _id 用 URL 编码后的包名（作用域包必须是 %40scope%2Fname），
  // 否则会返回 400 "Invalid package name"。这里包名无特殊字符仍按要求编码。
  _id: encodeURIComponent(pkg.name),
  name: pkg.name,
  description: pkg.description,
  'dist-tags': { latest: pkg.version },
  versions: { [pkg.version]: versionMeta },
  readme,
  access: 'public',
  _attachments: {
    [tgzName]: {
      content_type: 'application/octet-stream',
      data: buf.toString('base64'),
      length: buf.length,
    },
  },
};

console.log(`发布 ${pkg.name}@${pkg.version}（${buf.length} 字节）…`);
const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}`, {
  method: 'PUT',
  headers: {
    // npm registry 同时接受 Bearer 与基本认证；Automation token 用 Bearer 最简。
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    // npm 发布要求带 npm-command，部分镜像/网关会据此判断来源
    'npm-command': 'publish',
    'user-agent': 'dsh-tier-brain-publish/0.1.0',
  },
  body: JSON.stringify(body),
});

const text = await res.text();
if (res.ok) {
  console.log(`OK ${res.status}：https://www.npmjs.com/package/${pkg.name}`);
} else {
  console.error(`失败 ${res.status}`);
  console.error(text.slice(0, 1200));
  process.exit(1);
}
