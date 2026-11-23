/**
 * Tests of SUPERPORT's AI budget (Forge variable AI_BUDGET, set through App Status): parsing (unset, invalid,
 * ranges, per-site fallback), the stop that refuses every AI entry point even when the site's switch is on, the
 * monthly limits taken from the variable, and per-site caps keyed by the site host from serverInfo.
 *
 * @file        tests/ai-budget.test.js
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-11-16
 * @updated     2026-11-16
 */

import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { state, app, scenario, ctxProject, ctxSite, call, ok } from './support/harness.js';
import { MONTHLY_LLM_CALLS, MONTHLY_LLM_TOKENS } from '../src/lib/aiLimits.js';
import { parseAiBudget, aiBudget, effectiveCaps, siteBudget, costEur, priceOf, pricedTokens, DEFAULT_AI_BUDGET, EUR_PER_MONTH } from '../src/lib/aiBudget.js';

const STOP_EN = 'AI features are temporarily turned off by the app vendor. Please try again later.';
const STOP_DE = 'Die KI-Funktionen sind vorübergehend vom App-Anbieter ausgeschaltet. Bitte versuchen Sie es später erneut.';
const DEFAULTS = { stop: false, callsPerMonth: MONTHLY_LLM_CALLS, tokensPerMonth: MONTHLY_LLM_TOKENS };

const setBudget = (v) => { if (v === undefined) delete process.env.AI_BUDGET; else process.env.AI_BUDGET = typeof v === 'string' ? v : JSON.stringify(v); };
const answer = () => ({ choices: [{ message: { content: 'answer' } }], usage: { input_tokens: 1, output_tokens: 1 } });
const planReply = () => ({ choices: [{ message: { tool_calls: [{ function: { name: 'propose_workflow_changes', arguments: JSON.stringify({ explanation: 'ok', operations: [{ op: 'renameTransition', transition: 'Start', newName: 'Kick-off' }] }) } }] } }], usage: { input_tokens: 10, output_tokens: 5 } });
const month = () => new Date().toISOString().slice(0, 7);
const usageKey = () => `llm-usage:${month()}`;
const serverInfoCalls = (j) => j.log.filter((l) => /serverInfo/.test(l)).length;

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

afterEach(() => {
  setBudget(undefined);
  mock.restoreAll();
});

// ------------------------------------------------------------------ parsing

test('unset or empty AI_BUDGET: the aiLimits.js defaults, no warning', () => {
  for (const raw of [undefined, null, '', '   ']) {
    const { budget, error } = parseAiBudget(raw);
    assert.equal(error, null, String(raw));
    assert.deepEqual(effectiveCaps(budget, 'any.atlassian.net'), DEFAULTS);
  }
  assert.deepEqual(effectiveCaps(aiBudget({})), DEFAULTS);
  assert.deepEqual(effectiveCaps(), DEFAULTS);
  const { stop, callsPerMonth, tokensPerMonth } = DEFAULT_AI_BUDGET;
  assert.deepEqual({ stop, callsPerMonth, tokensPerMonth }, DEFAULTS);
  assert.equal(DEFAULT_AI_BUDGET.eurPerMonth, 20, 'SUPERPORT pays at most 20 EUR per site and month by default');
  assert.equal(siteBudget(parseAiBudget(undefined).budget, 'any.atlassian.net').eurPerMonth, EUR_PER_MONTH);
});

test('the documented example parses, unknown keys are ignored', () => {
  const raw = '{"stop":false,"callsPerMonth":1000,"tokensPerMonth":2000000,"siteCaps":{"bigcorp.atlassian.net":{"callsPerMonth":5000,"tokensPerMonth":10000000}},"kind":"usage"}';
  const { budget, error } = parseAiBudget(raw);
  assert.equal(error, null);
  assert.deepEqual(effectiveCaps(budget, 'bigcorp.atlassian.net'), { stop: false, callsPerMonth: 5000, tokensPerMonth: 10_000_000 });
  assert.deepEqual(effectiveCaps(budget, 'other.atlassian.net'), DEFAULTS);
  assert.deepEqual(effectiveCaps(parseAiBudget('{"stop":true}').budget), { ...DEFAULTS, stop: true });
  assert.deepEqual(effectiveCaps(parseAiBudget('{"callsPerMonth":7}').budget), { ...DEFAULTS, callsPerMonth: 7 });
  assert.deepEqual(effectiveCaps(parseAiBudget('{}').budget), DEFAULTS);
});

