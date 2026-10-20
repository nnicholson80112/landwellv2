// STRIPE SETUP AT BOOT. When STRIPE_SECRET_KEY is set (sandbox or live), the api server
// checks the Stripe account in the background and creates only what KeyHelm's billing
// needs and is missing:
//
//   1. ensureCatalog   a recurring monthly USD price per plan and term, found by lookup key
//                      keyhelm_<plan>_<monthly|annual> at LIST_PRICE, on the product
//                      "KeyHelm Essentials" / "KeyHelm Autopilot" / "KeyHelm Autopilot Pro"
//                      (made too when there isn't one; unit label "door").
//   2. ensureWebhook   the webhook endpoint PUBLIC_URL/webhooks/stripe for exactly
//                      BILLING_EVENTS; its signing secret is kept in the store (kv
//                      'stripe'/'webhookSecret') and the webhook route accepts it.
//   3. ensurePortal    a customer portal setup (update card, invoices, cancel at period end).
//
// Catalog objects only: nothing here charges anyone. Existing prices and products are
// never changed or archived, and webhook endpoints that KeyHelm didn't make are never
// touched. Turn it off with STRIPE_AUTO_SETUP=false. Notes: docs/notes/billing.md.

import type { Store } from '../store/store.ts';
import { LIST_PRICE } from './offers.ts';
import { BILLING_EVENTS, isLiveKey, stripeCall } from './stripe.ts';
import { PLANS, PLAN_CONTENTS, PLAN_NAMES, TERMS, asPlanId, lookupKey, planTermFromLookupKey, stripeTerm, termName, type Plan } from './plans.ts';

/** Store namespace (kv) for what the setup made: webhookSecret, webhookEndpoint, portalConfiguration, setupReport. */
export const STRIPE_KV = 'stripe';

export const PRODUCT_NAMES: Record<Plan, string> = { essentials: 'KeyHelm Essentials', autopilot: 'KeyHelm Autopilot', pro: 'KeyHelm Autopilot Pro' };

type Log = (msg: string) => void;
const noLog: Log = () => {};
const usd = (c: number) => '$' + (c / 100).toFixed(c % 100 ? 2 : 0);
const idOf = (x: unknown): string | undefined => (typeof x === 'string' ? x : (x as { id?: string } | null)?.id);
const form = (o: Record<string, string>) => new URLSearchParams(o);
export const webhookUrl = (publicUrl: string) => `${publicUrl.replace(/\/$/, '')}/webhooks/stripe`;
/** Stripe only delivers to (and portal links only open) public https addresses. */
const isPublicHttps = (u: string) => /^https:\/\//i.test(u) && !/^https:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(u);

/** Every page of a Stripe list (100 per page, at most 20 pages). */
async function listAll(key: string, path: string, params: Record<string, string> | URLSearchParams = {}): Promise<any[]> {
  const out: any[] = [];
  let after: string | undefined;
  for (let page = 0; page < 20; page++) {
    const q = new URLSearchParams(params);
    q.set('limit', '100');
    if (after) q.set('starting_after', after);
    const r = await stripeCall(key, 'GET', path, q);
    const data: any[] = r?.data ?? [];
    out.push(...data);
    if (!r?.has_more || !data.length) break;
    after = data[data.length - 1].id;
  }
  return out;
}

/* ---------------- 1. Products and prices ---------------- */

export interface CatalogReport {
  /** What was made, e.g. "price keyhelm_pro_annual $16/door (price_...)". */
  created: string[];
  /** Lookup keys that already had an active price. */
  ok: string[];
  /** Things a person should look at in Stripe (nothing was changed). */
  warnings: string[];
}

/**
 * Makes sure each plan and term has an active price under its lookup key. Creates only what
 * is missing: the product (when the plan has none) and the price. Running it again does nothing.
 */
