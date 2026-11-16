/**
 * Shared end-to-end harness: mocks the Forge platform modules (api, kvs, llm, resolver) and wires them to
 * FakeJira and an in-memory KVS, and provides the standard scenario and call helpers. Must be imported before
 * any src/ module (node --test --experimental-test-module-mocks).
 *
 * @file        tests/support/harness.js
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-24
 * @updated     2026-11-16
 */

import { mock } from 'node:test';
import assert from 'node:assert/strict';
import { FakeJira } from '../fakejira/fake.js';

export const state = { jira: null, kvs: new Map(), llm: [], kvsFail: null, invocationId: 'inv-0' };
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

mock.module('@forge/api', {
  defaultExport: {
    asApp: () => ({ requestJira: (path, opts) => state.jira.request(String(path), opts || {}, false) }),
    asUser: () => ({ requestJira: (path, opts) => state.jira.request(String(path), opts || {}, true) }),
  },
  namedExports: {
    // one Forge invocation per test step: set state.invocationId to start a new one
    getAppContext: () => ({ invocationId: state.invocationId }),
    route: (strings, ...vals) => strings.reduce((acc, s, i) => acc + s + (i < vals.length ? (vals[i] instanceof URLSearchParams ? vals[i].toString() : encodeURIComponent(String(vals[i]))) : ''), ''),
  },
});
mock.module('@forge/kvs', {
  namedExports: {
    kvs: {
      get: async (k) => clone(state.kvs.get(k)),
      set: async (k, v) => { if (state.kvsFail?.test(k)) throw new Error(`KVS unavailable (${k})`); assert.ok(JSON.stringify(v).length < 240 * 1024, `KVS value for ${k} exceeds 240 KiB`); state.kvs.set(k, clone(v)); },
      delete: async (k) => { state.kvs.delete(k); },
    },
  },
});
mock.module('@forge/llm', {
  namedExports: {
    list: async () => ({ models: [{ model: 'claude-sonnet-5', status: 'active' }] }),
    chat: async (req) => {
      const next = state.llm.shift();
      if (!next) throw new Error('LLM not scripted');
      return typeof next === 'function' ? next(req) : next;
    },
  },
});
mock.module('@forge/resolver', {
  defaultExport: class Resolver {
    constructor() { this.defs = {}; }
    define(name, fn) { this.defs[name] = fn; }
    getDefinitions() { return this.defs; }
  },
});

export const app = await import('../../src/index.js');
export const store = await import('../../src/lib/store.js');
export const { monitorRun } = await import('../../src/monitor.js');
export const { normalize } = await import('../../src/shared/engine.js');

// ------------------------------------------------------------------ scenario
export const G = { legal: 'aaaaaaaa-0000-4000-8000-000000000001', buy: 'aaaaaaaa-0000-4000-8000-000000000002', old: 'aaaaaaaa-0000-4000-8000-000000000003' };

