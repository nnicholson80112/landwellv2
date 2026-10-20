// Admin API for running the business (Authorization: Bearer <ADMIN_API_TOKEN>, like the other admin routes).
//
//   GET  /api/admin/status            health of the live business (see ./status.ts)
//   POST /api/admin/owners/:id/line   { "lineNumber": "+17205550123" } gives an owner their own texting
//                                     number (bought by hand in Twilio first; see docs/notes/ops.md).
//                                     "" or null (or the shared TWILIO_FROM) puts them back on the shared number.

import type { ServerResponse } from 'node:http';
import type { Handler, Req } from '../api/server.ts';
import type { Services } from '../services.ts';
import { safeEqual } from '../api/guard.ts';
import { addressKey, normalizePhone } from '../workflows/lib.ts';
import { opsStatus } from './status.ts';
import { sharedNumber } from './lines.ts';
import { ops } from './state.ts';

interface Kit {
  route: (method: string, path: string, h: Handler, auth?: boolean) => void;
  json: (res: ServerResponse, code: number, data: unknown) => void;
}

function isAdmin(req: Req, svc: Services): boolean {
  const want = ops(svc).env.ADMIN_API_TOKEN;
  const got = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  return !!want && !!got && safeEqual(got, want);
}

export function registerOpsRoutes({ route, json }: Kit): void {
  route('GET', '/api/admin/status', (req, res, svc) => {
    if (!isAdmin(req, svc)) return json(res, 401, { error: 'admin only' });
    json(res, 200, opsStatus(svc));
  });

  route('POST', '/api/admin/owners/:id/line', (req, res, svc) => {
    if (!isAdmin(req, svc)) return json(res, 401, { error: 'admin only' });
    const owner = svc.store.get('owners', req.params.id);
    if (!owner) return json(res, 404, { error: 'Not found.' });
    const b = req.body ?? {};
    if (!('lineNumber' in b)) return json(res, 400, { error: 'Send {"lineNumber": "+17205550123"}, or "" to put this owner back on the shared number.' });
    const text = b.lineNumber === null ? '' : String(b.lineNumber).trim();
    let lineNumber: string | undefined;
    if (text) {
      lineNumber = normalizePhone(text);
      if (!/^\+\d{10,15}$/.test(lineNumber)) return json(res, 400, { error: 'lineNumber must be a phone number, like +17205550123.' });
    }
    const env = ops(svc).env;
    const shared = sharedNumber(env);
    if (lineNumber && shared === lineNumber) lineNumber = undefined; // the shared number is the same as no number of their own
    if (lineNumber) {
      const taken = svc.store.find('owners', (o) => o.id !== owner.id && !!o.lineNumber && addressKey(o.lineNumber) === lineNumber);
      if (taken) return json(res, 409, { error: `That number is already the texting number of another owner (${taken.id}).` });
    }
    svc.store.update('owners', owner.id, { lineNumber });
    svc.engine.audit({ ownerId: owner.id, actor: 'system', action: 'owner.line', detail: lineNumber ? `${svc.brand.name} support set your own texting number: ${lineNumber}.` : `${svc.brand.name} support put you on the shared ${svc.brand.name} texting number.` });
    svc.store.flush();
    json(res, 200, { owner: { id: owner.id, name: owner.name }, lineNumber: lineNumber ?? null, shared: !lineNumber, sharedNumber: shared ?? null });
  });
}