test('ranges: 0 and the maxima are accepted, 0 turns the AI off', () => {
  const max = parseAiBudget('{"callsPerMonth":1000000,"tokensPerMonth":1000000000}');
  assert.equal(max.error, null);
  assert.deepEqual(effectiveCaps(max.budget), { stop: false, callsPerMonth: 1_000_000, tokensPerMonth: 1_000_000_000 });
  assert.deepEqual(effectiveCaps(parseAiBudget('{"callsPerMonth":0}').budget), { ...DEFAULTS, callsPerMonth: 0, stop: true });
  assert.deepEqual(effectiveCaps(parseAiBudget('{"tokensPerMonth":0}').budget), { ...DEFAULTS, tokensPerMonth: 0, stop: true });
});

test('invalid JSON or shape: defaults with an error, never a throw', () => {
  const invalid = [
    '{oops', 'null', '[]', '"x"', '42', 'true',
    '{"stop":"true"}', '{"stop":1}', '{"stop":null}',
    '{"callsPerMonth":-1}', '{"callsPerMonth":1.5}', '{"callsPerMonth":1000001}', '{"callsPerMonth":"1000"}', '{"callsPerMonth":null}',
    '{"tokensPerMonth":-1}', '{"tokensPerMonth":1000000001}', '{"tokensPerMonth":1e10}',
    '{"siteCaps":[]}', '{"siteCaps":"x"}', '{"siteCaps":null}',
    '{"siteCaps":{"https://bigcorp.atlassian.net":{}}}', '{"siteCaps":{"BigCorp.atlassian.net":{}}}', '{"siteCaps":{"bigcorp":{}}}', '{"siteCaps":{"bigcorp.atlassian.net/":{}}}',
    '{"siteCaps":{"bigcorp.atlassian.net":5000}}', '{"siteCaps":{"bigcorp.atlassian.net":{"callsPerMonth":-5}}}', '{"siteCaps":{"bigcorp.atlassian.net":{"tokensPerMonth":"1"}}}',
  ];
  for (const raw of invalid) {
    const { budget, error } = parseAiBudget(raw);
    assert.ok(error, `${raw} is rejected`);
    assert.deepEqual(effectiveCaps(budget, 'bigcorp.atlassian.net'), DEFAULTS, raw);
  }
});

test('an invalid AI_BUDGET is logged once per value', () => {
  const warn = mock.method(console, 'warn', () => {});
  aiBudget({ AI_BUDGET: '{oops' });
  aiBudget({ AI_BUDGET: '{oops' });
  aiBudget({ AI_BUDGET: '{oops' });
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0].arguments[0]), /AI_BUDGET ignored \(not valid JSON\)/);
  aiBudget({ AI_BUDGET: '{"stop":"yes"}' });
  assert.equal(warn.mock.callCount(), 2);
  aiBudget({ AI_BUDGET: '{"stop":false}' });
  aiBudget({});
  assert.equal(warn.mock.callCount(), 2, 'valid or unset values are not logged');
});

test('per-site caps: a missing field falls back to the app-wide value; the host is matched case- and scheme-insensitively', () => {
  const { budget } = parseAiBudget('{"callsPerMonth":200,"tokensPerMonth":300000,"siteCaps":{"bigcorp.atlassian.net":{"callsPerMonth":5000},"small.atlassian.net":{"tokensPerMonth":1000},"off.atlassian.net":{"callsPerMonth":0}}}');
  assert.deepEqual(effectiveCaps(budget, 'bigcorp.atlassian.net'), { stop: false, callsPerMonth: 5000, tokensPerMonth: 300_000 });
  assert.deepEqual(effectiveCaps(budget, 'https://BigCorp.Atlassian.net/'), { stop: false, callsPerMonth: 5000, tokensPerMonth: 300_000 });
  assert.deepEqual(effectiveCaps(budget, 'small.atlassian.net'), { stop: false, callsPerMonth: 200, tokensPerMonth: 1000 });
  assert.deepEqual(effectiveCaps(budget, 'off.atlassian.net'), { stop: true, callsPerMonth: 0, tokensPerMonth: 300_000 });
  for (const host of ['other.atlassian.net', null, '', 'constructor', '__proto__']) assert.deepEqual(effectiveCaps(budget, host), { stop: false, callsPerMonth: 200, tokensPerMonth: 300_000 }, String(host));
  // stop wins over any site cap
  assert.equal(effectiveCaps({ ...budget, stop: true }, 'bigcorp.atlassian.net').stop, true);
});

// ------------------------------------------------------------------ stop

