/**
 * In-memory Jira Cloud simulation for the backend end-to-end tests. Implements the REST endpoints the app uses
 * and the validation rules discovered live on a Jira Cloud test site.
 *
 * Rules covered: no conditions on INITIAL, team-managed spaces reject resolution "update field" rules, status
 * removal needs per project/issue type mappings with the removed status still listed, optimistic version checks,
 * and injectable 429 rate limiting.
 *
 * @file        tests/fakejira/fake.js
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-24
 * @updated     2026-11-16
 */

const clone = (o) => JSON.parse(JSON.stringify(o));

export class FakeJira {
  constructor() {
    this.projects = [];
    this.workflows = new Map();
    this.statuses = new Map();
    this.assign = new Map(); // projectId -> { issueTypeId: workflowId }
    this.groups = [];
    this.users = [];
    this.roles = [{ id: '10002', name: 'Administrators' }, { id: '10001', name: 'Developers' }];
    this.fields = [{ id: 'assignee', name: 'Assignee' }, { id: 'resolution', name: 'Resolution' }, { id: 'duedate', name: 'Due date' }, { id: 'customfield_10010', name: 'Cost centre', custom: true }];
    this.screens = [{ id: '1', name: 'Default Screen' }, { id: '2', name: 'Resolve Screen' }];
    this.resolutions = [{ id: '10000', name: 'Done' }, { id: '10001', name: "Won't Do" }];
    this.issues = [];
    this.me = { accountId: 'user-admin', displayName: 'Test Admin', locale: 'de_DE' };
    this.baseUrl = 'https://fake.atlassian.net';
    this.perms = { ADMINISTER: true, projectAdmin: new Set() };
    this.rateLimitEvery = 0;
    this.calls = 0;
    this.log = [];
    this.forceValidationError = null;
    // [{ match: RegExp on 'METHOD path', status, times, body }] – injected failures
    this.faults = [];
    this.usagePageSize = 200; // Jira pages workflow usages with nextPageToken
    this.archived = new Set();
    this.screensReadable = false;
    this.usagesExpandCap = 0; // live superportdev 2026-10: expand=workflows.usages is accepted but returns no usages // archived projects: still listed as usages, issue type usages 404
    this.appHidden = new Set(); // projects whose permission scheme does not grant the app (asApp) access
    this.nextStatusId = 20000;
    this.nextIssue = 1;
    // Live superportdev: the Resolution field is on no edit screen; only Jira admins may override screen security
    this.resolutionOnEditScreen = false;
    this.edits = [];
  }

  // ------------------------------------------------------------- seeding helpers
  addStatus(name, statusCategory, description) {
    const id = String(this.nextStatusId++);
    this.statuses.set(id, { id, name, statusCategory, statusReference: id, ...(description != null ? { description } : {}) });
    return id;
  }

  addProject({ id, key, name, style = 'classic', issueTypes = [{ id: '1', name: 'Task' }] }) {
    this.projects.push({ id: String(id), key, name, style, issueTypes });
    this.perms.projectAdmin.add(String(id));
    this.assign.set(String(id), {});
  }

  addWorkflow(wf, { projectId, issueTypeIds }) {
    const w = clone(wf);
    w.version ||= { id: `v-${w.id}-0`, versionNumber: 0 };
    this.workflows.set(w.id, w);
    for (const pid of [].concat(projectId)) {
      const a = this.assign.get(String(pid)) || {};
      for (const it of issueTypeIds) a[it] = w.id;
      this.assign.set(String(pid), a);
    }
    return w;
  }

  addIssue({ projectId, issueTypeId = '1', statusId, updated = new Date().toISOString(), resolution = null, summary = 'Issue' }) {
    const p = this.projects.find((x) => x.id === String(projectId));
    const issue = { key: `${p.key}-${this.nextIssue++}`, projectId: String(projectId), issueTypeId, statusId: String(statusId), updated, resolution, summary };
    this.issues.push(issue);
    return issue;
  }

  workflowUsage(wfId) {
    const out = [];
    for (const [pid, a] of this.assign) for (const [it, w] of Object.entries(a)) if (w === wfId) out.push({ projectId: pid, issueTypeId: it });
    return out;
  }

  statusesFor(wf) {
    return wf.statuses.map((s) => this.statuses.get(String(s.statusReference))).filter(Boolean);
  }

