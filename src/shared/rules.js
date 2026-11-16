/**
 * Catalogue of Jira Cloud workflow rules (new workflow API format) and helpers that extract the configuration
 * objects a rule depends on (groups, roles, fields, users, screens), including references inside app
 * configurations and transition/status properties.
 *
 * @file        src/shared/rules.js
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-24
 * @updated     2026-11-05
 */

export const SYSTEM_RULES = {
  // Validators
  'system:check-permission-validator': { kind: 'validator', name: 'rule.permissionValidator' },
  'system:parent-or-child-blocking-validator': { kind: 'validator', name: 'rule.parentBlockingValidator' },
  'system:previous-status-validator': { kind: 'validator', name: 'rule.previousStatusValidator' },
  'system:validate-field-value': { kind: 'validator', name: 'rule.validateFieldValue' },
  'system:proforma-forms-attached': { kind: 'validator', name: 'rule.formsAttached' },
  'system:proforma-forms-submitted': { kind: 'validator', name: 'rule.formsSubmitted' },
  // Conditions
  'system:check-field-value': { kind: 'condition', name: 'rule.checkFieldValue' },
  'system:restrict-issue-transition': { kind: 'condition', name: 'rule.restrictIssueTransition' },
  'system:previous-status-condition': { kind: 'condition', name: 'rule.previousStatusCondition' },
  'system:parent-or-child-blocking-condition': { kind: 'condition', name: 'rule.childBlockingCondition' },
  'system:separation-of-duties': { kind: 'condition', name: 'rule.separationOfDuties' },
  'system:restrict-from-all-users': { kind: 'condition', name: 'rule.restrictFromAllUsers' },
  'system:jsd-approvals-block-until-approved': { kind: 'condition', name: 'rule.blockUntilApproved' },
  'system:jsd-approvals-block-until-rejected': { kind: 'condition', name: 'rule.blockUntilRejected' },
  'system:block-in-progress-approval': { kind: 'condition', name: 'rule.blockInProgressApproval' },
  // Post functions
  'system:change-assignee': { kind: 'postfunction', name: 'rule.changeAssignee' },
  'system:copy-value-from-other-field': { kind: 'postfunction', name: 'rule.copyField' },
  'system:update-field': { kind: 'postfunction', name: 'rule.updateField' },
  'system:trigger-webhook': { kind: 'postfunction', name: 'rule.triggerWebhook' },
  'system:trigger-agent': { kind: 'postfunction', name: 'rule.triggerAgent' },
  // Screens
  'system:remind-people-to-update-fields': { kind: 'screen', name: 'rule.remindFields' },
  'system:transition-screen': { kind: 'screen', name: 'rule.transitionScreen' },
  // Triggers
  'system:development-triggers': { kind: 'trigger', name: 'rule.devTriggers' },
};

export const ECOSYSTEM_RULES = {
  'connect:expression-validator': { kind: 'validator', name: 'rule.appValidator' },
  'connect:expression-condition': { kind: 'condition', name: 'rule.appCondition' },
  'connect:remote-workflow-function': { kind: 'postfunction', name: 'rule.appPostFunction' },
  'forge:expression-validator': { kind: 'validator', name: 'rule.appValidator' },
  'forge:expression-condition': { kind: 'condition', name: 'rule.appCondition' },
  'forge:workflow-post-function': { kind: 'postfunction', name: 'rule.appPostFunction' },
};

export const REF_TYPES = ['app', 'group', 'role', 'field', 'user', 'screen', 'status', 'permission', 'webhook'];

const ACCOUNT_ID_RE = /^(?:\d{5,6}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{24})$/i;
const ACCOUNT_ID_IN_TEXT_RE = /\b(\d{5,6}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CUSTOMFIELD_RE = /\bcustomfield_\d+\b/g;

export const isAccountId = (v) => ACCOUNT_ID_RE.test(String(v || '').trim());
export const isUuid = (v) => UUID_RE.test(String(v || '').trim());

export function splitList(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.flatMap(splitList);
  const s = String(v).trim();
  if (!s) return [];
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) return arr.map(String);
    } catch { /* not JSON */ }
  }
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}

