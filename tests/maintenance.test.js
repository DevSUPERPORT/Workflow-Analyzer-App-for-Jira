/**
 * Tests of the SUPERPORT kill switch (APP_MAINTENANCE). With "on" every resolver, Rovo action and the scheduled
 * monitor is refused without touching Jira or storage; with "readonly" reads keep working and every write is
 * refused; nothing a caller sends can change or bypass it.
 *
 * @file        tests/maintenance.test.js
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-24
 * @updated     2026-11-16
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { state, app, scenario, ctxProject, ctxSite, call, ok } from './support/harness.js';
import { maintenanceMode } from '../src/lib/maintenance.js';

const set = (v) => { if (v === undefined) delete process.env.APP_MAINTENANCE; else process.env.APP_MAINTENANCE = v; };
afterEach(() => set(undefined));

const kvsDump = () => JSON.stringify([...state.kvs.entries()].sort(([a], [b]) => a.localeCompare(b)));
// Anything that changes Jira: issue edits, transitions, new issues, workflow updates (validation and searches are reads)
const JIRA_WRITE = /^(?:FAULT )?[AU] (?:PUT|DELETE) |^(?:FAULT )?[AU] POST \/rest\/api\/3\/(?:workflows\/update(?:\?|$)|issue(?:\?|$)|issue\/[^/]+\/transitions)/;
const jiraWrites = (j) => j.log.filter((l) => JIRA_WRITE.test(l));

// Every resolver the app defines, with a plausible payload and the page it is called from. A resolver missing
// here fails the coverage test below, so a new resolver cannot slip past the switch untested.
const RESOLVERS = {
  bootstrap: [{}], setPrefs: [{ lang: 'de' }],
  getProjectData: [{}], saveNote: [{ workflowId: 'wf-1', transitionId: '11', text: 'x' }], getNotes: [{ workflowIds: ['wf-1'] }],
  listSnapshots: [{}], saveSnapshot: [{ label: 'x' }], getSnapshot: [{ id: 'x' }], deleteSnapshot: [{ id: 'x' }],
  getStatusLoad: [{ statusIds: ['1'] }], getIssueTypes: [{}], getRemediation: [{}],
  createRemediation: [{ items: [{ fingerprint: 'f', summary: 's' }], issueTypeId: '1' }],
  getMonitoring: [{}], setMonitoring: [{ enabled: true }], touchVisit: [{ findings: ['abc'] }],
  aiAsk: [{ question: 'q' }], aiPlan: [{ instructions: 'x', workflowId: 'wf-1' }],
  createPlan: [{ workflowId: 'wf-1', ops: [{ op: 'renameTransition', transition: 'Start', newName: 'X' }] }],
  autofixPlan: [{ workflowId: 'wf-1' }], replanPlan: [{ id: 'PLAN' }], listPlans: [{}], getPlan: [{ id: 'PLAN' }],
  applyPlan: [{ id: 'PLAN' }], rollbackPlan: [{ id: 'PLAN' }], discardPlan: [{ id: 'PLAN' }],
  siteScanPage: [{}, 'site'], siteRefs: [{ ids: {} }, 'site'], siteProjects: [{ workflowIds: ['wf-1'] }, 'site'],
  siteBulkList: [{}, 'site'], siteBulkGet: [{ id: 'x' }, 'site'],
  siteBulkCreate: [{ workflowIds: ['wf-1'], ops: [{ op: 'renameTransition', transition: 'Start', newName: 'X' }] }, 'site'],
  siteBulkPlanBatch: [{ bulkId: 'x' }, 'site'], siteBulkApply: [{ bulkId: 'x', workflowId: 'wf-1' }, 'site'],
  siteBulkRollback: [{ bulkId: 'x', workflowId: 'wf-1' }, 'site'], siteBulkAi: [{ instructions: 'x', workflowId: 'wf-1' }, 'site'],
  resolutionAudit: [{}], resolutionIssues: [{ kind: 'doneUnresolved' }],
  resolutionRepair: [{ items: [{ key: 'ALP-1', from: null, to: '10000' }], runId: 'run-1', kind: 'doneUnresolved' }], resolutionRuns: [{}],
  getAiSettings: [{}, 'site'], setAiSettings: [{ enabled: false }, 'site'],
};
const READS = new Set(['bootstrap', 'getProjectData', 'getNotes', 'listSnapshots', 'getSnapshot', 'siteScanPage', 'siteRefs', 'siteProjects', 'getStatusLoad', 'getIssueTypes', 'getRemediation', 'getMonitoring', 'aiAsk', 'listPlans', 'getPlan', 'siteBulkList', 'siteBulkGet', 'resolutionAudit', 'resolutionIssues', 'resolutionRuns', 'getAiSettings']);

const ROVO = {
  actOverview: [{ projectKey: 'ALP' }, 'read'], actFindUsages: [{ projectKey: 'ALP', searchTerm: 'legal' }, 'read'],
  actHealth: [{ projectKey: 'ALP' }, 'read'], actExplain: [{ projectKey: 'ALP', transitionName: 'Start' }, 'read'],
  actStatusLoad: [{ projectKey: 'ALP' }, 'read'], actAccess: [{ projectKey: 'ALP' }, 'read'], actCompare: [{ projectKey: 'ALP' }, 'read'],
  actResolutions: [{ projectKey: 'ALP' }, 'read'], actListPlans: [{ projectKey: 'ALP' }, 'read'],
  actRemediate: [{ projectKey: 'ALP', minimumSeverity: 'low' }, 'write'],
  actPlanChange: [{ projectKey: 'ALP', workflowName: 'Alpha', instructions: 'x', operationsJson: JSON.stringify([{ op: 'renameTransition', transition: 'Start', newName: 'X' }]) }, 'write'],
  actApplyChange: [{ projectKey: 'ALP', planId: 'PLAN' }, 'write'], actRollbackChange: [{ projectKey: 'ALP', planId: 'PLAN' }, 'write'],
  actAutofix: [{ projectKey: 'ALP' }, 'write'],
};

const payloadFor = (p, planId) => JSON.parse(JSON.stringify(p).replaceAll('"PLAN"', JSON.stringify(planId)));
const ctxFor = (where) => (where === 'site' ? ctxSite() : ctxProject());

/** A scenario with real data behind the write resolvers: a planned and an applied plan, monitoring on. */
async function seeded() {
  const s = scenario();
  const planned = await ok('createPlan', { workflowId: 'wf-1', ops: [{ op: 'renameTransition', transition: 'Start', newName: 'Kick-off' }] });
  await ok('setMonitoring', { enabled: true });
  s.j.log.length = 0;
  return { ...s, planId: planned.id };
}

