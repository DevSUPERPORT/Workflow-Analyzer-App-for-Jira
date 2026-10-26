// Workflow analysis engine. Pure JavaScript, shared by the Forge backend (resolvers,
// Rovo actions) and the Custom UI frontend (views and exports).
//
// Input: a "bundle" as produced by src/lib/jira.js (raw Jira REST payloads plus
// reference data). Output: a normalized, analysed model.

import { SYSTEM_RULES, ECOSYSTEM_RULES, refsFromSystemParams, parseConfig, inspectAppConfig, refsFromProperties } from './rules.js';
import { JIRA_VENDOR } from './vendors.js';
import { detectVendor, forgeModuleFromKey } from './vendors.js';

export const KINDS = ['condition', 'validator', 'postfunction'];
export const SEVERITY_WEIGHT = { high: 8, medium: 3, low: 1, info: 0 };
// Jira system issue events (IDs are the same on every site); a transition without customIssueEventId fires the Generic Event
export const SYSTEM_EVENTS = [
  { id: '1', name: 'Issue Created' }, { id: '2', name: 'Issue Updated' }, { id: '3', name: 'Issue Assigned' },
  { id: '4', name: 'Issue Resolved' }, { id: '5', name: 'Issue Closed' }, { id: '6', name: 'Issue Commented' },
  { id: '7', name: 'Issue Reopened' }, { id: '8', name: 'Issue Deleted' }, { id: '9', name: 'Issue Moved' },
  { id: '10', name: 'Work Logged On Issue' }, { id: '11', name: 'Work Started On Issue' }, { id: '12', name: 'Work Stopped On Issue' },
  { id: '13', name: 'Generic Event' }, { id: '14', name: 'Issue Comment Edited' }, { id: '15', name: 'Issue Worklog Updated' },
  { id: '16', name: 'Issue Worklog Deleted' }, { id: '17', name: 'Issue Comment Deleted' },
];
export const GENERIC_EVENT_ID = '13';

// ---------------------------------------------------------------- lookups

export function buildLookups(bundle) {
  const ref = bundle.ref || {};
  const L = {
    fields: new Map(),
    groupsById: new Map(),
    groupsByName: new Map(),
    roles: new Map(),
    users: new Map(),
    screens: new Map(),
    permissions: new Map(),
    statusesById: new Map(),
    statusesByRef: new Map(),
    capabilities: ref.capabilities || null,
    loaded: {
      fields: Array.isArray(ref.fields),
      groups: Array.isArray(ref.groups) && ref.groupsComplete !== false,
      roles: Array.isArray(ref.roles),
      users: Array.isArray(ref.users),
      screens: Array.isArray(ref.screens),
      permissions: !!ref.permissions,
    },
  };
  for (const f of ref.fields || []) L.fields.set(String(f.id), { id: String(f.id), name: f.name, custom: !!f.custom, type: f.schema?.custom || f.schema?.type || null });
  for (const g of ref.groups || []) {
    const id = String(g.groupId || g.id || g.name);
    L.groupsById.set(id, { id, name: g.name });
    if (g.name) L.groupsByName.set(g.name, id);
  }
  for (const r of ref.roles || []) L.roles.set(String(r.id), { id: String(r.id), name: r.name });
  for (const u of ref.users || []) L.users.set(String(u.accountId), { id: String(u.accountId), name: u.displayName || u.accountId, active: u.active !== false, type: u.accountType });
  for (const s of ref.screens || []) L.screens.set(String(s.id), { id: String(s.id), name: s.name });
  L.events = new Map([...SYSTEM_EVENTS, ...(ref.events || [])].map((e) => [String(e.id), e.name]));
  const perms = ref.permissions?.permissions || ref.permissions || {};
  for (const [k, p] of Object.entries(perms)) L.permissions.set(k, { id: k, name: p?.name || k });
  for (const s of bundle.statuses || []) {
    const st = { id: String(s.id), ref: s.statusReference || String(s.id), name: s.name, category: s.statusCategory || 'TODO' };
    L.statusesById.set(st.id, st);
    L.statusesByRef.set(st.ref, st);
  }
  return L;
}