// Generic parameter-name based reference extraction. Works for every documented
// system rule and is robust to new rules that follow the same naming conventions.
const PARAM_REF_PATTERNS = [
  { re: /^(groupIds|groupsExemptFromValidation|groups?|groupId)$/i, type: 'group' },
  { re: /^(roleIds|roleId|roles?)$/i, type: 'role' },
  { re: /^(accountIds|accountId|agentId|userIds?)$/i, type: 'user' },
  { re: /^(fieldsRequired|fieldKey|fieldId|field|sourceFieldKey|targetFieldKey|date1FieldKey|date2FieldKey|remindingFieldIds|groupCustomFields|allowUserCustomFields|denyUserCustomFields)$/i, type: 'field' },
  { re: /^(statusIds|previousStatusIds|fromStatusId|toStatusId|statusId)$/i, type: 'status' },
  { re: /^(permissionKeys|permissionKey)$/i, type: 'permission' },
  { re: /^screenId$/i, type: 'screen' },
  { re: /^webhookId$/i, type: 'webhook' },
];

const PSEUDO_USERS = new Set(['allow-assignee', 'allow-reporter', 'assignee', 'reporter', 'currentUser', 'current-user']);

export function refsFromSystemParams(params = {}) {
  const out = [];
  for (const [k, v] of Object.entries(params || {})) {
    const p = PARAM_REF_PATTERNS.find((x) => x.re.test(k));
    if (!p) {
      // e.g. update-field "assignee" = <accountId>
      for (const id of splitList(v)) if (isAccountId(id)) out.push({ type: 'user', id, via: k });
      continue;
    }
    for (const id of splitList(v)) {
      if (p.type === 'user' && PSEUDO_USERS.has(id)) continue;
      out.push({ type: p.type, id, via: k });
    }
  }
  return out;
}

// Parse connect/forge `config` payloads which are stringified JSON (sometimes nested).
export function parseConfig(config) {
  if (config == null || config === '') return null;
  if (typeof config === 'object') return config;
  let cur = config;
  for (let i = 0; i < 3 && typeof cur === 'string'; i++) {
    const s = cur.trim();
    if (!(s.startsWith('{') || s.startsWith('[') || s.startsWith('"'))) break;
    try { cur = JSON.parse(s); } catch { break; }
  }
  return typeof cur === 'string' ? { value: cur } : cur;
}

function walk(obj, visit, path = []) {
  if (obj == null) return;
  if (Array.isArray(obj)) { obj.forEach((v, i) => walk(v, visit, [...path, i])); return; }
  if (typeof obj === 'object') { for (const [k, v] of Object.entries(obj)) walk(v, visit, [...path, k]); return; }
  visit(obj, path);
}

const EXPR_KEY_RE = /(expression|script|condition|jql|template|code|groovy|nunjucks|formula|value|text)$/i;
const MSG_KEY_RE = /(message|error|errorText|errorMsg)$/i;

/**
 * Inspect a third-party (Connect/Forge) rule configuration.
 * Returns readable details, expressions and references.
 * @param {object} cfg parsed config
 * @param {object} lookups { groupsByName: Map, groupsById: Map, roleIds:Set, roleNames:Map, statusIds:Set }
 */
