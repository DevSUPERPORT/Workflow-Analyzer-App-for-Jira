// Workflow Autopilot: structured change operations on raw Jira workflow JSON (new workflow API),
// dry-run analysis (diff + health impact), update payload builder and auto-fix generation.
//
// Operations are produced by humans (templates/UI), by the in-app Copilot (Forge LLM tool call)
// or by the Rovo agent. They are always validated and dry-run before anything is applied.

import { normalize } from './engine.js';
import { makeSnapshot, diffSnapshots } from './snapshot.js';
import { findingFingerprint } from './insights.js';
import { splitList } from './rules.js';

export const OPS = {
  addStatus: { required: ['name'], doc: 'Add a status. category: TODO | IN_PROGRESS | DONE (default IN_PROGRESS). Reuses an existing site status with the same name.' },
  removeStatus: { required: ['status', 'moveIssuesTo'], doc: 'Remove a status from the workflow; issues in it move to moveIssuesTo. Transitions from/to it are removed.' },
  addTransition: { required: ['name', 'to'], doc: 'Add a transition. from: list of status names, or "any" for a global transition. to: target status name.' },
  removeTransition: { required: ['transition'], doc: 'Remove a transition (optionally only the link from one status: from).' },
  renameTransition: { required: ['transition', 'newName'], doc: 'Rename a transition.' },
  addFromStatus: { required: ['transition', 'from'], doc: 'Make an existing transition also available from additional statuses (list).' },
  restrictTransition: { required: ['transition'], doc: 'Only allow listed groups / roles / reporter / assignee / permission to execute the transition (adds a condition, existing conditions stay).' },
  requireFields: { required: ['transition', 'fields'], doc: 'Validator: listed fields (names or IDs) must be filled in. Optional message.' },
  setResolution: { required: ['transition', 'resolution'], doc: 'Post function: set the resolution (name, e.g. "Done", or "none" to clear it).' },
  setAssignee: { required: ['transition', 'to'], doc: 'Post function: assign to current-user | unassigned | default | <user account ID>.' },
  setTransitionScreen: { required: ['transition', 'screen'], doc: 'Show a screen (name or ID) on the transition, or "none" to remove it.' },
  removeRule: { required: ['transition', 'match'], doc: 'Remove conditions/validators/post functions whose rule key, app or description contains match. Optional kind: condition | validator | postfunction.' },
  removeReference: { required: ['refType', 'ref'], doc: 'Remove a group / role / user (name or ID) from all Jira rules and transition/status properties of the workflow (e.g. deleted group, inactive user).' },
  replaceReference: { required: ['refType', 'ref', 'with'], doc: 'Replace a group / role / user with another one everywhere in the workflow (rules and properties), e.g. after a team re-organisation.' },
};

export const OPS_JSON_SCHEMA = {
  type: 'object',
  properties: {
    workflow: { type: 'string', description: 'Workflow name (optional when the project has one workflow)' },
    explanation: { type: 'string', description: 'Short explanation of the plan for the user, in the user language' },
    operations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: Object.keys(OPS) },
          name: { type: 'string' }, newName: { type: 'string' }, category: { type: 'string', enum: ['TODO', 'IN_PROGRESS', 'DONE'] },
          status: { type: 'string' }, moveIssuesTo: { type: 'string' },
          transition: { type: 'string' }, description: { type: 'string' },
          from: { description: 'Status name, list of status names, or "any"', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
          to: { type: 'string' },
          groups: { type: 'array', items: { type: 'string' } }, roles: { type: 'array', items: { type: 'string' } },
          reporter: { type: 'boolean' }, assignee: { type: 'boolean' }, permission: { type: 'string' },
          fields: { type: 'array', items: { type: 'string' } }, message: { type: 'string' },
          resolution: { type: 'string' }, screen: { type: 'string' },
          match: { type: 'string' }, kind: { type: 'string', enum: ['condition', 'validator', 'postfunction'] },
          refType: { type: 'string', enum: ['group', 'role', 'user'] }, ref: { type: 'string' }, with: { type: 'string', description: 'replacement (replaceReference)' },
        },
        required: ['op'],
      },
    },
  },
  required: ['operations'],
};

export const OP_EXAMPLES = {
  addStatus: { op: 'addStatus', name: 'Escalated', category: 'IN_PROGRESS' },
  removeStatus: { op: 'removeStatus', status: 'Archive', moveIssuesTo: 'Done' },
  addTransition: { op: 'addTransition', name: 'Escalate', from: ['Review'], to: 'Escalated' },
  removeTransition: { op: 'removeTransition', transition: 'Escalate' },
  renameTransition: { op: 'renameTransition', transition: 'Escalate', newName: 'Escalate to management' },
  addFromStatus: { op: 'addFromStatus', transition: 'Escalate', from: ['In Progress'] },
  restrictTransition: { op: 'restrictTransition', transition: 'Escalate', groups: ['managers'], roles: ['Administrators'], reporter: false },
  requireFields: { op: 'requireFields', transition: 'Done', fields: ['Due date'], message: 'Please set a due date' },
  setResolution: { op: 'setResolution', transition: 'Reject', resolution: "Won't Do" },
  setAssignee: { op: 'setAssignee', transition: 'Start', to: 'current-user' },
  setTransitionScreen: { op: 'setTransitionScreen', transition: 'Done', screen: 'Resolve screen' },
  removeRule: { op: 'removeRule', transition: 'Done', match: 'restrict-issue-transition', kind: 'condition' },
  removeReference: { op: 'removeReference', refType: 'group', ref: 'old-group' },
  replaceReference: { op: 'replaceReference', refType: 'group', ref: 'old-group', with: 'new-group' },
};