  // ------------------------------------------------------------- HTTP layer
  async request(path, { method = 'GET', body } = {}, asUser = false) {
    this.calls++;
    this.log.push(`${asUser ? 'U' : 'A'} ${method} ${path}`);
    if (this.rateLimitEvery && this.calls % this.rateLimitEvery === 0) return respond(429, { errorMessages: ['Rate limit'] }, { 'Retry-After': '0.01' });
    const fault = this.faults.find((x) => x.times !== 0 && x.match.test(`${method} ${path}`));
    if (fault) {
      if (fault.times > 0) fault.times--;
      this.log[this.log.length - 1] = `FAULT ${this.log[this.log.length - 1]}`;
      return respond(fault.status, fault.body || { errorMessages: [`Injected ${fault.status}`] }, fault.status === 429 ? { 'Retry-After': '0.01' } : {});
    }
    const url = new URL(path, 'https://fake.atlassian.net');
    const p = url.pathname;
    const q = url.searchParams;
    const json = body ? JSON.parse(body) : null;
    try {
      const out = this.route(method, p, q, json, asUser);
      return out instanceof Response0 ? out : respond(200, out);
    } catch (e) {
      return respond(e.status || 400, { errorMessages: [e.message] });
    }
  }

  route(method, p, q, body, asUser) {
    let m;
    if (method === 'GET' && p === '/rest/api/3/myself') return this.me;
    if (method === 'GET' && p === '/rest/api/3/serverInfo') return { baseUrl: this.baseUrl, displayUrl: this.baseUrl, deploymentType: 'Cloud' };
    if (method === 'GET' && p === '/rest/api/3/mypermissions') {
      const keys = (q.get('permissions') || '').split(',');
      const pref = q.get('projectId') || q.get('projectKey');
      const proj = pref ? this.projects.find((x) => x.id === pref || x.key === pref) : null;
      if (pref && !proj) throw err(404, 'No project could be found with id ' + pref);
      const pid = proj?.id || null;
      const has = (k) => (k === 'ADMINISTER' ? this.perms.ADMINISTER : k === 'ADMINISTER_PROJECTS' ? this.perms.ADMINISTER || (pid && this.perms.projectAdmin.has(pid)) : true);
      return { permissions: Object.fromEntries(keys.map((k) => [k, { key: k, havePermission: !!has(k) }])) };
    }
    if (method === 'GET' && p === '/rest/api/3/project/search') {
      const ids = q.getAll('id');
      return { values: this.projects.filter((x) => (!ids.length || ids.includes(x.id)) && (asUser ? !this.hiddenFromUser?.has(x.id) : !this.appHidden.has(x.id))).map((x) => ({ id: x.id, key: x.key, name: x.name })) };
    }
    if (method === 'GET' && (m = /^\/rest\/api\/3\/project\/([^/]+)$/.exec(p))) {
      const pr = this.projects.find((x) => x.id === m[1] || x.key === m[1]);
      if (!pr || (!asUser && this.appHidden.has(pr.id))) throw err(404, 'No project could be found');
      return { ...pr, issueTypes: pr.issueTypes };
    }
    if (method === 'POST' && p === '/rest/api/3/workflows') {
      let ids = [];
      if (body.workflowIds) ids = body.workflowIds;
      if (this.strictWorkflowIds && ids.some((id) => !this.workflows.has(id))) throw Object.assign(new Error('The workflow does not exist'), { status: 404 });
      if (body.projectAndIssueTypes) ids = body.projectAndIssueTypes.map((x) => this.assign.get(String(x.projectId))?.[x.issueTypeId]).filter(Boolean);
      const wfs = [...new Set(ids)].map((id) => this.workflows.get(id)).filter(Boolean).map(clone);
      if ((q.get('expand') || '').includes('workflows.usages')) {
        for (const w of wfs) {
          const byProject = new Map();
          for (const u of this.workflowUsage(w.id)) byProject.set(u.projectId, [...(byProject.get(u.projectId) || []), u.issueTypeId]);
          w.usages = [...byProject].filter(([pid]) => !this.archived.has(pid)).slice(0, this.usagesExpandCap).map(([pid, its]) => ({ project: { id: pid }, issueTypes: its }));
        }
      }
      return { workflows: wfs, statuses: [...new Map(wfs.flatMap((w) => this.statusesFor(w)).map((s) => [s.id, s])).values()] };
    }
    if (method === 'GET' && p === '/rest/api/3/workflows/search') {
      // like Jira: queryString filters by name; the search (unlike the bulk request) carries created/updated
      const qs = (q.get('queryString') || '').toLowerCase();
      const all = [...this.workflows.values()].filter((w) => !qs || w.name.toLowerCase().includes(qs));
      const start = Number(q.get('startAt') || 0);
      const max = Number(q.get('maxResults') || 50);
      const page = all.slice(start, start + max);
      return { values: page.map((w) => ({ id: w.id, name: w.name, created: '2026-01-05T09:00:00.000+0000', updated: w.updated || '2026-11-20T14:30:00.000+0000' })), total: all.length, isLast: start + max >= all.length, startAt: start };
    }
    if (method === 'GET' && p === '/rest/api/3/workflows/capabilities') return { systemRules: [], connectRules: [], forgeRules: [] };
    if (method === 'GET' && (m = /^\/rest\/api\/3\/workflow\/([^/]+)\/projectUsages$/.exec(p))) {
      const all = [...new Set(this.workflowUsage(m[1]).map((u) => u.projectId))].map((id) => ({ id }));
      const start = Number(q.get('nextPageToken') || 0);
      const size = Math.min(Number(q.get('maxResults') || 50), this.usagePageSize);
      return { workflowId: m[1], projects: { values: all.slice(start, start + size), nextPageToken: start + size < all.length ? String(start + size) : null } };
    }
    if (method === 'GET' && (m = /^\/rest\/api\/3\/workflow\/([^/]+)\/project\/([^/]+)\/issueTypeUsages$/.exec(p))) {
      if (this.archived.has(m[2])) throw err(404, 'The project is archived');
      return { workflowId: m[1], projectId: m[2], issueTypes: { values: this.workflowUsage(m[1]).filter((u) => u.projectId === m[2]).map((u) => ({ id: u.issueTypeId })) } };
    }
    if (method === 'GET' && p === '/rest/api/3/field') return this.fields;
    if (method === 'GET' && p === '/rest/api/3/role') return this.roles;
    if (method === 'GET' && p === '/rest/api/3/resolution') return this.resolutions;
    if (method === 'GET' && p === '/rest/api/3/permissions') return { permissions: { ADMINISTER_PROJECTS: { name: 'Administer projects' }, CREATE_ISSUES: { name: 'Create issues' } } };
    if (method === 'GET' && p === '/rest/api/3/group/bulk') {
      const ids = q.getAll('groupId');
      const names = q.getAll('groupName');
      const start = Number(q.get('startAt') || 0);
      const max = Number(q.get('maxResults') || 50);
      const list = ids.length || names.length ? this.groups.filter((g) => ids.includes(g.groupId) || names.includes(g.name)) : this.groups;
      return { values: list.slice(start, start + max), isLast: start + max >= list.length, total: list.length };
    }
    if (method === 'GET' && p === '/rest/api/3/user/bulk') {
      const ids = q.getAll('accountId');
      return { values: this.users.filter((u) => ids.includes(u.accountId)) };
    }
    if (method === 'GET' && p === '/rest/api/3/screens') {
      // live: the app's scopes do not include manage:jira-project, which this endpoint requires
      if (!this.screensReadable) throw err(401, 'Unauthorized; scope does not match');
      const ids = q.getAll('id');
      const start = Number(q.get('startAt') || 0);
      const max = Number(q.get('maxResults') || 100);
      const list = ids.length ? this.screens.filter((s) => ids.includes(s.id)) : this.screens;
      return { values: list.slice(start, start + max), isLast: start + max >= list.length, total: list.length };
    }
    if (method === 'POST' && p === '/rest/api/3/workflows/update/validation') return { errors: this.validate(body.payload) };
    if (method === 'POST' && p === '/rest/api/3/workflows/update') {
      const errors = this.validate(body).filter((e) => e.level === 'ERROR');
      if (errors.length) throw err(400, errors.map((e) => e.message).join('; '));
      return this.applyUpdate(body);
    }
    if (method === 'POST' && p === '/rest/api/3/search/approximate-count') return { count: this.count(body.jql) };
    if (method === 'GET' && (m = /^\/rest\/api\/3\/issue\/createmeta\/([^/]+)\/issuetypes$/.exec(p))) {
      return { issueTypes: (this.projects.find((x) => x.key === m[1])?.issueTypes || []).map((t) => ({ id: t.id, name: t.name })) };
    }
    if (method === 'POST' && p === '/rest/api/3/issue') {
      const pr = this.projects.find((x) => x.key === body.fields.project.key);
      if (!pr) throw err(400, 'project');
      const issue = this.addIssue({ projectId: pr.id, issueTypeId: body.fields.issuetype.id, statusId: [...this.statuses.keys()][0] });
      issue.summary = body.fields.summary;
      issue.labels = body.fields.labels;
      return { key: issue.key };
    }
    if (method === 'POST' && p === '/rest/api/3/search/jql') {
      const all = this.filter(body.jql).sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
      const start = Number(body.nextPageToken || 0);
      const page = all.slice(start, start + (body.maxResults || 50));
      return { issues: page.map((i) => this.issueJson(i)), ...(start + page.length < all.length ? { nextPageToken: String(start + page.length) } : {}) };
    }
    if ((m = /^\/rest\/api\/3\/issue\/([A-Z][A-Z0-9_]*-\d+)\/transitions$/.exec(p))) {
      const issue = this.issues.find((i) => i.key === m[1]);
      if (!issue) throw err(404, 'Issue does not exist or you do not have permission to see it.');
      const wf = this.workflows.get(this.assign.get(issue.projectId)?.[issue.issueTypeId]);
      // Like live Jira Cloud: global transitions are offered even into the issue's current status
      const avail = (wf?.transitions || []).filter((t) => t.type === 'GLOBAL' || (t.type === 'DIRECTED' && (t.links || []).some((l) => String(l.fromStatusReference) === issue.statusId)));
      if (method === 'GET') return { transitions: avail.map((t) => ({ id: String(t.id), name: t.name, to: { id: String(t.toStatusReference), name: this.statuses.get(String(t.toStatusReference))?.name } })) };
      if (method === 'POST') {
        const t = avail.find((x) => String(x.id) === String(body?.transition?.id));
        if (!t) throw err(400, `Transition id '${body?.transition?.id}' is not valid for this issue.`);
        issue.statusId = String(t.toStatusReference);
        for (const a of t.actions || []) if (a.ruleKey === 'system:update-field' && a.parameters?.field === 'resolution') issue.resolution = a.parameters.value ? String(a.parameters.value) : null;
        this.transitionsRun = [...(this.transitionsRun || []), { key: issue.key, id: String(t.id) }];
        return respond(204, null);
      }
    }
    if ((m = /^\/rest\/api\/3\/issue\/([A-Z][A-Z0-9_]*-\d+)$/.exec(p))) {
      const issue = this.issues.find((i) => i.key === m[1]);
      if (!issue || (asUser && this.hiddenFromUser?.has(issue.projectId))) throw err(404, 'Issue does not exist or you do not have permission to see it.');
      if (method === 'GET') return this.issueJson(issue);
      if (method === 'PUT') {
        const override = q.get('overrideScreenSecurity') === 'true';
        if ((override || q.get('notifyUsers') === 'false') && !this.perms.ADMINISTER) throw err(403, 'Connect app users with "admin" permission and Forge apps acting on behalf of users with ADMINISTER permission can override screen security.');
        // Live superportdev 2026-10-26: the edit API cannot clear a resolution – null, {id:null}, {name:null} and
        // "update … set: null" are all rejected (only a transition with a clearing post function clears it)
        const clears = Array.isArray(body.update?.resolution) || ('resolution' in (body.fields || {}) && (body.fields.resolution == null || (body.fields.resolution.id == null && body.fields.resolution.name == null)));
        if (clears) throw err(400, '{"errorMessages":[],"errors":{"resolution":"Specify the Resolution (id or name) in the string format"}}');
        if ('resolution' in (body.fields || {})) {
          if (!override && !this.resolutionOnEditScreen) throw err(400, "Field 'resolution' cannot be set. It is not on the appropriate screen, or unknown.");
          const r = body.fields.resolution;
          if (r && !this.resolutions.some((x) => x.id === String(r.id))) throw err(400, 'Resolution id not found');
          issue.resolution = r ? String(r.id) : null;
          this.edits.push({ key: issue.key, resolution: issue.resolution, notify: q.get('notifyUsers') !== 'false' });
        }
        return respond(204, null);
      }
    }
    throw err(404, `FakeJira: no route ${method} ${p}`);
  }

