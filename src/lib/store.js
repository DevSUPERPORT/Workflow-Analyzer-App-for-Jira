/**
 * Forge KVS persistence: user preferences, team notes per transition, workflow snapshots (chunked), remediation
 * tasks, monitoring state and per-user visit tracking. All keys are sanitised so hostile IDs cannot reach other
 * storage entries. Who did something is stored as the account ID only; names are looked up when shown
 * (lib/names.js), and lib/privacy.js reports and erases account IDs.
 *
 * @file        src/lib/store.js
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-24
 * @updated     2026-11-23
 */

import { kvs } from '@forge/kvs';
import { chunkString } from '../shared/snapshot.js';

const MAX_SNAPSHOTS = 50;
const safeKey = (s) => String(s).replace(/[^a-zA-Z0-9:._\s#-]/g, '_');

// ---------------------------------------------------------------- preferences

export async function getPrefs(accountId) {
  if (!accountId) return {};
  return (await kvs.get(safeKey(`pref-${accountId}`))) || {};
}

export async function setPrefs(accountId, patch) {
  const allowed = {};
  // en / de and their regional variants (de-AT, de_CH, en-GB …); anything else is ignored
  const lang = /^(en|de)(?:[-_][a-z]{2,4})?$/i.exec(String(patch?.lang || ''))?.[1]?.toLowerCase();
  if (lang) allowed.lang = lang;
  if (patch && typeof patch.exportCustomer === 'string') allowed.exportCustomer = patch.exportCustomer.slice(0, 20);
  if (patch && typeof patch.tourDone === 'boolean') allowed.tourDone = patch.tourDone;
  const next = { ...(await getPrefs(accountId)), ...allowed, updatedAt: new Date().toISOString() };
  await kvs.set(safeKey(`pref-${accountId}`), next);
  return next;
}

// ---------------------------------------------------------------- notes

export async function getNotes(workflowIds) {
  const out = {};
  await Promise.all(
    (workflowIds || []).map(async (id) => {
      out[id] = (await kvs.get(safeKey(`notes-${id}`))) || {};
    }),
  );
  return out;
}

const ID_RE = /^[A-Za-z0-9:._-]{1,80}$/;
export const isSafeId = (v) => ID_RE.test(String(v ?? '')) && !['__proto__', 'constructor', 'prototype'].includes(String(v));

// Workflows a project may touch, cached when the project is loaded (authorisation of notes)
export async function setProjectWorkflows(projectId, ids) {
  await kvs.set(safeKey(`pwf-${projectId}`), { ids: ids.map(String), at: new Date().toISOString() });
}
export async function getProjectWorkflows(projectId) {
  return kvs.get(safeKey(`pwf-${projectId}`));
}

export async function saveNote(workflowId, transitionId, text, author) {
  if (!isSafeId(workflowId) || !isSafeId(transitionId)) throw new Error('Invalid workflow or transition id');
  const key = safeKey(`notes-${workflowId}`);
  const notes = (await kvs.get(key)) || {};
  const clean = String(text || '').slice(0, 4000);
  if (!clean.trim()) delete notes[transitionId];
  else notes[transitionId] = { text: clean, by: author?.accountId || null, at: new Date().toISOString() };
  await kvs.set(key, notes);
  return notes[transitionId] || null;
}

// ---------------------------------------------------------------- snapshots

const idxKey = (projectId) => safeKey(`snapidx-${projectId}`);
const chunkKey = (projectId, id, i) => safeKey(`snap-${projectId}-${id}-${i}`);

export async function listSnapshots(projectId) {
  return (await kvs.get(idxKey(projectId))) || [];
}

/** `byId`: account ID of the user who saved it (null for automatic snapshots, whose `by` is a system label). */
export async function saveSnapshot(projectId, snapshot, byId = null) {
  const id = Date.now().toString(36);
  const chunks = chunkString(JSON.stringify(snapshot));
  for (let i = 0; i < chunks.length; i++) await kvs.set(chunkKey(projectId, id, i), chunks[i]);
  const index = await listSnapshots(projectId);
  const entry = { id, takenAt: snapshot.takenAt, by: snapshot.by || null, byId: byId || null, label: snapshot.label, stats: snapshot.stats, chunks: chunks.length };
  index.unshift(entry);
  const removed = index.splice(MAX_SNAPSHOTS);
  await kvs.set(idxKey(projectId), index);
  for (const r of removed) await deleteChunks(projectId, r);
  return entry;
}

export async function getSnapshot(projectId, id) {
  const entry = (await listSnapshots(projectId)).find((s) => s.id === id);
  if (!entry) return null;
  let str = '';
  for (let i = 0; i < entry.chunks; i++) str += (await kvs.get(chunkKey(projectId, id, i))) || '';
  return JSON.parse(str);
}

async function deleteChunks(projectId, entry) {
  for (let i = 0; i < entry.chunks; i++) await kvs.delete(chunkKey(projectId, entry.id, i));
}

export async function deleteSnapshot(projectId, id) {
  const index = await listSnapshots(projectId);
  const entry = index.find((s) => s.id === id);
  if (!entry) return false;
  await deleteChunks(projectId, entry);
  await kvs.set(idxKey(projectId), index.filter((s) => s.id !== id));
  return true;
}

// ---------------------------------------------------------------- remediation tasks (finding fingerprint -> issue key)

export async function getRemediation(projectId) {
  return (await kvs.get(safeKey(`rem-${projectId}`))) || {};
}

export async function addRemediation(projectId, entries) {
  const map = await getRemediation(projectId);
  for (const e of entries) map[e.fingerprint] = { key: e.key, at: new Date().toISOString(), byId: e.byId || null };
  await kvs.set(safeKey(`rem-${projectId}`), map);
  return map;
}

// ---------------------------------------------------------------- monitoring

const MON_LIST = 'monitor-projects';

export async function getMonitoredProjects() {
  return (await kvs.get(MON_LIST)) || [];
}

export async function setMonitoring(project, enabled, byId) {
  const list = (await getMonitoredProjects()).filter((p) => p.id !== project.id);
  if (enabled) list.push({ id: project.id, key: project.key, since: new Date().toISOString(), byId: byId || null });
  await kvs.set(MON_LIST, list.slice(0, 200));
  return enabled;
}

export async function getMonitorState(projectId) {
  return (await kvs.get(safeKey(`monstate-${projectId}`))) || null;
}

export async function setMonitorState(projectId, state) {
  await kvs.set(safeKey(`monstate-${projectId}`), state);
}

// Per user + project: when did the user last open the analyzer (for "changed since your last visit")
/** Stores the finding keys of this visit and returns those of the previous one (null on the first visit). */
export async function swapSeenFindings(accountId, projectId, keys) {
  const key = safeKey(`seenf-${accountId}-${projectId}`);
  const prev = await kvs.get(key);
  await kvs.set(key, { at: new Date().toISOString(), keys });
  return prev || null;
}

export async function touchLastSeen(accountId, projectId) {
  const key = safeKey(`seen-${accountId}-${projectId}`);
  const prev = await kvs.get(key);
  await kvs.set(key, new Date().toISOString());
  return prev || null;
}

// ---------------------------------------------------------------- AI switch and monthly Forge LLM usage

// One record per installation. AI is OFF unless a Jira admin switched it on (a missing value means off).
const AI_SETTINGS = 'ai-settings';

export async function getAiSettings() {
  const s = (await kvs.get(AI_SETTINGS)) || {};
  return { aiEnabled: s.aiEnabled === true, updatedAt: s.updatedAt || null, updatedBy: s.updatedBy || null, history: Array.isArray(s.history) ? s.history : [] };
}

/** Saves the switch with who changed it and when; the last 50 changes are kept as a change log. */
export async function setAiEnabled(enabled, user) {
  const prev = await getAiSettings();
  const entry = { aiEnabled: enabled === true, at: new Date().toISOString(), by: user?.accountId || null };
  const next = { aiEnabled: entry.aiEnabled, updatedAt: entry.at, updatedBy: entry.by, history: [entry, ...prev.history].slice(0, 50) };
  await kvs.set(AI_SETTINGS, next);
  return next;
}

/** Calendar month in UTC, e.g. "2026-11". */
export const usageMonth = (date = new Date()) => date.toISOString().slice(0, 7);
const usageKey = (month) => `llm-usage:${month}`;

export async function getLlmUsage(month = usageMonth()) {
  const u = (await kvs.get(usageKey(month))) || {};
  return { month, calls: Number(u.calls) || 0, tokens: Number(u.tokens) || 0, eur: Number(u.eur) || 0 };
}

const round6 = (v) => Math.round(v * 1e6) / 1e6;

/** Counts one Forge LLM call, its tokens (0 when the response reported no usage) and its price in EUR. */
export async function addLlmUsage(month, tokens, eur = 0) {
  const u = await getLlmUsage(month);
  const next = { calls: u.calls + 1, tokens: u.tokens + (Number(tokens) > 0 ? Math.round(Number(tokens)) : 0), eur: round6(u.eur + (Number(eur) > 0 ? Number(eur) : 0)), updatedAt: new Date().toISOString() };
  await kvs.set(usageKey(month), next);
  return { month, ...next };
}
