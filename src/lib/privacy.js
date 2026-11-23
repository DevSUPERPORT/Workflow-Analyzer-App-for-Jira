/**
 * Atlassian's user privacy requirements: apps that store account IDs report them to the Personal Data Reporting API
 * at least every 7 days and erase the data of accounts Atlassian reports as closed. Runs from the daily `privacy`
 * trigger (not limited to licensed sites); the report itself happens every 6 days.
 *
 * Scale: the report reads only the account registry (`acct-{id}`, lib/accounts.js), one small entry per account.
 * Erasing closed accounts deletes their own entries by key prefix and then makes one pass over the shared records
 * (plans, notes, snapshot indexes, logs) for all closed accounts together. Every run has a time budget; unfinished
 * work continues the next day (the account stays in the registry, so Atlassian reports it as closed again).
 * Records are re-read right before they are changed, so a user's concurrent change is not overwritten.
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
 *   acct-{id}               the registry entry itself                                         -> deleted last
 *
 * One-time migration (versions before 2026-11-23): builds the registry from existing data and removes the display
 * names those versions stored next to account IDs. Resumable, within the same time budget.
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
import { ACCOUNT_PREFIX, accountKey } from './accounts.js';

const LAST_RUN = 'privacy-last-report';
const MIGRATION = 'privacy-migration-v1';
const EVERY_MS = 6 * 86400000; // daily trigger: a 6-day gap keeps every report within Atlassian's 7 days
const BATCH = 90; // Atlassian's limit per call
const BUDGET_MS = 8 * 60 * 1000; // the function may run 15 minutes
const SYSTEM_AUTHORS = new Set(['Workflow Analyzer (auto)', 'Autopilot']);
const safeKey = (s) => String(s).replace(/[^a-zA-Z0-9:._\s#-]/g, '_'); // as in store.js

// Shared records that reference accounts, and the keys that belong to one account
const RECORD_PREFIXES = ['plan-', 'plans-', 'bulk-', 'snapidx-', 'notes-', 'rem-', 'resfix-'];
const RECORD_KEYS = ['bulkidx', 'monitor-projects', 'ai-settings'];
const OWN_PREFIXES = ['pref-', 'seen-', 'seenf-'];

// ---------------------------------------------------------------- storage helpers

async function page(prefix, cursor) {
  let q = kvs.query().where('key', WhereConditions.beginsWith(prefix)).limit(100);
  if (cursor) q = q.cursor(cursor);
  const res = await q.getMany();
  return { results: res?.results || [], cursor: res?.nextCursor || null };
}

async function* scan(prefix) {
  let cursor = null;
  do {
    const p = await page(prefix, cursor);
    for (const r of p.results) yield r;
    cursor = p.cursor;
  } while (cursor);
}

const values = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []);

/** The account references of one stored record: [{ rec, field, at }]. */
function refsOf(key, value) {
  const out = [];
  const add = (rec, fields, at) => { for (const f of fields) if (rec && typeof rec[f] === 'string' && rec[f]) out.push({ rec, field: f, at }); };
  if (key.startsWith('plan-')) add(value, ['createdBy', 'appliedById', 'rolledBackById'], value?.rolledBackAt || value?.appliedAt || value?.createdAt);
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

const iso = (at) => (at && !Number.isNaN(Date.parse(at)) ? new Date(at).toISOString() : null);

// ---------------------------------------------------------------- report and erase

/** accountId -> last time the app stored something for it (ISO), from the registry. */
export async function storedAccounts() {
  const out = new Map();
  for await (const { key, value } of scan(ACCOUNT_PREFIX)) {
    const id = value?.id || key.slice(ACCOUNT_PREFIX.length);
    if (id) out.set(id, iso(value?.at) || new Date(0).toISOString());
  }
  return out;
}

/**
 * Erases these (closed) accounts: deletes their own entries, removes their IDs from every shared record (re-read
 * right before writing) and finally their registry entries. Returns false when the time budget ran out first.
 */
export async function eraseAccounts(ids, { deadline = Date.now() + BUDGET_MS } = {}) {
  const closed = new Set(ids);
  if (!closed.size) return true;
  for (const id of closed) {
    for (const prefix of OWN_PREFIXES) {
      const exact = prefix === 'pref-' ? safeKey(`pref-${id}`) : null;
      if (exact) { await kvs.delete(exact); continue; }
      for await (const { key } of scan(safeKey(`${prefix}${id}-`))) await kvs.delete(key);
    }
    if (Date.now() > deadline) return false;
  }
  const sources = [...RECORD_PREFIXES.map((p) => ({ prefix: p })), ...RECORD_KEYS.map((k) => ({ key: k }))];
  for (const s of sources) {
    const entries = s.prefix ? scan(s.prefix) : (async function* one() { const value = await kvs.get(s.key); if (value != null) yield { key: s.key, value }; })();
    for await (const { key, value } of entries) {
      if (!refsOf(key, value).some((r) => closed.has(r.rec[r.field]))) continue;
      const fresh = await kvs.get(key); // the page may be minutes old: change the current value only
      if (fresh == null) continue;
      const hits = refsOf(key, fresh).filter((r) => closed.has(r.rec[r.field]));
      if (!hits.length) continue;
      for (const h of hits) h.rec[h.field] = null;
      await kvs.set(key, fresh);
      if (Date.now() > deadline) return false;
    }
  }
  for (const id of closed) await kvs.delete(accountKey(id));
  return true;
}

/**
 * Called daily; reports every 6 days. `report` is Atlassian's privacy.reportPersonalData (injectable for tests).
 * Returns what it did.
 */
export async function reportPersonalData({ report = (a) => privacy.reportPersonalData(a), now = Date.now(), deadline = now + BUDGET_MS } = {}) {
  if (!(await migrate({ deadline }))) return { reported: 0, erased: 0, skipped: true, reason: 'migrating' };
  const last = await kvs.get(LAST_RUN);
  if (last && now - new Date(last).getTime() < EVERY_MS) return { reported: 0, erased: 0, skipped: true };
  const accounts = [...(await storedAccounts()).entries()].map(([accountId, updatedAt]) => ({ accountId, updatedAt }));
  const closed = new Set();
  for (let i = 0; i < accounts.length; i += BATCH) {
    const updates = (await report(accounts.slice(i, i + BATCH))) || [];
    // "updated": nothing to do, the app stores no profile data. "closed": erase below, all in one pass.
    for (const u of updates) if (u?.status === 'closed' && u.accountId) closed.add(u.accountId);
  }
  const finished = await eraseAccounts(closed, { deadline });
  if (!finished) {
    console.warn(`[privacy] erasing ${closed.size} closed account(s) continues tomorrow`);
    return { reported: accounts.length, erased: 0, skipped: false, unfinished: true };
  }
  await kvs.set(LAST_RUN, new Date(now).toISOString());
  console.log(`[privacy] reported ${accounts.length} account(s), erased ${closed.size} closed account(s)`);
  return { reported: accounts.length, erased: closed.size, skipped: false };
}

// ---------------------------------------------------------------- one-time migration

const MIGRATION_SOURCES = [...RECORD_PREFIXES, ...OWN_PREFIXES];

/**
 * Builds the registry from data stored by older versions and removes the display names they stored. Resumable:
 * progress is saved after every page. Returns true once done.
 */
export async function migrate({ deadline = Date.now() + BUDGET_MS } = {}) {
  const state = (await kvs.get(MIGRATION)) || { i: 0, cursor: null, singles: false };
  if (state.done) return true;
  const registry = new Map();
  const remember = (id, at) => { if (!id) return; const t = iso(at) || new Date(0).toISOString(); if (!registry.has(id) || registry.get(id) < t) registry.set(id, t); };
  const flush = async () => {
    for (const [id, at] of registry) {
      const cur = await kvs.get(accountKey(id));
      if (!cur || (cur.at || '') < at) await kvs.set(accountKey(id), { id, at });
    }
    registry.clear();
  };
  const visit = async (key, value) => {
    const own = keyAccount(key);
    if (own && OWN_PREFIXES.some((p) => key.startsWith(p))) remember(own, typeof value === 'string' ? value : value?.updatedAt || value?.at);
    for (const r of refsOf(key, value)) remember(r.rec[r.field], r.at);
    await scrubNames(key);
  };

  while (state.i < MIGRATION_SOURCES.length) {
    const p = await page(MIGRATION_SOURCES[state.i], state.cursor);
    for (const { key, value } of p.results) await visit(key, value);
    await flush();
    if (p.cursor) state.cursor = p.cursor; else { state.i++; state.cursor = null; }
    await kvs.set(MIGRATION, state);
    if (Date.now() > deadline) return false;
  }
  if (!state.singles) {
    for (const key of RECORD_KEYS) { const value = await kvs.get(key); if (value != null) await visit(key, value); }
    await flush();
    state.singles = true;
  }
  await kvs.set(MIGRATION, { ...state, done: new Date().toISOString() });
  return true;
}

/** Removes stored display names from one record (re-read fresh; written only when something changed). */
async function scrubNames(key) {
  const value = await kvs.get(key);
  if (value == null || typeof value !== 'object') return;
  const strip = (rec, fields) => { let hit = false; for (const f of fields) if (rec && typeof rec === 'object' && f in rec) { delete rec[f]; hit = true; } return hit; };
  let hit = false;
  if (key.startsWith('plan-')) hit = strip(value, ['createdByName', 'appliedBy', 'rolledBackBy']);
  else if (key.startsWith('plans-') || key === 'bulkidx') {
    for (const e of values(value)) {
      if (!e || !('createdByName' in e)) continue;
      delete e.createdByName;
      if (!e.createdBy) {
        const full = await kvs.get(key === 'bulkidx' ? `bulk-${e.id}` : `plan-${e.id}`);
        e.createdBy = full?.createdBy || null;
      }
      hit = true;
    }
  } else if (key.startsWith('bulk-')) hit = strip(value, ['createdByName']);
  else if (key.startsWith('snapidx-')) {
    const projectId = key.slice('snapidx-'.length);
    for (const e of values(value)) {
      if (!e || !e.by || SYSTEM_AUTHORS.has(e.by)) continue;
      e.by = null;
      hit = true;
      await scrubSnapshotChunks(projectId, e);
    }
  } else if (key.startsWith('notes-')) for (const n of values(value)) hit = strip(n, ['byName']) || hit;
  // these stored the display name in `by`; they now store the account ID in `byId`
  else if (key.startsWith('rem-') || key === 'monitor-projects' || key.startsWith('resfix-')) for (const r of values(value)) hit = strip(r, ['by']) || hit;
  else if (key === 'ai-settings') {
    hit = strip(value, ['updatedByName']);
    for (const h of values(value?.history)) hit = strip(h, ['byName']) || hit;
  }
  if (hit) await kvs.set(key, value);
}

/** The snapshot body also carried the author's name: rewrite it without (chunk count may change). */
async function scrubSnapshotChunks(projectId, entry) {
  const chunkKey = (i) => safeKey(`snap-${projectId}-${entry.id}-${i}`);
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