  issueJson(i) {
    const st = this.statuses.get(i.statusId);
    const pr = this.projects.find((x) => x.id === i.projectId);
    const res = i.resolution ? this.resolutions.find((r) => r.id === i.resolution) : null;
    return { key: i.key, fields: { summary: i.summary, updated: i.updated, project: { key: pr.key, name: pr.name }, issuetype: { id: String(i.issueTypeId), name: pr.issueTypes.find((t) => t.id === i.issueTypeId)?.name || 'Task' }, status: { id: st.id, name: st.name, statusCategory: { key: st.statusCategory === 'DONE' ? 'done' : st.statusCategory === 'TODO' ? 'new' : 'indeterminate' } }, resolution: res ? { id: res.id, name: res.name } : null } };
  }

  // ------------------------------------------------------------- workflow update rules
  validate(payload) {
    const errors = [];
    const E = (code, message) => errors.push({ code, message, level: 'ERROR', type: 'X' });
    if (this.forceValidationError) E('FORCED', this.forceValidationError);
    const listed = new Map((payload.statuses || []).map((s) => [String(s.statusReference), s]));
    for (const w of payload.workflows || []) {
      const cur = this.workflows.get(w.id);
      if (!cur) { E('NOT_FOUND', 'Workflow not found'); continue; }
      if (w.version?.versionNumber !== cur.version.versionNumber || w.version?.id !== cur.version.id) E('VERSION_CONFLICT', 'The workflow was changed by someone else (version conflict)');
      const refs = new Set(w.statuses.map((s) => String(s.statusReference)));
      for (const r of refs) if (!listed.has(r)) E('STATUS_NOT_LISTED', `Status ${r} is missing in the statuses list`);
      for (const t of w.transitions) {
        if (t.type === 'INITIAL' && t.conditions) E('CONDITIONS_UNSUPPORTED_ON_INITIAL_TRANSITION', 'Initial transition cannot have any conditions.');
        if (t.toStatusReference && !refs.has(String(t.toStatusReference))) E('UNKNOWN_TARGET', `Transition ${t.name} targets an unknown status`);
        for (const l of t.links || []) if (!refs.has(String(l.fromStatusReference))) E('UNKNOWN_SOURCE', `Transition ${t.name} starts from an unknown status`);
        if (cur.scope?.type === 'PROJECT') {
          for (const a of t.actions || []) if (a.ruleKey === 'system:update-field' && a.parameters?.field === 'resolution') E('FIELD_NOT_SUPPORTED', 'This field type is not supported in "update field" rules in this type of space.');
        }
      }
      // Removing statuses from an active workflow (rules verified live)
      const removed = cur.statuses.map((s) => String(s.statusReference)).filter((r) => !refs.has(r));
      const usage = this.workflowUsage(w.id);
      if (removed.length && usage.length) {
        const maps = w.statusMappings || [];
        const projectsExpected = [...new Set(usage.map((u) => u.projectId))].filter((pid) => !this.archived.has(pid));
        const projectsGot = [...new Set(maps.map((m) => String(m.projectId)))];
        if (projectsExpected.some((pid) => !projectsGot.includes(pid))) E('INCORRECT_PROJECT_IDS_IN_STATUS_MAPPING', `We couldn't complete the migration because some projects are missing from the status mappings. We expected project IDs ${projectsExpected.join(',')}, but received ${projectsGot.join(',')}.`);
        for (const pid of projectsExpected) {
          const itsExpected = usage.filter((u) => u.projectId === pid).map((u) => u.issueTypeId);
          const itsGot = maps.filter((m) => String(m.projectId) === pid).map((m) => String(m.issueTypeId));
          if (itsExpected.some((it) => !itsGot.includes(it))) E('INCORRECT_ISSUE_TYPES_IN_STATUS_MAPPING', `We expected mappings for issue types ${itsExpected.join(',')}, but received ${itsGot.join(',')}.`);
        }
        for (const m of maps) {
          if (!(m.statusMigrations || []).length) throw err(400, `payload.workflows[0].statusMappings.statusMigrations : must not be empty`);
          for (const mig of m.statusMigrations) {
            if (!listed.has(String(mig.oldStatusReference))) E('OLD_STATUS_MISSING_IN_ORIGINAL_WORKFLOW', `The status ${mig.oldStatusReference} is not in the original workflow.`);
            if (!refs.has(String(mig.newStatusReference))) E('NEW_STATUS_MISSING', `The status ${mig.newStatusReference} is not in the new workflow.`);
          }
          const olds = m.statusMigrations.map((x) => String(x.oldStatusReference));
          if (removed.some((r) => !olds.includes(r))) E('INCORRECT_ORIGIN_STATUSES_IN_STATUS_MAPPING', `We expected mappings for origin statuses ${olds.join(',')}, but received ${removed.join(',')}.`);
        }
      }
    }
    return errors;
  }

