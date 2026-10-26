import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../src/shared/engine.js';
import { applyOperations, dryRun, autofixOperations, buildUpdatePayload } from '../src/shared/autopilot.js';
import { makeSnapshot, diffSnapshots } from '../src/shared/snapshot.js';
import { findingText } from '../src/shared/i18n.js';

// "Software Simplified Workflow for Project GMT" as returned by POST /rest/api/3/workflows on superportdev (live):
// every global transition clears the resolution – including the one into Done – and none sets an event.
const clear = (id) => ({ ruleKey: 'system:update-field', parameters: { field: 'resolution', value: '', mode: '' }, id });
const none = { operation: 'ALL', conditions: [], conditionGroups: [] };
const gmtWorkflow = () => ({
  id: 'aa07d0fd-ea6a-4b9a-a1e9-4c07ab3d21b9',
  name: 'Software Simplified Workflow for Project GMT',
  scope: { type: 'GLOBAL' },
  version: { versionNumber: 4, id: 'v4' },
  statuses: ['10004', '10005', '3', '10006'].map((r, i) => ({ statusReference: r, layout: { x: i * 200, y: 0 }, properties: {}, deprecated: false })),
  transitions: [
    { id: '11', type: 'GLOBAL', toStatusReference: '10004', links: [], name: 'Backlog', actions: [clear('898634005')], validators: [], conditions: none, triggers: [], properties: {} },
    { id: '21', type: 'GLOBAL', toStatusReference: '10005', links: [], name: 'Selected for development', actions: [clear('467514859')], validators: [], conditions: none, triggers: [], properties: {} },
    { id: '31', type: 'GLOBAL', toStatusReference: '3', links: [], name: 'In Progress', actions: [clear('121467911')], validators: [], conditions: none, triggers: [], properties: {} },
    { id: '41', type: 'GLOBAL', toStatusReference: '10006', links: [], name: 'Done', actions: [clear('1891229626')], validators: [], conditions: none, triggers: [], properties: {} },
    { id: '1', type: 'INITIAL', toStatusReference: '10004', links: [], name: 'Create', actions: [], validators: [{ ruleKey: 'system:check-permission-validator', parameters: { permissionKey: 'CREATE_ISSUES' } }], triggers: [], properties: {} },
  ],
});
const statuses = [
  { id: '10004', name: 'Backlog', statusCategory: 'TODO', statusReference: '10004' },
  { id: '10005', name: 'Selected for development', statusCategory: 'IN_PROGRESS', statusReference: '10005' },
  { id: '3', name: 'In Progress', statusCategory: 'IN_PROGRESS', statusReference: '3' },
  { id: '10006', name: 'Done', statusCategory: 'DONE', statusReference: '10006' },
];
const resolutions = [{ id: '10000', name: 'Done' }, { id: '10001', name: "Won't Do" }];
const bundle = () => ({
  kind: 'project',
  project: { id: '10003', key: 'GMT', name: 'GMT', style: 'classic' },
  workflows: [gmtWorkflow()],
  statuses,
  ref: { fields: [{ id: 'resolution', name: 'Resolution', custom: false }], resolutions },
});
const findingsFor = (m, name) => m.findings.filter((f) => f.tName === name).map((f) => f.code);

test('a Done transition that clears the resolution is reported (GMT)', () => {
  const m = normalize(bundle());
  assert.ok(findingsFor(m, 'Done').includes('DONE_CLEARS_RESOLUTION'));
  assert.ok(!findingsFor(m, 'Done').includes('DONE_NO_RESOLUTION'));
  const f = m.findings.find((x) => x.code === 'DONE_CLEARS_RESOLUTION');
  assert.equal(f.severity, 'medium');
  assert.match(findingText('en', f).title, /clears the resolution/);
  assert.match(findingText('de', f).title, /leert die Lösung/);
  // Clearing on the way out of Done is correct and stays quiet
  assert.ok(!m.findings.some((x) => x.code === 'REOPEN_KEEPS_RESOLUTION'));
});