test('stop refuses every AI entry point with AI_STOPPED even when the site switch is on, and keeps the setting', async () => {
  const { j } = scenario(); // the site switch is on
  setBudget({ stop: true });
  state.llm = [answer()];
  for (const [name, payload, ctx] of AI_RESOLVERS) {
    for (const [lang, text] of [['en', STOP_EN], ['de', STOP_DE]]) {
      const res = await call(name, { ...payload, lang }, ctx);
      assert.equal(res.error, 'AI_STOPPED', name);
      assert.equal(res.message, text, `${name} ${lang}`);
    }
  }
  const before = JSON.stringify([...state.kvs.entries()]);
  const logBefore = j.log.length;
  for (const [name, payload] of Object.entries(ROVO)) {
    assert.deepEqual(await app[name]({ ...payload }), { error: STOP_EN }, name);
    assert.deepEqual(await app[name]({ ...payload, language: 'de' }), { error: STOP_DE }, name);
  }
  assert.equal(j.log.length, logBefore, 'Rovo: no Jira call');
  assert.equal(JSON.stringify([...state.kvs.entries()]), before, 'nothing stored');
  assert.equal(state.llm.length, 1, 'the model was never called');
  assert.equal(state.kvs.has(usageKey()), false, 'nothing counted');

  // the UI hides the AI; Jira admins see their own setting, kept, next to the stop
  assert.deepEqual((await ok('bootstrap')).ai, { enabled: false, stopped: true });
  const s = await ok('getAiSettings', {}, ctxSite());
  assert.equal(s.enabled, true);
  assert.equal(s.stopped, true);
  // the switch can still be changed while stopped
  assert.equal((await ok('setAiSettings', { enabled: false }, ctxSite())).enabled, false);
  assert.equal((await call('aiAsk', { question: 'q' })).error, 'AI_STOPPED', 'stop is reported before the site switch');
  await ok('setAiSettings', { enabled: true }, ctxSite());

  // SUPERPORT lifts the stop: the kept setting applies again
  setBudget({ stop: false });
  assert.deepEqual((await ok('bootstrap')).ai, { enabled: true, stopped: false });
  assert.equal((await ok('aiAsk', { question: 'q' })).answer, 'answer');
});

test('a cap of 0 stops the AI like stop does', async () => {
  scenario();
  for (const budget of [{ callsPerMonth: 0 }, { tokensPerMonth: 0 }]) {
    setBudget(budget);
    assert.equal((await call('aiAsk', { question: 'q', lang: 'de' })).message, STOP_DE, JSON.stringify(budget));
    assert.deepEqual(await app.actOverview({ projectKey: 'ALP' }), { error: STOP_EN });
    assert.equal((await ok('getAiSettings', {}, ctxSite())).stopped, true);
  }
});

// ------------------------------------------------------------------ limits from AI_BUDGET

test('the quota check uses the limits from AI_BUDGET instead of the defaults', async () => {
  scenario();
  setBudget({ callsPerMonth: 3, tokensPerMonth: 100 });
  const u0 = (await ok('getAiSettings', {}, ctxSite())).usage;
  assert.deepEqual(u0.limits, { calls: 3, tokens: 100 });
  assert.equal((await ok('getAiSettings', {}, ctxSite())).stopped, false);

  state.kvs.set(usageKey(), { calls: 2, tokens: 0 });
  state.llm = [answer()];
  await ok('aiAsk', { question: 'q' });
  assert.equal((await call('aiAsk', { question: 'q' })).error, 'AI_LIMIT', 'the 3rd call was the last');
  state.kvs.set(usageKey(), { calls: 0, tokens: 100 });
  assert.equal((await call('aiAsk', { question: 'q' })).error, 'AI_LIMIT', 'token limit');
  assert.equal((await ok('getAiSettings', {}, ctxSite())).usage.exhausted, true);

  // a higher limit than the default lets a site go on past 1,000 calls
  setBudget({ callsPerMonth: 5000 });
  state.kvs.set(usageKey(), { calls: MONTHLY_LLM_CALLS, tokens: 0 });
  state.llm = [planReply()];
  assert.equal((await app.actPlanChange({ projectKey: 'ALP', workflowName: 'Alpha', instructions: 'rename Start' })).status, 'planned');
  assert.equal(state.kvs.get(usageKey()).calls, MONTHLY_LLM_CALLS + 1);
  assert.deepEqual((await ok('getAiSettings', {}, ctxSite())).usage.limits, { calls: 5000, tokens: MONTHLY_LLM_TOKENS });
});

