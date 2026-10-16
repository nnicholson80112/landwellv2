// RuleBasedAI: works with no model and no network. It is the fallback when a
// model is down, and the default in tests and the demo. Replies only quote
// the facts it was given.

import type { AIEntities, AIInput, AIResult, CommunicationAI, Fact, Intent } from './types.ts';

const TRADES: [string, RegExp][] = [
  ['plumbing', /\b(leak\w*|drip\w*|faucet|toilet|sink|drain|clog\w*|pipe|water heater|hot water|shower|tub|garbage disposal|sewer)\b/i],
  ['electrical', /\b(outlet|breaker|light(s)?|switch|electric\w*|power|spark\w*|wiring)\b/i],
  ['hvac', /\b(heat\w*|furnace|a\/?c|air condition\w*|thermostat|cooling|hvac|boiler)\b/i],
  ['appliance', /\b(fridge|refrigerator|oven|stove|dishwasher|washer|dryer|microwave|range)\b/i],
  ['windows', /\b(window\w*|screen\w*|glass|blinds?)\b/i],
  ['exterior_cleaning', /\b(pressure wash\w*|power wash\w*|house wash\w*|siding|mildew|algae|driveway stain\w*|deck clean\w*)\b/i],
  ['locks', /\b(lock\w*|key\w*|deadbolt|garage door)\b/i],
  ['pest', /\b(mice|mouse|rats?|roach\w*|ants?|bugs?|pest\w*|wasps?|bees?)\b/i],
  ['roofing', /\b(roof|gutter\w*|shingle\w*|ceiling stain)\b/i],
];

/** Best-guess trade from free text. Exported for the emergency path. */
export function guessTrade(t: string): string {
  if (/\b(gas|carbon monoxide)\b/i.test(t)) return 'plumbing';
  // Water where it shouldn't be is a plumber's job, whatever appliance it comes from.
  if (!/\b(roof|gutter\w*|shingle\w*|skylight)\b/i.test(t) && /\b(flood\w*|burst pipe|sewage|water (is |keeps )?(everywhere|pouring|gushing|spraying|flooding|leaking)|leak\w*)\b/i.test(t)) return 'plumbing';
  return TRADES.find(([, r]) => r.test(t))?.[0] ?? 'general';
}

/** Short work-order title: drop greetings, keep the first sentence. */
export function summarize(t: string): string {
  let s = t.replace(/^\s*(hi|hello|hey|good (morning|afternoon|evening))\b[!,.\s]*/i, '').trim();
  s = s.split(/(?<=[.!?])\s/)[0] ?? s;
  s = s.replace(/[.!?]+$/, '');
  s = s.charAt(0).toUpperCase() + s.slice(1);
  return s.length > 90 ? s.slice(0, 87).trimEnd() + '...' : s;
}

function pick(facts: Fact[], ...keys: string[]): Fact | undefined {
  return facts.find((f) => keys.some((k) => f.label.toLowerCase().includes(k)));
}

function dollars(s: string): number | undefined {
  const m = s.match(/\$\s?(\d[\d,]*(?:\.\d{1,2})?)/) ?? s.match(/\b(\d{2,5}(?:\.\d{2})?)\s*(?:dollars|bucks)\b/i);
  return m ? Number(m[1].replace(/,/g, '')) : undefined;
}