export function scenario() {
  const j = new FakeJira();
  const S = { open: j.addStatus('Open', 'TODO'), review: j.addStatus('Review', 'IN_PROGRESS'), done: j.addStatus('Done', 'DONE'), archived: j.addStatus('Archived', 'TODO') };
  j.groups = [{ groupId: G.legal, name: 'legal' }, { groupId: G.buy, name: 'buyers' }, { groupId: G.old, name: 'old-team' }];
  j.users = [{ accountId: '712020:aaaa', displayName: 'Ann', active: true }];
  j.addProject({ id: '100', key: 'ALP', name: 'Alpha', issueTypes: [{ id: '1', name: 'Task' }, { id: '2', name: 'Bug' }] });
  j.addProject({ id: '300', key: 'BET', name: 'Beta', issueTypes: [{ id: '1', name: 'Task' }] });
  j.addProject({ id: '200', key: 'TMP', name: 'Team', style: 'next-gen', issueTypes: [{ id: '5', name: 'Story' }] });
  const restrict = (p) => ({ operation: 'ALL', conditions: [{ ruleKey: 'system:restrict-issue-transition', parameters: p }], conditionGroups: [] });
  const w1 = {
    id: 'wf-1', name: 'Alpha Workflow', scope: { type: 'GLOBAL' },
    statuses: [S.open, S.review, S.done, S.archived].map((s) => ({ statusReference: s, properties: s === S.review ? { 'jira.permission.edit.group': 'old-team' } : {} })),
    transitions: [
      { id: '1', name: 'Create', type: 'INITIAL', toStatusReference: S.open, links: [], actions: [], validators: [], triggers: [], properties: {} },
      { id: '11', name: 'Start', type: 'DIRECTED', toStatusReference: S.review, links: [{ fromStatusReference: S.open }], conditions: restrict({ groupIds: G.legal }), actions: [], validators: [], triggers: [], properties: {} },
      { id: '21', name: 'Approve', type: 'DIRECTED', toStatusReference: S.done, links: [{ fromStatusReference: S.review }], conditions: restrict({ groupIds: `${G.buy},${G.legal}` }), actions: [{ ruleKey: 'system:update-field', parameters: { field: 'resolution', value: '10000', mode: 'replace' } }], validators: [], triggers: [], properties: {} },
      { id: '31', name: 'Reject', type: 'GLOBAL', toStatusReference: S.done, links: [], actions: [], validators: [], triggers: [], properties: {} },
      { id: '41', name: 'Archive', type: 'DIRECTED', toStatusReference: S.archived, links: [{ fromStatusReference: S.review }], actions: [], validators: [], triggers: [], properties: {} },
    ],
  };
  const w2 = { id: 'wf-2', name: 'Bug Workflow', scope: { type: 'GLOBAL' }, statuses: [S.open, S.done].map((s) => ({ statusReference: s, properties: {} })), transitions: [{ id: '1', name: 'Create', type: 'INITIAL', toStatusReference: S.open, links: [], actions: [], validators: [], triggers: [], properties: {} }, { id: '11', name: 'Fix', type: 'DIRECTED', toStatusReference: S.done, links: [{ fromStatusReference: S.open }], actions: [{ ruleKey: 'system:update-field', parameters: { field: 'resolution', value: '10000', mode: 'replace' } }], validators: [], triggers: [], properties: {} }] };
  const w3 = { id: 'wf-3', name: 'Team Workflow', scope: { type: 'PROJECT', project: { id: '200' } }, statuses: [S.open, S.done].map((s) => ({ statusReference: s, properties: {} })), transitions: [{ id: '1', name: 'Create', type: 'INITIAL', toStatusReference: S.open, links: [], actions: [], validators: [], triggers: [], properties: {} }, { id: '11', name: 'Done', type: 'GLOBAL', toStatusReference: S.done, links: [], actions: [], validators: [], triggers: [], properties: {} }] };
  j.addWorkflow(w1, { projectId: '100', issueTypeIds: ['1'] });
  j.addWorkflow(w2, { projectId: '100', issueTypeIds: ['2'] });
  j.addWorkflow(w3, { projectId: '200', issueTypeIds: ['5'] });
  j.addIssue({ projectId: '100', issueTypeId: '1', statusId: S.review, updated: '2020-01-01T00:00:00Z' });
  j.addIssue({ projectId: '100', issueTypeId: '1', statusId: S.archived });
  j.addIssue({ projectId: '100', issueTypeId: '1', statusId: S.archived });
  state.jira = j;
  // AI is off by default on a real site; the scenarios start with a Jira admin having turned it on, so the AI and
  // Rovo tests exercise the real paths (tests/ai-settings.test.js covers the default and the switch itself)
  state.kvs = new Map([['ai-settings', { aiEnabled: true }]]);
  state.llm = [];
  state.kvsFail = null;
  state.invocationId = `inv-${Math.random().toString(36).slice(2)}`;
  return { j, S };
}

export const ctxProject = (id = '100', key = 'ALP') => ({ accountId: 'user-admin', moduleKey: 'workflow-analyzer-project', extension: { project: { id, key } } });
export const ctxSite = () => ({ accountId: 'user-admin', moduleKey: 'workflow-analyzer-admin', extension: {} });
export async function call(name, payload = {}, context = ctxProject()) {
  const res = await app.handler[name]({ payload, context });
  return res;
}
export async function ok(name, payload, context) {
  const res = await call(name, payload, context);
  assert.equal(res.ok, true, `${name} failed: ${res.error} ${res.message || ''}`);
  return res.data;
}
export const shape = (wf) => ({ statuses: wf.statuses.map((s) => s.statusReference).sort(), transitions: wf.transitions.map((t) => [t.id, t.name, t.type, t.toStatusReference, (t.links || []).map((l) => l.fromStatusReference).sort().join(), JSON.stringify(t.conditions?.conditions || []), JSON.stringify((t.actions || []).map((a) => [a.ruleKey, a.parameters]))]).sort() });