export function opsDocumentation() {
  return Object.entries(OPS).map(([k, v]) => `- ${k} (required: ${v.required.join(', ')}): ${v.doc}\n  example: ${JSON.stringify(OP_EXAMPLES[k])}`).join('\n');
}

// LLMs sometimes use slightly different field names – map common aliases onto the canonical ones.
export function normalizeOp(raw) {
  const op = { ...(raw || {}) };
  const take = (target, ...aliases) => {
    if (op[target] != null && op[target] !== '') return;
    for (const a of aliases) if (op[a] != null && op[a] !== '') { op[target] = op[a]; return; }
  };
  op.op = String(op.op || op.operation || op.type || '').trim();
  switch (op.op) {
    case 'addStatus': take('name', 'status', 'statusName', 'newStatus', 'title'); take('category', 'statusCategory'); break;
    case 'removeStatus': take('status', 'name', 'statusName'); take('moveIssuesTo', 'to', 'targetStatus', 'migrateTo'); break;
    case 'addTransition': take('name', 'transition', 'transitionName', 'title'); take('to', 'toStatus', 'target', 'targetStatus'); take('from', 'fromStatus', 'fromStatuses', 'source', 'sources'); break;
    case 'renameTransition': take('transition', 'name', 'oldName'); take('newName', 'to', 'rename'); break;
    case 'addFromStatus': take('from', 'fromStatus', 'fromStatuses', 'status', 'statuses'); break;
    case 'requireFields': take('fields', 'field', 'fieldNames'); break;
    case 'setAssignee': take('to', 'assignee', 'user'); break;
    case 'removeReference': take('ref', 'name', 'id', 'group', 'user', 'role'); take('refType', 'type'); break;
    case 'replaceReference': take('ref', 'from', 'old', 'group', 'user', 'role'); take('with', 'to', 'new', 'replacement'); take('refType', 'type'); break;
    default: break;
  }
  if (['restrictTransition', 'requireFields', 'setResolution', 'setAssignee', 'setTransitionScreen', 'removeRule', 'removeTransition', 'addFromStatus'].includes(op.op)) take('transition', 'name', 'transitionName');
  if (op.op === 'restrictTransition') { take('groups', 'group'); take('roles', 'role', 'projectRoles'); }
  return op;
}

const lc = (s) => String(s ?? '').trim().toLowerCase();
const clone = (o) => JSON.parse(JSON.stringify(o));
const uuid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
  const r = (Math.random() * 16) | 0;
  return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
});

class OpError extends Error {}

/**
 * Remove or replace a group / role / user everywhere Jira stores it in a workflow:
 * restrict-issue-transition conditions, exempt groups, assignee post functions,
 * update-field values and transition/status properties. Returns the number of places changed.
 */
function rewriteReferences(wf, { type, id, name, toId, toName }) {
  let n = 0;
  const key = type === 'group' ? 'groupIds' : type === 'role' ? 'roleIds' : 'accountIds';
  const swapList = (value) => {
    const items = splitList(value);
    if (!items.includes(id)) return null;
    n++;
    const next = toId ? [...new Set(items.map((x) => (x === id ? toId : x)))] : items.filter((x) => x !== id);
    return next.join(',');
  };
  const fixRule = (r) => {
    const p = r.parameters || {};
    if (r.ruleKey === 'system:restrict-issue-transition' && p[key] != null) {
      const next = swapList(p[key]);
      if (next !== null) {
        if (next) p[key] = next; else delete p[key];
        const rest = ['accountIds', 'roleIds', 'groupIds', 'permissionKeys', 'groupCustomFields', 'allowUserCustomFields'].some((k) => p[k]);
        if (!rest) return false; // nobody left – drop the whole restriction
      }
    }
    if (type === 'group' && p.groupsExemptFromValidation) {
      const next = swapList(p.groupsExemptFromValidation);
      if (next !== null) p.groupsExemptFromValidation = next;
    }
    if (type === 'user' && r.ruleKey === 'system:change-assignee' && p.accountId === id) {
      n++;
      r.parameters = toId ? { ...p, accountId: toId } : { type: 'to-default-user' };
    }
    if (type === 'user' && r.ruleKey === 'system:update-field' && p.value === id) {
      n++;
      if (!toId) return false;
      p.value = toId;
    }
    return true;
  };
  const fixGroup = (g) => g && { ...g, conditions: (g.conditions || []).filter(fixRule), conditionGroups: (g.conditionGroups || []).map(fixGroup) };
  const propPattern = type === 'group' ? /group/i : type === 'role' ? /projectrole|\.role/i : /user|assignee|reporter/i;
  const fixProps = (props) => {
    if (!props) return props;
    for (const [k, v] of Object.entries(props)) {
      if (!propPattern.test(k)) continue;
      const items = splitList(v);
      if (!items.some((x) => x === id || lc(x) === lc(name))) continue;
      n++;
      const next = toId ? [...new Set(items.map((x) => (x === id ? toId : lc(x) === lc(name) ? toName : x)))] : items.filter((x) => x !== id && lc(x) !== lc(name));
      if (next.length) props[k] = next.join(','); else delete props[k];
    }
    return props;
  };
  for (const t of wf.transitions || []) {
    t.conditions = fixGroup(t.conditions);
    t.validators = (t.validators || []).filter(fixRule);
    t.actions = (t.actions || []).filter(fixRule);
    t.properties = fixProps(t.properties);
  }
  for (const s of wf.statuses || []) s.properties = fixProps(s.properties);
  return n;
}
// Nothing to do in this workflow (e.g. a selector matched no transition) – not an error in bulk runs
class NoopError extends Error {}

