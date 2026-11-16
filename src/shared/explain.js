/**
 * Plain-language explanations of workflows, transitions, rules and condition trees in English and German. A
 * deterministic "assistant" layer that works offline, inside exports and for the Rovo agent.
 *
 * @file        src/shared/explain.js
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-24
 * @updated     2026-11-05
 */

import { t as tr } from './i18n.js';
import { flattenConditions, allRules } from './engine.js';
import { splitList } from './rules.js';

const join = (lang, items, mode = 'and') => {
  const arr = items.filter(Boolean);
  if (arr.length <= 1) return arr.join('');
  const word = tr(lang, mode === 'or' ? 'x.or' : 'x.and');
  return `${arr.slice(0, -1).join(', ')} ${word} ${arr[arr.length - 1]}`;
};

const q = (s) => `„${s}“`;
const qEn = (s) => `"${s}"`;

function quote(lang, s) {
  return lang === 'de' ? q(s) : qEn(s);
}

function refNames(rule, type, via) {
  return rule.refs.filter((r) => r.type === type && (!via || r.via === via)).map((r) => r.name + (r.resolved === false ? ' (?)' : ''));
}

export function ruleTitle(rule, lang) {
  if (rule.vendor.thirdParty) {
    const kind = tr(lang, `kind.${rule.kind}`);
    return rule.label ? `${rule.label}` : kind;
  }
  if (rule.nameKey) return tr(lang, rule.nameKey);
  return rule.fallbackName || rule.ruleKey;
}

