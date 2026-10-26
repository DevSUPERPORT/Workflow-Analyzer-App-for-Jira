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
  if (e?.status === 404) return { code: 'NOT_FOUND', message: text };
  if (e?.status === 403 || e?.status === 401) return { code: 'NO_PERMISSION', message: text };
  if (/resolution/i.test(text) && /screen|cannot be set|not on the appropriate/i.test(text)) return { code: 'NOT_ON_SCREEN', message: text };
  return { code: 'FAILED', message: text.slice(0, 300) };
}

/**
 * Compare-and-set the resolution of up to BATCH issues: each item { key, from, to } (resolution IDs, null = none)
 * is only changed while the issue still has `from` – so a repeated or late call never overwrites a colleague's
 * edit, and undo is the same call with from/to swapped. The issue's status is never changed.
 * projectKey: issues must belong to this project (project page); null on the site page (Jira admins).
 */
export async function repairResolutions({ projectKey, items, admin }) {
  const list = cleanItems(items);
  if (list.length > BATCH) throw new Error(`At most ${BATCH} issues per call`);
  const one = async (it) => {
    try {
      const cur = await jira(route`/rest/api/3/issue/${it.key}?fields=resolution,status,project`, { asUser: true });
      if (projectKey && cur?.fields?.project?.key !== projectKey) return { ...it, status: 'failed', code: 'OUT_OF_SCOPE', message: `${it.key} is not in project ${projectKey}` };
      const now = cur?.fields?.resolution ? String(cur.fields.resolution.id) : null;
      if (now === it.to) return { ...it, status: 'skipped', code: 'ALREADY_DONE' };
      if (now !== it.from) return { ...it, status: 'skipped', code: 'CHANGED', current: now };
      const path = admin ? route`/rest/api/3/issue/${it.key}?notifyUsers=false&overrideScreenSecurity=true` : route`/rest/api/3/issue/${it.key}`;
      await jira(path, { method: 'PUT', asUser: true, body: { fields: { resolution: it.to ? { id: it.to } : null } } });
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
  return (await kvs.get(logKey(scope))) || [];
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
  if (undoOf) {
    const orig = runs.find((r) => r.id === undoOf);
    if (orig) orig.undoneBy = runId;
  }
  await kvs.set(logKey(scope), runs.slice(0, MAX_RUNS));
  return run;
}