export function resolveRef(rf, L) {
  const out = { type: rf.type, id: String(rf.id), name: String(rf.id), resolved: true, via: rf.via };
  switch (rf.type) {
    case 'group': {
      if (out.id.startsWith('name:')) {
        const n = out.id.slice(5);
        const id = L.groupsByName.get(n);
        if (id) { out.id = id; out.name = n; } else { out.name = n; out.resolved = L.loaded.groups ? false : null; }
        break;
      }
      const g = L.groupsById.get(out.id);
      if (g) out.name = g.name; else out.resolved = L.loaded.groups ? false : null;
      break;
    }
    case 'role': {
      const r = L.roles.get(out.id);
      if (r) out.name = r.name; else out.resolved = L.loaded.roles ? false : null;
      break;
    }
    case 'field': {
      const f = L.fields.get(out.id);
      if (f) { out.name = f.name; out.custom = f.custom; } else out.resolved = out.id.startsWith('customfield_') && L.loaded.fields ? false : null;
      break;
    }
    case 'user': {
      const u = L.users.get(out.id);
      if (u) { out.name = u.name; out.inactive = !u.active; } else out.resolved = L.loaded.users ? false : null;
      break;
    }
    case 'screen': {
      const s = L.screens.get(out.id);
      if (s) out.name = s.name; else out.resolved = L.loaded.screens ? false : null;
      break;
    }
    case 'status': {
      const s = L.statusesById.get(out.id) || L.statusesByRef.get(out.id);
      if (s) out.name = s.name; else out.resolved = null;
      break;
    }
    case 'permission': {
      const p = L.permissions.get(out.id);
      out.name = p ? p.name : out.id;
      out.resolved = p || !L.loaded.permissions ? true : null;
      break;
    }
    case 'webhook':
      out.name = `#${out.id}`;
      out.resolved = null;
      break;
    default:
      break;
  }
  return out;
}

// ---------------------------------------------------------------- rules

function appRuleLabel(rule, vendor, cfg, L) {
  // 1. Explicit naming inside the stored configuration
  if (cfg && typeof cfg === 'object') {
    for (const k of ['name', 'title', 'functionName', 'description', 'label', 'type', 'functionKey', 'moduleKey']) {
      const v = cfg[k];
      if (typeof v === 'string' && v.length > 1 && v.length < 80) return v;
    }
  }
  // 2. Forge module key
  if (vendor.type === 'forge') {
    const mod = forgeModuleFromKey(rule.parameters?.key);
    const fr = L.capabilities?.forgeRules?.find((r) => r.ruleKey === rule.ruleKey && String(r.id || '').endsWith(`/${mod}`));
    if (fr?.name) return fr.name;
    if (mod) return mod;
  }
  // 3. Unique rule of that type for this app in the capabilities catalogue
  if (vendor.type === 'connect' && L.capabilities?.connectRules) {
    const typeMap = { 'connect:expression-validator': 'Validator', 'connect:expression-condition': 'Condition', 'connect:remote-workflow-function': 'Function' };
    const cands = L.capabilities.connectRules.filter((r) => r.addonKey === vendor.appKey && r.ruleType === typeMap[rule.ruleKey]);
    if (cands.length === 1) return cands[0].name;
    if (rule.parameters?.tag) {
      const byTag = cands.find((c) => c.moduleKey === rule.parameters.tag);
      if (byTag) return byTag.name;
    }
  }
  if (rule.parameters?.tag) return String(rule.parameters.tag);
  return null;
}

function systemRuleName(ruleKey, L) {
  const cap = L.capabilities?.systemRules?.find((r) => r.ruleKey === ruleKey);
  return cap?.name || null;
}

