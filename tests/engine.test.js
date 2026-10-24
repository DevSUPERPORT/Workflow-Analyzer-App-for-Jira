import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, allRules, searchModel, collectRawRefs } from '../src/shared/engine.js';
import { describeTransition, describeWorkflow, describeRule } from '../src/shared/explain.js';
import { makeSnapshot, diffSnapshots } from '../src/shared/snapshot.js';
import { DICT, t, findingText } from '../src/shared/i18n.js';
import { detectVendor } from '../src/shared/vendors.js';
import { makeProcurementBundle, IDS } from './fixtures/procurement.js';

const model = normalize(makeProcurementBundle());
const wf = model.workflows.find((w) => w.name === 'IDE: Bedarfsworkflow');
const tr = (name) => wf.transitions.find((x) => x.name === name);
const codes = (code) => model.findings.filter((f) => f.code === code);

test('normalizes workflows, statuses and issue type mapping', () => {
  assert.equal(model.workflows.length, 2);
  assert.deepEqual(model.workflows.map((w) => w.name), ['IDE: Bedarfsworkflow', 'IDE: Bug Workflow']);
  assert.deepEqual(wf.issueTypes.map((i) => i.name), ['Bedarf', 'Unteraufgabe']);
  assert.equal(wf.statuses.length, 15);
  assert.equal(tr('GB OK').from[0].name, 'GB-Kontrolle');
  assert.equal(tr('GB OK').to.name, 'GB-Unterzeichnung');
  assert.equal(tr('zurück GB Erstellung').from.length, 2);
  assert.ok(tr('Ablehnen').isGlobal);
  assert.ok(tr('Create').isInitial);
});

test('detects vendors of third-party rules', () => {
  const names = model.vendors.filter((v) => v.thirdParty).map((v) => v.name).sort();
  assert.deepEqual(names, ['JMWE', 'JSU', 'ScriptRunner', 'Workflow Enhancer']);
  assert.equal(detectVendor('system:update-field').name, 'Jira');
  const forge = detectVendor('forge:expression-validator', { key: 'ari:cloud:ecosystem::extension/1234abcd-1111-2222-3333-444455556666/env/static/my-validator' });
  assert.equal(forge.type, 'forge');
});

test('builds condition trees with nested ANY groups', () => {
  const c = tr('GB OK').conditions;
  assert.equal(c.op, 'ALL');
  assert.equal(c.rules.length, 1);
  assert.equal(c.groups[0].op, 'ANY');
  assert.equal(c.groups[0].rules.length, 2);
  assert.equal(tr('GB OK').counts.condition, 3);
});

test('dependency index finds groups, users and fields (including inside app configs)', () => {
  const g = model.index.group;
  assert.equal(g[IDS.G_PROC].name, 'Procurement');
  assert.equal(g[IDS.G_PROC].transitionCount, 3);
  assert.ok(g[IDS.G_WGB], 'group referenced by name inside Workflow Enhancer expression');
  assert.equal(g[IDS.G_DELETED].resolved, false);
  assert.equal(model.index.user[IDS.U_BERNAR].inactive, true);
  assert.equal(model.index.field.customfield_11271.name, 'Standard Sortiment');
  assert.ok(model.index.field.customfield_11271.usages.some((u) => u.vendor === 'JSU'));
  assert.ok(model.index.field.customfield_11271.usages.some((u) => u.vendor === 'Workflow Enhancer'));
  assert.equal(model.index.screen['10050'].name, 'GB Prüfmaske');
  assert.equal(model.index.role['10002'].name, 'Administrators');
  assert.ok(model.index.app['connect:com.innovalog.jmwe.jira-cloud']);
});

test('health checks report the expected findings', () => {
  assert.equal(codes('UNREACHABLE').map((f) => f.params.status).join(), 'Archiv');
  assert.deepEqual(codes('DONE_NO_RESOLUTION').map((f) => f.tName).sort(), ['Ablehnen', 'Ware geliefert']);
  assert.equal(codes('GLOBAL_UNGUARDED').length, 1);
  assert.equal(codes('UNRESOLVED_REF').length, 1);
  assert.equal(codes('UNRESOLVED_REF')[0].params.id, IDS.G_DELETED);
  assert.ok(codes('INACTIVE_USER').length >= 2, 'Bernar is referenced by JMWE and update-field');
  assert.ok(codes('HARDCODED_USER').length >= 2);
  assert.equal(codes('LICENSE_GUARD').length, 2);
  assert.equal(codes('DISABLED_RULE').length, 1);
  assert.equal(codes('CONFIG_UNREADABLE').length, 1);
  // Bug workflow is clean apart from nothing critical
  assert.equal(model.findings.filter((f) => f.wfName === 'IDE: Bug Workflow' && f.severity !== 'info').length, 0);
  assert.ok(model.stats.healthScore > 0 && model.stats.healthScore < 100);
});

test('dead end detection', () => {
  const b = makeProcurementBundle();
  b.workflows[0].transitions = b.workflows[0].transitions.filter((x) => x.type !== 'GLOBAL');
  const m = normalize(b);
  const dead = m.findings.filter((f) => f.code === 'DEAD_END').map((f) => f.params.status);
  assert.ok(dead.includes('Archiv'));
  assert.ok(dead.includes('GB-Klärung') === false, 'GB-Klärung has a way back');
});

