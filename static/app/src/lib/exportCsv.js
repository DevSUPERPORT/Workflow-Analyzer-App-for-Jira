/**
 * CSV export of the transitions table for Excel (UTF-8 BOM, semicolon separator) with plain-language columns
 * (what happens, who, why, problems and fixes) and protection against CSV/formula injection from Jira names.
 *
 * @file        static/app/src/lib/exportCsv.js
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-24
 * @updated     2026-11-24
 */

import { t as tr } from '../../../../src/shared/i18n.js';
import { allRules, flattenConditions } from '../../../../src/shared/engine.js';
import { describeRule, describeConditionTree, describeTransition } from '../../../../src/shared/explain.js';
import { explainTransition, mainPath } from '../../../../src/shared/story.js';

// CSV/formula injection (OWASP): Excel executes cells starting with = + - @ (or tab/CR) as formulas.
// Names come from Jira and can be chosen by any project admin, so neutralise them with a leading quote.
const FORMULA_START = /^[=+\-@\t\r]/;
export const cell = (v) => {
  let s = String(v ?? '');
  if (FORMULA_START.test(s) && s !== '-' && s !== '–') s = `'${s}`;
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// Excel (DE/EN) friendly: UTF-8 BOM + semicolon separator
export function toCsv(rows) {
  return `﻿${rows.map((r) => r.map(cell).join(';')).join('\r\n')}`;
}

export function transitionsCsv(model, workflows, lang, notes = {}, onlyKeys = null) {
  const L = (k, v) => tr(lang, k, v);
  const rows = [[
    L('app.workflow'), 'ID', L('tt.col.transition'), L('tt.col.source'), L('tt.col.target'), L('param.type'), L('tt.col.screen'),
    L('tt.col.conditions'), L('tt.col.validators'), L('tt.col.postfunctions'), L('refs.app'), L('refs.group'), L('refs.field'), L('refs.user'),
    L('g.col.plain'), L('g.col.who'), L('g.col.why'), L('g.col.path'), L('g.col.issues'), L('tt.col.note'),
  ]];
  for (const wf of workflows) {
    const onPath = new Set((mainPath(wf) || []).map((x) => x.key));
    for (const t of wf.transitions) {
      if (onlyKeys && !onlyKeys.has(t.key)) continue;
      const rules = allRules(t);
      const refs = (type) => [...new Set(rules.flatMap((r) => r.refs.filter((x) => x.type === type).map((x) => x.name)))].join(', ');
      const x = explainTransition(model, wf, t, lang);
      const findings = x.findings.map((f) => `[${L(`ov.severity.${f.severity}`)}] ${f.title} – ${f.matters} ${L('g.improve.fix')}: ${f.fix}`).join(' | ');
      rows.push([
        wf.name,
        t.id,
        t.name,
        t.isInitial ? L('dg.start') : t.isGlobal ? L('tt.any') : t.from.map((f) => f.name).join(', '),
        t.to?.name || L('tt.loop'),
        L(`tt.type.${t.type}`),
        t.screen?.name || '',
        flattenConditions(t.conditions).length ? describeConditionTree(t.conditions, lang) : '',
        t.validators.map((r) => `[${r.vendor.name}] ${describeRule(r, lang)}`).join(' | '),
        [...t.postFunctions, ...t.triggers].map((r) => `[${r.vendor.name}] ${describeRule(r, lang)}`).join(' | '),
        [...new Set(rules.filter((r) => r.vendor.thirdParty).map((r) => r.vendor.name))].join(', '),
        refs('group'),
        refs('field'),
        refs('user'),
        describeTransition(wf, t, lang, model.findings).join(' '),
        x.who,
        x.why.join(' '),
        onPath.has(t.key) ? '✓' : '',
        findings,
        notes?.[wf.id]?.[t.id]?.text || '',
      ]);
    }
  }
  return toCsv(rows);
}