  applyUpdate(payload) {
    // Create new statuses (no id) and re-key their references like Jira does
    const rekey = new Map();
    for (const s of payload.statuses || []) {
      if (!s.id) {
        const id = this.addStatus(s.name, s.statusCategory, s.description);
        rekey.set(String(s.statusReference), id);
      } else if (this.statuses.has(String(s.id))) {
        // statuses are global: the update overwrites name, category and description (omitted = cleared)
        const cur = this.statuses.get(String(s.id));
        this.statuses.set(String(s.id), { ...cur, name: s.name ?? cur.name, statusCategory: s.statusCategory ?? cur.statusCategory, description: s.description ?? '' });
      }
    }
    const R = (r) => rekey.get(String(r)) || String(r);
    const out = [];
    for (const w of payload.workflows) {
      const cur = this.workflows.get(w.id);
      const removed = cur.statuses.map((s) => String(s.statusReference)).filter((r) => !w.statuses.some((x) => R(x.statusReference) === r));
      for (const m of w.statusMappings || []) {
        for (const mig of m.statusMigrations) for (const i of this.issues) if (i.projectId === String(m.projectId) && i.issueTypeId === String(m.issueTypeId) && i.statusId === String(mig.oldStatusReference)) i.statusId = R(mig.newStatusReference);
      }
      void removed;
      const next = {
        ...cur,
        statuses: w.statuses.map((s) => ({ ...s, statusReference: R(s.statusReference) })),
        transitions: w.transitions.map((t) => ({ ...clone(t), toStatusReference: t.toStatusReference ? R(t.toStatusReference) : t.toStatusReference, links: (t.links || []).map((l) => ({ ...l, fromStatusReference: R(l.fromStatusReference) })) })),
        // Jira bumps twice when statuses are removed (definition + issue migration) – seen live on superportdev
        version: { id: `v-${w.id}-${cur.version.versionNumber + (removed.length ? 2 : 1)}`, versionNumber: cur.version.versionNumber + (removed.length ? 2 : 1) },
      };
      this.workflows.set(w.id, next);
      out.push(clone(next));
    }
    return { workflows: out, statuses: [] };
  }