test('a Done transition firing the Generic Event is reported; Issue Resolved / Closed are fine', () => {
  const m = normalize(bundle());
  assert.ok(findingsFor(m, 'Done').includes('DONE_GENERIC_EVENT'));
  assert.equal(m.workflows[0].transitions.find((t) => t.name === 'Done').eventName, 'Generic Event');
  // Only transitions into Done are checked
  assert.deepEqual(m.findings.filter((x) => x.code === 'DONE_GENERIC_EVENT').map((x) => x.tName), ['Done']);
  for (const ev of ['4', '5']) {
    const b = bundle();
    b.workflows[0].transitions.find((t) => t.name === 'Done').customIssueEventId = ev;
    assert.ok(!findingsFor(normalize(b), 'Done').includes('DONE_GENERIC_EVENT'), `event ${ev}`);
  }
  const b = bundle();
  b.workflows[0].transitions.find((t) => t.name === 'Done').customIssueEventId = '13';
  assert.ok(findingsFor(normalize(b), 'Done').includes('DONE_GENERIC_EVENT'), 'explicit Generic Event');
});

test('team-managed workflows get no event finding', () => {
  const b = bundle();
  b.workflows[0].scope = { type: 'PROJECT', project: { id: '10003' } };
  assert.equal(normalize(b).findings.filter((f) => f.code === 'DONE_GENERIC_EVENT' || /RESOLUTION/.test(f.code)).length, 0);
});

test('auto-fix sets resolution Done and the Issue Resolved event; payload carries both', () => {
  const b = bundle();
  const m = normalize(b);
  const { ops } = autofixOperations(m, m.findings, resolutions);
  assert.ok(ops.some((o) => o.op === 'setResolution' && o.transition === '41' && o.resolution === 'Done'));
  assert.ok(ops.some((o) => o.op === 'setEvent' && o.transition === '41' && o.event === '4'));
  const dr = dryRun(b, b.workflows[0].id, ops);
  assert.ok(dr.results.every((r) => r.ok && !r.noop), JSON.stringify(dr.results));
  assert.deepEqual(dr.fixed.map((f) => f.code).sort(), ['DONE_CLEARS_RESOLUTION', 'DONE_GENERIC_EVENT']);
  assert.equal(dr.introduced.length, 0);
  assert.ok(dr.changes.some((c) => c.type === 'transition' && c.detail?.field === 'event' && c.detail.from === 'Generic Event' && c.detail.to === 'Issue Resolved'));
  const done = buildUpdatePayload(dr.workflow, { siteStatuses: statuses }).workflows[0].transitions.find((t) => t.id === '41');
  assert.equal(done.customIssueEventId, '4');
  assert.deepEqual(done.actions.filter((a) => a.parameters.field === 'resolution').map((a) => a.parameters.value), ['10000']);
});

test('setEvent accepts names, IDs, short names and "generic"; final Closed status gets Issue Closed', () => {
  const ctx = { statuses, ref: {}, resolutions, lang: 'en' };
  const wf = gmtWorkflow();
  const ev = (event) => applyOperations(wf, [{ op: 'setEvent', transition: 'Done', event }], ctx);
  assert.equal(ev('Issue Closed').workflow.transitions.find((t) => t.id === '41').customIssueEventId, '5');
  assert.equal(ev('resolved').workflow.transitions.find((t) => t.id === '41').customIssueEventId, '4');
  assert.match(ev('4').results[0].message, /Issue Resolved/);
  wf.transitions.find((t) => t.id === '41').customIssueEventId = '4';
  assert.equal(ev('generic').workflow.transitions.find((t) => t.id === '41').customIssueEventId, undefined);
  assert.equal(ev('Bogus').results[0].ok, false);
  // Custom events from the site are used when loaded
  const custom = applyOperations(gmtWorkflow(), [{ op: 'setEvent', transition: 'Done', event: 'Release shipped' }], { ...ctx, ref: { events: [{ id: '10100', name: 'Release shipped' }] } });
  assert.equal(custom.workflow.transitions.find((t) => t.id === '41').customIssueEventId, '10100');

  const b = bundle();
  b.statuses = statuses.map((s) => (s.id === '10006' ? { ...s, name: 'Closed' } : s));
  const m = normalize(b);
  assert.ok(autofixOperations(m, m.findings, resolutions).ops.some((o) => o.op === 'setEvent' && o.event === '5'));
});

test('old snapshots without events do not report every transition as changed', () => {
  const m = normalize(bundle());
  const old = makeSnapshot(m);
  for (const wf of old.workflows) for (const t of wf.t) delete t.ev;
  assert.deepEqual(diffSnapshots(old, makeSnapshot(m)), []);
});
