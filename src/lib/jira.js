/**
 * Jira REST access for the Workflow Analyzer: paging, retries, project and workflow bundles, reference data,
 * status load, issue creation. Workflow configuration is read with the app's own permissions (asApp) because
 * project admins of company-managed projects cannot read shared workflows via REST; every entry point checks the
 * user's permissions first (see auth.js).
 *
 * @file        src/lib/jira.js
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-24
 * @updated     2026-11-16
 */

import api, { route, getAppContext } from '@forge/api';
import { collectRawRefs } from '../shared/engine.js';

const MAX_GROUP_PAGES = 40; // 40 * 50 = 2000 groups for name matching inside app configurations

export class JiraError extends Error {
  constructor(status, message, path) {
    super(message);
    this.status = status;
    this.path = path;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// POSTs that only read or validate may be repeated safely; everything else that writes is never resent
// after a 5xx, because Jira may already have processed it.
const IDEMPOTENT_POST = /\/rest\/api\/3\/(workflows|workflows\/update\/validation|search\/approximate-count|search\/jql)(\?|$)/;
// UI resolvers are cut off after ~25 s, so all waiting of one call stays within this budget.
const RETRY_BUDGET_MS = 9000;

function retryAfterMs(res, attempt) {
  const h = res.headers?.get?.('Retry-After');
  const secs = Number(h);
  if (h != null && Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = h ? Date.parse(h) : NaN;
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return 2 ** attempt * 500 + Math.floor(Math.random() * 250);
}

export async function jira(path, { method = 'GET', body, asUser = false, allow404 = false } = {}) {
  const requester = asUser ? api.asUser() : api.asApp();
  const safe = method === 'GET' || IDEMPOTENT_POST.test(String(path));
  let waited = 0;
  for (let attempt = 0; ; attempt++) {
    const res = await requester.requestJira(path, {
      method,
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    // 429 means "not processed" and is always retryable; gateway errors only for requests without side effects
    const retryable = res.status === 429 || (safe && [502, 503, 504].includes(res.status));
    if (retryable) {
      const wait = retryAfterMs(res, attempt);
      if (attempt < 5 && waited + wait <= RETRY_BUDGET_MS) {
        waited += wait;
        await sleep(wait);
        continue;
      }
      throw new JiraError(res.status, res.status === 429 ? `Jira is rate limiting this app – please try again in ${Math.max(1, Math.ceil(wait / 1000))} s` : `Jira is temporarily unavailable (${res.status}) – please try again`, String(path));
    }
    if (res.status === 404 && allow404) return null;
    if (res.status === 204) return null;
    const text = await res.text();
    if (!res.ok) throw new JiraError(res.status, `Jira ${res.status}: ${text.slice(0, 300)}`, String(path));
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      // proxies / maintenance pages on customer sites sometimes answer 200 with HTML
      throw new JiraError(502, `Jira returned an unexpected (non-JSON) response for ${String(path).split('?')[0]}`, String(path));
    }
  }
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

// ------------------------------------------------------------------ reference data

async function safe(warnings, label, fn, fallback) {
  try {
    return await fn();
  } catch (e) {
    // permission problems on optional data get a readable note instead of Jira's raw JSON
    if (e?.status === 401 || e?.status === 403) warnings.push(`${label}: not readable with the app's permissions – shown by ID`);
    else warnings.push(`${label}: ${e.status || ''} ${String(e.message || e).slice(0, 160)}`.trim());
    return fallback;
  }
}

// Pages are fetched in parallel (large client sites have thousands of groups; sequential paging timed out).
// Returns { groups, complete } – complete=false when the list was capped or a page failed.
async function getAllGroups(warnings) {
  const page = (n) => jira(route`/rest/api/3/group/bulk?startAt=${n * 50}&maxResults=50`);
  const map = (res) => (res?.values || []).map((g) => ({ groupId: g.groupId, name: g.name }));
  const first = await safe(warnings, 'groups', () => page(0), null);
  if (!first) return { groups: null, complete: false };
  const groups = map(first);
  if (first.isLast !== false || !first.values?.length) return { groups, complete: true };
  const total = Number(first.total) || 0;
  const pages = total ? Math.min(MAX_GROUP_PAGES, Math.ceil(total / 50)) : MAX_GROUP_PAGES;
  let complete = !total || total <= MAX_GROUP_PAGES * 50;
  const rest = await pool(Array.from({ length: pages - 1 }, (_, i) => i + 1), 6, async (n) => {
    try {
      return await page(n);
    } catch (e) {
      complete = false;
      warnings.push(`groups page ${n}: ${String(e?.message || e).slice(0, 120)}`);
      return null;
    }
  });
  for (const res of rest) groups.push(...map(res));
  if (!total && rest.length && rest[rest.length - 1]?.isLast === false) complete = false;
  if (!complete) warnings.push(`groups: ${groups.length} groups loaded in the overview – referenced groups are resolved individually`);
  return { groups, complete };
}

async function getGroupsBy(param, values, warnings) {
  const out = [];
  let ok = true;
  for (const c of chunk(values, 40)) {
    const params = new URLSearchParams();
    c.forEach((v) => params.append(param, v));
    params.set('maxResults', '50');
    const res = await safe(warnings, `groups by ${param}`, () => jira(route`/rest/api/3/group/bulk?${params}`), null);
    if (res) out.push(...(res.values || []).map((g) => ({ groupId: g.groupId, name: g.name })));
    else ok = false;
  }
  return { groups: out, ok };
}

/**
 * Makes sure the given group IDs / names are in ref.groups (looked up directly when the overview list is capped).
 * Used for the Autopilot, where users and the AI may name groups that no workflow references yet.
 */
export async function ensureGroups(ref, { ids = [], names = [] } = {}, warnings = []) {
  if (!ref) return ref;
  const list = ref.groups || [];
  const byId = new Set(list.map((g) => g.groupId));
  const byName = new Set(list.map((g) => g.name.toLowerCase()));
  const missingIds = [...new Set(ids.map(String))].filter((id) => id && !byId.has(id));
  const missingNames = [...new Set(names.map(String))].filter((n) => n && !byName.has(n.toLowerCase()));
  if (!missingIds.length && !missingNames.length) return ref;
  const a = missingIds.length ? await getGroupsBy('groupId', missingIds, warnings) : { groups: [], ok: true };
  const b = missingNames.length ? await getGroupsBy('groupName', missingNames, warnings) : { groups: [], ok: true };
  const merged = new Map(list.map((g) => [g.groupId, g]));
  for (const g of [...a.groups, ...b.groups]) merged.set(g.groupId, g);
  ref.groups = [...merged.values()];
  if (!a.ok || !b.ok) ref.groupsComplete = false;
  return ref;
}

async function getUsers(accountIds, warnings) {
  const out = [];
  for (const c of chunk(accountIds, 50)) {
    const params = new URLSearchParams();
    c.forEach((id) => params.append('accountId', id));
    params.set('maxResults', '50');
    const res = await safe(warnings, 'users', () => jira(route`/rest/api/3/user/bulk?${params}`), null);
    if (res) out.push(...(res.values || []).map((u) => ({ accountId: u.accountId, displayName: u.displayName, active: u.active, accountType: u.accountType })));
  }
  return out;
}

async function getScreens(ids, warnings) {
  const out = [];
  for (const c of chunk(ids, 50)) {
    const params = new URLSearchParams();
    c.forEach((id) => params.append('id', id));
    params.set('maxResults', '100');
    let res = null;
    try {
      res = await jira(route`/rest/api/3/screens?${params}`);
    } catch (e) {
      // GET /screens needs the classic manage:jira-project scope (verified live), which the app does not request on
      // purpose (it would grant write access to project configuration) – screens are then shown by ID, silently
      if (e?.status === 401 || e?.status === 403) return null;
      warnings.push(`screens: ${e.status || ''} ${String(e.message || e).slice(0, 160)}`.trim());
    }
    if (res) out.push(...(res.values || []).map((s) => ({ id: String(s.id), name: s.name })));
  }
  return out;
}

/**
 * Resolve reference data. `ids` is the output of collectRawRefs(workflows).
 */
export async function getReferenceData(ids, warnings, { firstWorkflowId } = {}) {
  ids = { group: [], groupName: [], user: [], screen: [], ...(ids || {}) };
  const [fields, roles, groups, users, screens, permissions, capabilities, resolutions, events] = await Promise.all([
    safe(warnings, 'fields', () => jira(route`/rest/api/3/field`), null),
    safe(warnings, 'roles', () => jira(route`/rest/api/3/role`), null),
    getAllGroups(warnings),
    getUsers(ids.user, warnings),
    getScreens(ids.screen, warnings),
    safe(warnings, 'permissions', () => jira(route`/rest/api/3/permissions`), null),
    firstWorkflowId ? safe(warnings, 'capabilities', () => jira(route`/rest/api/3/workflows/capabilities?workflowId=${firstWorkflowId}`), null) : null,
    safe(warnings, 'resolutions', () => jira(route`/rest/api/3/resolution`), null),
    safe(warnings, 'events', () => jira(route`/rest/api/3/events`), null),
  ]);

  // Referenced groups missing from the (possibly capped) list are resolved directly by ID / name, so that
  // "unresolved group" findings are only reported when Jira confirmed the group does not exist.
  const groupRef = { groups: groups.groups, groupsComplete: groups.complete };
  if (groups.groups && !groups.complete) {
    groupRef.groupsComplete = true;
    await ensureGroups(groupRef, { ids: ids.group, names: ids.groupName || [] }, warnings);
  }

  return {
    fields: fields ? fields.map((f) => ({ id: f.id, name: f.name, custom: f.custom, schema: f.schema ? { type: f.schema.type, custom: f.schema.custom } : null })) : null,
    roles: roles ? roles.map((r) => ({ id: String(r.id), name: r.name })) : null,
    groups: groupRef.groups,
    // false: some lookups failed – unknown groups are shown as "unknown" instead of "deleted"
    groupsComplete: groupRef.groups ? groupRef.groupsComplete !== false : false,
    users,
    screens,
    resolutions: resolutions ? resolutions.map((r) => ({ id: String(r.id), name: r.name })) : [],
    // Issue events incl. custom ones (the transition's "Event"); without them the system events are used
    events: events ? events.map((e) => ({ id: String(e.id), name: e.name })) : null,
    permissions: permissions ? Object.fromEntries(Object.entries(permissions.permissions || {}).map(([k, p]) => [k, { name: p.name }])) : null,
    capabilities: capabilities
      ? {
          systemRules: (capabilities.systemRules || []).map((r) => ({ ruleKey: r.ruleKey, name: r.name, ruleType: r.ruleType })),
          connectRules: (capabilities.connectRules || []).map((r) => ({ ruleKey: r.ruleKey, name: r.name, ruleType: r.ruleType, addonKey: r.addonKey, moduleKey: r.moduleKey })),
          forgeRules: (capabilities.forgeRules || []).map((r) => ({ ruleKey: r.ruleKey, name: r.name, ruleType: r.ruleType, id: r.id })),
        }
      : null,
  };
}

// Host of the current site, kept for one invocation only: a Forge function container serves many sites.
let hostCache = { invocationId: null, host: null };

/**
 * Host of the Jira site this invocation runs for, e.g. "bigcorp.atlassian.net" (for per-site AI caps). From
 * serverInfo.baseUrl, read as the app: works the same in resolvers, Rovo actions and triggers (the Forge app
 * context carries no site URL). baseUrl stays the *.atlassian.net address even with a custom domain (displayUrl).
 */
export async function siteHost() {
  let invocationId = null;
  try {
    invocationId = getAppContext()?.invocationId || null;
  } catch { /* outside the Forge runtime: no cache */ }
  if (invocationId && hostCache.invocationId === invocationId) return hostCache.host;
  const info = await jira(route`/rest/api/3/serverInfo`);
  const host = new URL(String(info?.baseUrl || '')).host.toLowerCase();
  if (invocationId) hostCache = { invocationId, host };
  return host;
}

// ------------------------------------------------------------------ project bundle

/**
 * Project details. Enterprise permission schemes often drop the "atlassian-addons-project-access" role, so the
 * app itself cannot see the project – the user (a project admin) can, so we fall back to their permissions.
 */
export async function getProject(projectIdOrKey) {
  const path = route`/rest/api/3/project/${projectIdOrKey}?expand=issueTypes`;
  try {
    return await jira(path);
  } catch (e) {
    if (e?.status !== 404 && e?.status !== 403) throw e;
    return jira(path, { asUser: true });
  }
}

/** All projects using a workflow (follows nextPageToken – default workflows are shared by hundreds of projects). */
export async function workflowProjectIds(workflowId) {
  const out = [];
  let token = '';
  for (let i = 0; i < 50; i++) {
    const params = new URLSearchParams({ maxResults: '200' });
    if (token) params.set('nextPageToken', token);
    const res = await jira(route`/rest/api/3/workflow/${workflowId}/projectUsages?${params}`);
    out.push(...(res?.projects?.values || []).map((p) => String(p.id)));
    token = res?.projects?.nextPageToken;
    if (!token) break;
  }
  return [...new Set(out)];
}

/**
 * Project → issue types using a workflow. One bulk request with expand=workflows.usages; projects missing from
 * that answer are fetched individually in parallel. Returns { map: Map<projectId, issueTypeIds[]>, unreadable: [] }.
 */
export async function workflowUsageMap(workflowId) {
  const projectIds = await workflowProjectIds(workflowId);
  const map = new Map();
  try {
    const res = await jira(route`/rest/api/3/workflows?expand=workflows.usages`, { method: 'POST', body: { workflowIds: [String(workflowId)] } });
    for (const u of res?.workflows?.[0]?.usages || []) {
      const pid = String(u.project?.id ?? u.projectId ?? '');
      const its = (u.issueTypes || u.issueTypeIds || []).map((x) => String(x?.id ?? x));
      if (pid && its.length) map.set(pid, [...new Set([...(map.get(pid) || []), ...its])]);
    }
  } catch {
    // expand not supported – fall back to per-project requests below
  }
  const unreadable = [];
  await pool(projectIds.filter((pid) => !map.has(pid)), 8, async (pid) => {
    const its = await workflowIssueTypeIds(workflowId, pid);
    if (its === null) unreadable.push(pid);
    else if (its.length) map.set(pid, its);
  });
  return { map, unreadable, projectIds };
}

/** Issue types of a project that use a workflow; null when the project cannot be read (archived / deleted). */
export async function workflowIssueTypeIds(workflowId, projectId) {
  const out = [];
  let token = '';
  for (let i = 0; i < 20; i++) {
    const params = new URLSearchParams({ maxResults: '200' });
    if (token) params.set('nextPageToken', token);
    const res = await jira(route`/rest/api/3/workflow/${workflowId}/project/${projectId}/issueTypeUsages?${params}`, { allow404: true });
    if (res === null) return null;
    out.push(...(res?.issueTypes?.values || []).map((it) => String(it.id)));
    token = res?.issueTypes?.nextPageToken;
    if (!token) break;
  }
  return out;
}

/**
 * Jira's bulk workflow request (POST /workflows) returns no change dates; only the workflow search does. Adds
 * created/updated to workflows that lack them, matched by ID (one search by name per workflow). Never throws.
 */
async function addWorkflowDates(workflows, warnings) {
  await pool(workflows.filter((wf) => !wf.updated && wf.name), 4, async (wf) => {
    const res = await safe(warnings, `dates of ${wf.name}`, () => jira(route`/rest/api/3/workflows/search?queryString=${wf.name}&maxResults=50`), null);
    const hit = (res?.values || []).find((v) => String(v.id) === String(wf.id));
    if (hit) { wf.created = hit.created || wf.created; wf.updated = hit.updated || wf.updated; }
  });
}

/**
 * Load every workflow used by a project together with all reference data.
 */
export async function getProjectBundle(projectIdOrKey) {
  const warnings = [];
  const project = await getProject(projectIdOrKey);
  const issueTypes = (project.issueTypes || []).map((it) => ({ id: String(it.id), name: it.name, iconUrl: it.iconUrl, subtask: !!it.subtask }));

  const workflowsById = new Map();
  const statusesById = new Map();
  const mapping = [];
  await pool(issueTypes, 4, async (it) => {
    const res = await safe(warnings, `workflow for ${it.name}`, () =>
      jira(route`/rest/api/3/workflows`, { method: 'POST', body: { projectAndIssueTypes: [{ projectId: String(project.id), issueTypeId: it.id }] } }), null);
    for (const wf of res?.workflows || []) {
      workflowsById.set(String(wf.id), wf);
      mapping.push({ issueTypeId: it.id, workflowId: String(wf.id) });
    }
    for (const s of res?.statuses || []) statusesById.set(String(s.id), s);
  });

  const workflows = [...workflowsById.values()];
  await addWorkflowDates(workflows, warnings);
  const ref = await getReferenceData(collectRawRefs(workflows), warnings, { firstWorkflowId: workflows[0]?.id });

  return {
    kind: 'project',
    generatedAt: new Date().toISOString(),
    project: {
      id: String(project.id),
      key: project.key,
      name: project.name,
      style: project.style,
      projectTypeKey: project.projectTypeKey,
      avatar: project.avatarUrls?.['48x48'] || null,
      lead: project.lead ? project.lead.displayName : null,
    },
    issueTypes,
    mapping,
    workflows,
    statuses: [...statusesById.values()],
    ref,
    warnings,
  };
}

// ------------------------------------------------------------------ site-wide scan

export async function searchWorkflowsPage(startAt = 0, maxResults = 20) {
  const page = await jira(route`/rest/api/3/workflows/search?startAt=${startAt}&maxResults=${maxResults}&orderBy=name`);
  const ids = (page.values || []).map((w) => String(w.id));
  let full = { workflows: [], statuses: [] };
  if (ids.length) full = await jira(route`/rest/api/3/workflows`, { method: 'POST', body: { workflowIds: ids } });
  // the search page has the change dates the bulk request lacks
  const dates = new Map((page.values || []).map((w) => [String(w.id), w]));
  for (const wf of full.workflows || []) {
    const d = dates.get(String(wf.id));
    if (d) { wf.created = wf.created || d.created || null; wf.updated = wf.updated || d.updated || null; }
  }
  return {
    total: page.total ?? ids.length,
    isLast: page.isLast !== false,
    nextStartAt: startAt + ids.length,
    workflows: full.workflows || [],
    statuses: full.statuses || [],
  };
}

/** IDs of the workflows a project uses (no reference data – cheap, used for authorisation checks). */
export async function projectWorkflowIds(projectId) {
  const project = await getProject(projectId);
  const ids = new Set();
  await pool((project.issueTypes || []).map((it) => String(it.id)), 6, async (issueTypeId) => {
    const res = await jira(route`/rest/api/3/workflows`, { method: 'POST', body: { projectAndIssueTypes: [{ projectId: String(project.id), issueTypeId }] } }).catch(() => null);
    for (const wf of res?.workflows || []) ids.add(String(wf.id));
  });
  return [...ids];
}

/**
 * Projects using each workflow. visibleToUser: names/keys only for projects the calling user can see – a project
 * admin must not learn the names of projects they have no access to; hidden ones are counted, not named.
 */
export async function getWorkflowProjects(workflowIds, { visibleToUser = false } = {}) {
  const warnings = [];
  const usage = {};
  await pool(workflowIds, 4, async (id) => {
    usage[id] = (await safe(warnings, `projectUsages ${id}`, () => workflowProjectIds(id), null)) || [];
  });
  const allIds = [...new Set(Object.values(usage).flat())];
  const projects = new Map();
  for (const c of chunk(allIds, 50)) {
    const params = new URLSearchParams();
    c.forEach((id) => params.append('id', id));
    params.set('maxResults', '50');
    const res = await safe(warnings, 'projects', () => jira(route`/rest/api/3/project/search?${params}`, { asUser: visibleToUser }), null);
    for (const p of res?.values || []) projects.set(String(p.id), { id: String(p.id), key: p.key, name: p.name });
  }
  // Projects hidden from the app by their permission scheme: try with the user's permissions
  const hidden = allIds.filter((id) => !projects.has(id));
  for (const c of chunk(hidden, 50)) {
    const params = new URLSearchParams();
    c.forEach((id) => params.append('id', id));
    params.set('maxResults', '50');
    const res = await safe(warnings, 'projects (user)', () => jira(route`/rest/api/3/project/search?${params}`, { asUser: true }), null);
    for (const p of res?.values || []) projects.set(String(p.id), { id: String(p.id), key: p.key, name: p.name });
  }
  const out = {};
  for (const [wf, ids] of Object.entries(usage)) out[wf] = ids.map((id) => projects.get(id) || (visibleToUser ? { id, key: null, name: null, hidden: true } : { id, key: id, name: id }));
  return { usage: out, warnings };
}

// ------------------------------------------------------------------ phase 2: live data, issue creation

export async function approximateCount(jql) {
  const res = await jira(route`/rest/api/3/search/approximate-count`, { method: 'POST', body: { jql }, asUser: true });
  return Number(res?.count ?? 0);
}

const numericIds = (arr, max) => [...new Set((Array.isArray(arr) ? arr : []).map(String).filter((s) => /^\d+$/.test(s)))].slice(0, max);

async function countByStatus(scope, ids, days) {
  const byStatus = {};
  await pool(ids, 4, async (id) => {
    const [count, stale] = await Promise.all([
      approximateCount(`${scope} AND status = ${id}`),
      approximateCount(`${scope} AND status = ${id} AND updated <= -${days}d`),
    ]);
    let ever = count;
    if (count === 0) ever = await approximateCount(`${scope} AND status WAS ${id}`).catch(() => null);
    byStatus[id] = { count, stale, ever };
  });
  return byStatus;
}

/**
 * Issue load per status for a project (counts respect the user's browse permissions).
 * statusIds: numeric status IDs of the project's workflows.
 * workflows: [{ id, issueTypeIds, statusIds }] – when a project uses several workflows, each one is also counted
 * for its own issue types only (byWorkflow); otherwise two workflows sharing a status ("Backlog") both showed all
 * of the project's issues in it. All IDs are filtered to digits before they reach JQL.
 */
export async function getStatusLoad(projectKey, statusIds, staleDays = 30, workflows = []) {
  const key = String(projectKey).replace(/[^A-Za-z0-9_]/g, '');
  const ids = numericIds(statusIds, 80);
  const days = Math.min(365, Math.max(1, Number(staleDays) || 30));
  const project = `project = "${key}"`;
  const byStatus = await countByStatus(project, ids, days);
  const byWorkflow = {};
  const wfs = (Array.isArray(workflows) ? workflows : [])
    .map((w) => ({ id: String(w?.id || '').slice(0, 80), types: numericIds(w?.issueTypeIds, 50), statuses: numericIds(w?.statusIds, 40).filter((s) => ids.includes(s)) }))
    .filter((w) => w.id && w.types.length && w.statuses.length)
    .slice(0, 10);
  if (wfs.length > 1) {
    for (const w of wfs) {
      const scope = `${project} AND issuetype in (${w.types.join(', ')})`;
      byWorkflow[w.id] = { byStatus: await countByStatus(scope, w.statuses, days), total: await approximateCount(`${scope} AND statusCategory != Done`), all: await approximateCount(scope) };
    }
  }
  const total = await approximateCount(`${project} AND statusCategory != Done`);
  const all = await approximateCount(project);
  return { byStatus, byWorkflow, total, all, staleDays: days, at: new Date().toISOString() };
}

/** What getStatusLoad needs to count per workflow: its issue types and statuses. */
export function loadScopes(model) {
  return model.workflows.map((w) => ({ id: w.id, issueTypeIds: w.issueTypes.map((i) => String(i.id)), statusIds: w.statuses.map((s) => s.id).filter(Boolean) }));
}

export async function getCreatableIssueTypes(projectKey) {
  const res = await jira(route`/rest/api/3/issue/createmeta/${projectKey}/issuetypes?maxResults=50`, { asUser: true });
  return (res?.issueTypes || res?.values || []).filter((t) => !t.subtask).map((t) => ({ id: String(t.id), name: t.name }));
}

export async function createIssue({ projectKey, issueTypeId, summary, description, labels }) {
  const res = await jira(route`/rest/api/3/issue`, {
    method: 'POST',
    asUser: true,
    body: { fields: { project: { key: projectKey }, issuetype: { id: String(issueTypeId) }, summary, description, labels } },
  });
  return res?.key;
}

/** Bundle for specific workflows (site-wide bulk changes), same shape as getProjectBundle. */
export async function getWorkflowBundle(workflowIds) {
  const warnings = [];
  const ids = [...new Set((workflowIds || []).map(String))];
  const res = ids.length ? await jira(route`/rest/api/3/workflows`, { method: 'POST', body: { workflowIds: ids } }) : { workflows: [], statuses: [] };
  const workflows = res?.workflows || [];
  const ref = await getReferenceData(collectRawRefs(workflows), warnings, { firstWorkflowId: workflows[0]?.id });
  return { kind: 'site', generatedAt: new Date().toISOString(), project: { id: 'site', key: 'SITE', name: 'Site' }, issueTypes: [], mapping: [], workflows, statuses: res?.statuses || [], ref, warnings };
}
