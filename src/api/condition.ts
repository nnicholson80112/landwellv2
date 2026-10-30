// Condition reports: a room-by-room record of a home at move-in and move-out, with photos. The owner sets
// up the rooms; tenants fill in their side from My Home; each side's entries stay separate, so neither can
// change what the other wrote. A finished report can't be changed. Photos are JPEG files beside the data
// file (PHOTO_DIR), shrunk on the phone first; only their names live in the store.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Services } from '../services.ts';
import type { ConditionEntry, ConditionReport, ConditionRoom, Property, Tenant } from '../domain/types.ts';
import { fail, text } from './owner-data.ts';

const MAX_PHOTO_BYTES = 1_400_000;
const MAX_PER_ENTRY = 6;
const MAX_PER_REPORT = 80;
const PHOTO_NAME = /^[a-f0-9]{24}\.jpg$/;
export const CONDITIONS = ['good', 'fair', 'damaged'] as const;
export const REPORT_NAME = { move_in: 'move-in', move_out: 'move-out' } as const;

const photoDir = () => process.env.PHOTO_DIR ?? join(dirname(process.env.DATA_FILE ?? 'data/landwell.json'), 'photos');
const newRoom = (name: string): ConditionRoom => ({ id: randomBytes(6).toString('hex'), name });

/** A starting list of rooms from the home's size. The owner can change it before sending. */
export function defaultRooms(p: Pick<Property, 'beds' | 'baths'>): ConditionRoom[] {
  const count = (n: number, name: string) => (n <= 1 ? [name] : Array.from({ length: Math.ceil(n) }, (_x, i) => `${name} ${i + 1}`));
  return ['Entry and hallways', 'Living room', 'Kitchen', ...count(p.beds, 'Bedroom'), ...count(p.baths, 'Bathroom'), 'Laundry', 'Garage and storage', 'Outside and yard', 'Smoke and CO alarms', 'Keys and remotes'].map(newRoom);
}

/** The new room list. A room that keeps its name keeps what was already entered. */
export function roomsFrom(v: unknown, cur: ConditionRoom[] = []): ConditionRoom[] {
  if (!Array.isArray(v) || !v.length) fail('Add at least one room.', 'rooms');
  if ((v as unknown[]).length > 30) fail('30 rooms at most.', 'rooms');
  const seen = new Set<string>();
  return (v as unknown[]).map((x) => {
    const name = text(x, { field: 'rooms', label: 'a room name', max: 60, required: true })!;
    if (seen.has(name.toLowerCase())) fail(`"${name}" is listed twice.`, 'rooms');
    seen.add(name.toLowerCase());
    return cur.find((r) => r.name === name) ?? newRoom(name);
  });
}

export function roomOf(r: ConditionReport, roomId: string): ConditionRoom {
  const room = r.rooms.find((x) => x.id === roomId);
  if (!room) fail('That room is not on this report.', 'room', 404);
  return room!;
}

/** Save one side's rating and note for a room. */
export function saveEntry(svc: Services, r: ConditionReport, roomId: string, side: 'tenant' | 'owner', b: Record<string, unknown>): ConditionEntry {
  const room = roomOf(r, roomId);
  const had = room[side];
  const condition = b.condition === '' || b.condition === null ? undefined : b.condition;
  if (condition !== undefined && !CONDITIONS.includes(condition as ConditionEntry['condition'] & string)) fail('Pick good, fair or damaged.', 'condition');
  const entry: ConditionEntry = {
    photos: had?.photos ?? [],
    ...(condition ? { condition: condition as ConditionEntry['condition'] } : {}),
    ...(text(b.note, { field: 'note', label: 'the note', max: 1000, multiline: true }) ? { note: text(b.note, { field: 'note', label: 'the note', max: 1000, multiline: true }) } : {}),
  };
  svc.store.update('conditionReports', r.id, { rooms: r.rooms.map((x) => (x.id === roomId ? { ...x, [side]: entry } : x)) });
  return entry;
}