export async function ensureCatalog(o: { secretKey: string; log?: Log }): Promise<CatalogReport> {
  const key = o.secretKey, log = o.log ?? noLog;
  const report: CatalogReport = { created: [], ok: [], warnings: [] };
  const wanted = PLANS.flatMap((plan) => TERMS.map((term) => ({ plan, term, key: lookupKey(plan, term), amount: LIST_PRICE[plan][term] })));

  // Active and archived prices that hold one of our keys (a key can't be reused while an archived price holds it).
  const q = new URLSearchParams();
  for (const w of wanted) q.append('lookup_keys[]', w.key);
  const prices = await listAll(key, 'prices', q);

  let products: any[] | undefined; // loaded only when a price is missing
  const productFor = new Map<Plan, string>();
  for (const w of wanted) {
    const holders = prices.filter((p) => p.lookup_key === w.key);
    const active = holders.find((p) => p.active);
    if (active) {
      report.ok.push(w.key);
      if (active.unit_amount !== w.amount || active.currency !== 'usd' || active.recurring?.interval !== 'month') {
        report.warnings.push(`${w.key} is ${usd(Number(active.unit_amount))} ${String(active.currency ?? '').toUpperCase()} every ${active.recurring?.interval ?? '?'} in Stripe, but KeyHelm's standard price is ${usd(w.amount)} USD every month. Checkout charges what Stripe has; change one of them so they match.`);
      }
      continue;
    }
    if (holders.length) {
      report.warnings.push(`${w.key} belongs to an archived price (${holders[0].id}), so KeyHelm did not make a new one. In Stripe, unarchive that price or remove its lookup key, then restart the api service.`);
      continue;
    }

    // The plan's product: the one its other price uses, else one KeyHelm made (metadata brand=keyhelm, plan=<id>), else a new one.
    let product = productFor.get(w.plan) ?? idOf(prices.find((p) => p.active && planTermFromLookupKey(p.lookup_key)?.plan === w.plan)?.product);
    if (!product) {
      products ??= await listAll(key, 'products', { active: 'true' });
      product = idOf(products.find((p) => p.metadata?.brand === 'keyhelm' && asPlanId(p.metadata?.plan) === w.plan));
    }
    if (!product) {
      // Products are type "service" by default (the only kind subscriptions use), so no type is sent.
      const made = await stripeCall(key, 'POST', 'products', form({
        name: PRODUCT_NAMES[w.plan], description: PLAN_CONTENTS[w.plan], unit_label: 'door',
        'metadata[brand]': 'keyhelm', 'metadata[plan]': w.plan,
      }));
      product = String(made.id);
      report.created.push(`product ${PRODUCT_NAMES[w.plan]} (${product})`);
    }
    productFor.set(w.plan, product);

    const price = await stripeCall(key, 'POST', 'prices', form({
      product, currency: 'usd', unit_amount: String(w.amount), 'recurring[interval]': 'month',
      lookup_key: w.key, nickname: `${PLAN_NAMES[w.plan]}, ${termName(w.term)}, per door`,
      'metadata[brand]': 'keyhelm', 'metadata[plan]': w.plan, 'metadata[term]': stripeTerm(w.term),
    }));
    report.created.push(`price ${w.key} ${usd(w.amount)}/door (${price.id})`);
  }
  for (const c of report.created) log(`Stripe setup: created ${c}`);
  for (const m of report.warnings) log(`Stripe setup: check ${m}`);
  return report;
}

/* ---------------- 2. Webhook ---------------- */

export interface WebhookReport {
  /** env: STRIPE_WEBHOOK_SECRET and a hand-made endpoint are in use, nothing done. kept: KeyHelm's endpoint is fine. created: a new one was made. skipped: no public https PUBLIC_URL. */
  status: 'env' | 'kept' | 'created' | 'skipped';
  url: string;
  id?: string;
  /** KeyHelm-made endpoints for this address whose secret was lost, replaced by the new one. */
  deleted: string[];
  note?: string;
}

/** The signing secrets the webhook route accepts: STRIPE_WEBHOOK_SECRET, then the one the setup stored. */
export function webhookSecrets(store: Store, env: Record<string, string | undefined> = process.env): string[] {
  const stored = store.kvGet<string>(STRIPE_KV, 'webhookSecret');
  return [env.STRIPE_WEBHOOK_SECRET?.trim(), typeof stored === 'string' ? stored : undefined].filter((s): s is string => !!s);
}

/**
 * Makes sure Stripe sends KeyHelm's billing events to PUBLIC_URL/webhooks/stripe with a secret
 * this server knows. Leaves everything alone when STRIPE_WEBHOOK_SECRET is set and a hand-made
 * endpoint points here. Only endpoints KeyHelm made (metadata keyhelm=true) are ever changed or deleted.
 */
