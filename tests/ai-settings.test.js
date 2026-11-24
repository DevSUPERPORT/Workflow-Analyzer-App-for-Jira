/**
 * Tests of the per-site AI switch and the monthly Forge LLM quota: AI is off by default, only Jira admins can turn
 * it on (checked live), every AI entry point (aiAsk, aiPlan, siteBulkAi, every Rovo action) refuses while it is
 * off, and the quota counts calls and tokens per calendar month (UTC) and refuses before the model is called.
 *
 * @file        tests/ai-settings.test.js
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-11-16
 * @updated     2026-11-16
 */

import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { state, app, store, scenario, ctxProject, ctxSite, call, ok } from './support/harness.js';
import { MONTHLY_LLM_CALLS, MONTHLY_LLM_TOKENS } from '../src/lib/aiLimits.js';
// after the harness: lib/ai.js loads @forge/llm, which the harness mocks
const { usageTokens } = await import('../src/lib/ai.js');

const OFF_EN = 'AI features are turned off. A Jira administrator can turn them on under Jira settings › Apps › Workflow Analyzer & Autopilot for Jira (site-wide) › AI features.';
const OFF_DE = 'Die KI-Funktionen sind deaktiviert. Ein Jira-Administrator kann sie unter Jira-Einstellungen › Apps › Workflow Analyzer & Autopilot for Jira (instanzweit) › KI-Funktionen aktivieren.';
// Rovo also hears that every action is paused, so the agent doesn't offer work it can't do
const ROVO_EN = `${OFF_EN} Until then, every Workflow Analyst action is paused, including explanations and access checks. The Workflow Analyzer app itself (Project settings › Apps › Workflow Analyzer & Autopilot for Jira) works without AI.`;
const ROVO_DE = `${OFF_DE} Bis dahin sind alle Aktionen des Workflow Analyst pausiert, auch Erklärungen und Zugriffsprüfungen. Die App Workflow Analyzer selbst (Projekteinstellungen › Apps › Workflow Analyzer & Autopilot for Jira) funktioniert ohne KI.`;
const LIMIT_EN = 'The monthly AI quota is used up. It is available again from the 1st of next month.';
const LIMIT_DE = 'Das monatliche KI-Kontingent ist aufgebraucht. Es steht ab dem 1. des nächsten Monats wieder zur Verfügung.';

const answer = (usage) => ({ choices: [{ message: { content: 'answer' } }], ...(usage ? { usage } : {}) });
const planReply = () => ({ choices: [{ message: { tool_calls: [{ function: { name: 'propose_workflow_changes', arguments: JSON.stringify({ explanation: 'ok', operations: [{ op: 'renameTransition', transition: 'Start', newName: 'Kick-off' }] }) } }] } }], usage: { input_tokens: 10, output_tokens: 5 } });
const month = () => new Date().toISOString().slice(0, 7);

/** A site where nobody has touched the switch yet: no ai-settings record at all. */
function freshSite() {
  const s = scenario();
  state.kvs.delete('ai-settings');
  return s;
}

const AI_RESOLVERS = [
  ['aiAsk', { question: 'q' }, ctxProject()],
  ['aiPlan', { instructions: 'x', workflowId: 'wf-1' }, ctxProject()],
  ['siteBulkAi', { instructions: 'x', workflowId: 'wf-1' }, ctxSite()],
];
const ROVO = {
  actOverview: { projectKey: 'ALP' }, actFindUsages: { projectKey: 'ALP', searchTerm: 'legal' }, actHealth: { projectKey: 'ALP' },
  actExplain: { projectKey: 'ALP', transitionName: 'Start' }, actStatusLoad: { projectKey: 'ALP' }, actAccess: { projectKey: 'ALP' },
  actCompare: { projectKey: 'ALP' }, actResolutions: { projectKey: 'ALP' }, actListPlans: { projectKey: 'ALP' },
  actRemediate: { projectKey: 'ALP', minimumSeverity: 'low' }, actPlanChange: { projectKey: 'ALP', workflowName: 'Alpha', instructions: 'x' },
  actApplyChange: { projectKey: 'ALP', planId: 'x' }, actRollbackChange: { projectKey: 'ALP', planId: 'x' }, actAutofix: { projectKey: 'ALP' },
};

afterEach(() => mock.timers.reset());

test('AI is off by default: a missing setting means off, for the UI and for Jira admins', async () => {
  freshSite();
  assert.equal((await ok('bootstrap')).ai.enabled, false);
  assert.equal((await ok('bootstrap', {}, ctxSite())).ai.enabled, false);
  const s = await ok('getAiSettings', {}, ctxSite());
  assert.equal(s.enabled, false);
  assert.deepEqual({ calls: s.usage.calls, tokens: s.usage.tokens, limits: s.usage.limits, month: s.usage.month }, { calls: 0, tokens: 0, limits: { calls: MONTHLY_LLM_CALLS, tokens: MONTHLY_LLM_TOKENS }, month: month() });
  // anything but a stored true is off
  for (const v of [{}, { aiEnabled: 'true' }, { aiEnabled: 1 }, null]) {
    state.kvs.set('ai-settings', v);
    assert.equal((await store.getAiSettings()).aiEnabled, false, JSON.stringify(v));
  }
});