export function describeRule(rule, lang, opts = {}) {
  const p = rule.params || {};
  const L = (k, v) => tr(lang, k, v);
  const fields = (via) => join(lang, refNames(rule, 'field', via).map((n) => quote(lang, n)));
  let s;
  switch (rule.ruleKey) {
    case 'system:restrict-issue-transition': {
      const who = [];
      const ids = String(p.accountIds || '').split(',').map((x) => x.trim());
      if (ids.includes('allow-reporter')) who.push(L('x.reporter'));
      if (ids.includes('allow-assignee')) who.push(L('x.assignee'));
      const users = refNames(rule, 'user');
      if (users.length) who.push(L('x.users', { list: join(lang, users) }));
      const groups = refNames(rule, 'group');
      if (groups.length) who.push(L('x.groupMembers', { list: join(lang, groups.map((g) => quote(lang, g)), 'or') }));
      const roles = refNames(rule, 'role');
      if (roles.length) who.push(L('x.roleMembers', { list: join(lang, roles.map((g) => quote(lang, g)), 'or') }));
      const perms = refNames(rule, 'permission');
      if (perms.length) who.push(L('x.permissionHolders', { list: join(lang, perms.map((g) => quote(lang, g)), 'or') }));
      const gcf = refNames(rule, 'field', 'groupCustomFields');
      if (gcf.length) who.push(L('x.groupInField', { list: join(lang, gcf.map((g) => quote(lang, g))) }));
      const ucf = refNames(rule, 'field', 'allowUserCustomFields');
      if (ucf.length) who.push(L('x.userInField', { list: join(lang, ucf.map((g) => quote(lang, g))) }));
      if (opts.phrase) return join(lang, who, 'or') || '—';
      s = L('x.onlyWho', { who: join(lang, who, 'or') || '—' });
      const deny = refNames(rule, 'field', 'denyUserCustomFields');
      if (deny.length) s += ` ${L('x.denyField', { list: join(lang, deny.map((g) => quote(lang, g))) })}`;
      break;
    }
    case 'system:check-permission-validator':
      s = L('x.needsPermission', { perm: join(lang, refNames(rule, 'permission').map((n) => quote(lang, n))) });
      break;
    case 'system:validate-field-value': {
      const rt = p.ruleType;
      if (rt === 'fieldRequired') s = L('x.fieldRequired', { fields: fields('fieldsRequired') });
      else if (rt === 'fieldChanged') s = L('x.fieldChanged', { fields: fields('fieldKey') });
      else if (rt === 'fieldHasSingleValue') s = L('x.fieldSingle', { fields: fields('fieldKey') });
      else if (rt === 'fieldMatchesRegularExpression') s = L('x.fieldRegex', { fields: fields('fieldKey'), re: p.regexp });
      else if (rt === 'dateFieldComparison') s = L('x.dateCompare', { a: fields('date1FieldKey'), op: p.conditionSelected, b: fields('date2FieldKey') });
      else if (rt === 'windowDateComparison') s = L('x.dateWindow', { a: fields('date1FieldKey'), n: p.numberOfDays, b: fields('date2FieldKey') });
      else s = L('rule.validateFieldValue');
      const ex = refNames(rule, 'group', 'groupsExemptFromValidation');
      if (ex.length) s += ` ${L('x.exempt', { list: join(lang, ex.map((g) => quote(lang, g))) })}`;
      break;
    }
    case 'system:check-field-value':
      s = L('x.checkField', { field: fields('fieldId'), op: p.comparator || '=', value: join(lang, splitList(p.fieldValue).map((v) => quote(lang, v)), 'or') || L('x.empty') });
      break;
    case 'system:previous-status-condition':
    case 'system:previous-status-validator':
      s = L(String(p.not) === 'true' ? 'x.notPrevStatus' : 'x.prevStatus', { status: join(lang, refNames(rule, 'status').map((n) => quote(lang, n)), 'or') });
      break;
    case 'system:parent-or-child-blocking-condition':
      s = L('x.childBlocking', { status: join(lang, refNames(rule, 'status').map((n) => quote(lang, n)), 'or') });
      break;
    case 'system:parent-or-child-blocking-validator':
      s = L('x.parentBlocking', { status: join(lang, refNames(rule, 'status').map((n) => quote(lang, n)), 'or') });
      break;
    case 'system:separation-of-duties':
      s = L('x.separation', { from: refNames(rule, 'status', 'fromStatusId')[0] || '?', to: refNames(rule, 'status', 'toStatusId')[0] || '?' });
      break;
    case 'system:restrict-from-all-users':
      s = L(p.restrictMode === 'usersAndAPI' ? 'x.restrictAllApi' : 'x.restrictAll');
      break;
    case 'system:change-assignee': {
      const m = { 'to-selected-user': 'x.assignTo', 'to-unassigned': 'x.unassign', 'to-current-user': 'x.assignCurrent', 'to-default-user': 'x.assignDefault', 'to-reporter': 'x.assignReporter' };
      s = L(m[p.type] || 'rule.changeAssignee', { user: refNames(rule, 'user')[0] || p.accountId || '?' });
      break;
    }
    case 'system:copy-value-from-other-field':
      s = L(p.issueSource === 'PARENT' ? 'x.copyFieldParent' : 'x.copyField', { from: fields('sourceFieldKey'), to: fields('targetFieldKey') });
      break;
    case 'system:update-field': {
      const users = refNames(rule, 'user');
      s = L(p.mode === 'append' ? 'x.appendField' : 'x.setField', { field: fields('field'), value: users[0] || (p.value === '' || p.value == null ? L('x.empty') : String(p.value)) });
      break;
    }
    case 'system:trigger-webhook':
      s = L('x.webhook', { id: p.webhookId });
      break;
    case 'system:trigger-agent':
      s = L('x.agent', { agent: refNames(rule, 'user')[0] || p.agentId });
      break;
    case 'system:transition-screen':
      s = L('x.screen', { screen: refNames(rule, 'screen')[0] || p.screenId });
      break;
    case 'system:remind-people-to-update-fields':
      s = L('x.remind', { fields: fields('remindingFieldIds') });
      break;
    default: {
      if (rule.vendor.thirdParty) {
        const kind = tr(lang, `kind.${rule.kind}`);
        const lbl = rule.label || '';
        s = !lbl ? `${rule.vendor.name} ${kind}` : lbl.toLowerCase().includes(rule.vendor.name.toLowerCase()) ? quote(lang, lbl) : `${rule.vendor.name}: ${quote(lang, lbl)}`;
        const refs = rule.refs.filter((r) => r.type !== 'app');
        if (refs.length) s += ` (${L('x.uses')} ${refs.slice(0, 6).map((r) => `${tr(lang, `ref.${r.type}`)} ${quote(lang, r.name)}`).join(', ')}${refs.length > 6 ? ' …' : ''})`;
      } else {
        s = ruleTitle(rule, lang);
      }
    }
  }
  if (rule.disabled) s += ` [${L('x.disabled')}]`;
  return opts.phrase ? s.replace(/\.$/, '') : s;
}

