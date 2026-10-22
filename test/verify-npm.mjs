const url = 'https://registry.npmjs.org/dsh-tier-brain';
const res = await fetch(url);
console.log('HTTP', res.status);
if (!res.ok) {
  console.log(await res.text());
  process.exit(1);
}
const j = await res.json();
const latest = j['dist-tags'].latest;
console.log('name       :', j.name);
console.log('latest     :', latest);
console.log('versions   :', Object.keys(j.versions).join(', '));
console.log('description:', j.versions[latest].description);
console.log('tarball    :', j.versions[latest].dist.tarball);
console.log('shasum     :', j.versions[latest].dist.shasum);
console.log('integrity  :', String(j.versions[latest].dist.integrity).slice(0, 40) + '…');
console.log('published  :', j.time[latest]);
console.log('maintainers:', JSON.stringify(j.maintainers));