export function inspectAppConfig(cfg, lookups = {}) {
  const details = [];
  const expressions = [];
  const messages = [];
  const refs = [];
  if (!cfg || typeof cfg !== 'object') return { details, expressions, messages, refs };

  const seen = new Set();
  const addRef = (type, id, via) => {
    const key = `${type}|${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ type, id: String(id), via });
  };

  const groupsByName = lookups.groupsByName || new Map();
  const groupsById = lookups.groupsById || new Map();
  const groupNames = [...groupsByName.keys()].filter((n) => n.length >= 4);

  walk(cfg, (val, path) => {
    const key = String(path[path.length - 1] ?? '');
    const parentKey = String(path.filter((p) => typeof p === 'string').pop() || '');
    if (typeof val === 'boolean' || typeof val === 'number') {
      if (/role/i.test(parentKey) && typeof val === 'number') addRef('role', val, parentKey);
      if (/status/i.test(parentKey) && typeof val === 'number') addRef('status', val, parentKey);
      return;
    }
    const s = String(val);
    if (!s) return;

    for (const m of s.match(CUSTOMFIELD_RE) || []) addRef('field', m, parentKey);
    if (isAccountId(s)) addRef('user', s, parentKey);
    else for (const m of s.matchAll(ACCOUNT_ID_IN_TEXT_RE)) addRef('user', m[1], parentKey);

    if (isUuid(s) && groupsById.has(s)) addRef('group', s, parentKey);
    else if (isUuid(s) && /group/i.test(parentKey)) addRef('group', s, parentKey);
    if (groupsByName.has(s)) addRef('group', groupsByName.get(s), parentKey);
    else if (/group/i.test(parentKey) && !isUuid(s) && s.length <= 120 && !/\s{2,}|[{}()=]/.test(s)) {
      // Group referenced by name that does not exist (anymore) on this site
      for (const n of splitList(s)) if (groupsByName.has(n)) addRef('group', groupsByName.get(n), parentKey); else addRef('group', `name:${n}`, parentKey);
    } else if (s.length > 12) {
      for (const n of groupNames) {
        const i = s.indexOf(n);
        if (i < 0) continue;
        const before = s[i - 1];
        const after = s[i + n.length];
        const boundary = (ch) => ch === undefined || !/[\w.-]/.test(ch);
        if (boundary(before) && boundary(after)) addRef('group', groupsByName.get(n), parentKey);
      }
    }
    if (/role/i.test(parentKey) && /^\d+$/.test(s)) addRef('role', s, parentKey);
    if (/status/i.test(parentKey) && /^\d+$/.test(s)) addRef('status', s, parentKey);
    if (/^(field|fieldId|fieldKey|targetField|sourceField)$/i.test(parentKey) && /^[a-z]+$/i.test(s)) addRef('field', s, parentKey);

    if (isAccountId(s) || isUuid(s)) return; // shown as reference chip
    const isLong = s.length > 40 || /\{\{|\}\}|issue\.|\n|&&|\|\|/.test(s);
    if (MSG_KEY_RE.test(key) && !isLong) messages.push(s);
    else if (MSG_KEY_RE.test(key)) messages.push(s);
    else if (isLong && (EXPR_KEY_RE.test(parentKey) || /\{\{|issue\.|&&|\|\||==/.test(s))) expressions.push({ key: parentKey, code: s });
    else if (details.length < 14 && s.length <= 200 && !/^(id|tag|appKey|key)$/i.test(key)) {
      details.push({ label: path.filter((p) => typeof p === 'string').slice(-2).join('.'), value: s });
    }
  });

  return { details, expressions, messages, refs };
}

// Workflow / status properties (e.g. jira.permission.edit.group = jira-administrators,
// jira.permission.assignable.projectrole = 10002) can reference groups, roles, users and fields.
const PROPERTY_SKIP = /^jira\.(i18n|issue\.editable|field\.resolution)/i;

export function refsFromProperties(props = {}, lookups = {}) {
  const out = [];
  const groupsByName = lookups.groupsByName || new Map();
  const groupsById = lookups.groupsById || new Map();
  for (const [key, raw] of Object.entries(props || {})) {
    if (PROPERTY_SKIP.test(key) || raw == null) continue;
    const k = key.toLowerCase();
    const values = splitList(raw);
    if (/group/.test(k)) {
      for (const v of values) {
        if (groupsByName.has(v)) out.push({ type: 'group', id: groupsByName.get(v), via: key });
        else if (groupsById.has(v) || isUuid(v)) out.push({ type: 'group', id: v, via: key });
        else out.push({ type: 'group', id: `name:${v}`, via: key });
      }
      continue;
    }
    if (/projectrole|\.role/.test(k)) {
      for (const v of values) if (/^\d+$/.test(v)) out.push({ type: 'role', id: v, via: key });
      continue;
    }
    const s = String(raw);
    for (const m of s.match(CUSTOMFIELD_RE) || []) out.push({ type: 'field', id: m, via: key });
    for (const v of values) if (isAccountId(v)) out.push({ type: 'user', id: v, via: key });
  }
  return out;
}
