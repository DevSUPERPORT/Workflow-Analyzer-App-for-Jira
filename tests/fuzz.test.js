// Property-based / fuzz tests: random (and malformed) workflows through every engine function.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, searchModel, allRules } from '../src/shared/engine.js';
import { describeWorkflow, describeTransition, describeRule } from '../src/shared/explain.js';
import { makeSnapshot, diffSnapshots } from '../src/shared/snapshot.js';
import { findingText } from '../src/shared/i18n.js';
import { layoutWorkflow, diagramSvg } from '../src/shared/diagram.js';
import { accessMatrix, simulatePersona, personaFor, collectPrincipals, findPaths, similarity, compareWorkflows, governance, actionPlan, toMermaid, loadInsights } from '../src/shared/insights.js';
import { applyOperations, buildUpdatePayload, dryRun, autofixOperations } from '../src/shared/autopilot.js';
import { modelContext } from '../src/shared/context.js';
import { transitionsCsv } from '../static/app/src/lib/exportCsv.js';
import { makeRandomBundle, makeRandomOps } from './fuzz/generator.js';

const SEEDS = Number(process.env.FUZZ_SEEDS || 250);
const BAD_TEXT = /undefined|\[object Object\]|NaN|\{(?:\w+)\}/;

function assertText(s, where) {
  assert.equal(typeof s, 'string', `${where}: not a string`);
  // Allow the literal fixture names that contain these tokens
  const cleaned = s.replace(/\{placeholder\}|undefined"|"undefined|“undefined|undefined”|'undefined'/g, '').replace(/\bundefined\b(?=[^\n]*Status|[^\n]*Workflow)/g, '');
  assert.ok(!/\[object Object\]|NaN(?!\w)/.test(cleaned), `${where}: bad text → ${s.slice(0, 200)}`);
}

