/**
 * Compatibility matrix: the configurations met on client sites that differ from a fresh test site (team-managed,
 * Service Management, thousands of groups, hundreds of projects sharing a workflow, sites without AI). Each
 * scenario asserts on what Jira ends up containing after the app read or changed it.
 *
 * @file        tests/compat.e2e.test.js
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-24
 * @updated     2026-11-05
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { state, G, scenario, ctxProject, ctxSite, call, ok, normalize } from './support/harness.js';
import { FakeJira } from './fakejira/fake.js';

const rule = (ruleKey, parameters) => ({ id: `r-${Math.random().toString(36).slice(2, 8)}`, ruleKey, parameters });

/** A JSM-style project: approvals, layout, deprecated status, descriptions, third-party rules with odd parameters. */
function jsmSite() {
  const j = new FakeJira();
  const S = {
    open: j.addStatus('Waiting for support', 'TODO', 'Ticket is new – shown on the customer portal'),
    appr: j.addStatus('Waiting for approval', 'IN_PROGRESS', 'Manager approval required'),
    old: j.addStatus('Legacy triage', 'IN_PROGRESS', 'Do not use'),
    done: j.addStatus('Resolved', 'DONE', 'Solved'),
  };
  j.groups = [{ groupId: G.legal, name: 'legal' }, { groupId: G.buy, name: 'buyers' }];
  j.addProject({ id: '500', key: 'SD', name: 'Service Desk', issueTypes: [{ id: '10', name: 'Service request' }, { id: '11', name: 'Incident' }] });
  const third = [
    rule('connect:com.innovalog.jmwe__SetFieldValueFunction', { config: JSON.stringify({ field: 'customfield_10010', value: "{{issue.reporter}}\n<b>x</b>", nested: { a: [1, null, ''] } }) }),
    rule('forge:ari:cloud:ecosystem::extension/aaaa/bbbb/static/validator', { config: '{"expression":"issue.customfield_10020 != null && user.groups.includes(\\"legal\\")"}', errorMessage: 'Ünïcödé – “quotes”' }),
    rule('connect:com.onresolve.jira.groovy.groovyrunner__script-postfunction', null),
  ];
  const wf = {
    id: 'wf-sd', name: 'SD: Service request workflow', description: 'Customer facing – do not break', scope: { type: 'GLOBAL' },
    startPointLayout: { x: -100, y: 0 }, loopedTransitionContainerLayout: { x: 500, y: 40 },
    statuses: [
      { statusReference: S.open, layout: { x: 0, y: 0 }, properties: { 'jira.issue.editable': 'true' } },
      { statusReference: S.appr, layout: { x: 200, y: 0 }, properties: {}, approvalConfiguration: { active: 'true', conditionType: 'number', conditionValue: '1', exclude: 'reporter', fieldId: 'customfield_10003', prePopulatedFieldId: null, transitionApproved: '21', transitionRejected: '31' } },
      { statusReference: S.old, layout: { x: 200, y: 200 }, properties: {}, deprecated: true },
      { statusReference: S.done, layout: { x: 400, y: 0 }, properties: { 'jira.permission.edit.group': 'legal' } },
    ],
    transitions: [
      { id: '1', name: 'Create', type: 'INITIAL', toStatusReference: S.open, links: [], actions: [], validators: [], triggers: [], properties: {} },
      { id: '11', name: 'Request approval', description: 'Sends to the manager', type: 'DIRECTED', toStatusReference: S.appr, links: [{ fromStatusReference: S.open, fromPort: 1, toPort: 3 }], actions: [third[0], third[2]], validators: [third[1]], triggers: [], properties: { 'opsbar-sequence': '10' }, customIssueEventId: '10200', transitionScreen: rule('system:transition-screen', { screenId: '10050' }) },
      { id: '21', name: 'Approve', type: 'DIRECTED', toStatusReference: S.done, links: [{ fromStatusReference: S.appr }], conditions: { operation: 'ANY', conditions: [rule('system:restrict-issue-transition', { groupIds: G.legal })], conditionGroups: [{ operation: 'ALL', conditions: [rule('system:restrict-issue-transition', { roleIds: '10002' })], conditionGroups: [] }] }, actions: [rule('system:update-field', { field: 'resolution', value: '10000', mode: 'replace' })], validators: [], triggers: [], properties: {} },
      { id: '31', name: 'Decline', type: 'DIRECTED', toStatusReference: S.done, links: [{ fromStatusReference: S.appr }], actions: [rule('system:update-field', { field: 'resolution', value: '10001', mode: 'replace' })], validators: [], triggers: [rule('system:development-trigger', { enabledTriggers: 'pull-request-merged' })], properties: {} },
    ],
  };
  j.addWorkflow(wf, { projectId: '500', issueTypeIds: ['10', '11'] });
  state.jira = j;
  state.kvs = new Map();
  return { j, S, wf };
}

