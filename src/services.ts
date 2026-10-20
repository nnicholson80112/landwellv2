// Wires everything together. Adapters are chosen from environment variables:
// if a vendor's keys are present, the real integration is used; otherwise the
// safe mock. See .env.example.

import type { Adapters } from './adapters/types.ts';
import { ManualListings, MockIdentity, MockLocks, MockScreening, OutboxMessaging } from './adapters/mock.ts';
import { ChannelRouter, PostmarkEmail, SeamLocks, TwilioSMS } from './adapters/live.ts';
import { NativeESign } from './adapters/esign-native.ts';
import type { CommunicationAI } from './ai/types.ts';
import { RuleBasedAI } from './ai/rules.ts';
import { BudgetAI, HttpAI, ResilientAI, claudeFromEnv } from './ai/providers.ts';
import type { Store } from './store/store.ts';
import type { Clock } from './engine/clock.ts';
import { Engine } from './engine/engine.ts';
import { BRAND } from './config/brand.ts';

export interface Config {
  publicUrl: string; // where the API/app is reachable, used in links
  tz: string;
}

export interface Services {
  store: Store;
  clock: Clock;
  engine: Engine<Services>;
  ai: CommunicationAI;
  adapters: Adapters & { esign: NativeESign };
  outbox?: OutboxMessaging; // present when messaging is mocked
  cfg: Config;
  brand: typeof BRAND;
}

export function pickAI(env: Record<string, string | undefined>): CommunicationAI {
  const mode = (env.AI_PROVIDER ?? 'rules').toLowerCase();
  let primary: CommunicationAI = new RuleBasedAI();
  if (mode === 'anthropic' && env.ANTHROPIC_API_KEY) primary = claudeFromEnv(env)!; // Haiku 5.5 for routine, Sonnet 5.5 for repairs (src/ai/route.ts)
  if (mode === 'http' && env.AI_HTTP_URL) primary = new HttpAI({ url: env.AI_HTTP_URL, token: env.AI_HTTP_TOKEN });
  if (!(primary instanceof RuleBasedAI)) {
    const budget = new BudgetAI(primary, { perOwnerPerDay: Number(env.AI_OWNER_DAILY_MAX) || 400, totalPerDay: Number(env.AI_DAILY_MAX) || 20_000 });
    budget.onLimit = (what) => console.error(`[ai] ${what}; replying with built-in rules until midnight UTC`);
    primary = budget;
  }
  const r = new ResilientAI(primary);
  r.onError = (e) => console.error('[ai] provider failed, used rules fallback:', e instanceof Error ? e.message : e);
  return r;
}

export function createServices(o: {
  store: Store;
  clock: Clock;
  env?: Record<string, string | undefined>;
  overrides?: Partial<Adapters>;
  ai?: CommunicationAI;
  logMessages?: boolean;
}): Services {
  const env = o.env ?? process.env;
  const cfg: Config = { publicUrl: env.PUBLIC_URL ?? 'http://localhost:8787', tz: env.TZ_DEFAULT ?? 'America/Denver' };

  const outbox = new OutboxMessaging({ log: o.logMessages });
  const sms = env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM ? new TwilioSMS({ accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN, from: env.TWILIO_FROM }) : undefined;
  const email = env.POSTMARK_TOKEN && env.EMAIL_FROM ? new PostmarkEmail({ serverToken: env.POSTMARK_TOKEN, from: env.EMAIL_FROM }) : undefined;
  const messaging = sms || email ? new ChannelRouter({ sms, email }, outbox) : outbox;

  const adapters = {
    messaging,
    esign: new NativeESign({ store: o.store, publicUrl: cfg.publicUrl }),
    locks: env.SEAM_API_KEY ? new SeamLocks({ apiKey: env.SEAM_API_KEY }) : new MockLocks(),
    identity: new MockIdentity(),
    screening: new MockScreening(),
    listings: new ManualListings(),
    ...(o.overrides ?? {}),
  } as Adapters & { esign: NativeESign };

  const engine = new Engine<Services>({ store: o.store, clock: o.clock, tz: cfg.tz });
  const svc: Services = { store: o.store, clock: o.clock, engine, ai: o.ai ?? pickAI(env), adapters, outbox: messaging === outbox ? outbox : outbox, cfg, brand: BRAND };
  engine.svc = svc;
  return svc;
}
