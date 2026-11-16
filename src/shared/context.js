/**
 * Builds a compact, LLM-friendly text description of an analysed model (workflows, transitions, rules, findings)
 * for the Forge LLM Copilot, capped to a character budget.
 *
 * @file        src/shared/context.js
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-24
 * @updated     2026-11-05
 */

import { describeRule, describeConditionTree } from './explain.js';
import { findingText } from './i18n.js';
import { flattenConditions } from './engine.js';

export function modelContext(model, { workflowId = null, maxChars = 60000, lang = 'en', ref = null } = {}) {
  const lines = [];
  if (model.project) lines.push(`Project: ${model.project.key} – ${model.project.name}`);
  const wfs = workflowId ? model.workflows.filter((w) => w.id === String(workflowId)) : model.workflows;
  for (const wf of wfs) {
    lines.push('', `## Workflow "${wf.name}" (id ${wf.id}, ${wf.scope === 'PROJECT' ? 'team-managed' : 'company-managed'}; issue types: ${wf.issueTypes.map((i) => i.name).join(', ') || '-'})`);
    lines.push(`Statuses: ${wf.statuses.map((s) => `${s.name} [${s.category}]`).join('; ')}`);
    lines.push('Transitions:');
    for (const t of wf.transitions) {
      const from = t.isInitial ? 'CREATE' : t.isGlobal ? 'ANY STATUS' : t.from.map((f) => f.name).join(', ');
      const parts = [`- [${t.id}] "${t.name}": ${from} -> ${t.to?.name || 'same status'}`];
      if (t.screen) parts.push(`screen "${t.screen.name}"`);
      if (flattenConditions(t.conditions).length) parts.push(`conditions: ${describeConditionTree(t.conditions, lang)}`);
      if (t.validators.length) parts.push(`validators: ${t.validators.map((r) => `[${r.vendor.name}] ${describeRule(r, lang)}`).join('; ')}`);
      if (t.postFunctions.length) parts.push(`post functions: ${t.postFunctions.map((r) => `[${r.vendor.name}] ${describeRule(r, lang)}`).join('; ')}`);
      lines.push(parts.join(' | '));
    }
  }
  const ids = new Set(wfs.map((w) => w.id));
  const fs = model.findings.filter((f) => ids.has(f.wfId) && f.severity !== 'info').slice(0, 40);
  if (fs.length) {
    lines.push('', 'Health findings:');
    for (const f of fs) lines.push(`- [${f.severity}] ${f.wfName}${f.tName ? ` › ${f.tName}` : ''}: ${findingText(lang, f).title}`);
  }
  if (ref) {
    const list = (arr, map, n = 300) => (arr || []).slice(0, n).map(map).join(', ');
    lines.push('', `Available groups: ${list(ref.groups, (g) => g.name)}`);
    lines.push(`Available project roles: ${list(ref.roles, (r) => r.name)}`);
    lines.push(`Available resolutions: ${list(ref.resolutions, (r) => r.name)}`);
    lines.push(`Available screens: ${list(ref.screens, (s) => s.name, 100)}`);
    lines.push(`Fields (name = id): ${list(ref.fields, (f) => `${f.name} = ${f.id}`, 400)}`);
  }
  let text = lines.join('\n');
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n… (truncated)`;
  return text;
}
