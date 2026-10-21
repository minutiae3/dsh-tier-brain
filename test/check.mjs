import fs from 'node:fs';
import path from 'node:path';
const dir = path.resolve('C:/Users/minut/OneDrive/文档/deepseek-harness/default-workspace/work/dsh-tier-brain');
const idx = await import('file:///' + dir.replace(/\\/g, '/') + '/lib/index.js');
console.log('index exports:', Object.keys(idx).join(','));
const client = fs.readFileSync(path.join(dir, 'lib/client.js'), 'utf8');
try { new Function(client); console.log('client syntax: ok'); } catch (e) { console.log('client syntax FAIL', e.message); }
console.log('TIERS?', idx.name);