// The local sandbox: the real app on http://localhost:8787 with its own data file and a clock
// the Test lab (/app/lab) can move forward. Nothing here can reach a real phone, inbox or card:
// texts and emails go to the outbox, Stripe and the database are switched off.
//   npm run sandbox            (start; sign-in details are printed and saved in data/sandbox.env)
//   npm run sandbox -- --reset (start over with fresh demo data)

import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const DATA_FILE = join(ROOT, 'data/sandbox.json');
const LOGIN_FILE = join(ROOT, 'data/sandbox.env');
const PORT = Number(process.env.SANDBOX_PORT ?? 8787);

// Keep only what's safe. Anything that could send a real text or email, charge a card or touch
// the live database is dropped before the app loads (it reads process.env as it starts).
const KEEP = /^(PATH|HOME|USER|SHELL|LANG|LC_.*|TMPDIR|TERM|NODE_.*|AI_PROVIDER|ANTHROPIC_API_KEY|ANTHROPIC_WORKSPACE_ID|ANTHROPIC_MODEL|AI_MODEL_.*|AI_EFFORT_.*)$/;
for (const k of Object.keys(process.env)) if (!KEEP.test(k)) delete process.env[k];
Object.assign(process.env, {
  NODE_ENV: 'development', DEV_TOOLS: 'true', PORT: String(PORT), PUBLIC_URL: `http://localhost:${PORT}`,
  DATA_FILE, TZ_DEFAULT: 'America/Denver', SEED_DEMO: 'false', STRIPE_AUTO_SETUP: 'false',
});
// Claude answers only when a key is in your shell (AI_PROVIDER=anthropic ANTHROPIC_API_KEY=...); otherwise the built-in rules do.
if (!process.env.ANTHROPIC_API_KEY) process.env.AI_PROVIDER = 'rules';

if (process.argv.includes('--reset')) rmSync(DATA_FILE, { force: true });

const { MemoryStore } = await import('../store/store.ts');
const { OffsetClock } = await import('../engine/clock.ts');
const { createServices } = await import('../services.ts');
const { install } = await import('../workflows/index.ts');
const { seed } = await import('./seed.ts');
const { Lab } = await import('./lab.ts');
const { hashPassword } = await import('../api/auth.ts');
const { createApp } = await import('../api/server.ts');
const { DATA_VERSION } = await import('../store/data-version.ts');

/** A generated password, kept in data/sandbox.env (git-ignored) so it survives restarts. */
function loginPassword(): string {
  if (existsSync(LOGIN_FILE)) {
    const m = /^SANDBOX_PASSWORD=(.+)$/m.exec(readFileSync(LOGIN_FILE, 'utf8'));
    if (m) return m[1].trim();
  }
  const pw = `lab-${randomBytes(9).toString('base64url')}`;
  mkdirSync(dirname(LOGIN_FILE), { recursive: true });
  writeFileSync(LOGIN_FILE, `# Local sandbox sign-in (npm run sandbox). Test data only; never used on the live app.\nSANDBOX_EMAIL=nate@example.com\nSANDBOX_PASSWORD=${pw}\n`, { mode: 0o600 });
  return pw;
}
const password = loginPassword();
const passwordHash = await hashPassword(password);

const store = new MemoryStore({ file: DATA_FILE });
store.kvSet('meta', 'dataVersion', DATA_VERSION);
const clock = new OffsetClock(store.kvGet<number>('lab', 'offsetMs') ?? 0);
const svc = createServices({ store, clock, logMessages: false });
install(svc);

/** Demo data with made-up 555 numbers only, and the sandbox owner's password. */
function reseed() {
  const s = seed(store, { DEMO_OWNER_EMAIL: 'nate@example.com', DEMO_VENDOR_PHONE: '+17205550122' });
  store.update('owners', s.owner.id, { passwordHash, passwordSetAt: clock.now().toISOString() });
  store.kvSet('tokens', 'dev-token', s.owner.id); // for /play
  store.kvSet('meta', 'dataVersion', DATA_VERSION);
}
if (!store.list('owners').length) reseed();
svc.lab = new Lab(svc, clock, { reseed });

const ticker = setInterval(() => { svc.engine.tick(); void svc.engine.drain().then(() => store.flush()); }, 30_000);
svc.engine.tick();
await svc.engine.drain();
store.flush();

const server = createApp(svc).listen(PORT, () => {
  console.log(`\nKeyHelm sandbox on http://localhost:${PORT}/app  (AI: ${svc.ai.name}; texts and emails go nowhere)`);
  console.log(`Sign in with nate@example.com and the password in data/sandbox.env`);
  console.log(`Then open Test lab in the menu. Data: data/sandbox.json. Stop with Ctrl+C.\n`);
});
const stop = () => {
  clearInterval(ticker);
  server.close();
  void svc.engine.drain().then(() => store.flush()).finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 3_000).unref();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
