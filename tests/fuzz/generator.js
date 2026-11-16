/**
 * Seeded random generator of Jira workflow bundles (new workflow API shape) for the fuzz tests. Produces valid
 * workflows and, with `malformed: true`, structurally broken ones (dangling references, missing fields, garbage
 * parameters) that real sites can contain after migrations.
 *
 * @file        tests/fuzz/generator.js
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-24
 * @updated     2026-11-05
 */

export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r = {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    bool: (p = 0.5) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    sample: (arr, n) => [...arr].sort(() => next() - 0.5).slice(0, n),
  };
  return r;
}

const NASTY = [
  'Done', 'In Progress', 'Bedarfsanfrage stellen', 'Prüfung „GB“', "O'Brien's step", 'Ablehnen & Archiv',
  '<script>alert(1)</script>', '"><img src=x onerror=alert(1)>', '=HYPERLINK("http://evil")', '+SUM(1)', '-1+2', '@cmd',
  '🚀 Release', 'Ünïcödé ß', 'a'.repeat(300), '   spaced   ', 'tab\tname', 'line\nbreak', '{placeholder}', 'x}y{z', '${injection}',
  'null', 'undefined', '0', 'GB-Kontrolle', 'Stage 1', 'Stage 2',
];
const CATS = ['TODO', 'IN_PROGRESS', 'DONE'];
const PERMS = ['ADMINISTER_PROJECTS', 'CREATE_ISSUES', 'TRANSITION_ISSUES', 'BOGUS_PERMISSION'];
const APPS = ['com.innovalog.jmwe.jira-cloud', 'com.onresolve.jira.groovy.groovyrunner', 'com.beecom.jsu-cloud', 'com.decadis.jira.workflow-enhancer', 'com.unknown.vendor.app', ''];