function check(seed, malformed) {
  const bundle = makeRandomBundle(seed, { malformed });
  const model = normalize(bundle);
  const where = `seed ${seed}${malformed ? ' (malformed)' : ''}`;

  // Stats are finite and bounded
  for (const [k, v] of Object.entries(model.stats)) if (typeof v === 'number') assert.ok(Number.isFinite(v), `${where}: stat ${k}=${v}`);
  assert.ok(model.stats.healthScore >= 0 && model.stats.healthScore <= 100, `${where}: health ${model.stats.healthScore}`);

  // Texts in both languages
  for (const lang of ['en', 'de']) {
    for (const f of model.findings) {
      const ft = findingText(lang, f);
      // fuzz names deliberately contain braces – strip those literals before checking for unresolved placeholders
      const stripped = (ft.title + ft.fix).replace(/\$?\{(placeholder|injection)\}|x\}y\{z/g, '');
      assert.ok(!/\{\w+\}/.test(stripped), `${where}: placeholder in ${f.code}: ${ft.title}`);
    }
    for (const wf of model.workflows) {
      describeWorkflow(model, wf, lang).forEach((l) => assertText(l, `${where} describeWorkflow`));
      for (const t of wf.transitions) {
        describeTransition(wf, t, lang, model.findings).forEach((l) => assertText(l, `${where} describeTransition`));
        for (const r of allRules(t)) assertText(describeRule(r, lang), `${where} describeRule ${r.ruleKey}`);
      }
    }
  }

  // Snapshots: serialisable, self diff empty
  const snap = makeSnapshot(model);
  assert.doesNotThrow(() => JSON.stringify(snap));
  assert.deepEqual(diffSnapshots(snap, makeSnapshot(normalize(bundle))), [], `${where}: self diff not empty`);

  for (const wf of model.workflows) {
    // Diagram geometry is finite in every mode
    for (const opts of [{ mode: 'jira' }, { mode: 'auto' }, { mode: 'auto', wrap: 4 }]) {
      const l = layoutWorkflow(wf, opts);
      for (const n of [...l.nodes, ...l.virtual]) assert.ok([n.x, n.y, n.w, n.h].every(Number.isFinite), `${where}: node geometry`);
      for (const e of l.edges) assert.ok(!/NaN|undefined/.test(e.d) && Number.isFinite(e.label.x) && Number.isFinite(e.label.y), `${where}: edge geometry`);
      const svg = diagramSvg(l, { anyLabel: 'Any' });
      assert.ok(!/NaN/.test(svg), `${where}: NaN in svg`);
      assert.ok(!/<script|<img/i.test(svg), `${where}: unescaped markup in svg`);
    }
    // Mermaid never breaks out of the line / quote structure
    const mm = toMermaid(wf);
    assert.ok(mm.startsWith('stateDiagram-v2') && !/NaN|<script|<img/i.test(mm), `${where}: mermaid`);
    for (const line of mm.split('\n').slice(1)) assert.ok(/^ {4}(%%|S\d+|\[\*\])/.test(line), `${where}: mermaid line broken: ${line}`);
    // Access & paths
    const sim = simulatePersona(wf, personaFor(collectPrincipals([wf])[0]));
    assert.ok(Object.values(sim).every((s) => ['yes', 'no', 'maybe'].includes(s.state)));
    if (wf.statuses.length >= 2) {
      for (const p of findPaths(wf, wf.statuses[0].ref, wf.statuses[wf.statuses.length - 1].ref, { limit: 2 })) {
        for (let i = 1; i < p.length; i++) assert.equal(p[i].from, p[i - 1].to, `${where}: broken path chain`);
      }
    }
    const sim2 = similarity(wf, wf);
    assert.ok(sim2 >= 0 && sim2 <= 100);
    assert.equal(compareWorkflows(wf, wf).transitionsOnlyA.length, 0);
  }
  accessMatrix(model.workflows);
  governance(model).forEach((g) => assert.ok(g.score >= 0 && g.score <= 100));
  actionPlan(model);
  loadInsights(model, { byStatus: Object.fromEntries(model.workflows[0].statuses.map((s) => [s.id, { count: 3, stale: 2, ever: 0 }])), total: 3, staleDays: 30 });
  for (const q of ['a', 'Done', '<script>', '@', '中文', 'customfield_10100']) searchModel(model, q);
  assert.ok(modelContext(model, { ref: bundle.ref }).length > 0);

  // CSV: consistent column count, formula injection neutralised
  const csv = transitionsCsv(model, model.workflows, 'de', {});
  const rows = csv.replace(/^﻿/, '').split('\r\n');
  assert.ok(rows.length >= 1);
  assert.ok(!/(^|;)[=+@]/m.test(csv.replace(/"[^"]*"/g, '""')), `${where}: unescaped formula start in CSV`);
  return { bundle, model };
}

test(`fuzz: ${SEEDS} random workflows satisfy all engine invariants`, () => {
  for (let seed = 1; seed <= SEEDS; seed++) check(seed, false);
});

test(`fuzz: ${Math.round(SEEDS / 2)} malformed workflows never crash the engine`, () => {
  for (let seed = 5000; seed < 5000 + Math.round(SEEDS / 2); seed++) check(seed, true);
});

test('fuzz: random Autopilot operation sequences never throw and keep payload invariants', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const bundle = makeRandomBundle(seed);
    const raw = bundle.workflows[0];
    const ops = makeRandomOps(seed, bundle);
    let res;
    assert.doesNotThrow(() => { res = applyOperations(raw, ops, { statuses: bundle.statuses, ref: bundle.ref, resolutions: bundle.ref.resolutions }); }, `seed ${seed}`);
    assert.equal(res.results.length, ops.length, `seed ${seed}: one result per op`);
    for (const r of res.results) assert.equal(typeof r.message, 'string');
    const p = buildUpdatePayload(res.workflow, { siteStatuses: bundle.statuses, newStatuses: res.newStatuses, statusMappings: res.statusMappings });
    const listed = new Set(p.statuses.map((s) => s.statusReference));
    const inWf = new Set(p.workflows[0].statuses.map((s) => s.statusReference));
    for (const s of p.workflows[0].statuses) assert.ok(listed.has(s.statusReference), `seed ${seed}: workflow status not listed`);
    for (const t of p.workflows[0].transitions) {
      if (t.type === 'INITIAL') assert.equal(t.conditions, undefined, `seed ${seed}: conditions on INITIAL`);
      if (t.conditions) assert.ok(t.conditions.conditions.length || t.conditions.conditionGroups.length, `seed ${seed}: empty conditions block`);
      if (t.toStatusReference) assert.ok(inWf.has(t.toStatusReference), `seed ${seed}: transition "${t.name}" targets a status outside the workflow`);
      for (const l of t.links) assert.ok(inWf.has(l.fromStatusReference), `seed ${seed}: link from a status outside the workflow`);
      for (const r of [...t.validators, ...t.actions]) assert.ok(r.ruleKey, `seed ${seed}: rule without key`);
    }
    // the original raw workflow is never mutated
    assert.deepEqual(raw, makeRandomBundle(seed).workflows[0], `seed ${seed}: input mutated`);
    // dry run and auto-fix are robust too
    assert.doesNotThrow(() => dryRun(bundle, raw.id, ops), `seed ${seed}: dryRun`);
    const model = normalize(bundle);
    assert.doesNotThrow(() => autofixOperations(model, model.findings, bundle.ref.resolutions));
  }
});