/** Keep one photo. It must really be a JPEG, which is what the phone's shrinking step always makes. */
export function addPhoto(svc: Services, r: ConditionReport, roomId: string, side: 'tenant' | 'owner', data: unknown): string {
  const room = roomOf(r, roomId);
  const photos = room[side]?.photos ?? [];
  if (photos.length >= MAX_PER_ENTRY) fail(`${MAX_PER_ENTRY} photos per room at most.`, 'photo');
  if (r.rooms.reduce((n, x) => n + (x.tenant?.photos.length ?? 0) + (x.owner?.photos.length ?? 0), 0) >= MAX_PER_REPORT) fail(`${MAX_PER_REPORT} photos per report at most.`, 'photo');
  if (typeof data !== 'string' || !data) fail('Please choose a photo.', 'photo');
  const bytes = Buffer.from(data as string, 'base64');
  if (bytes.length < 4 || bytes.length > MAX_PHOTO_BYTES) fail('That photo is too large. Please try another.', 'photo');
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) fail("That file isn't a photo we can use. Please try another.", 'photo');
  const name = randomBytes(12).toString('hex') + '.jpg';
  const dir = join(photoDir(), r.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), bytes);
  const entry: ConditionEntry = { ...(room[side] ?? {}), photos: [...photos, name] };
  svc.store.update('conditionReports', r.id, { rooms: r.rooms.map((x) => (x.id === roomId ? { ...x, [side]: entry } : x)) });
  return name;
}

export function removePhoto(svc: Services, r: ConditionReport, roomId: string, side: 'tenant' | 'owner', name: string): void {
  const room = roomOf(r, roomId);
  const entry = room[side];
  if (!entry || !entry.photos.includes(name)) fail('That photo is not on this report.', 'photo', 404);
  rmSync(join(photoDir(), r.id, name), { force: true });
  svc.store.update('conditionReports', r.id, { rooms: r.rooms.map((x) => (x.id === roomId ? { ...x, [side]: { ...entry, photos: entry!.photos.filter((p) => p !== name) } } : x)) });
}

/** A photo's bytes, only if it belongs to this report. */
export function readPhoto(r: ConditionReport, name: string): Buffer | undefined {
  if (!PHOTO_NAME.test(name) || !r.rooms.some((x) => x.tenant?.photos.includes(name) || x.owner?.photos.includes(name))) return undefined;
  const file = join(photoDir(), r.id, name);
  return existsSync(file) ? readFileSync(file) : undefined;
}

export const removePhotos = (r: ConditionReport) => rmSync(join(photoDir(), r.id), { recursive: true, force: true });

/** The tenants on a report who can still act on it. */
export const activeTenants = (svc: Services, r: ConditionReport): Tenant[] =>
  r.tenantIds.map((id) => svc.store.get('tenants', id)).filter((t): t is Tenant => !!t && t.status !== 'former');

/** The last finished move-in report for a home, to compare against at move-out. */
export const lastMoveIn = (svc: Services, propertyId: string): ConditionReport | undefined =>
  svc.store.list('conditionReports', (x) => x.propertyId === propertyId && x.kind === 'move_in' && x.status === 'done')
    .sort((a, b) => (b.ownerAck?.at ?? '').localeCompare(a.ownerAck?.at ?? ''))[0];