export function makeRandomBundle(seed, { malformed = false, maxStatuses = 18, maxTransitions = 40 } = {}) {
  const r = rng(seed);
  const statusCount = r.int(1, maxStatuses);
  const statuses = Array.from({ length: statusCount }, (_, i) => ({
    id: String(10000 + i),
    name: r.bool(0.4) ? r.pick(NASTY) : `Status ${i}`,
    statusCategory: r.pick(CATS),
    statusReference: r.bool(0.5) ? String(10000 + i) : `ref-${seed}-${i}`,
  }));
  const groups = Array.from({ length: r.int(0, 8) }, (_, i) => ({ groupId: `0000000${i}-aaaa-4bbb-8ccc-${String(seed).padStart(12, '0').slice(-12)}`, name: r.bool(0.3) ? r.pick(NASTY) : `group-${i}` }));
  const users = Array.from({ length: r.int(0, 5) }, (_, i) => ({ accountId: `712020:${String(i).padStart(8, '0')}-1111-4222-8333-444455556666`, displayName: r.bool(0.3) ? r.pick(NASTY) : `User ${i}`, active: r.bool(0.8) }));
  const roles = [{ id: '10002', name: 'Administrators' }, { id: '10001', name: 'Developers' }];
  const fields = [{ id: 'assignee', name: 'Assignee' }, { id: 'resolution', name: 'Resolution' }, { id: 'duedate', name: 'Due date' }, ...Array.from({ length: 6 }, (_, i) => ({ id: `customfield_${10100 + i}`, name: r.bool(0.3) ? r.pick(NASTY) : `CF ${i}`, custom: true }))];

  const sref = (s) => s.statusReference;
  const wfStatuses = r.sample(statuses, r.int(1, statuses.length));
  const anyRef = () => (malformed && r.bool(0.1) ? `dangling-${r.int(1, 99)}` : sref(r.pick(wfStatuses)));
  const groupRef = () => (r.bool(0.2) || !groups.length ? `deadbeef-0000-4000-8000-${String(r.int(1, 1e6)).padStart(12, '0')}` : r.pick(groups).groupId);
  const userRef = () => (r.bool(0.2) || !users.length ? `712020:${r.int(1, 1e6)}` : r.pick(users).accountId);
  const fieldRef = () => (r.bool(0.15) ? `customfield_${r.int(20000, 29999)}` : r.pick(fields).id);

  const systemRule = (kind) => {
    const options = {
      condition: [
        () => ({ ruleKey: 'system:restrict-issue-transition', parameters: { groupIds: Array.from({ length: r.int(0, 3) }, groupRef).join(','), roleIds: r.bool(0.3) ? '10002' : '', accountIds: r.pick(['', 'allow-reporter', 'allow-assignee', userRef()]), permissionKeys: r.bool(0.2) ? r.pick(PERMS) : '' } }),
        () => ({ ruleKey: 'system:check-field-value', parameters: { fieldId: fieldRef(), fieldValue: r.pick(['["Done"]', '[]', 'not-json', '["a","b"]']), comparator: r.pick(['=', '!=', '>']), comparisonType: 'STRING' } }),
        () => ({ ruleKey: 'system:previous-status-condition', parameters: { previousStatusIds: r.pick(wfStatuses).id, not: String(r.bool()) } }),
        () => ({ ruleKey: 'system:separation-of-duties', parameters: { fromStatusId: r.pick(wfStatuses).id, toStatusId: r.pick(wfStatuses).id } }),
        () => ({ ruleKey: 'system:restrict-from-all-users', parameters: { restrictMode: r.pick(['users', 'usersAndAPI']) } }),
        () => ({ ruleKey: 'system:parent-or-child-blocking-condition', parameters: { blocker: 'CHILD', statusIds: r.sample(wfStatuses, 2).map((s) => s.id).join(',') } }),
      ],
      validator: [
        () => ({ ruleKey: 'system:validate-field-value', parameters: { ruleType: r.pick(['fieldRequired', 'fieldChanged', 'fieldHasSingleValue', 'fieldMatchesRegularExpression', 'dateFieldComparison', 'windowDateComparison', 'weird']), fieldsRequired: fieldRef(), fieldKey: fieldRef(), regexp: r.pick(['[0-9]{4}', '(', '.*']), date1FieldKey: fieldRef(), date2FieldKey: fieldRef(), errorMessage: r.bool() ? r.pick(NASTY) : undefined } }),
        () => ({ ruleKey: 'system:check-permission-validator', parameters: { permissionKey: r.pick(PERMS) } }),
        () => ({ ruleKey: 'system:previous-status-validator', parameters: { previousStatusIds: r.pick(wfStatuses).id } }),
      ],
      postfunction: [
        () => ({ ruleKey: 'system:update-field', parameters: { field: r.pick(['resolution', 'assignee', fieldRef()]), value: r.pick(['', '10000', userRef(), r.pick(NASTY)]), mode: r.pick(['replace', 'append', '']) } }),
        () => ({ ruleKey: 'system:change-assignee', parameters: r.bool() ? { type: 'to-selected-user', accountId: userRef() } : { type: r.pick(['to-current-user', 'to-unassigned', 'to-default-user', 'garbage']) } }),
        () => ({ ruleKey: 'system:copy-value-from-other-field', parameters: { sourceFieldKey: fieldRef(), targetFieldKey: fieldRef(), issueSource: r.pick(['SAME', 'PARENT']) } }),
        () => ({ ruleKey: 'system:trigger-webhook', parameters: { webhookId: String(r.int(1, 9)) } }),
      ],
    };
    const rule = r.pick(options[kind])();
    if (r.bool(0.5)) rule.id = `rule-${r.int(1, 1e9)}`;
    return rule;
  };
  const appRule = (kind) => {
    const key = { condition: 'connect:expression-condition', validator: 'connect:expression-validator', postfunction: 'connect:remote-workflow-function' }[kind];
    const forge = r.bool(0.2);
    const config = r.pick([
      '',
      JSON.stringify({ expression: `issue.${fieldRef()} != null && user.groups.includes("${r.pick(groups)?.name || 'x'}")`, errorMessage: r.pick(NASTY) }),
      JSON.stringify(JSON.stringify({ name: r.pick(NASTY), field: 'assignee', value: userRef(), nested: { group: r.pick(groups)?.name || 'missing-group', roleId: 10002 } })),
      '{not valid json',
      JSON.stringify({ big: 'x'.repeat(r.int(0, 5000)), list: Array.from({ length: r.int(0, 20) }, fieldRef) }),
      JSON.stringify({ script: 'if (app.license == null || app.license.active == true) { true } else { false }' }),
    ]);
    return forge
      ? { ruleKey: key.replace('connect:', 'forge:').replace('remote-workflow-function', 'workflow-post-function'), parameters: { key: `ari:cloud:ecosystem::extension/12345678-aaaa-4bbb-8ccc-1234567890ab/env/static/mod-${r.int(1, 3)}`, config, disabled: String(r.bool(0.1)) } }
      : { ruleKey: key, parameters: { appKey: r.pick(APPS), config, id: `id-${r.int(1, 1e6)}`, disabled: String(r.bool(0.1)), tag: r.bool(0.3) ? 'module-x' : '' } };
  };
  const rules = (kind, max) => Array.from({ length: r.int(0, max) }, () => (r.bool(0.3) ? appRule(kind) : systemRule(kind)));
  const condGroup = (depth) => ({
    operation: r.pick(['ALL', 'ANY']),
    conditions: rules('condition', 3),
    conditionGroups: depth > 0 && r.bool(0.3) ? Array.from({ length: r.int(1, 2) }, () => condGroup(depth - 1)) : [],
  });
  const props = () => (r.bool(0.3) ? { 'jira.permission.edit.group': r.pick(groups)?.name || 'missing', 'jira.permission.assignable.projectrole': '10002', 'jira.i18n.title': 'x', 'custom.user': userRef() } : {});

  const transitions = [];
  const tCount = r.int(0, maxTransitions);
  let nextId = 1;
  if (!malformed || r.bool(0.8)) transitions.push({ id: String(nextId), name: r.bool(0.8) ? 'Create' : r.pick(NASTY), type: 'INITIAL', toStatusReference: sref(wfStatuses[0]), links: [], validators: rules('validator', 2), actions: rules('postfunction', 2), triggers: [], properties: props() });
  for (let i = 0; i < tCount; i++) {
    nextId += 10;
    const type = r.pick(['DIRECTED', 'DIRECTED', 'DIRECTED', 'GLOBAL']);
    const t = {
      id: String(nextId),
      name: r.bool(0.35) ? r.pick(NASTY) : `T${i}`,
      description: r.bool(0.2) ? r.pick(NASTY) : '',
      type,
      toStatusReference: type === 'GLOBAL' && r.bool(0.1) ? undefined : anyRef(),
      links: type === 'DIRECTED' ? Array.from({ length: r.int(1, 3) }, () => ({ fromStatusReference: anyRef(), fromPort: 0, toPort: 1 })) : [],
      validators: rules('validator', 3),
      actions: rules('postfunction', 3),
      triggers: r.bool(0.1) ? [{ ruleKey: 'system:development-triggers', parameters: {} }] : [],
      properties: props(),
    };
    if (r.bool(0.7)) t.conditions = condGroup(3);
    if (r.bool(0.2)) t.transitionScreen = { ruleKey: 'system:transition-screen', parameters: { screenId: String(r.int(1, 3)) } };
    if (malformed && r.bool(0.05)) delete t.name;
    if (malformed && r.bool(0.05)) t.validators = null;
    transitions.push(t);
  }
  const wf = {
    id: `wf-${seed}`,
    name: r.bool(0.4) ? r.pick(NASTY) : `Workflow ${seed}`,
    scope: { type: r.bool(0.2) ? 'PROJECT' : 'GLOBAL' },
    version: { id: `v-${seed}`, versionNumber: r.int(0, 50) },
    statuses: wfStatuses.map((s) => ({ statusReference: sref(s), properties: props(), layout: r.bool(0.5) ? { x: r.int(-500, 2000), y: r.int(-500, 1500) } : undefined, deprecated: r.bool(0.05) })),
    transitions,
  };
  return {
    kind: r.bool(0.2) ? 'site' : 'project',
    project: { id: '1', key: 'FUZ', name: 'Fuzz' },
    issueTypes: [{ id: '1', name: 'Task' }],
    mapping: [{ issueTypeId: '1', workflowId: wf.id }],
    workflows: [wf],
    workflowProjects: r.bool(0.5) ? { [wf.id]: r.bool() ? [{ id: '1', key: 'FUZ', name: 'Fuzz' }] : [] } : undefined,
    statuses,
    ref: {
      fields,
      groups,
      roles,
      users,
      screens: [{ id: '1', name: 'Screen <b>1</b>' }],
      permissions: { ADMINISTER_PROJECTS: { name: 'Administer projects' }, CREATE_ISSUES: { name: 'Create issues' } },
      resolutions: [{ id: '10000', name: 'Done' }, { id: '10001', name: "Won't Do" }],
      capabilities: { systemRules: [], connectRules: [{ addonKey: 'com.beecom.jsu-cloud', ruleType: 'Validator', name: 'JSU Validator <i>x</i>' }], forgeRules: [] },
    },
  };
}