// Operation result messages, in the language of the person planning the change (English is the default)
const LABEL = {
  en: { Field: 'Field', Group: 'Group', 'Project role': 'Project role', Resolution: 'Resolution', Screen: 'Screen', group: 'group', role: 'role', user: 'user', 'allow-reporter': 'the reporter', 'allow-assignee': 'the assignee' },
  de: { Field: 'Feld', Group: 'Gruppe', 'Project role': 'Projektrolle', Resolution: 'Lösung', Screen: 'Maske', group: 'Gruppe', role: 'Rolle', user: 'Benutzer', 'allow-reporter': 'der Autor', 'allow-assignee': 'der Bearbeiter' },
};
const MSG = {
  en: {
    statusNotFound: (v) => `Status "${v.name}" not found`,
    statusNotInWf: (v) => `Status "${v.name}" is not part of workflow "${v.wf}"`,
    selectorNotAllowed: (v) => `Selectors like "${v.raw}" are not allowed for this operation`,
    unknownSelector: (v) => `Unknown selector "${v.raw}" – use @all, @done, @global, @initial, @to:<status>, @from:<status> or @name:<text>`,
    noSelectorMatch: (v) => `No transition matches ${v.raw} in "${v.wf}" – nothing to change`,
    transitionNotFound: (v) => `Transition "${v.name}" not found in workflow "${v.wf}"`,
    notFound: (v) => `${v.label} "${v.name}" not found`,
    unknownOp: (v) => `Unknown operation "${v.op}"`,
    needs: (v) => `"${v.op}" needs "${v.field}"`,
    statusAlreadyIn: (v) => `Status "${v.name}" already in workflow`,
    reusesStatus: (v) => `Reuses existing status "${v.name}"`,
    createsStatus: (v) => `Creates new status "${v.name}" (${v.category})`,
    moveTargetSame: () => 'moveIssuesTo must differ from the removed status',
    removesStatus: (v) => `Removes "${v.name}" (${v.n} transitions removed), issues move to "${v.target}"`,
    transitionExists: (v) => `Transition "${v.name}" to "${v.to}" already exists`,
    globalTransition: (v) => `Global transition "${v.name}" → "${v.to}"`,
    addsTransition: (v) => `Transition "${v.name}": ${v.from} → "${v.to}"`,
    removesFrom: (v) => `Removes "${v.name}" from "${v.from}"`,
    removesTransition: (v) => `Removes transition "${v.name}"`,
    cannotRemoveCreate: () => 'The create transition cannot be removed',
    notDirected: (v) => `"${v.name}" is not a directed transition`,
    alsoFrom: (v) => `"${v.name}" also from ${v.list}`,
    restrictNeeds: () => 'restrictTransition needs groups, roles, reporter, assignee or permission',
    onlyWho: (v) => `Only ${v.list}`,
    or: () => ' or ',
    required: (v) => `Required: ${v.list}`,
    tmResolution: () => 'Team-managed spaces set the resolution automatically when an issue enters a Done status – Jira does not allow a resolution rule here, nothing to change',
    clearsResolution: () => 'Clears the resolution',
    setsResolution: (v) => `Sets resolution "${v.name}"`,
    assignee: (v) => `Assignee → ${v.to}`,
    removesScreen: () => 'Removes the screen',
    showsScreen: (v) => `Shows screen "${v.name}"`,
    noRuleMatch: (v) => `No rule matching "${v.match}" on "${v.name}"`,
    removesRules: (v) => (v.n === 1 ? 'Removes 1 rule' : `Removes ${v.n} rules`),
    replacementNotFound: (v) => `${v.type} "${v.name}" not found – the replacement must exist`,
    replacementSame: () => 'Replacement is the same object',
    refNotUsed: (v) => `${v.type} "${v.name}" is not used by Jira rules or properties of "${v.wf}" – nothing to change (app rules must be edited in the app)`,
    replacesRef: (v) => `Replaces ${v.type} "${v.name}" with "${v.to}" in ${v.n} place(s)`,
    removesRef: (v) => `Removes ${v.type} "${v.name}" from ${v.n} place(s)`,
    unsupported: (v) => `Unsupported operation ${v.op}`,
  },
  de: {
    statusNotFound: (v) => `Status „${v.name}“ nicht gefunden`,
    statusNotInWf: (v) => `Status „${v.name}“ gehört nicht zum Workflow „${v.wf}“`,
    selectorNotAllowed: (v) => `Selektoren wie „${v.raw}“ sind für diese Operation nicht erlaubt`,
    unknownSelector: (v) => `Unbekannter Selektor „${v.raw}“ – verwenden Sie @all, @done, @global, @initial, @to:<Status>, @from:<Status> oder @name:<Text>`,
    noSelectorMatch: (v) => `Keine Transition passt zu ${v.raw} in „${v.wf}“ – nichts zu ändern`,
    transitionNotFound: (v) => `Transition „${v.name}“ im Workflow „${v.wf}“ nicht gefunden`,
    notFound: (v) => `${v.label} „${v.name}“ nicht gefunden`,
    unknownOp: (v) => `Unbekannte Operation „${v.op}“`,
    needs: (v) => `„${v.op}“ benötigt „${v.field}“`,
    statusAlreadyIn: (v) => `Status „${v.name}“ ist bereits im Workflow`,
    reusesStatus: (v) => `Verwendet den vorhandenen Status „${v.name}“`,
    createsStatus: (v) => `Legt den neuen Status „${v.name}“ an (${v.category})`,
    moveTargetSame: () => 'moveIssuesTo muss sich vom entfernten Status unterscheiden',
    removesStatus: (v) => `Entfernt „${v.name}“ (${v.n} Transitionen entfernt), Vorgänge wechseln nach „${v.target}“`,
    transitionExists: (v) => `Transition „${v.name}“ nach „${v.to}“ existiert bereits`,
    globalTransition: (v) => `Globale Transition „${v.name}“ → „${v.to}“`,
    addsTransition: (v) => `Transition „${v.name}“: ${v.from} → „${v.to}“`,
    removesFrom: (v) => `Entfernt „${v.name}“ aus „${v.from}“`,
    removesTransition: (v) => `Entfernt die Transition „${v.name}“`,
    cannotRemoveCreate: () => 'Die Erstellen-Transition kann nicht entfernt werden',
    notDirected: (v) => `„${v.name}“ ist keine gerichtete Transition`,
    alsoFrom: (v) => `„${v.name}“ zusätzlich aus ${v.list}`,
    restrictNeeds: () => 'restrictTransition benötigt Gruppen, Rollen, Autor, Bearbeiter oder eine Berechtigung',
    onlyWho: (v) => `Nur ${v.list}`,
    or: () => ' oder ',
    required: (v) => `Pflichtfelder: ${v.list}`,
    tmResolution: () => 'Teamverwaltete Bereiche setzen die Lösung automatisch, wenn ein Vorgang einen Erledigt-Status erreicht – Jira erlaubt hier keine Lösungsregel, nichts zu ändern',
    clearsResolution: () => 'Leert die Lösung',
    setsResolution: (v) => `Setzt die Lösung „${v.name}“`,
    assignee: (v) => `Bearbeiter → ${v.to}`,
    removesScreen: () => 'Entfernt die Maske',
    showsScreen: (v) => `Zeigt die Maske „${v.name}“`,
    noRuleMatch: (v) => `Keine Regel passt zu „${v.match}“ an „${v.name}“`,
    removesRules: (v) => (v.n === 1 ? 'Entfernt 1 Regel' : `Entfernt ${v.n} Regeln`),
    replacementNotFound: (v) => `${v.type} „${v.name}“ nicht gefunden – der Ersatz muss existieren`,
    replacementSame: () => 'Der Ersatz ist dasselbe Objekt',
    refNotUsed: (v) => `${v.type} „${v.name}“ wird von keiner Jira-Regel und keiner Eigenschaft in „${v.wf}“ verwendet – nichts zu ändern (App-Regeln müssen in der App bearbeitet werden)`,
    replacesRef: (v) => `Ersetzt ${v.type} „${v.name}“ durch „${v.to}“ an ${v.n} Stelle(n)`,
    removesRef: (v) => `Entfernt ${v.type} „${v.name}“ an ${v.n} Stelle(n)`,
    unsupported: (v) => `Nicht unterstützte Operation ${v.op}`,
  },
};

