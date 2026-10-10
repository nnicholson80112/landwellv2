// Demo data. Replace the address, phone numbers and vendor with real ones via
// environment variables (see .env.example) to run the demo on a real home.

import type { Store } from '../store/store.ts';
import { prepareTemplate } from '../leases/template.ts';

export const SAMPLE_LEASE = `RESIDENTIAL LEASE AGREEMENT

This Lease is made on ________ between ______________________ ("Landlord") and ______________________ ("Tenant").

1. PREMISES. Landlord leases to Tenant the dwelling located at ______________________________.

2. TERM. The term begins on ____________ and ends on ____________.

3. RENT. Tenant shall pay monthly rent of $________, due on or before the ______ day of each month. This amount includes all mandatory fees.

4. SECURITY DEPOSIT. Tenant shall pay a security deposit of $________, which Landlord will return, less lawful deductions, within the time required by Colorado law.

5. LATE FEE. If rent is unpaid 7 or more days after the due date, Tenant shall pay a late fee of $________, not to exceed the limit set by C.R.S. 38-12-105.

6. PETS. Pet terms: ______________________________. Assistance animals are not pets.

7. REPAIRS. Tenant shall report needed repairs through the tenant app or by text. Landlord will respond within the time required by Colorado law.

8. UTILITIES. Tenant pays: ____________________.

[The owner's remaining clauses appear here, unchanged.]

Landlord: ______________________   Tenant: ______________________`;

export function seed(store: Store, env: Record<string, string | undefined> = process.env) {
  const now = '2026-10-01T15:00:00.000Z';
  const owner = store.insert('owners', {
    name: env.DEMO_OWNER_NAME ?? 'Nate', email: env.DEMO_OWNER_EMAIL ?? 'nate@example.com', phone: env.DEMO_OWNER_PHONE ?? '+17205550100',
    plan: 'autopilot', timezone: 'America/Denver', lineNumber: env.TWILIO_FROM ?? '+17205550199', createdAt: now,
  });
  store.insert('rules', {
    id: owner.id, ownerId: owner.id, repairSpendLimit: 15_000, emergencySpendLimit: 100_000, rentDueDay: 1, graceDays: 5, lateFee: 5_000, autoLateNotice: true,
    petPolicy: 'One dog under 50 lb or up to two cats, with a $300 pet deposit. Assistance animals are not pets and have no pet fees.',
    screeningCriteria: [
      { key: 'income_multiple', label: 'Monthly income at least 3x rent', value: 3 },
      { key: 'evictions_years', label: 'No evictions in the last 5 years', value: 5 },
      { key: 'collections_years', label: 'No rental collections in the last 2 years', value: 2 },
      { key: 'references', label: 'At least 1 positive landlord reference', value: 1 },
    ],
    showingMode: 'self', showingHours: { start: '09:00', end: '19:00' }, renewalLeadDays: 120, quietHours: { start: '21:00', end: '08:00' },
    alwaysRouteToOwner: [],
    facts: { 'Trash day': 'Tuesday morning; bins go out Monday night', 'Move-in instructions': 'Your door code will be texted the morning of move-in.' },
  });

  const home = store.insert('properties', {
    // The real demo home. Beds, baths and rent are placeholders until confirmed (DEMO_BEDS, DEMO_BATHS, DEMO_RENT).
    ownerId: owner.id, address: env.DEMO_ADDRESS ?? '7610 S Rosemary Cir', city: env.DEMO_CITY ?? 'Centennial', state: 'CO', zip: env.DEMO_ZIP ?? '80112',
    beds: Number(env.DEMO_BEDS ?? 3), baths: Number(env.DEMO_BATHS ?? 2), rent: Math.round(Number(env.DEMO_RENT ?? 2750) * 100), deposit: Math.round(Number(env.DEMO_RENT ?? 2750) * 100), status: 'occupied', lock: { kind: 'smart', deviceId: 'lock_demo_front' },
    facts: { Parking: 'One-car garage plus street parking', Laundry: 'Washer and dryer included', Utilities: 'Tenant pays gas and electric; water and trash included' },
  });
  const vacant = store.insert('properties', {
    ownerId: owner.id, address: '88 Aspen Ct', city: 'Aurora', state: 'CO', zip: '80012', beds: 2, baths: 1, rent: 185_000, deposit: 185_000, status: 'listed',
    lock: { kind: 'smart', deviceId: 'lock_demo_aspen' }, facts: { Parking: 'Two assigned spaces', Laundry: 'In-unit hookups', Utilities: 'Tenant pays electric; water, sewer and trash included', 'Tour notes': 'Please take shoes off inside.' },
  });

  const tenant = store.insert('tenants', { ownerId: owner.id, propertyId: home.id, name: 'Lisa Chen', phone: env.DEMO_TENANT_PHONE ?? '+17205550111', email: 'lisa@example.com', preferredChannel: 'sms', autopay: false, status: 'active' });
  const lease = store.insert('leases', { ownerId: owner.id, propertyId: home.id, tenantIds: [tenant.id], startDate: '2025-12-15', endDate: '2027-02-14', rent: home.rent, deposit: home.deposit, depositHeld: home.deposit, status: 'active', lastRentIncreaseAt: '2025-12-15' });

  // GlassHouse Exteriors (glasshouseexteriors.com): window cleaning, house washing, pressure washing.
  const windowCo = store.insert('vendors', { ownerId: owner.id, name: env.DEMO_VENDOR_NAME ?? 'GlassHouse Exteriors', trades: ['windows', 'exterior_cleaning'], phone: env.DEMO_VENDOR_PHONE ?? '+17209305782', email: env.DEMO_VENDOR_EMAIL, emergency: false, preferred: true });
  const plumber = store.insert('vendors', { ownerId: owner.id, name: 'Front Range Plumbing', trades: ['plumbing'], phone: '+17205550133', emergency: true, preferred: true });
  const handy = store.insert('vendors', { ownerId: owner.id, name: 'Mile High Handyman', trades: ['general', 'appliance', 'locks'], phone: '+17205550144', emergency: true, preferred: false });

  const prepared = prepareTemplate(SAMPLE_LEASE);
  const template = store.insert('leaseTemplates', { ownerId: owner.id, name: "Owner's Colorado lease", body: prepared.body, fields: prepared.fields, uploadedAt: now });

  return { owner, home, vacant, tenant, lease, windowCo, plumber, handy, template };
}
