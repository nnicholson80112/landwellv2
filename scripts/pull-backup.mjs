#!/usr/bin/env node
// Save a copy of the live data and photos on this computer, off Railway.
//
//   ADMIN_API_TOKEN=... node scripts/pull-backup.mjs <url> [folder]     (folder default: ~/keyhelm-backups)
//
// Makes a fresh backup on the server, saves it, checks it reads back, then saves any photos not yet here.
// The files are private: they have names, phones and sign-in records.

import { existsSync, mkdirSync, renameSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const [url, folder = join(homedir(), 'keyhelm-backups')] = process.argv.slice(2);
const token = process.env.ADMIN_API_TOKEN?.trim();
if (!url || !token) {
  console.error('Usage: ADMIN_API_TOKEN=... node scripts/pull-backup.mjs <url> [folder]');
  process.exit(2);
}

const call = async (path, method = 'GET') => {
  const r = await fetch(new URL(path, url), { method, headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(120_000) });
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r;
};

const save = (file, bytes) => {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(`${file}.tmp`, bytes, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
};

try {
  await call('/api/admin/backup', 'POST');
  const { backups, photos } = await (await call('/api/admin/backup')).json();
  if (!backups.length) throw new Error('the server has no backups');
  const { date, bytes } = backups[0];
  const file = join(folder, `keyhelm-${date}.json`);
  save(file, Buffer.from(await (await call(`/api/admin/backup/data/${date}`)).arrayBuffer()));
  const snap = JSON.parse(readFileSync(file, 'utf8'));
  if (!snap.tables || statSync(file).size !== bytes) throw new Error(`${file} doesn't match what the server has`);
  const owners = Object.keys(snap.tables.owners ?? {}).length;

  let added = 0;
  for (const p of photos) {
    const to = join(folder, 'photos', p);
    if (existsSync(to)) continue;
    save(to, Buffer.from(await (await call(`/api/admin/backup/photos/${p}`)).arrayBuffer()));
    added++;
  }
  console.log(`Saved ${file} (${bytes} bytes, ${owners} owner(s)). Photos: ${added} new, ${photos.length} in all.`);
} catch (e) {
  console.error(`Backup not saved: ${e.message}`);
  process.exit(1);
}
