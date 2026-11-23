/**
 * Atlassian's user privacy requirements: apps that store account IDs report them to the Personal Data Reporting API
 * at least every 7 days and erase the data of accounts Atlassian reports as closed. Runs from the daily `privacy`
 * trigger (not limited to licensed sites); the actual report happens at most once a week.
 *
 * What the app stores per account (account IDs only; display names are looked up when shown, lib/names.js):
 *   pref-{id}, seen-{id}-{project}, seenf-{id}-{project}   preferences and last-visit markers   -> deleted
 *   plan-*, plans-*         createdBy, appliedById, rolledBackById                             -> set to null
 *   bulk-*, bulkidx         createdBy                                                          -> set to null
 *   snapidx-*               byId (who saved the snapshot)                                      -> set to null
 *   notes-*                 by (note author; the note text stays, it belongs to the team)      -> set to null
 *   rem-*, monitor-projects byId (who created the tasks / switched monitoring on)              -> set to null
 *   resfix-*                byId (who ran the resolution repair)                               -> set to null
 *   ai-settings             updatedBy, history[].by                                           -> set to null
 * Versions before 2026-11-23 also stored display names; `scrubStoredNames` removes them once.
 *
 * @file        src/lib/privacy.js
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-11-23
 * @updated     2026-11-23
 */

import { privacy } from '@forge/api';
import { kvs, WhereConditions } from '@forge/kvs';
import { chunkString } from '../shared/snapshot.js';

const LAST_RUN = 'privacy-last-report';
const SCRUBBED = 'privacy-names-scrubbed-v1';
const EVERY_MS = 7 * 86400000;
const BATCH = 90; // Atlassian's limit per call
const SYSTEM_AUTHORS = new Set(['Workflow Analyzer (auto)', 'Autopilot']);

// ---------------------------------------------------------------- storage walk

async function* scan(prefix) {
  let cursor;
  do {
    let q = kvs.query().where('key', WhereConditions.beginsWith(prefix)).limit(100);
    if (cursor) q = q.cursor(cursor);
    const page = await q.getMany();
    for (const r of page?.results || []) yield r;
    cursor = page?.nextCursor;
  } while (cursor);
}

async function* entries() {
  for (const prefix of ['plan-', 'plans-', 'bulk-', 'snapidx-', 'notes-', 'rem-', 'resfix-', 'pref-', 'seen-', 'seenf-']) {
    for await (const r of scan(prefix)) yield r;
  }
  for (const key of ['bulkidx', 'monitor-projects', 'ai-settings']) {
    const value = await kvs.get(key);
    if (value !== undefined && value !== null) yield { key, value };
  }
}

const values = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []);

/** The account references of one stored entry: [{ rec, field, at }], plus the key's own account (prefs, visits). */
function refsOf(key, value) {
  const out = [];
  const add = (rec, fields, at) => { for (const f of fields) if (rec && typeof rec[f] === 'string' && rec[f]) out.push({ rec, field: f, at }); };
  if (key.startsWith('plan-')) add(value, ['createdBy', 'appliedById', 'rolledBackById'], value?.appliedAt || value?.createdAt);
  else if (key.startsWith('plans-') || key === 'bulkidx') for (const e of values(value)) add(e, ['createdBy'], e?.createdAt);
  else if (key.startsWith('bulk-')) add(value, ['createdBy'], value?.createdAt);
  else if (key.startsWith('snapidx-')) for (const e of values(value)) add(e, ['byId'], e?.takenAt);
  else if (key.startsWith('notes-')) for (const n of values(value)) add(n, ['by'], n?.at);
  else if (key.startsWith('rem-')) for (const r of values(value)) add(r, ['byId'], r?.at);
  else if (key === 'monitor-projects') for (const p of values(value)) add(p, ['byId'], p?.since);
  else if (key.startsWith('resfix-')) for (const r of values(value)) add(r, ['byId'], r?.updatedAt || r?.at);
  else if (key === 'ai-settings') {
    add(value, ['updatedBy'], value?.updatedAt);
    for (const h of values(value?.history)) add(h, ['by'], h?.at);
  }
  return out;
}