test('while AI is off, aiAsk, aiPlan and siteBulkAi refuse with AI_DISABLED before the model is called', async () => {
  const { j } = freshSite();
  const scripted = answer();
  for (const [name, payload, ctx] of AI_RESOLVERS) {
    state.llm = [scripted];
    const logBefore = j.log.length;
    for (const [lang, text] of [['en', OFF_EN], ['de', OFF_DE]]) {
      const res = await call(name, { ...payload, lang }, ctx);
      assert.equal(res.ok, false, name);
      assert.equal(res.error, 'AI_DISABLED', name);
      assert.equal(res.message, text, `${name} ${lang}`);
    }
    assert.equal(state.llm.length, 1, `${name} did not call the model`);
    assert.ok(j.log.slice(logBefore).every((l) => /mypermissions/.test(l)), `${name} read no workflow data: ${j.log.slice(logBefore).join()}`);
  }
  assert.equal(state.kvs.has(`llm-usage:${month()}`), false, 'nothing counted');
});

test('while AI is off, every Rovo action answers with the "turned off" text and does nothing', async () => {
  const { j } = freshSite();
  state.llm = [planReply()];
  const before = JSON.stringify([...state.kvs.entries()]);
  for (const [name, payload] of Object.entries(ROVO)) {
    assert.deepEqual(await app[name]({ ...payload }), { error: ROVO_EN }, name);
    assert.deepEqual(await app[name]({ ...payload, language: 'de' }), { error: ROVO_DE }, name);
  }
  assert.equal(j.log.length, 0, 'no Jira call');
  assert.equal(state.llm.length, 1, 'no model call');
  assert.equal(JSON.stringify([...state.kvs.entries()]), before, 'nothing stored');
});

test('only Jira admins can see and change the switch, checked live for every change', async () => {
  const { j } = freshSite();
  // a project admin (no "Administer Jira") – from the project page and from the admin page
  j.perms.ADMINISTER = false;
  j.perms.projectAdmin = new Set(['100']);
  for (const ctx of [ctxProject(), ctxSite()]) {
    assert.equal((await call('setAiSettings', { enabled: true }, ctx)).error, 'FORBIDDEN_SITE');
    assert.equal((await call('getAiSettings', {}, ctx)).error, 'FORBIDDEN_SITE');
  }
  // payload or context tricks do not help
  assert.equal((await app.handler.setAiSettings({ payload: { enabled: true, isJiraAdmin: true, caps: { jiraAdmin: true } }, context: { ...ctxSite(), isJiraAdmin: true } })).error, 'FORBIDDEN_SITE');
  assert.equal(state.kvs.has('ai-settings'), false, 'nothing stored');
  assert.equal((await call('aiAsk', { question: 'q' })).error, 'AI_DISABLED');

  // a Jira admin turns it on; the change is logged with who and when
  j.perms.ADMINISTER = true;
  const on = await ok('setAiSettings', { enabled: true }, ctxSite());
  assert.equal(on.enabled, true);
  assert.ok(on.updatedAt);
  assert.equal(state.kvs.get('ai-settings').history[0].by, 'user-admin');
  assert.equal(state.kvs.get('ai-settings').history[0].aiEnabled, true);
  assert.equal((await ok('bootstrap')).ai.enabled, true);

  // the same user loses "Administer Jira": the next change is refused (no cached role)
  j.perms.ADMINISTER = false;
  assert.equal((await call('setAiSettings', { enabled: false }, ctxSite())).error, 'FORBIDDEN_SITE');
  assert.equal(state.kvs.get('ai-settings').aiEnabled, true);

  // only real booleans are accepted
  j.perms.ADMINISTER = true;
  for (const v of ['true', 1, null, undefined]) assert.equal((await call('setAiSettings', { enabled: v }, ctxSite())).ok, false, String(v));
  assert.equal(state.kvs.get('ai-settings').aiEnabled, true);

  const off = await ok('setAiSettings', { enabled: false }, ctxSite());
  assert.equal(off.enabled, false);
  assert.deepEqual(state.kvs.get('ai-settings').history.map((h) => h.aiEnabled), [false, true]);
  assert.equal((await call('aiAsk', { question: 'q' })).error, 'AI_DISABLED');
});