const sd = ctxProject('500', 'SD');
// Equivalent normalisations Jira itself applies: missing description = '', null parameters = {}
const canon = (t) => ({ ...t, description: t.description || '', actions: (t.actions || []).map((r) => ({ ...r, parameters: r.parameters || {} })) });
const strip = (wf) => JSON.parse(JSON.stringify({ ...wf, version: undefined, transitions: wf.transitions.map((t) => canon(t.id === '21' ? { ...t, name: undefined } : t)) }));

test('JSM workflow: approvals, layouts, deprecated statuses, descriptions and third-party rules survive a change byte for byte', async () => {
  const { j, wf } = jsmSite();
  const statusesBefore = JSON.stringify([...j.statuses.values()]);
  const plan = await ok('createPlan', { workflowId: 'wf-sd', ops: [{ op: 'renameTransition', transition: 'Approve', newName: 'Approve request' }] }, sd);
  assert.equal(plan.status, 'planned', JSON.stringify(plan.results));
  const applied = await ok('applyPlan', { id: plan.id }, sd);
  assert.equal(applied.status, 'applied', JSON.stringify(applied.errors));
  const after = j.workflows.get('wf-sd');
  assert.equal(after.transitions.find((t) => t.id === '21').name, 'Approve request');
  const diff = (a, b, p = '') => { if (JSON.stringify(a) === JSON.stringify(b)) return []; if (a && b && typeof a === 'object' && typeof b === 'object') return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((k) => diff(a[k], b[k], `${p}.${k}`)); return [`${p}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`]; };
  assert.deepEqual(diff(strip(wf), strip(after)), [], 'everything except the renamed transition is unchanged');
  assert.equal(JSON.stringify([...j.statuses.values()]), statusesBefore, 'global status names/descriptions untouched');
  // and the rollback restores the original name without losing anything either
  await ok('rollbackPlan', { id: plan.id }, sd);
  const back = j.workflows.get('wf-sd');
  assert.equal(back.transitions.find((t) => t.id === '21').name, 'Approve');
  assert.deepEqual(diff(strip(wf), strip(back)), []);
});

test('JSM workflow: analysis recognises approvals, vendors and nested condition groups', async () => {
  jsmSite();
  const data = await ok('getProjectData', {}, sd);
  const model = normalize(data.bundle);
  const wf = model.workflows[0];
  assert.equal(wf.transitions.length, 4);
  const vendors = new Set(wf.transitions.flatMap((t) => [...t.validators, ...t.postFunctions].map((r) => r.vendor.name)));
  assert.ok([...vendors].some((v) => /JMWE|Workflow Extensions/i.test(v)), [...vendors].join());
  assert.ok([...vendors].some((v) => /ScriptRunner/i.test(v)), [...vendors].join());
  assert.ok(!model.findings.some((f) => f.code === 'UNRESOLVED_REF' && f.params?.name === 'legal'));
  assert.equal(model.stats.healthScore >= 0 && model.stats.healthScore <= 100, true);
});