/**
 * Apply operations to a raw workflow.
 * ctx: { statuses (site/bundle statuses JiraWorkflowStatus[]), ref (bundle.ref), resolutions [{id,name}], lang ('en' | 'de') }
 * Returns { workflow, newStatuses, statusMappings, results: [{op, ok, message}] }
 */
export function applyOperations(rawWf, ops, ctx) {
  const wf = clone(rawWf);
  wf.transitions ||= [];
  wf.statuses ||= [];
  const allStatuses = [...(ctx.statuses || [])];
  const newStatuses = [];
  const statusMappings = [];
  const results = [];
  const ref = ctx.ref || {};
  const lang = ctx.lang === 'de' ? 'de' : 'en';
  const m = (key, v = {}) => MSG[lang][key](v);
  const label = (k) => LABEL[lang][k] || k;

  const statusByName = (name, { mustBeInWorkflow = true } = {}) => {
    const n = lc(name);
    const s = [...allStatuses, ...newStatuses].find((x) => lc(x.name) === n || String(x.id) === String(name) || x.statusReference === name);
    if (!s) throw new OpError(m('statusNotFound', { name }));
    if (mustBeInWorkflow && !wf.statuses.some((w) => w.statusReference === s.statusReference)) throw new OpError(m('statusNotInWf', { name: s.name, wf: wf.name }));
    return s;
  };
  const statusCategory = (ref2) => [...allStatuses, ...newStatuses].find((s) => s.statusReference === ref2 || String(s.id) === String(ref2))?.statusCategory;
  // Selectors address many transitions at once (bulk changes):
  // @all  @done  @global  @initial  @to:<status>  @from:<status>  @name:<text>
  const transitionsByName = (name, { selectors = true } = {}) => {
    const raw = String(name ?? '').trim();
    if (raw.startsWith('@')) {
      if (!selectors) throw new OpError(m('selectorNotAllowed', { raw }));
      const [sel, ...rest] = raw.slice(1).split(':');
      const arg = rest.join(':').trim();
      let list;
      switch (lc(sel)) {
        case 'all': list = wf.transitions.filter((t) => t.type !== 'INITIAL'); break;
        case 'done': list = wf.transitions.filter((t) => t.type !== 'INITIAL' && statusCategory(t.toStatusReference) === 'DONE'); break;
        case 'global': list = wf.transitions.filter((t) => t.type === 'GLOBAL'); break;
        case 'initial': list = wf.transitions.filter((t) => t.type === 'INITIAL'); break;
        case 'to': { const s = statusByName(arg); list = wf.transitions.filter((t) => t.toStatusReference === s.statusReference); break; }
        case 'from': { const s = statusByName(arg); list = wf.transitions.filter((t) => (t.links || []).some((l) => l.fromStatusReference === s.statusReference)); break; }
        case 'name': list = wf.transitions.filter((t) => lc(t.name).includes(lc(arg))); break;
        default: throw new OpError(m('unknownSelector', { raw }));
      }
      if (!list.length) throw new NoopError(m('noSelectorMatch', { raw, wf: wf.name }));
      return list;
    }
    const n = lc(raw);
    const list = wf.transitions.filter((t) => lc(t.name) === n || String(t.id) === raw);
    if (!list.length) throw new OpError(m('transitionNotFound', { name: raw, wf: wf.name }));
    return list;
  };
  const find = (list, name, lbl, idKey = 'id') => {
    const n = lc(name);
    const x = (list || []).find((e) => lc(e.name) === n || lc(e[idKey]) === n || lc(e.groupId) === n);
    if (!x) throw new OpError(m('notFound', { label: label(lbl), name }));
    return x;
  };
  const fieldId = (name) => {
    if (/^customfield_\d+$/.test(name)) return name;
    return find(ref.fields, name, 'Field').id;
  };
  const nextId = () => String(Math.max(0, ...wf.transitions.map((t) => Number(t.id) || 0)) + 10);
  const asList = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]).flatMap((x) => (typeof x === 'string' ? x.split(/\s*,\s*/) : [x])).filter(Boolean);
  // Transition names for messages: plans address transitions by ID (auto-fix, templates), people read names
  const trName = (v) => {
    const raw = String(v ?? '');
    if (raw.startsWith('@')) return raw;
    return wf.transitions.find((t) => String(t.id) === raw)?.name || rawWf.transitions?.find((t) => String(t.id) === raw)?.name || raw;
  };

  for (const rawOp of ops || []) {
    const op = normalizeOp(rawOp);
    try {
      const spec = OPS[op?.op];
      if (!spec) throw new OpError(m('unknownOp', { op: op?.op }));
      for (const r of spec.required) if (op[r] == null || op[r] === '' || (Array.isArray(op[r]) && !op[r].length)) throw new OpError(m('needs', { op: op.op, field: r }));
      let message = '';
      switch (op.op) {
        case 'addStatus': {
          const existing = allStatuses.find((s) => lc(s.name) === lc(op.name)) || newStatuses.find((s) => lc(s.name) === lc(op.name));
          if (existing && wf.statuses.some((w) => w.statusReference === existing.statusReference)) throw new OpError(m('statusAlreadyIn', { name: op.name }));
          const s = existing || { statusReference: uuid(), name: String(op.name).slice(0, 60), statusCategory: op.category || 'IN_PROGRESS', isNew: true };
          if (!existing) newStatuses.push(s);
          const xs = wf.statuses.map((w) => w.layout?.x).filter(Number.isFinite);
          wf.statuses.push({ statusReference: s.statusReference, properties: {}, layout: xs.length ? { x: Math.max(...xs) + 260, y: 0 } : undefined });
          message = existing ? m('reusesStatus', { name: s.name }) : m('createsStatus', { name: s.name, category: s.statusCategory });
          break;
        }
        case 'removeStatus': {
          const s = statusByName(op.status);
          const target = statusByName(op.moveIssuesTo);
          if (s.statusReference === target.statusReference) throw new OpError(m('moveTargetSame'));
          wf.statuses = wf.statuses.filter((w) => w.statusReference !== s.statusReference);
          const before = wf.transitions.length;
          wf.transitions = wf.transitions
            .map((t) => ({ ...t, links: (t.links || []).filter((l) => l.fromStatusReference !== s.statusReference) }))
            .filter((t) => t.toStatusReference !== s.statusReference && !(t.type === 'DIRECTED' && !(t.links || []).length));
          statusMappings.push({ oldStatusReference: s.id || s.statusReference, newStatusReference: target.id || target.statusReference });
          message = m('removesStatus', { name: s.name, n: before - wf.transitions.length, target: target.name });
          break;
        }
        case 'addTransition': {
          const to = statusByName(op.to);
          const fromList = asList(op.from);
          const global = !fromList.length || fromList.some((f) => lc(f) === 'any' || lc(f) === '*' || lc(f) === 'jeder status');
          const links = global ? [] : fromList.map((f) => ({ fromStatusReference: statusByName(f).statusReference, fromPort: 0, toPort: 0 }));
          if (wf.transitions.some((t) => lc(t.name) === lc(op.name) && t.toStatusReference === to.statusReference)) throw new OpError(m('transitionExists', { name: op.name, to: to.name }));
          wf.transitions.push({
            id: nextId(),
            name: String(op.name).slice(0, 60),
            description: op.description || '',
            type: global ? 'GLOBAL' : 'DIRECTED',
            toStatusReference: to.statusReference,
            links,
            actions: [],
            validators: [],
            triggers: [],
            properties: {},
            conditions: { operation: 'ALL', conditions: [], conditionGroups: [] },
          });
          message = global ? m('globalTransition', { name: op.name, to: to.name }) : m('addsTransition', { name: op.name, from: fromList.join(', '), to: to.name });
          break;
        }
        case 'removeTransition': {
          const name = trName(op.transition);
          const list = transitionsByName(op.transition, { selectors: false });
          if (op.from) {
            const s = statusByName(op.from);
            for (const t of list) t.links = (t.links || []).filter((l) => l.fromStatusReference !== s.statusReference);
            wf.transitions = wf.transitions.filter((t) => !(list.includes(t) && t.type === 'DIRECTED' && !t.links.length));
            message = m('removesFrom', { name, from: s.name });
          } else {
            if (list.some((t) => t.type === 'INITIAL')) throw new OpError(m('cannotRemoveCreate'));
            wf.transitions = wf.transitions.filter((t) => !list.includes(t));
            message = m('removesTransition', { name });
          }
          break;
        }
        case 'renameTransition': {
          const name = trName(op.transition);
          for (const t of transitionsByName(op.transition, { selectors: false })) t.name = String(op.newName).slice(0, 60);
          message = lang === 'de' ? `„${name}“ → „${op.newName}“` : `"${name}" → "${op.newName}"`;
          break;
        }
        case 'addFromStatus': {
          const list = transitionsByName(op.transition);
          const add = asList(op.from).map((f) => statusByName(f));
          for (const t of list) {
            if (t.type !== 'DIRECTED') throw new OpError(m('notDirected', { name: t.name }));
            for (const s of add) if (!t.links.some((l) => l.fromStatusReference === s.statusReference)) t.links.push({ fromStatusReference: s.statusReference, fromPort: 0, toPort: 0 });
          }
          message = m('alsoFrom', { name: trName(op.transition), list: add.map((s) => s.name).join(', ') });
          break;
        }
        case 'restrictTransition': {
          const params = {};
          const groups = asList(op.groups).map((g) => find(ref.groups, g, 'Group', 'groupId'));
          const roles = asList(op.roles).map((r) => find(ref.roles, r, 'Project role'));
          if (groups.length) params.groupIds = groups.map((g) => g.groupId).join(',');
          if (roles.length) params.roleIds = roles.map((r) => r.id).join(',');
          const acc = [op.reporter ? 'allow-reporter' : null, op.assignee ? 'allow-assignee' : null].filter(Boolean);
          if (acc.length) params.accountIds = acc.join(',');
          if (op.permission) params.permissionKeys = String(op.permission).toUpperCase();
          if (!Object.keys(params).length) throw new OpError(m('restrictNeeds'));
          for (const t of transitionsByName(op.transition)) {
            t.conditions ||= { operation: 'ALL', conditions: [], conditionGroups: [] };
            if (t.conditions.operation === 'ANY' && (t.conditions.conditions.length || t.conditions.conditionGroups.length)) {
              t.conditions = { operation: 'ALL', conditions: [], conditionGroups: [t.conditions] };
            }
            t.conditions.conditions.push({ ruleKey: 'system:restrict-issue-transition', parameters: params });
          }
          message = m('onlyWho', { list: [...groups.map((g) => `${label('group')} ${g.name}`), ...roles.map((r) => `${label('role')} ${r.name}`), ...acc.map(label), op.permission].filter(Boolean).join(m('or')) });
          break;
        }
        case 'requireFields': {
          const ids = asList(op.fields).map(fieldId);
          for (const t of transitionsByName(op.transition)) {
            for (const id of ids) t.validators.push({ ruleKey: 'system:validate-field-value', parameters: { ruleType: 'fieldRequired', fieldsRequired: id, ignoreContext: 'true', ...(op.message ? { errorMessage: String(op.message) } : {}) } });
          }
          message = m('required', { list: ids.map((id) => (ref.fields || []).find((f) => f.id === id)?.name || id).join(', ') });
          break;
        }
        case 'setResolution': {
          if (rawWf.scope?.type === 'PROJECT') {
            throw new NoopError(m('tmResolution'));
          }
          const none = /^(none|leer|empty|clear|-)$/i.test(String(op.resolution));
          const res = none ? null : find(ctx.resolutions, op.resolution, 'Resolution');
          for (const t of transitionsByName(op.transition)) {
            t.actions = (t.actions || []).filter((a) => !(a.ruleKey === 'system:update-field' && a.parameters?.field === 'resolution'));
            t.actions.push({ ruleKey: 'system:update-field', parameters: { field: 'resolution', value: none ? '' : String(res.id), mode: 'replace' } });
          }
          message = `${trName(op.transition)}: ${none ? m('clearsResolution') : m('setsResolution', { name: res.name })}`;
          break;
        }
        case 'setAssignee': {
          const v = lc(op.to);
          const type = v === 'current-user' || v === 'current' ? 'to-current-user' : v === 'unassigned' ? 'to-unassigned' : v === 'default' ? 'to-default-user' : 'to-selected-user';
          const params = { type, ...(type === 'to-selected-user' ? { accountId: String(op.to) } : {}) };
          for (const t of transitionsByName(op.transition)) {
            t.actions = (t.actions || []).filter((a) => a.ruleKey !== 'system:change-assignee');
            t.actions.push({ ruleKey: 'system:change-assignee', parameters: params });
          }
          message = m('assignee', { to: op.to });
          break;
        }
        case 'setTransitionScreen': {
          const none = /^(none|keine|-)$/i.test(String(op.screen));
          const scr = none ? null : find(ref.screens, op.screen, 'Screen');
          for (const t of transitionsByName(op.transition)) {
            if (none) delete t.transitionScreen;
            else t.transitionScreen = { ruleKey: 'system:transition-screen', parameters: { screenId: String(scr.id) } };
          }
          message = none ? m('removesScreen') : m('showsScreen', { name: scr.name });
          break;
        }
        case 'removeRule': {
          const mt = lc(op.match);
          let n = 0;
          const keep = (r) => {
            const hay = lc(`${r.ruleKey} ${r.id || ''} ${JSON.stringify(r.parameters || {})}`);
            const hit = hay.includes(mt);
            if (hit) n++;
            return !hit;
          };
          const pruneGroup = (g) => g && { ...g, conditions: (g.conditions || []).filter(keep), conditionGroups: (g.conditionGroups || []).map(pruneGroup) };
          for (const t of transitionsByName(op.transition)) {
            if (!op.kind || op.kind === 'condition') t.conditions = pruneGroup(t.conditions);
            if (!op.kind || op.kind === 'validator') t.validators = (t.validators || []).filter(keep);
            if (!op.kind || op.kind === 'postfunction') t.actions = (t.actions || []).filter(keep);
          }
          if (!n) throw new OpError(m('noRuleMatch', { match: op.match, name: trName(op.transition) }));
          message = `${trName(op.transition)}: ${m('removesRules', { n })}`;
          break;
        }
        case 'removeReference':
        case 'replaceReference': {
          const type = op.refType;
          const list = type === 'group' ? ref.groups : type === 'role' ? ref.roles : ref.users;
          const lookup = (v) => (list || []).find((e) => lc(e.name) === lc(v) || lc(e.displayName) === lc(v) || lc(e.groupId || e.id || e.accountId) === lc(v));
          const hit = lookup(op.ref);
          const id = String(hit ? hit.groupId || hit.accountId || hit.id : op.ref);
          const name = String(hit ? hit.name || hit.displayName : op.ref);
          let toId = null;
          let toName = null;
          if (op.op === 'replaceReference') {
            const target = lookup(op.with);
            if (!target) throw new OpError(m('replacementNotFound', { type: label(type), name: op.with }));
            toId = String(target.groupId || target.accountId || target.id);
            toName = String(target.name || target.displayName);
            if (toId === id) throw new OpError(m('replacementSame'));
          }
          const n = rewriteReferences(wf, { type, id, name, toId, toName });
          if (!n) throw new NoopError(m('refNotUsed', { type: label(type), name, wf: wf.name }));
          message = op.op === 'replaceReference' ? m('replacesRef', { type: label(type), name, to: toName, n }) : m('removesRef', { type: label(type), name, n });
          break;
        }
        default:
          throw new OpError(m('unsupported', { op: op.op }));
      }
      results.push({ op, ok: true, message });
    } catch (e) {
      if (e instanceof NoopError) results.push({ op, ok: true, noop: true, message: e.message });
      else results.push({ op, ok: false, message: e instanceof OpError ? e.message : String(e?.message || e) });
    }
  }
  return { workflow: wf, newStatuses, statusMappings, results };
}