test('stats aggregate rule counts', () => {
  const s = model.stats;
  assert.equal(s.workflows, 2);
  assert.equal(s.transitions, wf.transitions.length + 4);
  assert.equal(s.apps, 4);
  assert.ok(s.condition >= 8);
  assert.equal(s.validator, 7);
});

test('plain language explanations in English and German contain no placeholders', () => {
  for (const lang of ['en', 'de']) {
    for (const w of model.workflows) {
      const lines = describeWorkflow(model, w, lang);
      assert.ok(lines.length > 3);
      for (const x of w.transitions) {
        const s = describeTransition(w, x, lang, model.findings).join(' ');
        assert.ok(!/\{\w+\}/.test(s), `unresolved placeholder in ${lang}: ${s}`);
        for (const r of allRules(x)) assert.ok(describeRule(r, lang).length > 3);
      }
    }
    for (const f of model.findings) {
      const ft = findingText(lang, f);
      assert.ok(!/\{\w+\}/.test(ft.title + ft.fix), `placeholder in finding ${f.code}: ${ft.title}`);
    }
  }
  const de = describeTransition(wf, tr('GB OK'), 'de').join(' ');
  assert.match(de, /Procurement/);
  assert.match(de, /Melder/);
  const en = describeTransition(wf, tr('Create'), 'en').join(' ');
  assert.match(en, /Product Owner/);
  assert.match(en, /JMWE/);
});

test('snapshots and diffs detect structural changes', () => {
  const a = makeSnapshot(model, { label: 'before' });
  const b2 = makeProcurementBundle();
  const w = b2.workflows[0];
  w.transitions.find((x) => x.name === 'Freigeben').name = 'Freigabe erteilen';
  w.transitions.find((x) => x.name === 'Ware geliefert').actions.push({ ruleKey: 'system:update-field', parameters: { field: 'resolution', value: '10000', mode: 'replace' } });
  w.transitions = w.transitions.filter((x) => x.name !== 'Bestellen');
  const b = makeSnapshot(normalize(b2));
  const d = diffSnapshots(a, b);
  assert.ok(d.find((c) => c.type === 'transition' && c.op === 'changed' && c.detail.field === 'name' && c.detail.to === 'Freigabe erteilen'));
  assert.ok(d.find((c) => c.type === 'transition' && c.op === 'removed' && c.name === 'Bestellen'));
  assert.ok(d.find((c) => c.type === 'rule' && c.op === 'added' && c.name === 'Ware geliefert'));
  assert.equal(diffSnapshots(a, makeSnapshot(model)).length, 0);
  assert.ok(JSON.stringify(a).length < 100000);
});

test('search finds statuses, transitions, refs and expression content', () => {
  assert.ok(searchModel(model, 'GB-K').some((r) => r.type === 'status'));
  assert.ok(searchModel(model, 'procurement').some((r) => r.type === 'ref' && r.refType === 'group'));
  assert.ok(searchModel(model, 'app.license').some((r) => r.type === 'rule'));
});

test('collectRawRefs gathers IDs for bulk resolution', () => {
  const r = collectRawRefs(makeProcurementBundle().workflows);
  assert.ok(r.group.includes(IDS.G_PROC));
  assert.ok(r.user.includes(IDS.U_RENE));
  assert.ok(r.screen.includes('10050'));
  assert.ok(r.role.includes('10002'));
});

test('i18n dictionaries are complete in both languages', () => {
  const en = Object.keys(DICT.en).sort();
  const de = Object.keys(DICT.de).sort();
  assert.deepEqual(en.filter((k) => !DICT.de[k]), []);
  assert.deepEqual(de.filter((k) => !DICT.en[k]), []);
  assert.equal(t('de', 'tab.overview'), 'Übersicht');
  assert.equal(t('en', 'tt.transitionsN', { n: 3 }), '3 transitions');
});

test('groups/roles referenced in transition and status properties are found (boss use case)', () => {
  const b = makeProcurementBundle();
  const w = b.workflows[0];
  w.transitions.find((x) => x.name === 'Bestellen').properties = { 'jira.permission.edit.group': 'jira-admins', 'jira.i18n.title': 'x' };
  w.statuses.find((s) => s.statusReference === 'ref-10640').properties = { 'jira.permission.comment.group.1': 'deleted-old-group', 'jira.permission.assignable.projectrole': '10002' };
  const m = normalize(b);
  const admins = Object.values(m.index.group).find((g) => g.name === 'jira-admins');
  assert.ok(admins, 'group used only in a transition property is indexed');
  assert.equal(admins.usages[0].kind, 'property');
  const gone = Object.values(m.index.group).find((g) => g.name === 'deleted-old-group');
  assert.equal(gone.resolved, false);
  assert.ok(gone.usages[0].statusProperty);
  assert.ok(m.findings.some((f) => f.code === 'UNRESOLVED_REF' && f.params.name === 'deleted-old-group'));
  assert.ok(m.index.role['10002'].usages.some((u) => u.kind === 'property'));
});