  count(jql) {
    return this.filter(jql).length;
  }

  filter(jql) {
    const pm = /project = "?([\w]+)"?/.exec(jql);
    const pr = pm && this.projects.find((x) => x.id === pm[1] || x.key === pm[1]);
    let list = this.issues.filter((i) => !pr || i.projectId === pr.id);
    const sm = /status = (\d+)/.exec(jql);
    if (sm) list = list.filter((i) => i.statusId === sm[1]);
    if (/status WAS (\d+)/.test(jql)) list = list.filter((i) => i.statusId === /status WAS (\d+)/.exec(jql)[1]);
    const it = /issuetype = (\d+)/.exec(jql);
    if (it) list = list.filter((i) => i.issueTypeId === it[1]);
    const its = /issuetype in \(([\d, ]+)\)/.exec(jql);
    if (its) { const set = new Set(its[1].split(',').map((x) => x.trim())); list = list.filter((i) => set.has(i.issueTypeId)); }
    if (/statusCategory != Done/.test(jql)) list = list.filter((i) => this.statuses.get(i.statusId)?.statusCategory !== 'DONE');
    else if (/statusCategory = Done/.test(jql)) list = list.filter((i) => this.statuses.get(i.statusId)?.statusCategory === 'DONE');
    if (/resolution is EMPTY/.test(jql)) list = list.filter((i) => !i.resolution);
    if (/resolution is not EMPTY/.test(jql)) list = list.filter((i) => !!i.resolution);
    const upd = /updated <= -(\d+)d/.exec(jql);
    if (upd) list = list.filter((i) => Date.now() - new Date(i.updated).getTime() >= Number(upd[1]) * 864e5);
    return list;
  }
}

class Response0 {
  constructor(status, body, headers = {}) {
    this.status = status;
    this.ok = status >= 200 && status < 300;
    this._body = body;
    this.headers = { get: (k) => headers[k] ?? null };
  }

  async text() {
    return this._body == null ? '' : JSON.stringify(this._body);
  }

  async json() {
    return this._body;
  }
}

function respond(status, body, headers) {
  return new Response0(status, body, headers);
}

function err(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