/** Dry run: apply ops to a copy of the bundle and compare analyses. */
export function dryRun(bundle, workflowId, ops, extra = {}) {
  const raw = bundle.workflows.find((w) => String(w.id) === String(workflowId));
  if (!raw) throw new Error('Workflow not found in bundle');
  const res = applyOperations(raw, ops, { statuses: bundle.statuses, ref: bundle.ref, resolutions: extra.resolutions || bundle.ref?.resolutions || [], lang: extra.lang });
  const after = clone(bundle);
  after.workflows = after.workflows.map((w) => (String(w.id) === String(workflowId) ? res.workflow : w));
  after.statuses = [...after.statuses, ...res.newStatuses.map((s) => ({ id: s.statusReference, name: s.name, statusCategory: s.statusCategory, statusReference: s.statusReference }))];
  const mBefore = normalize(bundle);
  const mAfter = normalize(after);
  const keep = (m) => ({ ...m, workflows: m.workflows.filter((w) => String(w.id) === String(workflowId)) });
  const changes = diffSnapshots(makeSnapshot(keep(mBefore)), makeSnapshot(keep(mAfter)));
  const fpB = new Map(mBefore.findings.filter((f) => f.wfId === String(workflowId)).map((f) => [findingFingerprint(f), f]));
  const fpA = new Map(mAfter.findings.filter((f) => f.wfId === String(workflowId)).map((f) => [findingFingerprint(f), f]));
  return {
    ...res,
    changes,
    healthBefore: mBefore.stats.healthScore,
    healthAfter: mAfter.stats.healthScore,
    fixed: [...fpB].filter(([k]) => !fpA.has(k)).map(([, f]) => f),
    introduced: [...fpA].filter(([k]) => !fpB.has(k)).map(([, f]) => f),
  };
}

