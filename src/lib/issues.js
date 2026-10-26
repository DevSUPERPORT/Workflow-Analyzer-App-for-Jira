// Issue resolution check and repair. A wrong workflow leaves two kinds of damage in the issue data:
// issues in a Done status without a resolution (filters, reports and dashboards count them as open) and
// open issues that still carry a resolution (they count as resolved). The workflow fix only helps future
// transitions – this module finds the existing issues and repairs them in place, without changing their status.
//
// Everything runs as the user: the search only returns issues the user may browse, and the edit uses the
// user's permissions. Jira admins may override screen security (the Resolution field is rarely on an edit
// screen) and suppress notification mails; other users can only repair issues whose edit screen has the field.

import { route } from '@forge/api';
import { jira, approximateCount } from './jira.js';
import { kvs } from '@forge/kvs';

export const KINDS = {
  doneUnresolved: 'statusCategory = Done AND resolution is EMPTY',
  openResolved: 'statusCategory != Done AND resolution is not EMPTY',
};
export const BATCH = 20; // issues per repair call – stays well inside the resolver time limit
const KEY_RE = /^[A-Z][A-Z0-9_]{0,49}$/;
const ISSUE_RE = /^[A-Z][A-Z0-9_]{0,49}-\d{1,9}$/;
const RES_ID_RE = /^\d{1,12}$/;
const RUN_RE = /^[a-z0-9]{6,24}$/;
const MAX_RUNS = 20;
const MAX_RUN_ITEMS = 2000;

export const isProjectKey = (k) => KEY_RE.test(String(k ?? ''));

function jql(kind, projectKey) {
  if (!KINDS[kind]) throw new Error(`Unknown check "${kind}"`);
  return `${projectKey ? `project = "${projectKey}" AND ` : ''}${KINDS[kind]}`;
}

/** Counts of both kinds of damaged issues (project or whole site), as visible to the user. */
export async function resolutionAudit(projectKey) {
  const [doneUnresolved, openResolved] = await Promise.all([approximateCount(jql('doneUnresolved', projectKey)), approximateCount(jql('openResolved', projectKey))]);
  return { projectKey: projectKey || null, doneUnresolved, openResolved, at: new Date().toISOString() };
}

const slimIssue = (i) => ({
  key: i.key,
  summary: String(i.fields?.summary || '').slice(0, 200),
  status: i.fields?.status ? { id: String(i.fields.status.id), name: i.fields.status.name, category: i.fields.status.statusCategory?.key === 'done' ? 'DONE' : i.fields.status.statusCategory?.key === 'new' ? 'TODO' : 'IN_PROGRESS' } : null,
  resolution: i.fields?.resolution ? { id: String(i.fields.resolution.id), name: i.fields.resolution.name } : null,
  issueType: i.fields?.issuetype?.name || null,
  project: i.fields?.project ? { key: i.fields.project.key, name: i.fields.project.name } : null,
  updated: i.fields?.updated || null,
});

/** One page (max 100) of affected issues, newest first. */
export async function resolutionIssues(projectKey, kind, nextPageToken) {
  const body = {
    jql: `${jql(kind, projectKey)} ORDER BY updated DESC`,
    fields: ['summary', 'status', 'resolution', 'issuetype', 'project', 'updated'],
    maxResults: 100,
    ...(typeof nextPageToken === 'string' && nextPageToken.length < 2000 ? { nextPageToken } : {}),
  };
  const res = await jira(route`/rest/api/3/search/jql`, { method: 'POST', body, asUser: true });
  return { kind, issues: (res?.issues || []).map(slimIssue), nextPageToken: res?.nextPageToken || null };
}

function cleanItems(items) {
  const out = [];
  const seen = new Set();
  for (const it of Array.isArray(items) ? items : []) {
    const key = String(it?.key || '').toUpperCase();
    if (!ISSUE_RE.test(key) || seen.has(key)) continue;
    const norm = (v) => (v == null || v === '' ? null : RES_ID_RE.test(String(v)) ? String(v) : undefined);
    const from = norm(it.from);
    const to = norm(it.to);
    if (from === undefined || to === undefined || from === to) continue;
    seen.add(key);
    out.push({ key, from, to });
  }
  return out;
}

function describeError(e) {
  const text = String(e?.message || e);
  if (e?.code === 'CANNOT_CLEAR') return { code: 'CANNOT_CLEAR', message: text };
  if (e?.status === 404) return { code: 'NOT_FOUND', message: text };
  if (e?.status === 403 || e?.status === 401) return { code: 'NO_PERMISSION', message: text };
  if (/resolution/i.test(text) && /screen|cannot be set|not on the appropriate/i.test(text)) return { code: 'NOT_ON_SCREEN', message: text };
  return { code: 'FAILED', message: text.slice(0, 300) };
}

// Clearing: live Jira Cloud rejects {"fields":{"resolution":null}} with "Specify the Resolution (id or name) in the
// string format" (superportdev, 2026-10-26). Each shape is tried in turn; Jira rejects a wrong one with a 400 and changes
// nothing, so trying the next is safe. The shape that worked is remembered for the rest of the invocation.
export const CLEAR_BODIES = [
  { update: { resolution: [{ set: null }] } },
  { fields: { resolution: null } },
  { fields: { resolution: { id: null } } },
  { fields: { resolution: { name: null } } },
];
let clearShape = 0;
const shapeRejected = (e) => e?.status === 400 && /resolution/i.test(String(e?.message || '')) && !/screen|cannot be set|not on the appropriate/i.test(String(e?.message || ''));

