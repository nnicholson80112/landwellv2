// Rebuilds apps/review/review.html from a fresh run of the end-to-end demo,
// so the build review always shows the current demo data and test count.
//   npm run build:review
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const node = ['--experimental-strip-types', '--no-warnings'];
const run = (args) => execFileSync(process.execPath, [...node, ...args], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 });

const raw = run(['src/sim/demo.ts']).replace(/\x1b\[[0-9;]*m/g, '');
const scenes = [];
let cur = null, last = null;
for (const line of raw.split('\n')) {
  let m;
  if ((m = line.match(/^━━ (.+) ━━\s+(.+)$/))) {
    if (m[1] === 'Summary') { cur = null; continue; }
    cur = { title: m[1], time: m[2].trim(), items: [] }; scenes.push(cur); last = null; continue;
  }
  if (!cur) continue;
  if ((m = line.match(/^ {3}← (.+?): (.*)$/))) { last = null; cur.items.push({ k: 'in', who: m[1], t: m[2].replace(/^"|"$/g, '').replace(/" \[photo\]$/, ' [photo]') }); continue; }
  if ((m = line.match(/^ {3}→ (.+?) \((sms|email|voice)\)$/))) { last = { k: 'out', who: m[1], t: '' }; cur.items.push(last); continue; }
  if ((m = line.match(/^ {3}\((.+)\)$/))) { last = null; cur.items.push({ k: 'note', t: m[1] }); continue; }
  if (last && line.startsWith('     ')) { last.t += (last.t ? '\n' : '') + line.slice(5); continue; }
}
const summary = (raw.match(/Workflow runs: (\d+) \((\d+) completed, (\d+) waiting, (\d+) failed\)/) || []).slice(1);

let tests = '?';
try {
  const out = execFileSync(process.execPath, [...node, '--test', ...readTests()], { cwd: root, encoding: 'utf8' });
  tests = (out.match(/^# pass (\d+)/m) || [])[1] || tests;
} catch (e) { tests = ((e.stdout || '').match(/^# pass (\d+)/m) || [])[1] || tests; }
function readTests() { return execFileSync('ls', ['tests'], { cwd: root, encoding: 'utf8' }).split('\n').filter((f) => f.endsWith('.test.ts')).map((f) => 'tests/' + f); }

const lines = execFileSync('sh', ['-c', 'cat src/*/*.ts src/*.ts | wc -l'], { cwd: root, encoding: 'utf8' }).trim();
const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Denver' });

let html = readFileSync(join(root, 'apps/review/review.tpl.html'), 'utf8')
  .replace('/*SCENES*/[]', JSON.stringify(scenes))
  .replaceAll('{{DATE}}', today).replaceAll('{{TESTS}}', tests).replaceAll('{{LINES}}', Number(lines).toLocaleString('en-US'))
  .replaceAll('{{RUNS}}', summary[0] || '?').replaceAll('{{FAILED}}', summary[3] ?? '?');
writeFileSync(join(root, 'apps/review/review.html'), html);
console.log(`review.html: ${scenes.length} scenes, ${tests} tests passing, ${summary[0]} runs / ${summary[3]} failed`);