const hasConditions = (g) => !!g && ((g.conditions || []).length > 0 || (g.conditionGroups || []).some(hasConditions));

/** Jira payload for POST /rest/api/3/workflows/update (and /validation). */
export function buildUpdatePayload(rawWf, { siteStatuses = [], newStatuses = [], statusMappings = [], projectStatusMappings = [] } = {}) {
  const byRef = new Map(siteStatuses.map((s) => [s.statusReference, s]));
  const statuses = rawWf.statuses.map((ws) => {
    const n = newStatuses.find((x) => x.statusReference === ws.statusReference);
    if (n) return { name: n.name, statusCategory: n.statusCategory, statusReference: n.statusReference, ...(n.description ? { description: n.description } : {}) };
    const s = byRef.get(ws.statusReference);
    // Statuses are global: always send the description back, otherwise Jira would clear it on every project
    return { id: s?.id, name: s?.name, statusCategory: s?.statusCategory, statusReference: ws.statusReference, ...(s?.description != null ? { description: s.description } : {}) };
  });
  // Jira validates status migrations against the payload's status list: removed statuses must stay listed
  const migrationRefs = [...statusMappings, ...projectStatusMappings.flatMap((m) => m.statusMigrations || [])].map((m) => String(m.oldStatusReference));
  for (const ref of migrationRefs) {
    if (statuses.some((s) => s.statusReference === ref)) continue;
    const s = byRef.get(ref) || siteStatuses.find((x) => String(x.id) === ref);
    if (s) statuses.push({ id: s.id, name: s.name, statusCategory: s.statusCategory, statusReference: s.statusReference || ref, ...(s.description != null ? { description: s.description } : {}) });
  }
  const strip = (r) => (r ? { ruleKey: r.ruleKey, parameters: r.parameters || {}, ...(r.id ? { id: r.id } : {}) } : undefined);
  const stripGroup = (g) => ({ operation: g?.operation || 'ALL', conditions: (g?.conditions || []).map(strip), conditionGroups: (g?.conditionGroups || []).map(stripGroup) });
  return {
    statuses,
    workflows: [
      {
        id: rawWf.id,
        version: rawWf.version,
        description: rawWf.description,
        startPointLayout: rawWf.startPointLayout,
        loopedTransitionContainerLayout: rawWf.loopedTransitionContainerLayout,
        statuses: rawWf.statuses.map((s) => ({ statusReference: s.statusReference, properties: s.properties || {}, ...(s.layout ? { layout: s.layout } : {}), ...(s.approvalConfiguration ? { approvalConfiguration: s.approvalConfiguration } : {}), ...(s.deprecated != null ? { deprecated: s.deprecated } : {}) })),
        transitions: rawWf.transitions.map((t) => ({
          id: String(t.id),
          name: t.name,
          description: t.description || '',
          type: t.type,
          toStatusReference: t.toStatusReference,
          links: t.links || [],
          properties: t.properties || {},
          ...(t.customIssueEventId ? { customIssueEventId: t.customIssueEventId } : {}),
          // Jira rejects any conditions block on the initial transition, and empty groups are noise
          ...(t.type !== 'INITIAL' && hasConditions(t.conditions) ? { conditions: stripGroup(t.conditions) } : {}),
          validators: (t.validators || []).map(strip),
          actions: (t.actions || []).map(strip),
          triggers: (t.triggers || []).map(strip),
          ...(t.transitionScreen ? { transitionScreen: strip(t.transitionScreen) } : {}),
        })),
        // Jira requires explicit mappings per project + issue type when an active workflow loses a status
        ...(projectStatusMappings.length ? { statusMappings: projectStatusMappings } : {}),
      },
    ],
  };
}

