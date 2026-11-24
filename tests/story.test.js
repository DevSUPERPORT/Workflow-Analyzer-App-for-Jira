/**
 * Unit tests of the plain-language export guide: usual path, transition roles, verdicts, improvements with reasons
 * and fixes, and that every dynamic text key (finding reasons, efforts, glossary) exists in English and German.
 *
 * @file        tests/story.test.js
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-11-24
 * @updated     2026-11-24
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../src/shared/engine.js';
import { CATEGORY_OF } from '../src/shared/insights.js';
import { DICT } from '../src/shared/i18n.js';

const { en, de } = DICT;
import { workflowStory, siteStory, mainPath, transitionRole, exportGlossary, improvements, exportScope, canAutofix, GLOSSARY_KEYS, AUTOFIX_CODES } from '../src/shared/story.js';
import { makeProcurementBundle } from './fixtures/procurement.js';

const model = normalize(makeProcurementBundle());
const proc = model.workflows.find((w) => w.name === 'IDE: Bedarfsworkflow');
const bug = model.workflows.find((w) => w.name === 'IDE: Bug Workflow');

test('the usual path runs from the create transition to a Done status and avoids "reject" steps', () => {
  const path = mainPath(proc);
  assert.ok(path.length >= 2);
  assert.ok(path[0].isInitial);
  const last = path[path.length - 1];
  assert.equal(proc.statuses.find((s) => s.ref === last.to.ref).category, 'DONE');
  assert.ok(!path.some((t) => /ablehn|reject/i.test(t.name)), 'reject transition on the usual path');
  // every step starts where the previous one ended
  for (let i = 1; i < path.length; i++) assert.ok(path[i].from.some((f) => f.ref === path[i - 1].to.ref));
});

test('simple workflow: Create → Start → Done, Reopen is a step back', () => {
  assert.deepEqual(mainPath(bug).map((t) => t.name), ['Create', 'Start', 'Done']);
  const reopen = bug.transitions.find((t) => t.name === 'Reopen');
  assert.equal(transitionRole(bug, reopen), 'back');
  assert.equal(transitionRole(bug, bug.transitions.find((t) => t.name === 'Done')), 'done');
});

test('workflow story: verdict, journey with who/checks/why, other routes and improvements', () => {
  const s = workflowStory(model, proc, 'en');
  assert.equal(s.verdict.level, 'critical');
  assert.match(s.verdict.text, /Needs action/);
  assert.ok(s.journey.length >= 2);
  assert.equal(s.journey[0].n, 1);
  assert.ok(s.journey.every((j) => typeof j.who === 'string' && j.who.length));
  assert.ok(s.journey[0].why.some((w) => /every new issue/.test(w)));
  const approve = s.journey.find((j) => j.name === 'Freigeben');
  assert.match(approve.who, /^Members of group "Procurement"/);
  assert.ok(approve.why.some((w) => /right people/.test(w)));
  assert.ok(s.others.some((o) => o.kind === 'global' && o.name === 'Ablehnen'));
  assert.ok(s.others.some((o) => o.kind === 'back'));
  assert.equal(s.transitions.length, proc.transitions.length);
  // improvements: sorted P1 first, each with reason and fix, auto-fixable ones flagged
  assert.equal(s.improvements[0].priority, 'P1');
  for (const i of s.improvements) {
    assert.ok(i.matters && !i.matters.startsWith('why.'), i.code);
    assert.ok(i.fix && !i.fix.startsWith('finding.'), i.code);
    assert.ok(i.where.length, i.code);
  }
  assert.ok(s.improvements.find((i) => i.code === 'DONE_NO_RESOLUTION').autofix);
});

test('resolution post functions are explained without raw IDs', () => {
  const s = workflowStory(model, bug, 'en');
  const done = s.transitions.find((x) => x.name === 'Done');
  assert.deepEqual(done.automatic, ['Sets the resolution, so the issue counts as resolved']);
  assert.ok(done.why.some((w) => /reports, filters/.test(w)));
  const reopen = s.transitions.find((x) => x.name === 'Reopen');
  assert.ok(reopen.automatic[0].startsWith('Clears the resolution'));
  assert.equal(s.verdict.level, 'good');
});

test('German texts are used for lang=de', () => {
  const s = workflowStory(model, proc, 'de');
  assert.match(s.verdict.text, /Handlungsbedarf/);
  assert.equal(s.journey[0].who, 'Alle, die in diesem Projekt Vorgänge erstellen dürfen');
  assert.match(siteStory(model, 'de').top[0].matters, /\S/);
  assert.equal(exportGlossary('de')[0].term, 'Status');
});

test('site story lists the most important improvements across workflows', () => {
  const site = siteStory(model, 'en', { top: 3 });
  assert.equal(site.top.length, 3);
  assert.ok(site.top[0].where.every((w) => w.startsWith('IDE: ')));
  assert.equal(improvements(model, null, 'en').length >= site.top.length, true);
});

test('every finding code, effort and glossary term has an English and German text', () => {
  for (const code of Object.keys(CATEGORY_OF)) {
    for (const [name, d] of [['en', en], ['de', de]]) {
      assert.ok(d[`why.finding.${code}`], `${name} why.finding.${code}`);
      assert.ok(d[`finding.${code}.title`], `${name} finding.${code}.title`);
      assert.ok(d[`finding.${code}.fix`], `${name} finding.${code}.fix`);
    }
  }
  for (const code of AUTOFIX_CODES) assert.ok(CATEGORY_OF[code], code);
  for (const e of ['S', 'M', 'L']) assert.ok(en[`g.effort.${e}`] && de[`g.effort.${e}`]);
  for (const k of GLOSSARY_KEYS) assert.ok(en[`gl.${k}`] && de[`gl.${k}`] && en[`gl.${k}.text`] && de[`gl.${k}.text`], k);
  for (const k of ['initial', 'global', 'done', 'back', 'loop']) assert.ok(en[`why.t.${k}`] && de[`why.t.${k}`], k);
  for (const k of ['global', 'back', 'done', 'side']) assert.ok(en[`g.other.${k}`] && de[`g.other.${k}`], k);
  for (const k of ['good', 'attention', 'critical']) assert.ok(en[`g.verdict.${k}`] && de[`g.verdict.${k}`], k);
});

test('guide keys exist in both languages with the same placeholders', () => {
  const keys = Object.keys(en).filter((k) => /^(g\.|why\.|gl\.)/.test(k));
  assert.ok(keys.length > 80);
  const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  for (const k of keys) {
    assert.ok(de[k], `missing de ${k}`);
    assert.equal(ph(de[k]), ph(en[k]), k);
  }
});

test('export scope: score, apps and dependencies of the exported workflows only', () => {
  const all = exportScope(model, model.workflows);
  assert.equal(all.stats.healthScore, model.stats.healthScore);
  assert.equal(all.stats.transitions, model.stats.transitions);
  const one = exportScope(model, [bug]);
  assert.equal(one.findings.every((f) => f.wfId === bug.id), true);
  assert.equal(one.vendors.filter((v) => v.thirdParty).length, 0);
  assert.ok(one.stats.healthScore >= all.stats.healthScore);
  assert.ok(!one.index.group || Object.values(one.index.group).every((e) => e.usages.every((u) => u.wfId === bug.id)));
  const t = proc.transitions.find((x) => x.name === 'Zur Freigabe');
  const sel = exportScope(model, model.workflows, [t.key]);
  assert.equal(sel.stats.transitions, 1);
  assert.equal(sel.workflows.length, 1);
  assert.deepEqual(sel.vendors.filter((v) => v.thirdParty).map((v) => v.name), ['JSU']);
});

// Minimal normalized workflows for path edge cases
const st = (ref, name, category = 'IN_PROGRESS') => ({ ref, id: ref, name, category });
const tr = (key, name, from, to, extra = {}) => ({ key, id: key, name, from: from.map((r) => ({ ref: r, name: r })), to: to ? { ref: to, name: to } : null, conditions: { op: 'ALL', rules: [], groups: [] }, validators: [], postFunctions: [], screens: [], triggers: [], propertyRules: [], isGlobal: false, isInitial: false, isLoop: false, ...extra });

test('usual path may use a global transition when there is no directed route', () => {
  const w = { statuses: [st('Open', 'Open', 'TODO'), st('Review', 'Review'), st('Done', 'Done', 'DONE')], transitions: [
    tr('c', 'Create', [], 'Open', { isInitial: true }), tr('g', 'Send to review', [], 'Review', { isGlobal: true }), tr('a', 'Approve', ['Review'], 'Done')] };
  assert.deepEqual(mainPath(w).map((t) => t.name), ['Create', 'Send to review', 'Approve']);
});

test('usual path does not end in a rejection status when a normal Done exists', () => {
  const w = { statuses: [st('Open', 'Open', 'TODO'), st('In Progress', 'In Progress'), st('Rejected', 'Rejected', 'DONE'), st('Done', 'Done', 'DONE')], transitions: [
    tr('c', 'Create', [], 'Open', { isInitial: true }), tr('x', 'Close', ['Open'], 'Rejected'), tr('s', 'Start', ['Open'], 'In Progress'), tr('f', 'Finish', ['In Progress'], 'Done')] };
  assert.deepEqual(mainPath(w).map((t) => t.name), ['Create', 'Start', 'Finish']);
});

test('Autopilot note only for findings the Autopilot really fixes', () => {
  assert.equal(canAutofix({ code: 'INACTIVE_USER', vendor: 'JMWE', ruleKind: 'postfunction' }), false);
  assert.equal(canAutofix({ code: 'INACTIVE_USER', vendor: 'Jira', ruleKind: 'condition' }), true);
  assert.equal(canAutofix({ code: 'UNRESOLVED_REF', vendor: 'Jira', ruleKind: 'condition', params: { type: 'field' } }), false);
  const imp = workflowStory(model, proc, 'en').improvements.find((i) => i.code === 'INACTIVE_USER');
  assert.notEqual(imp.autofix, 'all');
});