export async function ensureWebhook(o: { secretKey: string; publicUrl: string; store: Store; env?: Record<string, string | undefined>; log?: Log }): Promise<WebhookReport> {
  const key = o.secretKey, log = o.log ?? noLog, env = o.env ?? process.env;
  const url = webhookUrl(o.publicUrl);
  if (!isPublicHttps(url)) return { status: 'skipped', url, deleted: [], note: 'PUBLIC_URL is not a public https address, so Stripe cannot reach it' };

  const here = (await listAll(key, 'webhook_endpoints')).filter((e) => e.url === url);
  const ours = here.filter((e) => e.metadata?.keyhelm === 'true');
  const handMade = here.filter((e) => e.metadata?.keyhelm !== 'true');
  if (env.STRIPE_WEBHOOK_SECRET?.trim() && handMade.length) return { status: 'env', url, id: handMade[0].id, deleted: [], note: 'STRIPE_WEBHOOK_SECRET is set and a webhook endpoint made in Stripe points here' };
  const note = handMade.length ? `Another endpoint (${handMade.map((e) => e.id).join(', ')}) also sends to ${url}, and its secret isn't known here, so its deliveries are refused. Delete it in Stripe (Developers, Webhooks).` : undefined;
  if (note) log(`Stripe setup: check ${note}`);

  const deleteStale = async (keep: string) => {
    const deleted: string[] = [];
    for (const e of ours) {
      if (e.id === keep) continue;
      try { await stripeCall(key, 'DELETE', `webhook_endpoints/${e.id}`); deleted.push(e.id); }
      catch (err) { log(`Stripe setup: could not delete old webhook ${e.id}: ${(err as Error).message}`); }
    }
    return deleted;
  };

  const storedSecret = o.store.kvGet<string>(STRIPE_KV, 'webhookSecret');
  const storedId = o.store.kvGet<{ id: string }>(STRIPE_KV, 'webhookEndpoint')?.id;
  const keep = storedSecret && storedId ? ours.find((e) => e.id === storedId) : undefined;
  if (keep) {
    const want = [...BILLING_EVENTS].sort().join(',');
    if ([...(keep.enabled_events ?? [])].sort().join(',') !== want || keep.status === 'disabled') {
      const p = form({ disabled: 'false' });
      for (const ev of BILLING_EVENTS) p.append('enabled_events[]', ev);
      await stripeCall(key, 'POST', `webhook_endpoints/${keep.id}`, p);
      log(`Stripe setup: webhook ${keep.id} now listens to ${BILLING_EVENTS.join(', ')}`);
    }
    return { status: 'kept', url, id: keep.id, deleted: await deleteStale(keep.id), note };
  }

  // Make a new endpoint first and store its secret, then remove KeyHelm's older ones whose secret was lost.
  const p = form({ url, description: 'KeyHelm subscription billing (made by the KeyHelm server)', 'metadata[keyhelm]': 'true' });
  for (const ev of BILLING_EVENTS) p.append('enabled_events[]', ev);
  const made = await stripeCall(key, 'POST', 'webhook_endpoints', p);
  if (!made?.secret) throw new Error(`Stripe made webhook ${made?.id} but sent no signing secret`);
  o.store.kvSet(STRIPE_KV, 'webhookSecret', String(made.secret));
  o.store.kvSet(STRIPE_KV, 'webhookEndpoint', { id: made.id, url, livemode: !!made.livemode, events: BILLING_EVENTS, createdAt: new Date().toISOString() });
  o.store.flush();
  log(`Stripe setup: created webhook ${made.id} for ${url}`);
  return { status: 'created', url, id: made.id, deleted: await deleteStale(made.id), note };
}

/* ---------------- 3. Customer portal ---------------- */

export interface PortalReport {
  /** default: the account's own portal settings (saved in Stripe) are used. kept / created: KeyHelm's. */
  status: 'default' | 'kept' | 'created';
  id: string;
}

/** The portal setup to pass when opening a portal session (undefined = the account's default). */
export function portalConfiguration(store: Store, secretKey: string): string | undefined {
  const c = store.kvGet<{ id: string; livemode: boolean }>(STRIPE_KV, 'portalConfiguration');
  return c?.id && c.livemode === isLiveKey(secretKey) ? c.id : undefined;
}