// A rejected or cancelled issue is not "Done": pick the resolution that says what happened, when the site has one
// (resolution patterns in order of preference)
const OUTCOMES = [
  { when: /duplic|duplikat/i, res: [/^(duplicate|duplikat)/i] },
  { when: /reject|declin|ablehn|abgelehnt|nicht genehmigt|not approved|won'?t|invalid|ungültig/i, res: [/^(declined|rejected|abgelehnt)/i, /^(won'?t (do|fix)|wird nicht (erledigt|behoben)|nicht erledigt)/i] },
  { when: /cancel|abbr|abgebrochen|storn|withdraw|zurückgezogen|obsolete|obsolet/i, res: [/^(cancel|abgebrochen|storniert)/i, /^(won'?t do|wird nicht erledigt)/i, /^(declined|abgelehnt)/i] },
];
export function resolutionFor(tr, resolutions, fallback) {
  const said = `${tr?.to?.name || ''} ${tr?.name || ''}`;
  for (const o of OUTCOMES) {
    if (!o.when.test(said)) continue;
    for (const re of o.res) {
      const hit = (resolutions || []).find((r) => re.test(String(r.name || '').trim()));
      if (hit) return hit;
    }
  }
  return fallback;
}

/** Deterministic auto-fix operations for health findings. Returns { ops, manual: findings without auto-fix }. */
export function autofixOperations(model, findings, resolutions = []) {
  const ops = [];
  const manual = [];
  const done = (resolutions || []).find((r) => /^(done|fertig|erledigt|behoben|fixed)$/i.test(r.name)) || resolutions[0];
  const seen = new Set();
  const push = (o) => {
    const k = JSON.stringify(o);
    if (!seen.has(k)) { seen.add(k); ops.push(o); }
  };
  for (const f of findings) {
    if (f.severity === 'info') continue;
    const wf = model.workflows.find((w) => w.id === f.wfId);
    const tr = wf?.transitions.find((t) => t.key === f.tKey);
    switch (f.code) {
      case 'DONE_NO_RESOLUTION':
        if (tr && done) push({ op: 'setResolution', transition: tr.id, resolution: resolutionFor(tr, resolutions, done).name, _wf: f.wfId, _f: f.id });
        else manual.push(f);
        break;
      case 'REOPEN_KEEPS_RESOLUTION':
        if (tr) push({ op: 'setResolution', transition: tr.id, resolution: 'none', _wf: f.wfId, _f: f.id });
        break;
      case 'UNRESOLVED_REF':
        if (['group', 'role', 'user'].includes(f.params?.type) && f.vendor === 'Jira' && f.ruleKind !== 'property') push({ op: 'removeReference', refType: f.params.type, ref: f.params.id, _wf: f.wfId, _f: f.id });
        else manual.push(f);
        break;
      case 'INACTIVE_USER':
        if (f.vendor === 'Jira' && f.ruleKind !== 'property') push({ op: 'removeReference', refType: 'user', ref: f.params.id, _wf: f.wfId, _f: f.id });
        else manual.push(f);
        break;
      case 'DISABLED_RULE':
        if (tr && f.ruleId) push({ op: 'removeRule', transition: tr.id, match: f.ruleId, _wf: f.wfId, _f: f.id });
        else manual.push(f);
        break;
      default:
        manual.push(f);
    }
  }
  return { ops, manual };
}

/**
 * Status migrations needed when going from workflow `current` to `target` (statuses that disappear).
 * Each removed status is mapped to a status of the target workflow: the source of a transition that
 * led into it, otherwise the initial status.
 */
export function removedStatusMigrations(current, target) {
  const keep = new Set((target.statuses || []).map((s) => s.statusReference));
  const removed = (current.statuses || []).map((s) => s.statusReference).filter((r) => !keep.has(r));
  const initial = (target.transitions || []).find((t) => t.type === 'INITIAL')?.toStatusReference || [...keep][0];
  return removed.map((ref) => {
    const into = (current.transitions || []).find((t) => t.toStatusReference === ref && (t.links || []).some((l) => keep.has(l.fromStatusReference)));
    const back = into ? into.links.find((l) => keep.has(l.fromStatusReference)).fromStatusReference : initial;
    return { oldStatusReference: ref, newStatusReference: back };
  });
}