function window(s: string): string | undefined {
  const timeFirst = s.match(/\b\d{1,2}(?::\d{2})?\s*(?:am|pm)(?:\s*(?:-|to)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?\s+(?:on\s+)?(?:mon|tue|wed|thu|fri|sat|sun|today|tonight|tomorrow)\w*/i);
  if (timeFirst) return timeFirst[0].trim();
  const day = s.match(/\b(mon|tue|wed|thu|fri|sat|sun|today|tonight|tomorrow)\w*\.?\s*(?:at\s*|from\s*|between\s*)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?(?:\s*(?:-|to|and)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?)?(?:\s*(?:morning|afternoon|evening))?/i);
  if (day) return day[0].trim();
  const soon = s.match(/\b(on (my|our|the) way|omw|heading (over|there) now|right now|asap|(with)?in (\d+|an?|half an) (min\w*|hours?|hrs?)|within the hour|(\d{1,2}(?::\d{2})?\s*(?:am|pm))(\s*(?:-|to)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?|\d{1,2}\/\d{1,2}|this (morning|afternoon|evening))\b[^.,;$]*/i);
  return soon ? soon[0].trim().replace(/\s+\$.*$/, '') : undefined;
}

function isoDate(s: string): string | undefined {
  const m = s.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (m) return m[0];
  const mm = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\.?\s+(\d{1,2})(?:,?\s*(20\d{2}))?/i);
  if (!mm) return undefined;
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const mo = months.indexOf(mm[1].toLowerCase().slice(0, 3)) + 1;
  const yr = mm[3] ?? String(new Date().getUTCFullYear());
  return `${yr}-${String(mo).padStart(2, '0')}-${String(Number(mm[2])).padStart(2, '0')}`;
}

export class RuleBasedAI implements CommunicationAI {
  name = 'rules';

  async respond(input: AIInput): Promise<AIResult> {
    const t = input.message;
    const e: AIEntities = {};
    let intent: Intent = 'general';
    let reply = '';
    let handoff = false;
    let handoffReason: string | undefined;

    if (input.senderRole === 'vendor') {
      intent = 'vendor_update';
      const no = /^\s*no\b|\b(can'?t|cannot|can not|unavailable|not available|no availability|pass|decline\w*|booked up|fully booked|too busy|not (this|that) (one|week|job))\b/i.test(t);
      if (!no && /\b(yes|yep|sure|can do|i can|we can|available|accept\w*|ok(ay)?|confirm\w*|on (my|our) way|omw)\b/i.test(t)) e.vendorAccept = true;
      if (no && !/^\s*(yes|yep|sure)\b/i.test(t)) e.vendorAccept = false;
      else if (no) e.vendorAccept = true;
      if (/\b(done|finished|complete\w*|fixed|all set|wrapped up)\b/i.test(t)) { e.vendorDone = true; e.vendorInvoice = dollars(t); }
      else e.vendorQuote = dollars(t);
      e.vendorWindow = window(t);
      reply = e.vendorDone ? 'Thanks! Logged as complete. The owner will pay you directly once the invoice is checked.' : e.vendorAccept === false ? 'No problem, thanks for letting us know.' : e.vendorAccept ? 'Great, thank you. We\'ll confirm with the resident.' : '';
      return { intent, confidence: 0.7, reply, entities: e, handoff: false, provider: this.name };
    }

    const trade = TRADES.find(([, r]) => r.test(t));
    const isRepair = !!trade && /\b(broken|broke|not working|isn'?t working|won'?t|stopped|leak\w*|drip\w*|clog\w*|crack\w*|torn|stuck|out|fix|repair|problem|issue|damage\w*|noise|dirty|filthy)\b/i.test(t);

    if (input.senderRole === 'tenant' && isRepair) {
      intent = 'maintenance_request';
      e.trade = trade![0];
      e.urgency = /\b(no hot water|no water|won'?t lock|can'?t lock|fridge (is )?(out|warm|not))\b/i.test(t) ? 'urgent' : 'routine';
      e.summary = summarize(t);
      reply = input.mediaCount > 0
        ? "Thanks for the photo. I'm setting up the repair now and will text you the appointment time."
        : "Sorry about that! Could you reply with a photo? I'll get the repair booked and text you the time.";
    } else if (input.senderRole === 'tenant' && /\b(move|moving) out\b|\bnot renew\w*|\bwon'?t be renewing|\bgive (my|our) notice\b|\bvacat\w*/i.test(t)) {
      intent = /\b(not renew|won'?t be renewing|decline)\w*/i.test(t) ? 'renewal_response' : 'move_out_notice';
      if (intent === 'renewal_response') e.renewalAnswer = 'decline';
      e.moveOutDate = isoDate(t);
      reply = "Thanks for letting us know. I've noted it and the owner will confirm the details. I'll send move-out steps shortly.";
    } else if (input.senderRole === 'tenant' && /\b(renew\w*|sign (again|another)|stay another|extend\w*)\b/i.test(t)) {
      intent = 'renewal_response';
      e.renewalAnswer = /\b(yes|accept\w*|we'?d like to|want to|happy to|sounds good|sign)\b/i.test(t) ? 'accept' : /\b(no|decline)\b/i.test(t) ? 'decline' : 'question';
      reply = e.renewalAnswer === 'accept' ? "Wonderful! I'll prepare the renewal lease and send it for e-signature." : "Thanks! I've passed this to the owner.";
    } else if (/\b(rent|pay\w*|autopay|balance|late fee|due)\b/i.test(t) && input.senderRole === 'tenant') {
      intent = 'rent_question';
      const due = pick(input.facts, 'rent due', 'due date');
      const how = pick(input.facts, 'how to pay', 'payment');
      reply = [how?.value ?? 'Rent is paid to your landlord directly, the way you normally pay.', due ? `Rent is due ${due.value}.` : ''].filter(Boolean).join(' ');
    } else if (/\b(tour|show(ing)?|see (it|the (place|home|house|unit))|view(ing)?|visit|walk ?through|open house)\b/i.test(t)) {
      intent = 'showing_request';
      e.preferredTimes = window(t) ? [window(t)!] : [];
      reply = "Happy to help you see it! I'll text you the next steps right now.";
    } else if (/\b(apply|application)\b/i.test(t)) {
      intent = 'application_question';
      const link = pick(input.facts, 'application');
      reply = (link ? `${link.value} ` : '') + 'Every applicant is reviewed against the same written criteria, and the owner makes the decision.';
    } else if (/\b(pets?|dogs?|cats?|available|availability|still (open|for rent)|price|how much|rent is|cost|deposit|bed(room)?s?|bath|square|sq ?ft|parking|laundry|utilities)\b/i.test(t)) {
      intent = 'listing_question';
      const beds = t.match(/(\d)\s*(bed|br|bd)/i);
      if (beds) e.beds = Number(beds[1]);
      const price = dollars(t);
      if (price) e.maxRent = price;
      const want: [RegExp, string[]][] = [
        [/\b(available|availability|still|price|how much|rent|cost)\b/i, ['rent for']],
        [/\b(deposit)\b/i, ['deposit']],
        [/\b(bed|bath|size|square|sq ?ft)\w*/i, ['size of']],
        [/\b(pets?|dogs?|cats?)\b/i, ['pet']],
        [/\b(parking|garage)\b/i, ['parking']],
        [/\b(laundry|washer|dryer)\b/i, ['laundry']],
        [/\b(utilities|water|electric|gas bill)\b/i, ['utilities']],
      ];
      const found: Fact[] = [];
      for (const [re, keys] of want) if (re.test(t)) { const f = pick(input.facts, ...keys); if (f && !found.includes(f)) found.push(f); }
      if (/\b(available|availability|still)\b/i.test(t) && found.some((f) => /rent for/i.test(f.label))) found.unshift({ label: 'Availability', value: 'Yes, it is available' });
      reply = found.length
        ? found.map((f) => (/^(pet policy|availability)$/i.test(f.label) ? f.value : `${f.label}: ${f.value}`).replace(/\.$/, '')).join('. ') + '. Would you like to schedule a self-guided tour?'
        : "Thanks for reaching out! I'll get those details to you shortly.";
      if (!found.length) { handoff = true; handoffReason = 'Prospect asked something with no facts on file.'; }
    } else if (/\b(lease|contract|sublet|roommate|guest|parking|trash|recycling|quiet hours)\b/i.test(t)) {
      intent = 'lease_question';
      const f = input.facts.find((x) => t.toLowerCase().split(/\W+/).some((w) => w.length > 3 && x.label.toLowerCase().includes(w)));
      reply = f ? `${f.label}: ${f.value}.` : "Good question. I've passed it to the owner, who will get back to you.";
      if (!f) { handoff = true; handoffReason = 'Lease question with no matching fact.'; }
    } else {
      intent = 'general';
      reply = "Thanks for your message! I've passed it along and you'll hear back soon.";
      handoff = true;
      handoffReason = 'Could not classify the message.';
    }

    if (!input.allowedIntents.includes(intent)) {
      handoff = true;
      handoffReason = `Intent ${intent} not allowed for ${input.senderRole}.`;
      reply = "Thanks for your message! I've passed it along and you'll hear back soon.";
      intent = 'general';
    }
    return { intent, confidence: handoff ? 0.4 : 0.75, reply, entities: e, handoff, handoffReason, provider: this.name };
  }
}