/** Makes sure owners can open Stripe's billing portal: uses the account's default portal settings, or makes KeyHelm's. */
export async function ensurePortal(o: { secretKey: string; publicUrl: string; store: Store; log?: Log }): Promise<PortalReport> {
  const key = o.secretKey, log = o.log ?? noLog;
  const configs = await listAll(key, 'billing_portal/configurations', { active: 'true' });
  const def = configs.find((c) => c.is_default);
  if (def) { o.store.kvDelete(STRIPE_KV, 'portalConfiguration'); return { status: 'default', id: def.id }; }
  const remember = (id: string) => { o.store.kvSet(STRIPE_KV, 'portalConfiguration', { id, livemode: isLiveKey(key) }); o.store.flush(); };
  const ours = configs.find((c) => c.metadata?.keyhelm === 'true');
  if (ours) { remember(ours.id); return { status: 'kept', id: ours.id }; }

  const base = o.publicUrl.replace(/\/$/, '');
  const p = form({
    'business_profile[headline]': 'KeyHelm billing',
    'features[payment_method_update][enabled]': 'true',
    'features[invoice_history][enabled]': 'true',
    'features[subscription_cancel][enabled]': 'true',
    'features[subscription_cancel][mode]': 'at_period_end',
    'metadata[keyhelm]': 'true',
  });
  if (isPublicHttps(base)) {
    p.set('default_return_url', `${base}/app`);
    p.set('business_profile[privacy_policy_url]', `${base}/privacy`);
    p.set('business_profile[terms_of_service_url]', `${base}/terms`);
  }
  const made = await stripeCall(key, 'POST', 'billing_portal/configurations', p);
  remember(made.id);
  log(`Stripe setup: created customer portal settings ${made.id}`);
  return { status: 'created', id: made.id };
}

/* ---------------- At boot ---------------- */

export interface SetupReport {
  at: string;
  mode: 'live' | 'test';
  catalog?: CatalogReport;
  webhook?: WebhookReport;
  portal?: PortalReport;
  errors: string[];
}

/**
 * Called once from the server's start-up (not awaited). Does nothing without STRIPE_SECRET_KEY
 * or with STRIPE_AUTO_SETUP=false. Never throws: each step's failure is logged and the next runs.
 * The last report (no secrets in it) is kept in kv 'stripe'/'setupReport' and shown in /api/admin/overview.
 */
export async function startStripeSetup(o: { store: Store; publicUrl: string; env?: Record<string, string | undefined>; log?: Log }): Promise<SetupReport | undefined> {
  const env = o.env ?? process.env, log = o.log ?? console.log;
  try {
    const secretKey = env.STRIPE_SECRET_KEY?.trim();
    if (!secretKey) return undefined;
    if (/^(false|0|no|off)$/i.test(env.STRIPE_AUTO_SETUP?.trim() ?? '')) { log('Stripe setup: off (STRIPE_AUTO_SETUP=false)'); return undefined; }
    const mode = isLiveKey(secretKey) ? 'live' : 'test';
    const report: SetupReport = { at: new Date().toISOString(), mode, errors: [] };
    const step = async <T>(name: 'catalog' | 'webhook' | 'portal', run: () => Promise<T>) => {
      try { (report as any)[name] = await run(); }
      catch (e) { report.errors.push(`${name}: ${(e as Error).message}`); log(`Stripe setup (${mode}): ${name} failed: ${(e as Error).message}`); }
    };
    await step('catalog', () => ensureCatalog({ secretKey, log }));
    await step('webhook', () => ensureWebhook({ secretKey, publicUrl: o.publicUrl, store: o.store, env, log }));
    await step('portal', () => ensurePortal({ secretKey, publicUrl: o.publicUrl, store: o.store, log }));
    try { o.store.kvSet(STRIPE_KV, 'setupReport', report); o.store.flush(); } catch { /* the report is only informational */ }
    const made = (report.catalog?.created.length ?? 0) + (report.webhook?.status === 'created' ? 1 : 0) + (report.portal?.status === 'created' ? 1 : 0);
    log(`Stripe setup (${mode}): ${report.errors.length ? `${report.errors.length} step(s) failed` : 'ready'}; ${made ? `${made} thing(s) created` : 'nothing to create'}${report.catalog?.warnings.length ? `; ${report.catalog.warnings.length} warning(s)` : ''}.`);
    return report;
  } catch (e) {
    log(`Stripe setup failed: ${(e as Error).message}`);
    return undefined;
  }
}