test('the switch is read from the environment and fails closed on anything unknown', () => {
  assert.equal(maintenanceMode({}), 'off');
  assert.equal(maintenanceMode({ APP_MAINTENANCE: '' }), 'off');
  assert.equal(maintenanceMode({ APP_MAINTENANCE: 'off' }), 'off');
  assert.equal(maintenanceMode({ APP_MAINTENANCE: ' OFF ' }), 'off');
  assert.equal(maintenanceMode({ APP_MAINTENANCE: ' ReadOnly ' }), 'readonly');
  assert.equal(maintenanceMode({ APP_MAINTENANCE: 'read-only' }), 'readonly');
  assert.equal(maintenanceMode({ APP_MAINTENANCE: 'on' }), 'on');
  for (const v of ['of', 'false', '0', 'no', 'disabled', 'maintenance', 'readonl']) assert.equal(maintenanceMode({ APP_MAINTENANCE: v }), 'on', v);
});

test('every resolver the app defines is covered by these tests', () => {
  const defined = Object.keys(app.handler).filter((n) => n !== 'availability').sort();
  assert.deepEqual(defined, Object.keys(RESOLVERS).sort());
});

test('APP_MAINTENANCE=on: every resolver is refused for a Jira admin, with no Jira call and nothing stored', async () => {
  const { j, planId } = await seeded();
  set('on');
  const before = kvsDump();
  for (const [name, [payload, where]] of Object.entries(RESOLVERS)) {
    const res = await call(name, payloadFor(payload, planId), ctxFor(where));
    assert.equal(res.ok, false, name);
    assert.equal(res.error, 'UNAVAILABLE', name);
    assert.equal(res.mode, 'on', name);
    assert.match(res.message, /temporarily unavailable.*maintenance to keep your data safe.*superapps\.statuspage\.io/, name);
  }
  assert.equal(j.log.length, 0, 'not even a read reaches Jira');
  assert.equal(kvsDump(), before, 'nothing stored');
});