test('switched on: the AI works, and every call and its tokens are counted for the month', async () => {
  freshSite();
  await ok('setAiSettings', { enabled: true }, ctxSite());
  state.llm = [answer({ input_tokens: 1200, output_tokens: 300, total_tokens: 1500 })];
  assert.equal((await ok('aiAsk', { question: 'q' })).answer, 'answer');
  assert.deepEqual({ calls: state.kvs.get(`llm-usage:${month()}`).calls, tokens: state.kvs.get(`llm-usage:${month()}`).tokens }, { calls: 1, tokens: 1500 });

  state.llm = [planReply()];
  await ok('aiPlan', { instructions: 'rename', workflowId: 'wf-1' });
  state.llm = [planReply()];
  await ok('siteBulkAi', { instructions: 'rename', workflowId: 'wf-1' }, ctxSite());
  // Rovo plan-workflow-change without operations asks the model too
  state.llm = [planReply()];
  assert.equal((await app.actPlanChange({ projectKey: 'ALP', workflowName: 'Alpha', instructions: 'rename Start' })).status, 'planned');
  // no usage in the response: the call is still counted, without tokens
  state.llm = [answer()];
  await ok('aiAsk', { question: 'q' });

  const u = (await ok('getAiSettings', {}, ctxSite())).usage;
  assert.equal(u.calls, 5);
  assert.equal(u.tokens, 1500 + 3 * 15);
  assert.equal(u.exhausted, false);
});

test('usage tokens: prompt + completion from the response, total as fallback, nothing when missing', () => {
  assert.equal(usageTokens({ input_tokens: 10, output_tokens: 5, total_tokens: 99 }), 15);
  assert.equal(usageTokens({ prompt_tokens: 7, completion_tokens: 3 }), 10);
  assert.equal(usageTokens({ total_tokens: 42 }), 42);
  assert.equal(usageTokens(null), 0);
  assert.equal(usageTokens({}), 0);
});

test('the monthly limit refuses with AI_LIMIT before the model is called (calls or tokens)', async () => {
  scenario();
  const key = `llm-usage:${month()}`;
  for (const used of [{ calls: MONTHLY_LLM_CALLS, tokens: 0 }, { calls: 1, tokens: MONTHLY_LLM_TOKENS }, { calls: MONTHLY_LLM_CALLS + 5, tokens: MONTHLY_LLM_TOKENS + 1 }]) {
    state.kvs.set(key, used);
    state.llm = [answer({ input_tokens: 1, output_tokens: 1 })];
    for (const [name, payload, ctx] of AI_RESOLVERS) {
      const en = await call(name, payload, ctx);
      assert.equal(en.error, 'AI_LIMIT', `${name} ${JSON.stringify(used)}`);
      assert.equal(en.message, LIMIT_EN);
      assert.equal((await call(name, { ...payload, lang: 'de' }, ctx)).message, LIMIT_DE);
    }
    assert.deepEqual(await app.actPlanChange({ projectKey: 'ALP', workflowName: 'Alpha', instructions: 'x', language: 'de' }), { error: LIMIT_DE });
    assert.equal(state.llm.length, 1, 'the model was not called');
    assert.deepEqual(state.kvs.get(key), used, 'refused calls are not counted');
    assert.equal((await ok('getAiSettings', {}, ctxSite())).usage.exhausted, true);
  }
  // Rovo actions that do not call the model are not affected by the quota
  assert.equal((await app.actOverview({ projectKey: 'ALP' })).project.key, 'ALP');
  // one call below the limit still goes through, and is the last one
  state.kvs.set(key, { calls: MONTHLY_LLM_CALLS - 1, tokens: 0 });
  state.llm = [answer({ input_tokens: 1, output_tokens: 1 })];
  await ok('aiAsk', { question: 'q' });
  assert.equal((await call('aiAsk', { question: 'q' })).error, 'AI_LIMIT');
});

test('month rollover: the quota is per calendar month in UTC and is available again on the 1st', async () => {
  scenario();
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-30T23:59:30.000Z') });
  assert.equal(store.usageMonth(), '2026-11');
  assert.equal(store.usageMonth(new Date('2026-12-01T01:30:00+02:00')), '2026-11', 'UTC, not local time');
  assert.equal(store.usageMonth(new Date('2026-11-30T23:30:00-02:00')), '2026-12');
  state.kvs.set('llm-usage:2026-11', { calls: MONTHLY_LLM_CALLS, tokens: 10 });
  assert.equal((await call('aiAsk', { question: 'q' })).error, 'AI_LIMIT');

  mock.timers.setTime(new Date('2026-12-01T00:00:00.000Z').getTime());
  state.llm = [answer({ input_tokens: 20, output_tokens: 2 })];
  assert.equal((await ok('aiAsk', { question: 'q' })).answer, 'answer');
  assert.deepEqual({ ...state.kvs.get('llm-usage:2026-12'), updatedAt: undefined, eur: undefined }, { calls: 1, tokens: 22, updatedAt: undefined, eur: undefined });
  assert.ok(state.kvs.get('llm-usage:2026-12').eur > 0, 'the answer is priced in EUR');
  assert.equal(state.kvs.get('llm-usage:2026-11').calls, MONTHLY_LLM_CALLS, 'last month is left as it was');
  const u = (await ok('getAiSettings', {}, ctxSite())).usage;
  assert.equal(u.month, '2026-12');
  assert.equal(u.calls, 1);
});