const VISIT = /^seenf?-(.+)-([^-]+)$/;
/** Account ID a key belongs to (preferences and visit markers), else null. */
function keyAccount(key) {
  if (key.startsWith('pref-')) return key.slice(5);
  const m = VISIT.exec(key);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------- report and erase

/** accountId -> latest time the app stored something for it (ISO). */
export async function storedAccounts() {
  const out = new Map();
  const note = (id, at) => {
    if (!id) return;
    const t = at && !Number.isNaN(Date.parse(at)) ? new Date(at).toISOString() : new Date(0).toISOString();
    if (!out.has(id) || out.get(id) < t) out.set(id, t);
  };
  for await (const { key, value } of entries()) {
    const own = keyAccount(key);
    if (own) note(own, typeof value === 'string' ? value : value?.updatedAt || value?.at);
    for (const r of refsOf(key, value)) note(r.rec[r.field], r.at);
  }
  return out;
}

/** Deletes the account's own entries and removes it from every record (the records themselves stay). */
export async function eraseAccount(accountId) {
  let changed = 0;
  for await (const { key, value } of entries()) {
    if (keyAccount(key) === accountId) { await kvs.delete(key); changed++; continue; }
    const hits = refsOf(key, value).filter((r) => r.rec[r.field] === accountId);
    if (!hits.length) continue;
    for (const h of hits) h.rec[h.field] = null;
    await kvs.set(key, value);
    changed++;
  }
  return changed;
}

/**
 * Called daily; reports at most once every 7 days. `report` is Atlassian's privacy.reportPersonalData (injectable
 * for tests). Returns what it did.
 */
export async function reportPersonalData({ report = (a) => privacy.reportPersonalData(a), now = Date.now() } = {}) {
  await scrubStoredNames();
  const last = await kvs.get(LAST_RUN);
  if (last && now - new Date(last).getTime() < EVERY_MS) return { reported: 0, erased: 0, skipped: true };
  const accounts = [...(await storedAccounts()).entries()].map(([accountId, updatedAt]) => ({ accountId, updatedAt }));
  let erased = 0;
  for (let i = 0; i < accounts.length; i += BATCH) {
    const updates = (await report(accounts.slice(i, i + BATCH))) || [];
    for (const u of updates) {
      // "updated": nothing to do, the app stores no profile data. "closed": erase.
      if (u?.status === 'closed' && u.accountId) { await eraseAccount(u.accountId); erased++; }
    }
  }
  await kvs.set(LAST_RUN, new Date(now).toISOString());
  console.log(`[privacy] reported ${accounts.length} account(s), erased ${erased} closed account(s)`);
  return { reported: accounts.length, erased, skipped: false };
}

// ---------------------------------------------------------------- one-time clean-up of stored display names

/** Removes display names that versions before 2026-11-23 stored next to account IDs. Runs once per installation. */
export async function scrubStoredNames() {
  if (await kvs.get(SCRUBBED)) return { skipped: true };
  let changed = 0;
  const save = async (key, value) => { await kvs.set(key, value); changed++; };
  const strip = (rec, fields) => { let hit = false; for (const f of fields) if (rec && f in rec) { delete rec[f]; hit = true; } return hit; };

  for await (const { key, value } of entries()) {
    if (key.startsWith('plan-')) {
      if (strip(value, ['createdByName', 'appliedBy', 'rolledBackBy'])) await save(key, value);
    } else if (key.startsWith('plans-') || key === 'bulkidx') {
      let hit = false;
      for (const e of values(value)) {
        if (!e || !('createdByName' in e)) continue;
        delete e.createdByName;
        if (!e.createdBy) {
          const full = await kvs.get(key === 'bulkidx' ? `bulk-${e.id}` : `plan-${e.id}`);
          e.createdBy = full?.createdBy || null;
        }
        hit = true;
      }
      if (hit) await save(key, value);
    } else if (key.startsWith('bulk-')) {
      if (strip(value, ['createdByName'])) await save(key, value);
    } else if (key.startsWith('snapidx-')) {
      const projectId = key.slice('snapidx-'.length);
      let hit = false;
      for (const e of values(value)) {
        if (!e || !e.by || SYSTEM_AUTHORS.has(e.by)) continue;
        e.by = null;
        hit = true;
        await scrubSnapshotChunks(projectId, e);
      }
      if (hit) await save(key, value);
    } else if (key.startsWith('notes-')) {
      let hit = false;
      for (const n of values(value)) hit = strip(n, ['byName']) || hit;
      if (hit) await save(key, value);
    } else if (key.startsWith('rem-') || key === 'monitor-projects' || key.startsWith('resfix-')) {
      // these stored the display name in `by`; they now store the account ID in `byId`
      let hit = false;
      for (const r of values(value)) hit = strip(r, ['by']) || hit;
      if (hit) await save(key, value);
    } else if (key === 'ai-settings') {
      let hit = strip(value, ['updatedByName']);
      for (const h of values(value?.history)) hit = strip(h, ['byName']) || hit;
      if (hit) await save(key, value);
    }
  }
  await kvs.set(SCRUBBED, new Date().toISOString());
  if (changed) console.log(`[privacy] removed stored display names from ${changed} entr${changed === 1 ? 'y' : 'ies'}`);
  return { skipped: false, changed };
}

/** The snapshot body also carried the author's name: rewrite it without (chunk count may change). */
async function scrubSnapshotChunks(projectId, entry) {
  const chunkKey = (i) => `snap-${projectId}-${entry.id}-${i}`.replace(/[^a-zA-Z0-9:._\s#-]/g, '_');
  let str = '';
  for (let i = 0; i < entry.chunks; i++) str += (await kvs.get(chunkKey(i))) || '';
  let snap;
  try { snap = JSON.parse(str); } catch { return; }
  if (!snap || SYSTEM_AUTHORS.has(snap.by) || !snap.by) return;
  snap.by = null;
  const chunks = chunkString(JSON.stringify(snap));
  for (let i = 0; i < chunks.length; i++) await kvs.set(chunkKey(i), chunks[i]);
  for (let i = chunks.length; i < entry.chunks; i++) await kvs.delete(chunkKey(i));
  entry.chunks = chunks.length;
}