test('APP_MAINTENANCE=on cannot be switched off or bypassed through anything a caller sends', async () => {
  const { j, planId } = await seeded();
  set('on');
  const before = kvsDump();
  const hostile = { APP_MAINTENANCE: 'off', maintenance: 'off', mode: 'off', env: { APP_MAINTENANCE: 'off' } };
  for (const [name, [payload, where]] of Object.entries(RESOLVERS)) {
    const res = await app.handler[name]({ payload: { ...payloadFor(payload, planId), ...hostile }, context: { ...ctxFor(where), APP_MAINTENANCE: 'off', env: { APP_MAINTENANCE: 'off' } } });
    assert.equal(res.error, 'UNAVAILABLE', name);
  }
  assert.deepEqual((await ok('availability', hostile)), { mode: 'on', statusUrl: 'https://superapps.statuspage.io' });
  assert.equal(process.env.APP_MAINTENANCE, 'on');
  assert.equal(j.log.length, 0);
  assert.equal(kvsDump(), before);
});

test('APP_MAINTENANCE=on: the UI is told, Rovo answers with the status page and the daily monitor does nothing', async () => {
  const { j, planId } = await seeded();
  set('on');
  const before = kvsDump();
  assert.deepEqual(await ok('availability', {}), { mode: 'on', statusUrl: 'https://superapps.statuspage.io' });
  for (const [name, [payload]] of Object.entries(ROVO)) {
    const res = await app[name](payloadFor(payload, planId));
    assert.match(res.error, /temporarily unavailable.*superapps\.statuspage\.io/, name);
  }
  await app.monitor({});
  assert.equal(j.log.length, 0, 'not even a read reaches Jira');
  assert.equal(kvsDump(), before, 'nothing stored');
});

test('availability still requires a signed-in caller', async () => {
  scenario();
  set('on');
  const res = await app.handler.availability({ payload: {}, context: { moduleKey: 'workflow-analyzer-project' } });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'FORBIDDEN');
});

test('APP_MAINTENANCE=readonly: reads work, every write is refused, and nothing changes in Jira or storage', async () => {
  const { j, planId } = await seeded();
  set('readonly');
  assert.equal((await ok('availability', {})).mode, 'readonly');
  for (const [name, [payload, where]] of Object.entries(RESOLVERS)) {
    // reads may refresh the project's workflow-ID cache, nothing else
    const before = kvsDump();
    const res = await call(name, payloadFor(payload, planId), ctxFor(where));
    if (READS.has(name)) {
      assert.notEqual(res.error, 'UNAVAILABLE', `${name} is a read and must keep working`);
    } else {
      assert.equal(res.ok, false, name);
      assert.equal(res.error, 'UNAVAILABLE', name);
      assert.equal(res.mode, 'readonly', name);
      assert.match(res.message, /Changes are paused for maintenance.*superapps\.statuspage\.io/, name);
      assert.equal(kvsDump(), before, `${name} stored something`);
    }
  }
  assert.ok((await ok('getProjectData')).bundle.workflows.length > 0, 'the analysis still loads');
  assert.deepEqual(jiraWrites(j), [], 'no Jira writes');
});

test('APP_MAINTENANCE=readonly: Rovo can answer but not change anything, and the daily monitor does nothing', async () => {
  const { j, planId } = await seeded();
  set('readonly');
  const before = kvsDump();
  for (const [name, [payload, kind]] of Object.entries(ROVO)) {
    const res = await app[name](payloadFor(payload, planId));
    if (kind === 'read') assert.doesNotMatch(String(res?.error || ''), /paused|unavailable/, name);
    else assert.match(res.error, /Changes are paused for maintenance.*superapps\.statuspage\.io/, name);
  }
  assert.equal((await app.actOverview({ projectKey: 'ALP' })).project.key, 'ALP');
  const logBefore = j.log.length;
  await app.monitor({});
  assert.equal(j.log.length, logBefore, 'monitor made no Jira call');
  assert.deepEqual(jiraWrites(j), [], 'no Jira writes');
  assert.equal(kvsDump(), before, 'nothing stored');
});

test('APP_MAINTENANCE=off (or unset): everything works normally', async () => {
  const { j, planId } = await seeded();
  assert.equal((await ok('availability', {})).mode, 'off');
  set('off');
  assert.equal((await ok('availability', {})).mode, 'off');
  assert.ok((await ok('getProjectData')).bundle.workflows.length > 0);
  const applied = await ok('applyPlan', { id: planId });
  assert.equal(applied.status, 'applied');
  assert.ok(jiraWrites(j).length > 0, 'the apply reached Jira');
  assert.ok((await app.actOverview({ projectKey: 'ALP' })).project);
});