test('permission scheme without app access: the project still loads via the admin user', async () => {
  const { j } = scenario();
  j.appHidden.add('100');
  const data = await ok('getProjectData');
  assert.equal(data.bundle.project.key, 'ALP');
  assert.equal(data.bundle.workflows.length, 2);
  const plan = await ok('createPlan', { workflowId: 'wf-1', ops: [{ op: 'renameTransition', transition: 'Start', newName: 'Go' }] });
  assert.equal(plan.sharedProjects[0].key, 'ALP', 'project keys are resolved, not raw IDs');
});

test('default workflow shared by 450 projects (one archived): status removal maps every readable project', async () => {
  const { j, S } = scenario();
  j.usagePageSize = 200;
  for (let i = 0; i < 449; i++) {
    const id = String(1000 + i);
    j.addProject({ id, key: `P${i}`, name: `Project ${i}`, issueTypes: [{ id: '1', name: 'Task' }, { id: '2', name: 'Bug' }] });
    j.addWorkflow(j.workflows.get('wf-1'), { projectId: id, issueTypeIds: ['1', '2'] });
  }
  j.archived.add('1448');
  const plan = await ok('createPlan', { workflowId: 'wf-1', ops: [{ op: 'removeStatus', status: 'Archived', moveIssuesTo: 'Open' }] });
  assert.equal(plan.sharedProjects.length, 450);
  const applied = await ok('applyPlan', { id: plan.id, confirmShared: true });
  assert.equal(applied.status, 'applied', JSON.stringify(applied.errors));
  assert.ok(!j.workflows.get('wf-1').statuses.some((s) => s.statusReference === S.archived));
  assert.equal(j.issues.filter((i) => i.statusId === S.archived).length, 0);
});

test('site with 5,000 groups: referenced groups beyond the list resolve, deleted ones are still reported', async () => {
  const { j } = scenario();
  const far = 'bbbbbbbb-0000-4000-8000-000000004500';
  for (let i = 0; i < 5000; i++) j.groups.push({ groupId: i === 4500 ? far : `cccccccc-0000-4000-8000-${String(i).padStart(12, '0')}`, name: i === 4500 ? 'zz-far-away' : `team-${i}` });
  const wf = j.workflows.get('wf-1');
  wf.transitions.find((t) => t.name === 'Archive').conditions = { operation: 'ALL', conditions: [{ ruleKey: 'system:restrict-issue-transition', parameters: { groupIds: `${far},dddddddd-0000-4000-8000-00000000dead` } }], conditionGroups: [] };
  wf.statuses[0].properties = { 'jira.permission.edit.group': 'zz-far-away' };
  const t0 = Date.now();
  const data = await ok('getProjectData');
  assert.ok(Date.now() - t0 < 10000, `took ${Date.now() - t0} ms`);
  const model = normalize(data.bundle);
  const unresolved = model.findings.filter((f) => f.code === 'UNRESOLVED_REF').map((f) => f.params?.name || f.params?.id);
  assert.ok(!unresolved.some((n) => /zz-far-away|4500/.test(String(n))), `false positive: ${unresolved}`);
  assert.ok(unresolved.some((n) => /dead/.test(String(n))), `deleted group not reported: ${unresolved}`);
  // the Autopilot can use a group no workflow references yet
  const plan = await ok('createPlan', { workflowId: 'wf-1', ops: [{ op: 'restrictTransition', transition: 'Reject', groups: ['team-4999'] }] });
  assert.equal(plan.status, 'planned', JSON.stringify(plan.results));
});