async function writeResolution(path, to) {
  if (to) return jira(path, { method: 'PUT', asUser: true, body: { fields: { resolution: { id: to } } } });
  let last = null;
  for (let k = 0; k < CLEAR_BODIES.length; k++) {
    const i = (clearShape + k) % CLEAR_BODIES.length;
    try {
      await jira(path, { method: 'PUT', asUser: true, body: CLEAR_BODIES[i] });
      clearShape = i;
      return null;
    } catch (e) {
      if (!shapeRejected(e)) throw e;
      last = e;
    }
  }
  const err = new Error(`Jira cannot clear the resolution in place and no transition into this status clears it: ${String(last?.message || '').slice(0, 200)}`);
  err.code = 'CANNOT_CLEAR';
  throw err;
}

/**
 * Compare-and-set the resolution of up to BATCH issues: each item { key, from, to } (resolution IDs, null = none)
 * is only changed while the issue still has `from` – so a repeated or late call never overwrites a colleague's
 * edit, and undo is the same call with from/to swapped. The issue's status is never changed.
 * projectKey: issues must belong to this project (project page); null on the site page (Jira admins).
 */
/**
 * Clear through the workflow: run a transition into the issue's own status whose post function clears the
 * resolution (see clearingSelfTransitions). Jira records the transition and may send its event's notifications.
 * Returns false when no such transition is available to the user for this issue.
 */
async function clearByTransition(key, cur, clearing) {
  const candidates = clearing?.[`${cur?.fields?.issuetype?.id}|${cur?.fields?.status?.id}`];
  if (!candidates?.length) return false;
  const res = await jira(route`/rest/api/3/issue/${key}/transitions`, { asUser: true });
  const t = (res?.transitions || []).find((x) => candidates.includes(String(x.id)) && String(x.to?.id) === String(cur.fields.status.id));
  if (!t) return false;
  await jira(route`/rest/api/3/issue/${key}/transitions`, { method: 'POST', asUser: true, body: { transition: { id: String(t.id) } } });
  const after = await jira(route`/rest/api/3/issue/${key}?fields=resolution,status`, { asUser: true });
  if (after?.fields?.resolution) throw Object.assign(new Error(`Transition "${t.name}" ran but did not clear the resolution`), { code: 'CANNOT_CLEAR' });
  return t.name || true;
}

/**
 * clearing: clearingSelfTransitions() of the project's workflows (project page) – the reliable way to clear a
 * resolution on Jira Cloud. Without it (site page) only the edit API is tried.
 */
export async function repairResolutions({ projectKey, items, admin, clearing = null }) {
  const list = cleanItems(items);
  if (list.length > BATCH) throw new Error(`At most ${BATCH} issues per call`);
  const one = async (it) => {
    try {
      const cur = await jira(route`/rest/api/3/issue/${it.key}?fields=resolution,status,project,issuetype`, { asUser: true });
      if (projectKey && cur?.fields?.project?.key !== projectKey) return { ...it, status: 'failed', code: 'OUT_OF_SCOPE', message: `${it.key} is not in project ${projectKey}` };
      const now = cur?.fields?.resolution ? String(cur.fields.resolution.id) : null;
      if (now === it.to) return { ...it, status: 'skipped', code: 'ALREADY_DONE' };
      if (now !== it.from) return { ...it, status: 'skipped', code: 'CHANGED', current: now };
      if (!it.to) {
        const via = await clearByTransition(it.key, cur, clearing);
        if (via) return { ...it, status: 'repaired', via: typeof via === 'string' ? via : 'transition' };
      }
      const path = admin ? route`/rest/api/3/issue/${it.key}?notifyUsers=false&overrideScreenSecurity=true` : route`/rest/api/3/issue/${it.key}`;
      await writeResolution(path, it.to);
      return { ...it, status: 'repaired' };
    } catch (e) {
      return { ...it, status: 'failed', ...describeError(e) };
    }
  };
  const results = new Array(list.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, list.length) }, async () => {
    while (next < list.length) {
      const i = next++;
      results[i] = await one(list[i]);
    }
  }));
  return { results, silent: !!admin };
}

// ---------------------------------------------------------------- run log (undo across sessions)

const logKey = (scope) => `resfix-${String(scope).replace(/[^A-Za-z0-9_-]/g, '_')}`;

export async function listRuns(scope) {
  const runs = (await kvs.get(logKey(scope))) || [];
  // An undo that restored nothing (all failed) does not count: the original run stays undoable
  for (const r of runs) if (r.undoneBy && !runs.find((u) => u.id === r.undoneBy)?.items?.length) delete r.undoneBy;
  return runs;
}

/** Append the repaired items of one batch to a run (created on first use). */
export async function recordRun(scope, { runId, kind, by, undoOf, results }) {
  if (!RUN_RE.test(String(runId || ''))) throw new Error('Invalid run id');
  const done = results.filter((r) => r.status === 'repaired').map((r) => ({ key: r.key, from: r.from, to: r.to }));
  const runs = await listRuns(scope);
  let run = runs.find((r) => r.id === runId);
  if (!run) {
    run = { id: runId, kind: KINDS[kind] ? kind : null, at: new Date().toISOString(), by: by || null, undoOf: RUN_RE.test(String(undoOf || '')) ? undoOf : null, items: [], failed: 0, skipped: 0 };
    runs.unshift(run);
  }
  run.items = [...run.items, ...done].slice(0, MAX_RUN_ITEMS);
  run.failed += results.filter((r) => r.status === 'failed').length;
  run.skipped += results.filter((r) => r.status === 'skipped').length;
  run.updatedAt = new Date().toISOString();
  if (undoOf && run.items.length) {
    const orig = runs.find((r) => r.id === undoOf);
    if (orig) orig.undoneBy = runId;
  }
  await kvs.set(logKey(scope), runs.slice(0, MAX_RUNS));
  return run;
}