/* ---------------- tenant pages (My Home) ---------------- */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const WORD = { good: 'Good', fair: 'Fair', damaged: 'Damaged' };
const STYLE = `<style>h2{font-size:20px;margin:0 0 10px}.rate{display:flex;gap:8px;flex-wrap:wrap;margin:6px 0 12px}.rate label{display:flex;align-items:center;gap:8px;margin:0;font-weight:500;min-height:44px;padding:0 14px;border:1.5px solid #EADFD2;border-radius:10px;background:#fff}.rate input{width:auto;min-height:0}textarea{width:100%;box-sizing:border-box;min-height:80px;border:1.5px solid #EADFD2;border-radius:12px;padding:10px 14px;font:inherit}.thumbs{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}.thumbs figure{margin:0}.thumbs img{display:block;width:96px;height:96px;object-fit:cover;border-radius:8px}.link{background:none;color:#A63F20;padding:6px 0;margin:0;font:600 14px system-ui;text-decoration:underline}.file{display:inline-flex;align-items:center;min-height:44px;margin:0;padding:0 14px;border:1.5px solid #C8502D;border-radius:10px;color:#A63F20;font-weight:700;cursor:pointer}.file input{position:absolute;opacity:0;width:1px;height:1px;min-height:0;padding:0}.file:focus-within{outline:3px solid #E8A33D;outline-offset:2px}.note{white-space:pre-wrap;margin:6px 0}.say{min-height:20px}.cta{display:inline-block;background:#C8502D;color:#fff;border-radius:10px;padding:12px 20px;font-weight:700;text-decoration:none}</style>`;

function readOnlyEntry(label: string, e: ConditionEntry | undefined, photo: (n: string) => string): string {
  if (!e?.condition && !e?.note && !e?.photos.length) return `<p class="muted">${esc(label)}: nothing entered.</p>`;
  return `<p><strong>${esc(label)}: ${e.condition ? WORD[e.condition] : 'not rated'}</strong></p>${e.note ? `<p class="note">${esc(e.note)}</p>` : ''}${e.photos.length ? `<div class="thumbs">${e.photos.map((n, i) => `<a href="${esc(photo(n))}"><img src="${esc(photo(n))}" alt="${esc(label)} photo ${i + 1}" loading="lazy"></a>`).join('')}</div>` : ''}`;
}