test('an invalid AI_BUDGET falls back to the defaults and the app keeps working', async () => {
  scenario();
  mock.method(console, 'warn', () => {});
  setBudget('{"callsPerMonth":"lots"');
  assert.deepEqual((await ok('getAiSettings', {}, ctxSite())).usage.limits, { calls: MONTHLY_LLM_CALLS, tokens: MONTHLY_LLM_TOKENS });
  state.llm = [answer()];
  assert.equal((await ok('aiAsk', { question: 'q' })).answer, 'answer');
  state.kvs.set(usageKey(), { calls: MONTHLY_LLM_CALLS, tokens: 0 });
  assert.equal((await call('aiAsk', { question: 'q' })).error, 'AI_LIMIT');
});

// ------------------------------------------------------------------ per-site caps

test('site unknown (serverInfo fails): the strictest limits of any site apply, so a limited site stays limited', async () => {
  const { j } = scenario();
  mock.method(console, 'warn', () => {});
  setBudget({ eurPerMonth: 20, sites: { 'off.atlassian.net': 0 } });
  j.faults.push({ match: /serverInfo/, status: 500, times: -1 });
  assert.equal((await call('aiAsk', { question: 'q' })).error, 'AI_STOPPED');
  j.faults = [];
  state.invocationId = 'inv-known';
  state.llm = [answer()];
  assert.equal((await ok('aiAsk', { question: 'q' })).answer, 'answer', 'this site is not the limited one');
});

test('per-site caps: this site (host from serverInfo) gets its own limits, other sites the app-wide ones', async () => {
  const { j } = scenario();
  setBudget({ callsPerMonth: 1000, tokensPerMonth: 2_000_000, siteCaps: { 'bigcorp.atlassian.net': { callsPerMonth: 5000 }, 'blocked.atlassian.net': { tokensPerMonth: 0 } } });
  state.kvs.set(usageKey(), { calls: 1000, tokens: 0 });

  // this test site is not listed: app-wide 1,000 calls are used up
  assert.equal((await call('aiAsk', { question: 'q' })).error, 'AI_LIMIT');

  // the same data on bigcorp (Jira reports the base URL in any case)
  j.baseUrl = 'https://BigCorp.atlassian.net';
  state.invocationId = 'inv-bigcorp';
  const s = await ok('getAiSettings', {}, ctxSite());
  assert.deepEqual(s.usage.limits, { calls: 5000, tokens: 2_000_000 }, 'tokens fall back to the app-wide value');
  state.invocationId = 'inv-bigcorp-2';
  state.llm = [answer()];
  assert.equal((await ok('aiAsk', { question: 'q' })).answer, 'answer');

  // one serverInfo lookup per invocation, even though the gate and the quota check both need the caps
  state.invocationId = 'inv-plan';
  const before = serverInfoCalls(j);
  state.llm = [planReply()];
  assert.equal((await app.actPlanChange({ projectKey: 'ALP', workflowName: 'Alpha', instructions: 'rename Start' })).status, 'planned');
  assert.equal(serverInfoCalls(j) - before, 1);

  // a site with a 0 cap is stopped; the others are not
  j.baseUrl = 'https://blocked.atlassian.net';
  state.invocationId = 'inv-blocked';
  assert.equal((await call('aiAsk', { question: 'q' })).error, 'AI_STOPPED');
  state.invocationId = 'inv-blocked-2';
  assert.deepEqual((await ok('bootstrap')).ai, { enabled: false, stopped: true });
});

test('the site host is only looked up when AI_BUDGET has per-site caps, and a failed lookup means app-wide limits', async () => {
  const { j } = scenario();
  setBudget({ callsPerMonth: 10 });
  state.llm = [answer()];
  await ok('aiAsk', { question: 'q' });
  await ok('bootstrap');
  await ok('getAiSettings', {}, ctxSite());
  assert.equal(serverInfoCalls(j), 0);

  mock.method(console, 'warn', () => {});
  setBudget({ callsPerMonth: 10, siteCaps: { 'fake.atlassian.net': { callsPerMonth: 20 } } });
  j.faults.push({ match: /serverInfo/, status: 500, times: -1 });
  state.kvs.set(usageKey(), { calls: 10, tokens: 0 });
  assert.equal((await call('aiAsk', { question: 'q' })).error, 'AI_LIMIT', 'host unknown: the strictest limit, 10 calls');
  j.faults = [];
  state.invocationId = 'inv-next';
  state.llm = [answer()];
  assert.equal((await ok('aiAsk', { question: 'q' })).answer, 'answer', 'host known: the site cap of 20 applies');
});