/** Random (often invalid) Autopilot operations for the given bundle. */
export function makeRandomOps(seed, bundle) {
  const r = rng(seed * 7919);
  const wf = bundle.workflows[0];
  const statusNames = bundle.statuses.map((s) => s.name);
  const tNames = (wf.transitions || []).map((t) => t?.name).filter(Boolean);
  const groupNames = bundle.ref.groups.map((g) => g.name);
  const anyName = () => r.pick([...tNames, '@all', '@done', '@global', '@initial', '@to:' + r.pick(statusNames), '@from:' + r.pick(statusNames), '@name:T', '@bogus', 'Missing transition', '']);
  const gens = [
    () => ({ op: 'addStatus', name: r.pick([...statusNames, 'New status ' + r.int(1, 9), '']), category: r.pick(['TODO', 'IN_PROGRESS', 'DONE', 'BAD']) }),
    () => ({ op: 'removeStatus', status: r.pick(statusNames), moveIssuesTo: r.pick(statusNames) }),
    () => ({ op: 'addTransition', name: 'Added ' + r.int(1, 99), from: r.bool(0.3) ? 'any' : r.sample(statusNames, r.int(0, 3)), to: r.pick(statusNames) }),
    () => ({ op: 'removeTransition', transition: anyName() }),
    () => ({ op: 'renameTransition', transition: anyName(), newName: r.pick(['Renamed', '<b>x</b>', '']) }),
    () => ({ op: 'addFromStatus', transition: anyName(), from: r.sample(statusNames, 2) }),
    () => ({ op: 'restrictTransition', transition: anyName(), groups: r.sample([...groupNames, 'unknown-group'], r.int(0, 2)), roles: r.bool() ? ['Administrators'] : [], reporter: r.bool() }),
    () => ({ op: 'requireFields', transition: anyName(), fields: r.sample(['Due date', 'customfield_10100', 'Unknown field'], r.int(0, 2)) }),
    () => ({ op: 'setResolution', transition: anyName(), resolution: r.pick(['Done', 'none', "Won't Do", 'Missing']) }),
    () => ({ op: 'setAssignee', transition: anyName(), to: r.pick(['current-user', 'unassigned', 'default', '712020:x']) }),
    () => ({ op: 'setTransitionScreen', transition: anyName(), screen: r.pick(['Screen <b>1</b>', 'none', 'Missing']) }),
    () => ({ op: 'removeRule', transition: anyName(), match: r.pick(['restrict', 'update-field', 'zzz']), kind: r.pick(['condition', 'validator', 'postfunction', undefined]) }),
    () => ({ op: 'removeReference', refType: r.pick(['group', 'role', 'user']), ref: r.pick([...groupNames, '10002', 'nobody']) }),
    () => ({ op: 'replaceReference', refType: 'group', ref: r.pick([...groupNames, 'nobody']), with: r.pick([...groupNames, 'missing']) }),
    () => ({ op: r.pick(['bogus', '', null]) }),
    () => r.pick([null, undefined, 42, 'string', []]),
  ];
  return Array.from({ length: r.int(1, 8) }, () => r.pick(gens)());
}