export function conditionPage(svc: Services, r: ConditionReport, t: Tenant, token: string): { title: string; inner: string } {
  const p = svc.store.get('properties', r.propertyId)!;
  const base = `/my-home/${esc(token)}/condition/${esc(r.id)}`;
  const photo = (n: string) => `${base}/photos/${n}`;
  const title = `${REPORT_NAME[r.kind][0].toUpperCase()}${REPORT_NAME[r.kind].slice(1)} condition report`;
  const head = `${STYLE}<p><a href="/my-home/${esc(token)}">Back to My Home</a></p><h1>${esc(title)}</h1><p class="muted">${esc(p.address)}</p>`;
  if (r.status !== 'with_tenant') {
    const final = r.status === 'done';
    return {
      title,
      inner: head + `<p>${final ? 'This report is final.' : "Thanks. Your side is in, and your landlord is reviewing it."}</p>`
        + r.rooms.map((room) => `<section class="card"><h2>${esc(room.name)}</h2>${readOnlyEntry('Tenant', room.tenant, photo)}${final ? readOnlyEntry('Landlord', room.owner, photo) : ''}</section>`).join('')
        + `<section class="card">${r.tenantAck ? `<p>Tenant: ${esc(r.tenantAck.name)}, ${esc(r.tenantAck.at.slice(0, 10))}</p>` : ''}${r.ownerAck ? `<p>Landlord: ${esc(r.ownerAck.name)}, ${esc(r.ownerAck.at.slice(0, 10))}</p>` : ''}</section>`,
    };
  }
  const rooms = r.rooms.map((room) => {
    const e = room.tenant;
    return `<section class="card" data-room="${esc(room.id)}"><h2>${esc(room.name)}</h2>
<fieldset style="border:0;padding:0;margin:0"><legend><strong>Condition</strong></legend><div class="rate">${CONDITIONS.map((c) => `<label><input type="radio" name="c-${esc(room.id)}" value="${c}"${e?.condition === c ? ' checked' : ''}>${WORD[c]}</label>`).join('')}</div></fieldset>
<label for="n-${esc(room.id)}">Anything to note? (optional)</label><textarea id="n-${esc(room.id)}" maxlength="1000">${esc(e?.note ?? '')}</textarea>
<div class="thumbs">${(e?.photos ?? []).map((n) => `<figure data-photo="${esc(n)}"><img src="${esc(photo(n))}" alt="${esc(room.name)} photo"><figcaption><button type="button" class="link" data-remove>Remove</button></figcaption></figure>`).join('')}</div>
<label class="file">Add photos<input type="file" accept="image/*" multiple></label><p class="muted say" role="status"></p></section>`;
  }).join('');
  return {
    title,
    inner: head + `<p>Go room by room and note what you see, especially anything already worn or damaged. Add photos if you can. Your answers save as you go.</p>${rooms}
<form class="card" id="finish"><h2>Finish</h2><label for="who">Type your full name</label><input id="who" required autocomplete="name" value="${esc(t.name)}"><label class="check"><input type="checkbox" id="ok" required><span>I went through each room, and this report is accurate as far as I know.</span></label><button>Send to my landlord</button><p class="muted say" role="status"></p></form>
<script>(function(){var base=${JSON.stringify(base)};
function call(m,path,body){return fetch(base+path,{method:m,headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined}).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||'That did not save. Please try again.');return j;});});}
function shrink(file){return new Promise(function(ok,no){var fr=new FileReader();fr.onerror=no;fr.onload=function(){var img=new Image();img.onerror=function(){no(new Error('We could not read that photo. Please try another.'));};img.onload=function(){var s=Math.min(1,1600/Math.max(img.width,img.height)),c=document.createElement('canvas');c.width=Math.round(img.width*s);c.height=Math.round(img.height*s);c.getContext('2d').drawImage(img,0,0,c.width,c.height);var q=.8,d=c.toDataURL('image/jpeg',q);while(d.length>1800000&&q>.3){q-=.2;d=c.toDataURL('image/jpeg',q);}ok(d.split(',')[1]);};img.src=fr.result;};fr.readAsDataURL(file);});}
document.querySelectorAll('[data-room]').forEach(function(sec){var id=sec.dataset.room,say=sec.querySelector('.say'),thumbs=sec.querySelector('.thumbs'),note=sec.querySelector('textarea'),file=sec.querySelector('input[type=file]');
function save(){var c=sec.querySelector('input[type=radio]:checked');say.textContent='Saving...';call('POST','/rooms/'+id,{condition:c?c.value:'',note:note.value}).then(function(){say.textContent='Saved.';}).catch(function(e){say.textContent=e.message;});}
sec.querySelectorAll('input[type=radio]').forEach(function(x){x.addEventListener('change',save);});note.addEventListener('change',save);
function wire(fig){fig.querySelector('[data-remove]').addEventListener('click',function(){say.textContent='Removing...';call('DELETE','/rooms/'+id+'/photos/'+fig.dataset.photo).then(function(){fig.remove();say.textContent='Removed.';}).catch(function(e){say.textContent=e.message;});});}
thumbs.querySelectorAll('figure').forEach(wire);
file.addEventListener('change',async function(){var list=Array.from(file.files);file.value='';for(var i=0;i<list.length;i++){say.textContent='Adding photo '+(i+1)+' of '+list.length+'...';try{var j=await call('POST','/rooms/'+id+'/photos',{data:await shrink(list[i])});var fig=document.createElement('figure');fig.dataset.photo=j.name;var img=document.createElement('img');img.src=base+'/photos/'+j.name;img.alt='Photo';var cap=document.createElement('figcaption');var b=document.createElement('button');b.type='button';b.className='link';b.dataset.remove='';b.textContent='Remove';cap.append(b);fig.append(img,cap);thumbs.append(fig);wire(fig);say.textContent='Photo added.';}catch(e){say.textContent=e.message;return;}}});});
var f=document.getElementById('finish');f.addEventListener('submit',function(e){e.preventDefault();var say=f.querySelector('.say');say.textContent='Sending...';call('POST','/submit',{name:f.querySelector('#who').value,consent:f.querySelector('#ok').checked}).then(function(){location.reload();}).catch(function(x){say.textContent=x.message;});});
})();</script>`,
  };
}