// ------------------------------------------------------------------ EUR budget (kind "eur")

test('the EUR fields App Status writes parse; sites override eurPerMonth; 0 EUR turns the AI off', () => {
  const raw = '{"eurPerMonth":20,"eurPerUsd":1,"dailyPerPerson":60,"stop":false,"sites":{"bigcorp.atlassian.net":100,"off.atlassian.net":0},"callsPerMonth":1000,"tokensPerMonth":2000000,"siteCaps":{}}';
  const { budget, error } = parseAiBudget(raw);
  assert.equal(error, null);
  assert.deepEqual(siteBudget(budget, 'other.atlassian.net'), { ...DEFAULTS, eurPerMonth: 20, eurPerUsd: 1 });
  assert.deepEqual(siteBudget(budget, 'https://BigCorp.atlassian.net/'), { ...DEFAULTS, eurPerMonth: 100, eurPerUsd: 1 });
  assert.equal(siteBudget(budget, 'off.atlassian.net').stop, true);
  assert.equal(siteBudget(parseAiBudget('{"eurPerMonth":0}').budget).stop, true);
  assert.equal(siteBudget(parseAiBudget('{"eurPerMonth":7.5,"eurPerUsd":0.92}').budget).eurPerMonth, 7.5);
  for (const bad of ['{"eurPerMonth":-1}', '{"eurPerMonth":"20"}', '{"eurPerUsd":3}', '{"dailyPerPerson":0}', '{"sites":[]}', '{"sites":{"BigCorp":5}}', '{"sites":{"bigcorp.atlassian.net":-2}}']) {
    const r = parseAiBudget(bad);
    assert.ok(r.error, bad);
    assert.equal(siteBudget(r.budget).eurPerMonth, 20, bad);
  }
});

test('pricing: Atlassian prices per model, unknown models at the highest price, missing usage estimated', () => {
  assert.deepEqual(priceOf('claude-sonnet-5'), { inUsd: 3, outUsd: 15 });
  assert.deepEqual(priceOf('claude-haiku-4-5-20251001'), { inUsd: 1, outUsd: 5 });
  assert.deepEqual(priceOf('mystery-model'), { inUsd: 5, outUsd: 25 });
  assert.equal(costEur('claude-sonnet-5', { inTok: 1_000_000, outTok: 1_000_000 }), 18);
  assert.equal(costEur('claude-sonnet-5', { inTok: 1_000_000, outTok: 0 }, 0.5), 1.5);
  assert.deepEqual(pricedTokens({ input_tokens: 10, output_tokens: 4 }, 999, 999), { inTok: 10, outTok: 4 });
  assert.deepEqual(pricedTokens({ prompt_tokens: 7, completion_tokens: 2 }), { inTok: 7, outTok: 2 });
  assert.deepEqual(pricedTokens(null, 300, 30), { inTok: 100, outTok: 10 });
});

test('the EUR budget stops new AI calls from 98 % until the next month; the meter adds every answer', async () => {
  scenario();
  setBudget({ eurPerMonth: 20 });
  state.kvs.set(usageKey(), { calls: 3, tokens: 100, eur: 19.5 });
  state.llm = [answer()];
  assert.equal((await ok('aiAsk', { question: 'q' })).answer, 'answer', '97.5 %: still allowed');
  const after = state.kvs.get(usageKey());
  assert.equal(after.calls, 4);
  assert.ok(after.eur > 19.5, 'the answer was priced and added');
  state.kvs.set(usageKey(), { calls: 4, tokens: 100, eur: 19.6 });
  state.llm = [answer()];
  for (const [name, payload, ctx] of AI_RESOLVERS) assert.equal((await call(name, { ...payload }, ctx)).error, 'AI_LIMIT', name);
  assert.equal(state.llm.length, 1, 'the model was not called');
  const s = await ok('getAiSettings', {}, ctxSite());
  assert.equal(s.usage.exhausted, true);
  assert.equal(s.usage.eurLimit, 20);
  assert.equal(s.usage.eur, 19.6);
  // SUPERPORT raises this site's budget: AI works again at once
  setBudget({ eurPerMonth: 20, sites: { 'superportdev.atlassian.net': 50, 'fake.atlassian.net': 50 } });
  state.invocationId = 'inv-raised';
  const raised = await ok('getAiSettings', {}, ctxSite());
  assert.equal(raised.usage.exhausted, false, JSON.stringify(raised.usage));
});
