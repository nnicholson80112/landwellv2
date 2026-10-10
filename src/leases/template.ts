// Turning an owner's own lease into a reusable template.
//
// Owners upload the lease they already use. Real leases have blanks like
// "Tenant(s): ____________" rather than merge fields, so prepareTemplate()
// finds those blanks, guesses what goes in each from the words before it,
// and turns them into {{merge_fields}}. Anything it can't name becomes
// {{blank_1}}, {{blank_2}}... which the owner fills or names once in the app.
// The owner's wording is never changed.

export const KNOWN_FIELDS = [
  'tenant_names', 'owner_name', 'property_address', 'start_date', 'end_date', 'term_months',
  'monthly_rent', 'security_deposit', 'rent_due_day', 'late_fee', 'pet_terms', 'utilities', 'today',
] as const;

const GUESS: [RegExp, string][] = [
  [/\b(tenant|resident|lessee)s?(\(s\))?\b/i, 'tenant_names'],
  [/\b(landlord|owner|lessor)\b/i, 'owner_name'],
  [/\b(premises|property|address|located at|dwelling|unit)\b/i, 'property_address'],
  [/\b(commenc\w*|begin\w*|start\w*|from)\b/i, 'start_date'],
  [/\b(end\w*|terminat\w*|expir\w*|through|until)\b/i, 'end_date'],
  [/\b(term|months?)\b/i, 'term_months'],
  [/\b(security deposit|deposit)\b/i, 'security_deposit'],
  [/\b(late (fee|charge))\b/i, 'late_fee'],
  [/\b(monthly rent|rent of|rent:|rent in the amount|rent amount|base rent|rent)\b/i, 'monthly_rent'],
  [/\b(due on the|due day|on or before the)\b/i, 'rent_due_day'],
  [/\b(pets?|animals?)\b/i, 'pet_terms'],
  [/\b(dated?|this day|effective date|made on|entered into on|executed on)\b/i, 'today'],
  [/\b(tenant pays|utilities)\b/i, 'utilities'],
];

export interface Prepared {
  body: string;
  fields: string[];
}

export function prepareTemplate(raw: string): Prepared {
  let blankN = 0;
  // A blank = 4+ underscores, or [ ] / [____] placeholders. A "$" right before
  // a blank is dropped because filled money values already include it.
  const body = raw.replace(/\$?\s?(_{4,}|\[\s*_*\s*\])/g, (_m, _g, offset: number, all: string) => {
    const lead = /^\s/.test(_m) ? ' ' : '';
    // 1. A label right AFTER the blank wins: ____ ("Landlord")
    const after = all.slice(offset + _m.length, offset + _m.length + 30);
    if (/^\s*\(?\s*["“]?(landlord|owner|lessor)/i.test(after)) return `${lead}{{owner_name}}`;
    if (/^\s*\(?\s*["“]?(tenants?|residents?|lessees?)/i.test(after)) return `${lead}{{tenant_names}}`;
    // 2. Otherwise the keyword closest BEFORE the blank in the same clause.
    const before = all.slice(Math.max(0, offset - 60), offset);
    const lastClause = before.split(/[.;\n]/).pop() ?? before;
    let best: { pos: number; field: string } | null = null;
    for (const [re, field] of GUESS) {
      const g = new RegExp(re.source, 'gi');
      let mm: RegExpExecArray | null;
      while ((mm = g.exec(lastClause))) if (!best || mm.index >= best.pos) best = { pos: mm.index, field };
    }
    if (best) return `${lead}{{${best.field}}}`;
    blankN += 1;
    return `${lead}{{blank_${blankN}}}`;
  });
  return { body, fields: findFields(body) };
}

export function findFields(body: string): string[] {
  return [...new Set([...body.matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi)].map((m) => m[1].toLowerCase()))];
}

/** Fill merge fields. Unfilled ones become a blank line and are reported. */
export function fillTemplate(body: string, values: Record<string, string | undefined>): { text: string; missing: string[] } {
  const missing = new Set<string>();
  const text = body.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_m, k: string) => {
    const v = values[k.toLowerCase()];
    if (v === undefined || v === '') { missing.add(k.toLowerCase()); return '______________'; }
    return v;
  });
  return { text, missing: [...missing] };
}
