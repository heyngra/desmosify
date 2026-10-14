import { readFile } from 'node:fs/promises';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node tests/profile-report.mjs <file.cpuprofile> [...]');
  process.exit(1);
}

for (const file of files) {
  const profile = JSON.parse(await readFile(file, 'utf8'));
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));

  const selfByKey = new Map();
  let total = 0;
  const deltas = profile.timeDeltas ?? [];
  profile.samples?.forEach((id, index) => {
    const delta = deltas[index] ?? 0;
    if (delta <= 0 || delta > 100000) return;
    const node = byId.get(id);
    if (!node) return;
    const frame = node.callFrame;
    const name = frame.functionName || '(anonymous)';
    const url = (frame.url || 'native').replace(/^https?:\/\/[^/]+/, '');
    const key = `${name} @ ${url}:${frame.lineNumber + 1}`;
    selfByKey.set(key, (selfByKey.get(key) ?? 0) + delta);
    total += delta;
  });

  const urlTotals = new Map();
  for (const [key, value] of selfByKey) {
    const url = key.split(' @ ')[1]?.replace(/:\d+$/, '') ?? 'unknown';
    urlTotals.set(url, (urlTotals.get(url) ?? 0) + value);
  }

  console.log(`\n=== ${file} ===`);
  console.log(`total sampled ${(total / 1000).toFixed(0)} ms over ${profile.samples?.length ?? 0} samples`);
  console.log('\n-- by file --');
  for (const [url, value] of [...urlTotals].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`${((value / total) * 100).toFixed(1).padStart(5)}%  ${(value / 1000).toFixed(0).padStart(7)} ms  ${url}`);
  }
  console.log('\n-- by function (self time) --');
  for (const [key, value] of [...selfByKey].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
    console.log(`${((value / total) * 100).toFixed(1).padStart(5)}%  ${(value / 1000).toFixed(0).padStart(7)} ms  ${key}`);
  }
}