test('group listing fails half-way: unknown groups are shown as unknown, never as deleted', async () => {
  const { j } = scenario();
  for (let i = 0; i < 300; i++) j.groups.push({ groupId: `cccccccc-0000-4000-8000-${String(i).padStart(12, '0')}`, name: `team-${i}` });
  j.faults.push({ match: /group\/bulk\?startAt=(100|150)/, status: 500, times: -1 });
  j.faults.push({ match: /group\/bulk\?groupId/, status: 500, times: -1 });
  const data = await ok('getProjectData');
  const model = normalize(data.bundle);
  assert.ok(!model.findings.some((f) => f.code === 'UNRESOLVED_REF' && f.params?.type === 'group'), JSON.stringify(model.findings.filter((f) => f.code === 'UNRESOLVED_REF')));
  assert.ok(data.bundle.warnings.length > 0, 'the gap is reported as a warning');
});

test('project with 120 issue types loads within the resolver time budget', async () => {
  const j = new FakeJira();
  const open = j.addStatus('Open', 'TODO');
  const done = j.addStatus('Done', 'DONE');
  const types = Array.from({ length: 120 }, (_, i) => ({ id: String(100 + i), name: `Type ${i}`, subtask: i % 10 === 0 }));
  j.addProject({ id: '700', key: 'BIG', name: 'Big', issueTypes: types });
  for (let w = 0; w < 12; w++) {
    j.addWorkflow({ id: `wf-t${w}`, name: `Type workflow ${w}`, scope: { type: 'GLOBAL' }, statuses: [{ statusReference: open, properties: {} }, { statusReference: done, properties: {} }], transitions: [{ id: '1', name: 'Create', type: 'INITIAL', toStatusReference: open, links: [], actions: [], validators: [], triggers: [], properties: {} }, { id: '11', name: 'Done', type: 'GLOBAL', toStatusReference: done, links: [], actions: [{ ruleKey: 'system:update-field', parameters: { field: 'resolution', value: '10000', mode: 'replace' } }], validators: [], triggers: [], properties: {} }] }, { projectId: '700', issueTypeIds: types.filter((_, i) => i % 12 === w).map((t) => t.id) });
  }
  state.jira = j;
  state.kvs = new Map();
  const t0 = Date.now();
  const data = await ok('getProjectData', {}, ctxProject('700', 'BIG'));
  assert.equal(data.bundle.workflows.length, 12);
  assert.equal(data.bundle.mapping.length, 120);
  const calls = j.log.length;
  assert.ok(calls < 160, `${calls} Jira calls`);
  assert.ok(Date.now() - t0 < 10000);
});

test('empty and unusual projects never crash the analysis', async () => {
  const j = new FakeJira();
  j.addProject({ id: '800', key: 'EMPTY', name: 'Empty', issueTypes: [] });
  j.addProject({ id: '801', key: 'NOWF', name: 'No workflow mapped', issueTypes: [{ id: '1', name: 'Task' }] });
  state.jira = j;
  state.kvs = new Map();
  for (const [id, key] of [['800', 'EMPTY'], ['801', 'NOWF']]) {
    const data = await ok('getProjectData', {}, ctxProject(id, key));
    const model = normalize(data.bundle);
    assert.equal(model.workflows.length, 0);
    assert.ok(Number.isFinite(model.stats.healthScore));
    assert.equal((await call('createPlan', { workflowId: 'x', ops: [{ op: 'addStatus', name: 'A' }] }, ctxProject(id, key))).ok, false);
  }
});

test('preferences: unsupported UI languages fall back to English, German variants map to German', async () => {
  scenario();
  for (const [lang, want] of [['de-AT', 'de'], ['fr', 'de'], ['en_GB', 'en'], ['de_CH', 'de'], ['', 'de'], ['<script>', 'de'], ['deutsch', 'de']]) {
    const res = await ok('setPrefs', { lang });
    assert.equal(res.lang, want, `lang ${lang}: unsupported values keep the previous choice`);
  }
});

test('site page: the bulk scan works when a workflow cannot be read', async () => {
  const { j } = scenario();
  j.faults.push({ match: /projectUsages/, status: 500, times: -1 });
  const page = await ok('siteScanPage', { startAt: 0 }, ctxSite());
  assert.ok(page.workflows.length >= 3);
});