export function describeConditionTree(tree, lang) {
  if (!tree) return '';
  const parts = [...tree.rules.map((r) => describeRule(r, lang, { phrase: true })), ...tree.groups.map((g) => `(${describeConditionTree(g, lang)})`)];
  return join(lang, parts, tree.op === 'ANY' ? 'or' : 'and');
}

export function describeTransition(wf, t, lang, findings = []) {
  const L = (k, v) => tr(lang, k, v);
  const out = [];
  const qq = (s) => quote(lang, s);
  if (t.isInitial) out.push(L('x.tInitial', { name: qq(t.name), to: qq(t.to?.name || '?') }));
  else if (t.isLoop) out.push(L('x.tLoop', { name: qq(t.name) }));
  else if (t.isGlobal) out.push(L('x.tGlobal', { name: qq(t.name), to: qq(t.to?.name || '?') }));
  else out.push(L('x.tDirected', { name: qq(t.name), from: join(lang, t.from.map((f) => qq(f.name)), 'or'), to: qq(t.to?.name || '?') }));

  if (t.screen) out.push(L('x.tScreen', { screen: qq(t.screen.name) }));
  const conds = flattenConditions(t.conditions);
  if (!conds.length) out.push(L('x.tNoConditions'));
  else out.push(L('x.tConditions', { list: describeConditionTree(t.conditions, lang) }));
  if (t.validators.length) out.push(L('x.tValidators', { list: t.validators.map((r) => describeRule(r, lang, { phrase: true })).join('; ') }));
  if (t.postFunctions.length) out.push(L('x.tPostFunctions', { list: t.postFunctions.map((r) => describeRule(r, lang, { phrase: true })).join('; ') }));
  const apps = [...new Set(allRules(t).filter((r) => r.vendor.thirdParty).map((r) => r.vendor.name))];
  if (apps.length) out.push(L('x.tApps', { list: join(lang, apps) }));
  const fs = findings.filter((f) => f.tKey === t.key && f.severity !== 'info');
  if (fs.length) out.push(L('x.tFindings', { n: fs.length }));
  return out;
}

export function describeWorkflow(model, wf, lang) {
  const L = (k, v) => tr(lang, k, v);
  const qq = (s) => quote(lang, s);
  const out = [];
  out.push(L('x.wfIntro', { name: qq(wf.name), s: wf.statuses.length, t: wf.transitions.length }));
  if (wf.issueTypes.length) out.push(L('x.wfIssueTypes', { list: join(lang, wf.issueTypes.map((i) => i.name)) }));
  if (wf.projects?.length) out.push(L('x.wfProjects', { n: wf.projects.length, list: wf.projects.slice(0, 8).map((p) => p.key).join(', ') }));
  const init = wf.transitions.find((t) => t.isInitial);
  if (init?.to) out.push(L('x.wfStart', { status: qq(init.to.name) }));
  const done = wf.statuses.filter((s) => s.category === 'DONE').map((s) => qq(s.name));
  if (done.length) out.push(L('x.wfDone', { list: join(lang, done, 'or') }));
  const glob = wf.transitions.filter((t) => t.isGlobal).length;
  if (glob) out.push(L('x.wfGlobal', { n: glob }));
  const apps = new Map();
  for (const t of wf.transitions) for (const r of allRules(t)) if (r.vendor.thirdParty) apps.set(r.vendor.name, (apps.get(r.vendor.name) || 0) + 1);
  if (apps.size) out.push(L('x.wfApps', { list: join(lang, [...apps].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} (${c})`)) }));
  else out.push(L('x.wfNoApps'));
  const top = [...wf.transitions].sort((a, b) => b.complexity - a.complexity)[0];
  if (top && top.complexity > 0) out.push(L('x.wfComplex', { name: qq(top.name), n: top.complexity }));
  const fs = model.findings.filter((f) => f.wfId === wf.id);
  const hi = fs.filter((f) => f.severity === 'high').length;
  out.push(hi ? L('x.wfFindingsHigh', { n: fs.length, hi }) : fs.length ? L('x.wfFindings', { n: fs.length }) : L('x.wfNoFindings'));
  return out;
}