export function normalizeRule(rule, kindHint, L) {
  const params = rule.parameters || rule.params || {};
  const meta = SYSTEM_RULES[rule.ruleKey] || ECOSYSTEM_RULES[rule.ruleKey] || null;
  const vendor = detectVendor(rule.ruleKey, params, L.capabilities);
  const kind = kindHint || meta?.kind || 'postfunction';
  const out = {
    id: rule.id || params.id || null,
    ruleKey: rule.ruleKey,
    kind,
    vendor,
    nameKey: meta?.name || null,
    label: null,
    fallbackName: systemRuleName(rule.ruleKey, L),
    disabled: String(params.disabled) === 'true',
    params,
    details: [],
    expressions: [],
    messages: [],
    refs: [],
    configReadable: true,
  };

  let raw = [];
  if (vendor.type === 'jira' || vendor.type === 'other') {
    raw = refsFromSystemParams(params);
    for (const [k, v] of Object.entries(params)) {
      if (k === 'errorMessage' || k === 'remindingMessage') { if (v) out.messages.push(String(v)); continue; }
      if (k === 'regexp') { out.expressions.push({ key: k, code: String(v) }); continue; }
      if (k === 'approvalConfigurationJson' || k === 'disabled') continue;
      out.details.push({ key: k, value: v, refType: raw.find((r) => r.via === k)?.type || null });
    }
  } else {
    const cfg = parseConfig(params.config);
    if (!cfg) out.configReadable = false;
    const ins = inspectAppConfig(cfg, L);
    out.details = ins.details.map((d) => ({ key: d.label, value: d.value, refType: null, free: true }));
    out.expressions = ins.expressions;
    out.messages = ins.messages;
    raw = ins.refs;
    out.label = appRuleLabel(rule, vendor, cfg, L);
  }

  const seen = new Set();
  for (const r of raw) {
    const res = resolveRef(r, L);
    const k = `${res.type}|${res.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.refs.push(res);
  }
  if (vendor.thirdParty) out.refs.push({ type: 'app', id: vendor.key, name: vendor.name, resolved: true });
  // Hardcoded user marker for health checks
  out.hardcodedUsers = out.refs.filter((r) => r.type === 'user');
  return out;
}

/** Synthetic "rule" for workflow properties that reference configuration objects. */
export function propertyRule(props, L, owner) {
  const raw = refsFromProperties(props, L);
  if (!raw.length) return null;
  const seen = new Set();
  const refs = [];
  for (const r of raw) {
    const res = resolveRef(r, L);
    const k = `${res.type}|${res.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    refs.push(res);
  }
  return {
    id: null,
    ruleKey: `property:${owner}`,
    kind: 'property',
    vendor: JIRA_VENDOR,
    nameKey: owner === 'status' ? 'rule.statusProperty' : 'rule.transitionProperty',
    label: null,
    fallbackName: null,
    disabled: false,
    params: props,
    details: Object.entries(props).map(([key, value]) => ({ key, value, refType: raw.find((x) => x.via === key)?.type || null, free: true })),
    expressions: [],
    messages: [],
    refs,
    configReadable: true,
    hardcodedUsers: refs.filter((x) => x.type === 'user'),
  };
}

function normalizeConditionGroup(g, L) {
  if (!g) return { op: 'ALL', rules: [], groups: [] };
  return {
    op: g.operation || 'ALL',
    rules: (g.conditions || []).map((c) => normalizeRule(c, 'condition', L)),
    groups: (g.conditionGroups || []).map((cg) => normalizeConditionGroup(cg, L)),
  };
}

export function flattenConditions(tree) {
  if (!tree) return [];
  return [...tree.rules, ...tree.groups.flatMap(flattenConditions)];
}

export function allRules(t) {
  return [...flattenConditions(t.conditions), ...t.validators, ...t.postFunctions, ...t.screens, ...t.triggers, ...(t.propertyRules || [])];
}

// ---------------------------------------------------------------- workflows

function statusOf(ref, L, wfStatuses) {
  const g = L.statusesByRef.get(ref) || L.statusesById.get(ref);
  const local = wfStatuses?.find((s) => s.statusReference === ref);
  return {
    ref,
    id: g?.id || null,
    name: g?.name || (local?.name) || ref,
    category: g?.category || 'TODO',
  };
}

export function normalizeWorkflow(wf, L, extra = {}) {
  const statuses = (wf.statuses || []).map((s) => {
    const st = statusOf(s.statusReference, L, wf.statuses);
    const propRule = propertyRule(s.properties || {}, L, 'status');
    return { ...st, x: s.layout?.x ?? null, y: s.layout?.y ?? null, deprecated: !!s.deprecated, properties: s.properties || {}, propertyRule: propRule, approval: s.approvalConfiguration || null };
  });
  const transitions = (wf.transitions || []).map((t) => {
    const from = (t.links || []).map((l) => statusOf(l.fromStatusReference, L, wf.statuses));
    const screens = t.transitionScreen ? [normalizeRule(t.transitionScreen, 'screen', L)] : [];
    const screenRef = screens.flatMap((s) => s.refs).find((r) => r.type === 'screen') || null;
    const tr = {
      key: `${wf.id}::${t.id}`,
      id: String(t.id),
      name: t.name || '',
      description: t.description || '',
      type: t.type || (from.length ? 'DIRECTED' : 'GLOBAL'),
      from,
      to: t.toStatusReference ? statusOf(t.toStatusReference, L, wf.statuses) : null,
      screen: screenRef,
      screens,
      properties: t.properties || {},
      eventId: t.customIssueEventId || null,
      eventName: L.events.get(String(t.customIssueEventId || GENERIC_EVENT_ID)) || String(t.customIssueEventId),
      conditions: normalizeConditionGroup(t.conditions, L),
      validators: (t.validators || []).map((r) => normalizeRule(r, 'validator', L)),
      postFunctions: (t.actions || []).map((r) => normalizeRule(r, 'postfunction', L)),
      triggers: (t.triggers || []).map((r) => normalizeRule(r, 'trigger', L)),
    };
    const pr = propertyRule(t.properties || {}, L, 'transition');
    tr.propertyRules = pr ? [pr] : [];
    // Looped transitions ("any status to itself") arrive as GLOBAL with no target in some payloads
    tr.isGlobal = tr.type === 'GLOBAL';
    tr.isInitial = tr.type === 'INITIAL';
    tr.isLoop = tr.isGlobal && !tr.to;
    tr.counts = {
      condition: flattenConditions(tr.conditions).length,
      validator: tr.validators.length,
      postfunction: tr.postFunctions.length,
    };
    tr.thirdParty = allRules(tr).filter((r) => r.vendor.thirdParty).length;
    tr.complexity = tr.counts.condition + tr.counts.validator + tr.counts.postfunction + tr.thirdParty + (tr.conditions.groups.length ? 1 : 0);
    return tr;
  });
  return {
    id: String(wf.id),
    name: wf.name,
    description: wf.description || '',
    scope: wf.scope?.type || 'GLOBAL',
    version: wf.version?.versionNumber ?? null,
    created: wf.created || null,
    updated: wf.updated || null,
    isEditable: wf.isEditable !== false,
    startPoint: wf.startPointLayout || null,
    issueTypes: extra.issueTypes || [],
    projects: extra.projects || [],
    statuses,
    transitions,
  };
}

// ---------------------------------------------------------------- model

export function normalize(bundle) {
  const L = buildLookups(bundle);
  const issueTypesById = new Map((bundle.issueTypes || []).map((it) => [String(it.id), it]));
  const wfIssueTypes = new Map();
  for (const m of bundle.mapping || []) {
    const arr = wfIssueTypes.get(String(m.workflowId)) || [];
    const it = issueTypesById.get(String(m.issueTypeId));
    if (it && !arr.find((x) => x.id === String(it.id))) arr.push({ id: String(it.id), name: it.name, iconUrl: it.iconUrl || null });
    wfIssueTypes.set(String(m.workflowId), arr);
  }
  const workflows = (bundle.workflows || []).map((wf) =>
    normalizeWorkflow(wf, L, {
      issueTypes: wfIssueTypes.get(String(wf.id)) || [],
      projects: (bundle.workflowProjects || {})[String(wf.id)] || [],
    }),
  ).sort((a, b) => a.name.localeCompare(b.name));

  const model = {
    kind: bundle.kind || 'project',
    project: bundle.project || null,
    site: bundle.site || null,
    generatedAt: bundle.generatedAt || new Date().toISOString(),
    warnings: bundle.warnings || [],
    projectUsageKnown: !!bundle.workflowProjects,
    workflows,
  };
  model.index = buildIndex(model);
  model.vendors = vendorSummary(model);
  model.findings = runHealthChecks(model);
  model.stats = computeStats(model);
  return model;
}

export function buildIndex(model) {
  const index = {};
  const add = (ref, usage) => {
    const bucket = (index[ref.type] ||= {});
    const e = (bucket[ref.id] ||= { type: ref.type, id: ref.id, name: ref.name, resolved: ref.resolved, inactive: !!ref.inactive, usages: [], workflows: new Set(), transitions: new Set() });
    if (ref.resolved === false) e.resolved = false;
    e.usages.push(usage);
    e.workflows.add(usage.wfId);
    e.transitions.add(usage.tKey);
  };
  for (const wf of model.workflows) {
    for (const t of wf.transitions) {
      for (const rule of allRules(t)) {
        for (const ref of rule.refs) {
          add(ref, {
            wfId: wf.id,
            wfName: wf.name,
            tKey: t.key,
            tId: t.id,
            tName: t.name,
            from: t.from.map((s) => s.name),
            to: t.to?.name || null,
            kind: rule.kind,
            ruleKey: rule.ruleKey,
            ruleNameKey: rule.nameKey,
            ruleLabel: rule.label || rule.fallbackName,
            vendor: rule.vendor.name,
            via: ref.via || null,
          });
        }
      }
    }
  }
  // Status properties (e.g. jira.permission.edit.group) – usages are keyed by status
  for (const wf of model.workflows) {
    for (const st of wf.statuses) {
      if (!st.propertyRule) continue;
      for (const ref of st.propertyRule.refs) {
        add(ref, { wfId: wf.id, wfName: wf.name, tKey: `${wf.id}::status:${st.ref}`, tId: '', tName: st.name, from: [], to: st.name, kind: 'property', ruleKey: 'property:status', ruleNameKey: 'rule.statusProperty', ruleLabel: null, vendor: 'Jira', via: ref.via || null, statusProperty: true });
      }
    }
  }
  // Convert sets to counts (keep plain data for postMessage/structuredClone friendliness)
  for (const type of Object.keys(index)) {
    for (const e of Object.values(index[type])) {
      e.workflowCount = e.workflows.size;
      e.transitionCount = e.transitions.size;
      e.workflowIds = [...e.workflows];
      delete e.workflows;
      delete e.transitions;
    }
  }
  return index;
}

export function vendorSummary(model) {
  const v = {};
  for (const wf of model.workflows) {
    for (const t of wf.transitions) {
      for (const r of allRules(t)) {
        const e = (v[r.vendor.key] ||= { key: r.vendor.key, name: r.vendor.name, appKey: r.vendor.appKey || null, type: r.vendor.type, maker: r.vendor.maker || null, thirdParty: r.vendor.thirdParty, condition: 0, validator: 0, postfunction: 0, screen: 0, trigger: 0, total: 0, disabled: 0, transitions: new Set(), workflows: new Set() });
        e[r.kind] = (e[r.kind] || 0) + 1;
        e.total++;
        if (r.disabled) e.disabled++;
        e.transitions.add(t.key);
        e.workflows.add(wf.id);
      }
    }
  }
  return Object.values(v)
    .map((e) => ({ ...e, transitionCount: e.transitions.size, workflowCount: e.workflows.size, transitions: undefined, workflows: undefined }))
    .sort((a, b) => (a.thirdParty === b.thirdParty ? b.total - a.total : a.thirdParty ? -1 : 1));
}

export function computeStats(model) {
  const s = { workflows: model.workflows.length, statuses: 0, transitions: 0, globalTransitions: 0, condition: 0, validator: 0, postfunction: 0, thirdPartyRules: 0, apps: 0, refs: {}, findings: { high: 0, medium: 0, low: 0, info: 0 }, healthScore: 100, maxComplexity: 0 };
  const statusIds = new Set();
  for (const wf of model.workflows) {
    wf.statuses.forEach((st) => statusIds.add(st.id || st.ref));
    s.transitions += wf.transitions.length;
    for (const t of wf.transitions) {
      if (t.isGlobal) s.globalTransitions++;
      s.condition += t.counts.condition;
      s.validator += t.counts.validator;
      s.postfunction += t.counts.postfunction;
      s.thirdPartyRules += t.thirdParty;
      s.maxComplexity = Math.max(s.maxComplexity, t.complexity);
    }
  }
  s.statuses = statusIds.size;
  s.apps = model.vendors.filter((v) => v.thirdParty).length;
  for (const [type, items] of Object.entries(model.index)) s.refs[type] = Object.keys(items).length;
  for (const f of model.findings) s.findings[f.severity]++;
  s.healthScore = healthScore(model.findings, s.transitions);
  return s;
}

export function healthScore(findings, transitions = 1) {
  // Penalty is normalised by workflow size so large workflows are not punished just for size.
  const penalty = findings.reduce((a, f) => a + SEVERITY_WEIGHT[f.severity], 0);
  const scale = Math.max(1, Math.sqrt(Math.max(transitions, 1) / 10));
  return Math.max(0, Math.min(100, Math.round(100 - penalty / scale)));
}

// ---------------------------------------------------------------- health checks

export function runHealthChecks(model) {
  const findings = [];
  let n = 0;
  const push = (f) => findings.push({ id: `f${++n}`, ...f });

  for (const wf of model.workflows) {
    const base = { wfId: wf.id, wfName: wf.name };
    const statusByRef = new Map(wf.statuses.map((s) => [s.ref, s]));
    const outgoing = new Map(wf.statuses.map((s) => [s.ref, []]));
    const incoming = new Map(wf.statuses.map((s) => [s.ref, []]));
    const globals = wf.transitions.filter((t) => t.isGlobal);
    for (const t of wf.transitions) {
      for (const f of t.from) outgoing.get(f.ref)?.push(t);
      if (t.to) incoming.get(t.to.ref)?.push(t);
    }

    // Reachability from the initial transition(s)
    const initial = wf.transitions.filter((t) => t.isInitial);
    const start = initial.map((t) => t.to?.ref).filter(Boolean);
    const seen = new Set(start);
    const queue = [...start];
    while (queue.length) {
      const cur = queue.shift();
      const next = [...(outgoing.get(cur) || []), ...globals].map((t) => t.to?.ref).filter(Boolean);
      for (const nx of next) if (!seen.has(nx)) { seen.add(nx); queue.push(nx); }
    }
    if (!initial.length && wf.transitions.length) push({ ...base, severity: 'medium', code: 'NO_INITIAL' });
    if (model.kind === 'site' && model.projectUsageKnown && !wf.projects.length) push({ ...base, severity: 'info', code: 'INACTIVE_WORKFLOW' });

    for (const st of wf.statuses) {
      const outs = (outgoing.get(st.ref) || []).length + globals.filter((g) => g.to?.ref !== st.ref || g.isLoop).length;
      if (outs === 0 && st.category !== 'DONE') push({ ...base, severity: 'high', code: 'DEAD_END', params: { status: st.name } });
      if (start.length && !seen.has(st.ref)) push({ ...base, severity: 'medium', code: 'UNREACHABLE', params: { status: st.name } });
      if (st.deprecated) push({ ...base, severity: 'low', code: 'DEPRECATED_STATUS', params: { status: st.name } });
    }

    const nameBySource = new Map();
    for (const t of wf.transitions) {
      const tb = { ...base, tKey: t.key, tName: t.name };
      const rules = allRules(t);
      const toDone = t.to && statusByRef.get(t.to.ref)?.category === 'DONE';
      const fromDone = t.from.length > 0 && t.from.every((f) => statusByRef.get(f.ref)?.category === 'DONE');
      // "Update field: Resolution" with an empty value clears the resolution – it does not set one
      const resolutionRules = t.postFunctions.filter((r) => /resolution/i.test(String(r.params.field || r.params.targetFieldKey || '')) || r.refs.some((x) => x.type === 'field' && x.id === 'resolution'));
      const clearsValue = (r) => r.ruleKey === 'system:update-field' && (r.params.value == null || String(r.params.value).trim() === '');
      const setsResolution = resolutionRules.some((r) => !clearsValue(r));
      const clearsResolution = resolutionRules.some(clearsValue);

      // Team-managed spaces set/clear the resolution automatically on Done statuses (and reject
      // "update field" rules for it), so resolution findings only apply to company-managed workflows.
      const autoResolution = wf.scope === 'PROJECT';
      if (!autoResolution && toDone && !fromDone && !setsResolution) {
        // A clearing post function runs after the screen, so a Resolution field on the screen does not help
        if (clearsResolution) push({ ...tb, severity: 'medium', code: 'DONE_CLEARS_RESOLUTION', params: { status: t.to.name } });
        else push({ ...tb, severity: t.screen ? 'low' : 'medium', code: t.screen ? 'DONE_RESOLUTION_SCREEN' : 'DONE_NO_RESOLUTION', params: { status: t.to.name } });
      }
      if (!autoResolution && fromDone && t.to && !toDone && !resolutionRules.length) push({ ...tb, severity: 'low', code: 'REOPEN_KEEPS_RESOLUTION', params: { status: t.to.name } });
      // Notification schemes send "Issue Resolved" / "Issue Closed" mails; the Generic Event on a Done transition bypasses them
      if (!autoResolution && toDone && !fromDone && (!t.eventId || String(t.eventId) === GENERIC_EVENT_ID)) {
        push({ ...tb, severity: 'low', code: 'DONE_GENERIC_EVENT', params: { status: t.to.name } });
      }
      if (t.isGlobal && !t.isLoop && t.counts.condition === 0) push({ ...tb, severity: 'low', code: 'GLOBAL_UNGUARDED', params: { status: t.to?.name || '' } });
      if (t.complexity >= 12) push({ ...tb, severity: 'info', code: 'COMPLEX', params: { n: t.complexity } });

      for (const f of t.from) {
        const k = `${f.ref}|${t.name.trim().toLowerCase()}`;
        if (nameBySource.has(k) && nameBySource.get(k) !== t.id) push({ ...tb, severity: 'low', code: 'DUPLICATE_NAME', params: { status: f.name } });
        nameBySource.set(k, t.id);
      }

      for (const r of rules) {
        const rb = { ...tb, ruleKind: r.kind, ruleId: r.id, ruleKey: r.ruleKey, vendor: r.vendor.name, ruleLabel: r.label || r.fallbackName || r.ruleKey };
        if (r.disabled) push({ ...rb, severity: 'medium', code: 'DISABLED_RULE' });
        if (r.vendor.thirdParty && !r.configReadable) push({ ...rb, severity: 'info', code: 'CONFIG_UNREADABLE' });
        if (r.expressions.some((e) => /app\.license/.test(e.code))) push({ ...rb, severity: 'medium', code: 'LICENSE_GUARD' });
        for (const ref of r.refs) {
          if (ref.type === 'app') continue;
          if (ref.resolved === false) push({ ...rb, severity: 'high', code: 'UNRESOLVED_REF', params: { type: ref.type, id: ref.id, name: ref.name } });
          else if (ref.type === 'user' && ref.inactive) push({ ...rb, severity: 'high', code: 'INACTIVE_USER', params: { name: ref.name, id: ref.id } });
          else if (ref.type === 'user') push({ ...rb, severity: 'low', code: 'HARDCODED_USER', params: { name: ref.name, id: ref.id } });
        }
      }
    }
  }
  for (const wf of model.workflows) {
    for (const st of wf.statuses) {
      for (const ref of st.propertyRule?.refs || []) {
        const fb = { wfId: wf.id, wfName: wf.name, tName: st.name, ruleKind: 'property', vendor: 'Jira', ruleLabel: 'status property' };
        if (ref.resolved === false) push({ ...fb, severity: 'high', code: 'UNRESOLVED_REF', params: { type: ref.type, id: ref.id, name: ref.name } });
        else if (ref.type === 'user' && ref.inactive) push({ ...fb, severity: 'high', code: 'INACTIVE_USER', params: { name: ref.name, id: ref.id } });
      }
    }
  }
  const order = { high: 0, medium: 1, low: 2, info: 3 };
  return findings.sort((a, b) => order[a.severity] - order[b.severity] || a.wfName.localeCompare(b.wfName));
}

// ---------------------------------------------------------------- search

export function searchModel(model, q, limit = 60) {
  const query = String(q || '').trim().toLowerCase();
  if (query.length < 2) return [];
  const out = [];
  const hit = (s) => String(s || '').toLowerCase().includes(query);
  for (const wf of model.workflows) {
    if (hit(wf.name)) out.push({ type: 'workflow', wfId: wf.id, label: wf.name });
    for (const st of wf.statuses) if (hit(st.name)) out.push({ type: 'status', wfId: wf.id, label: st.name, sub: wf.name, statusRef: st.ref });
    for (const t of wf.transitions) {
      if (hit(t.name) || hit(t.id)) out.push({ type: 'transition', wfId: wf.id, tKey: t.key, label: t.name, sub: `${wf.name} · ${t.from.map((f) => f.name).join(', ') || '*'} → ${t.to?.name || '↺'}` });
      else if (allRules(t).some((r) => r.expressions.some((e) => hit(e.code)) || r.messages.some(hit) || hit(r.label))) out.push({ type: 'rule', wfId: wf.id, tKey: t.key, label: t.name, sub: wf.name });
    }
  }
  for (const [type, items] of Object.entries(model.index)) {
    for (const e of Object.values(items)) if (hit(e.name) || hit(e.id)) out.push({ type: 'ref', refType: type, refId: e.id, label: e.name, sub: `${e.transitionCount}` });
  }
  const seen = new Set();
  return out.filter((r) => { const k = `${r.type}|${r.wfId}|${r.tKey}|${r.refType}|${r.refId}|${r.label}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, limit);
}

// ---------------------------------------------------------------- reference collection (backend, before resolving)

// Collect IDs referenced by raw workflow payloads so the backend can bulk-resolve them.
export function collectRawRefs(workflows) {
  const L = buildLookups({ ref: {} });
  const ids = { group: new Set(), groupName: new Set(), user: new Set(), screen: new Set(), role: new Set(), field: new Set() };
  const add = (ref) => {
    const id = String(ref.id);
    if (id.startsWith('name:')) { if (ref.type === 'group') ids.groupName.add(id.slice(5)); } else if (ids[ref.type]) ids[ref.type].add(id);
  };
  for (const wf of workflows || []) {
    const n = normalizeWorkflow(wf, L);
    for (const t of n.transitions) for (const r of allRules(t)) for (const ref of r.refs) add(ref);
    for (const st of n.statuses) for (const ref of st.propertyRule?.refs || []) add(ref);
  }
  return Object.fromEntries(Object.entries(ids).map(([k, v]) => [k, [...v]]));
}
