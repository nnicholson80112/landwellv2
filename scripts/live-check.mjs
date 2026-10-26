// Checks the live app from the outside. No dependencies.
//   node scripts/live-check.mjs https://your-app.up.railway.app [--expect-commit abc1234] [--wait 720] [--conversations]
// --expect-commit / --wait : poll /health until that commit is live (proves the deploy happened)
// --conversations          : also talk to the front desk through the phone-line webhook, like a tenant
//                            and a prospect would (only while texts are mocked, so no real texts go out)

const args = process.argv.slice(2);
const base = (args.find((a) => a.startsWith('http')) ?? process.env.LIVE_URL ?? '').replace(/\/$/, '');
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
if (!base) { console.error('usage: node scripts/live-check.mjs <base-url>'); process.exit(2); }

const results = [];
const ok = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(path) {
  const r = await fetch(base + path, { redirect: 'manual', signal: AbortSignal.timeout(20_000) });
  return { status: r.status, text: await r.text() };
}

// 1. Is the expected commit live?
let health;
const want = opt('--expect-commit')?.slice(0, 7);
const deadline = Date.now() + Number(opt('--wait') ?? 0) * 1000;
for (;;) {
  try { const r = await get('/health'); health = JSON.parse(r.text); } catch (e) { health = { ok: false, error: String(e) }; }
  if (!want || health?.commit === want || Date.now() > deadline) break;
  console.log(`waiting for ${want} (live: ${health?.commit ?? 'down'})`);
  await sleep(20_000);
}
console.log('health:', JSON.stringify(health));
ok('health', health?.ok === true);
if (want) ok(`deployed commit ${want}`, health?.commit === want, `live is ${health?.commit}`);

// 2. Public pages.
for (const [path, must] of [['/', health?.brand ?? ''], ['/privacy', 'Privacy'], ['/terms', 'Terms'], ['/sms', 'Reply <b>STOP</b>'], ['/play', '<html']]) {
  try { const r = await get(path); ok(`GET ${path}`, r.status === 200 && r.text.includes(must), `status ${r.status}`); }
  catch (e) { ok(`GET ${path}`, false, String(e)); }
}

// 3. Conversations through the phone-line webhook (works while TWILIO_AUTH_TOKEN is unset).
if (flag('--conversations')) {
  if (!/outbox|mock/i.test(String(health?.messaging))) {
    console.log(`skipping conversations: messaging is "${health?.messaging}" (real texts would go out)`);
  } else {
    const line = process.env.LINE_NUMBER ?? '+17205550199';
    const tenant = process.env.TENANT_PHONE ?? '+13037481671';
    const prospect = '+1720555' + String(Date.now()).slice(-4);
    const say = async (from, speech) => {
      const body = new URLSearchParams({ From: from, To: line, CallSid: 'CA' + Date.now() + Math.floor(Math.random() * 1e6), SpeechResult: speech });
      const r = await fetch(base + '/webhooks/twilio/voice/turn', { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(45_000) });
      const xml = await r.text();
      const reply = [...xml.matchAll(/<Say[^>]*>([\s\S]*?)<\/Say>/g)].map((m) => m[1]).join(' ').replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      console.log(`\n  ${from === tenant ? 'TENANT' : 'PROSPECT'}: ${speech}\n  REPLY:  ${reply}`);
      return { status: r.status, reply };
    };
    // Calls are part of Autopilot Pro. Off Pro, a non-emergency call is pointed to texting (911 first), which is right;
    // an emergency must still get its safety steps on every plan.
    const toText = (r) => /handled by text on this number/i.test(r) && /911/.test(r);
    const t = async (name, from, speech, check, { emergency = false } = {}) => {
      try {
        const r = await say(from, speech);
        const texting = !emergency && toText(r.reply);
        ok(name, r.status === 200 && (texting || check(r.reply)), r.status === 403 ? 'webhook is signature-protected' : texting ? 'not on Autopilot Pro: pointed to texting' : '');
      } catch (e) { ok(name, false, String(e)); }
    };
    await t('prospect: availability + pets answered with facts', prospect, 'Is the Aspen Court place available? Do you allow dogs?', (r) => /\$|available/i.test(r) && !/passed it/i.test(r));
    await t('prospect: schools question deflected neutrally', prospect, 'Are there good schools nearby?', (r) => !/\bgood school|great school|top.rated/i.test(r));
    await t('tenant: repair gets a helpful answer', tenant, "The toilet won't stop running", (r) => r.length > 20);
    await t('tenant: gas smell says leave + 911', tenant, 'I smell gas in the kitchen', (r) => /911/.test(r) && /leave|outside/i.test(r), { emergency: true });
    await t('tenant: flooding gets shut-off help, no 911', tenant, 'Water is pouring out from under the dishwasher', (r) => /shut|valve|water/i.test(r) && !/911/.test(r), { emergency: true });
  }
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import('node:fs');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Live check: ${base}\n\nLive commit: \`${health?.commit}\` · data version ${health?.dataVersion} · AI: ${health?.ai} · messaging: ${health?.messaging}\n\n${results.map((r) => `- ${r.pass ? '✅' : '❌'} ${r.name}${r.detail ? ` (${r.detail})` : ''}`).join('\n')}\n`);
}
process.exit(failed.length ? 1 : 0);
