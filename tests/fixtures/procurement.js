/**
 * Realistic test bundle modelled on a German procurement workflow (the legacy "IDE" export), in the shape
 * returned by src/lib/jira.js getProjectBundle. Used by the unit tests and the mock UI.
 *
 * @file        tests/fixtures/procurement.js
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-24
 * @updated     2026-11-05
 */

const G_PROC = '8b1e2c10-1111-4a7b-9b6e-0a0000000001';
const G_WGB = '8b1e2c10-2222-4a7b-9b6e-0a0000000002';
const G_RECHT = '8b1e2c10-3333-4a7b-9b6e-0a0000000003';
const G_DELETED = '8b1e2c10-dead-4a7b-9b6e-0a00000000ff';
const U_RENE = '712020:47fcf721-d7be-4162-97c1-8afe796ad49b';
const U_BERNAR = '712020:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const JMWE = 'com.innovalog.jmwe.jira-cloud';
const SR = 'com.onresolve.jira.groovy.groovyrunner';
const WE = 'com.decadis.jira.workflow-enhancer';
const JSU = 'com.beecom.jsu-cloud';

const st = (id, name, cat) => ({ id: String(id), name, statusCategory: cat, statusReference: `ref-${id}`, scope: { type: 'GLOBAL' } });
const R = (id) => `ref-${id}`;
const link = (...ids) => ids.map((id) => ({ fromStatusReference: R(id), fromPort: 0, toPort: 1 }));
const restrict = (p) => ({ ruleKey: 'system:restrict-issue-transition', parameters: p });
const connect = (ruleKey, appKey, config, extra = {}) => ({ ruleKey, parameters: { appKey, config: typeof config === 'string' ? config : JSON.stringify(config), id: Math.random().toString(16).slice(2), disabled: 'false', tag: '', ...extra } });
const resolution = (v = '10000') => ({ ruleKey: 'system:update-field', parameters: { field: 'resolution', value: v, mode: 'replace' } });

const statuses = [
  st(10289, 'Bedarfsanfrage stellen', 'TODO'),
  st(10288, 'Freigabe notwendig', 'IN_PROGRESS'),
  st(10290, 'Lagerbestand prüfen', 'IN_PROGRESS'),
  st(10291, 'Ist lagernd', 'IN_PROGRESS'),
  st(10292, 'Bestellung notwendig', 'IN_PROGRESS'),
  st(10302, 'Angebote einholen', 'IN_PROGRESS'),
  st(10338, 'GB-Erstellung', 'IN_PROGRESS'),
  st(10640, 'GB-Kontrolle', 'IN_PROGRESS'),
  st(10339, 'GB-Klärung', 'IN_PROGRESS'),
  st(10341, 'GB-Unterzeichnung', 'IN_PROGRESS'),
  st(10300, 'Geschaeftsleitung Pruefung', 'IN_PROGRESS'),
  st(10286, 'Bestellung abgeschlossen', 'DONE'),
  st(10287, 'Ware geliefert', 'DONE'),
  st(10301, 'Nicht genehmigt', 'DONE'),
  st(10999, 'Archiv', 'TODO'),
  st(1, 'To Do', 'TODO'),
  st(3, 'In Progress', 'IN_PROGRESS'),
  st(10001, 'Done', 'DONE'),
];

const wfStatus = (id, x, y) => ({ statusReference: R(id), layout: x != null ? { x, y } : undefined, properties: {}, deprecated: false });

const procurement = {
  id: 'b7a1d1c0-0000-4000-8000-000000000001',
  name: 'IDE: Bedarfsworkflow',
  description: 'Bestellprozess für IT-Bedarfe',
  version: { id: 'v1', versionNumber: 42 },
  scope: { type: 'GLOBAL' },
  isEditable: true,
  created: '2024-03-01T08:00:00.000+0000',
  updated: '2026-09-30T14:12:00.000+0000',
  statuses: [10289, 10288, 10290, 10291, 10292, 10302, 10338, 10640, 10339, 10341, 10300, 10286, 10287, 10301, 10999].map((id) => wfStatus(id)),
  transitions: [
    {
      id: '1', name: 'Create', type: 'INITIAL', toStatusReference: R(10289), links: [],
      validators: [
        { ruleKey: 'system:check-permission-validator', parameters: { permissionKey: 'CREATE_ISSUES' } },
        { ruleKey: 'system:validate-field-value', parameters: { ruleType: 'fieldRequired', fieldsRequired: 'customfield_10904', ignoreContext: 'true', errorMessage: 'Please enter a Product Owner' } },
        { ruleKey: 'system:validate-field-value', parameters: { ruleType: 'fieldRequired', fieldsRequired: 'customfield_11370', ignoreContext: 'false' } },
        connect('connect:expression-validator', WE, { expression: 'if (app.license == null || app.license.active == true) { issue.customfield_11271 != null && issue.customfield_11271.toLowerCase().match("ja|nein") != null } else { false }', errorMessage: 'Im Feld Standard Sortiment muss Ja oder Nein stehen.' }),
        connect('connect:expression-validator', WE, { expression: "if (app.license == null || app.license.active == true) { (issue.customfield_11420 != null && issue.customfield_11420.value == \"B - Betrieb/Operations\" && ('[' + user.groups.join(', ') + ']').match(\"unit.jira-buy-warengruppe-b\") != null) || (issue.customfield_11420 != null && issue.customfield_11420.value != \"B - Betrieb/Operations\") } else { false }", errorMessage: 'Bestellungen fuer die Materialgruppe B können nur von der Warengruppe B durchgeführt werden' }),
      ],
      actions: [
        connect('connect:remote-workflow-function', JMWE, { name: 'Set Field Value', field: 'assignee', value: U_RENE, conditionalExecution: '{{ issue.fields.customfield_11420.value not in ["A - Arbeitsplatz", "C1 - SaaS/Cloud-Dienst"] }}', runAs: 'currentUser' }),
        connect('connect:remote-workflow-function', JMWE, { name: 'Set Field Value', field: 'assignee', value: U_BERNAR, conditionalExecution: '{{ issue.fields.customfield_11420.value in ["A - Arbeitsplatz", "C1 - SaaS/Cloud-Dienst"] }}', runAs: 'currentUser' }),
        connect('connect:remote-workflow-function', SR, '', { disabled: 'true' }),
      ],
      conditions: { operation: 'ALL', conditions: [], conditionGroups: [] },
    },
    {
      id: '11', name: 'Zur Freigabe', type: 'DIRECTED', toStatusReference: R(10288), links: link(10289),
      validators: [connect('connect:expression-validator', JSU, { name: 'Fields Required', fields: ['customfield_11271', 'customfield_11420'], errorMessage: 'Sortiment und Warengruppe angeben' })],
      actions: [], conditions: { operation: 'ALL', conditions: [], conditionGroups: [] },
    },
    {
      id: '21', name: 'Freigeben', type: 'DIRECTED', toStatusReference: R(10290), links: link(10288),
      conditions: { operation: 'ALL', conditions: [restrict({ groupIds: G_PROC, roleIds: '10002' })], conditionGroups: [] },
      validators: [], actions: [{ ruleKey: 'system:change-assignee', parameters: { type: 'to-current-user' } }],
    },
    {
      id: '31', name: 'Ist lagernd', type: 'DIRECTED', toStatusReference: R(10291), links: link(10290),
      conditions: { operation: 'ALL', conditions: [], conditionGroups: [] }, validators: [], actions: [],
    },
    {
      id: '41', name: 'Bestellen', type: 'DIRECTED', toStatusReference: R(10292), links: link(10290),
      conditions: { operation: 'ALL', conditions: [], conditionGroups: [] }, validators: [], actions: [],
    },
    {
      id: '51', name: 'Angebote einholen', type: 'DIRECTED', toStatusReference: R(10302), links: link(10292),
      conditions: { operation: 'ALL', conditions: [restrict({ groupIds: G_DELETED })], conditionGroups: [] }, validators: [], actions: [],
    },
    {
      id: '61', name: 'GB erstellen', type: 'DIRECTED', toStatusReference: R(10338), links: link(10302),
      conditions: { operation: 'ALL', conditions: [], conditionGroups: [] }, validators: [], actions: [],
    },
    {
      id: '71', name: 'Zur GB-Kontrolle', type: 'DIRECTED', toStatusReference: R(10640), links: link(10338),
      conditions: { operation: 'ALL', conditions: [], conditionGroups: [] }, validators: [], actions: [],
      transitionScreen: { ruleKey: 'system:transition-screen', parameters: { screenId: '10050' } },
    },
    {
      id: '1931', name: 'GB prüfen', type: 'DIRECTED', toStatusReference: R(10339), links: link(10640),
      conditions: { operation: 'ALL', conditions: [restrict({ groupIds: G_RECHT })], conditionGroups: [] },
      validators: [], actions: [{ ruleKey: 'system:change-assignee', parameters: { type: 'to-selected-user', accountId: U_RENE } }],
    },
    {
      id: '2511', name: 'GB OK', type: 'DIRECTED', toStatusReference: R(10341), links: link(10640),
      conditions: {
        operation: 'ALL',
        conditions: [restrict({ groupIds: G_PROC })],
        conditionGroups: [{ operation: 'ANY', conditions: [restrict({ groupIds: G_RECHT }), restrict({ accountIds: 'allow-reporter' })], conditionGroups: [] }],
      },
      validators: [], actions: [{ ruleKey: 'system:update-field', parameters: { field: 'assignee', value: U_BERNAR, mode: 'replace' } }],
    },
    {
      id: '2521', name: 'zurück GB Erstellung', type: 'DIRECTED', toStatusReference: R(10338), links: link(10640, 10339),
      conditions: { operation: 'ALL', conditions: [restrict({ groupIds: `${G_RECHT},${G_PROC}` })], conditionGroups: [] }, validators: [], actions: [],
    },
    {
      id: '81', name: 'Zur Geschäftsleitung', type: 'DIRECTED', toStatusReference: R(10300), links: link(10341),
      conditions: { operation: 'ALL', conditions: [{ ruleKey: 'system:separation-of-duties', parameters: { fromStatusId: '10640', toStatusId: '10341' } }], conditionGroups: [] },
      validators: [{ ruleKey: 'system:previous-status-validator', parameters: { previousStatusIds: '10640', mostRecentStatusOnly: 'false' } }],
      actions: [],
    },
    {
      id: '91', name: 'Bestellung abschließen', type: 'DIRECTED', toStatusReference: R(10286), links: link(10300),
      conditions: { operation: 'ALL', conditions: [{ ruleKey: 'system:check-field-value', parameters: { fieldId: 'customfield_10996', fieldValue: '["Keine"]', comparator: '!=', comparisonType: 'OPTIONID' } }], conditionGroups: [] },
      validators: [], actions: [resolution()],
    },
    {
      id: '101', name: 'Ware geliefert', type: 'DIRECTED', toStatusReference: R(10287), links: link(10291, 10286),
      conditions: { operation: 'ALL', conditions: [], conditionGroups: [] }, validators: [], actions: [],
    },
    {
      id: '901', name: 'Ablehnen', type: 'GLOBAL', toStatusReference: R(10301), links: [],
      conditions: { operation: 'ALL', conditions: [], conditionGroups: [] }, validators: [], actions: [],
    },
  ],
};

const bug = {
  id: 'b7a1d1c0-0000-4000-8000-000000000002',
  name: 'IDE: Bug Workflow',
  description: '',
  version: { id: 'v2', versionNumber: 3 },
  scope: { type: 'GLOBAL' },
  isEditable: true,
  updated: '2026-08-01T10:00:00.000+0000',
  statuses: [wfStatus(1, 0, 0), wfStatus(3, 260, 0), wfStatus(10001, 520, 0)],
  transitions: [
    { id: '1', name: 'Create', type: 'INITIAL', toStatusReference: R(1), links: [], conditions: { operation: 'ALL', conditions: [], conditionGroups: [] }, validators: [], actions: [] },
    { id: '11', name: 'Start', type: 'DIRECTED', toStatusReference: R(3), links: link(1), conditions: { operation: 'ALL', conditions: [], conditionGroups: [] }, validators: [], actions: [{ ruleKey: 'system:change-assignee', parameters: { type: 'to-current-user' } }] },
    { id: '21', name: 'Done', type: 'DIRECTED', toStatusReference: R(10001), links: link(3), customIssueEventId: '4', conditions: { operation: 'ALL', conditions: [], conditionGroups: [] }, validators: [], actions: [resolution()] },
    { id: '31', name: 'Reopen', type: 'DIRECTED', toStatusReference: R(1), links: link(10001), conditions: { operation: 'ALL', conditions: [], conditionGroups: [] }, validators: [], actions: [resolution('')] },
  ],
};

export function makeProcurementBundle() {
  return {
    kind: 'project',
    generatedAt: '2026-10-21T12:00:00.000Z',
    site: { baseUrl: 'https://superportdev.atlassian.net' },
    project: { id: '10100', key: 'IDE', name: 'IT-Bedarf', style: 'classic' },
    issueTypes: [
      { id: '10001', name: 'Bedarf' },
      { id: '10002', name: 'Unteraufgabe', subtask: true },
      { id: '10003', name: 'Bug' },
    ],
    mapping: [
      { issueTypeId: '10001', workflowId: procurement.id },
      { issueTypeId: '10002', workflowId: procurement.id },
      { issueTypeId: '10003', workflowId: bug.id },
    ],
    workflows: [JSON.parse(JSON.stringify(procurement)), JSON.parse(JSON.stringify(bug))],
    statuses,
    ref: {
      fields: [
        { id: 'assignee', name: 'Assignee', custom: false },
        { id: 'resolution', name: 'Resolution', custom: false },
        { id: 'description', name: 'Description', custom: false },
        { id: 'customfield_10904', name: 'Product Owner/ Projektverantw.', custom: true },
        { id: 'customfield_11370', name: 'Vorgang für Kst.', custom: true },
        { id: 'customfield_11271', name: 'Standard Sortiment', custom: true },
        { id: 'customfield_11420', name: 'Warengruppe', custom: true },
        { id: 'customfield_10996', name: 'GB erforderlich?', custom: true },
      ],
      groups: [
        { groupId: G_PROC, name: 'Procurement' },
        { groupId: G_WGB, name: 'unit.jira-buy-warengruppe-b' },
        { groupId: G_RECHT, name: 'recht' },
        { groupId: '8b1e2c10-4444-4a7b-9b6e-0a0000000004', name: 'jira-admins' },
      ],
      roles: [{ id: '10002', name: 'Administrators' }, { id: '10001', name: 'Developers' }],
      users: [
        { accountId: U_RENE, displayName: 'René Kusserow', active: true },
        { accountId: U_BERNAR, displayName: 'Bernar Bonkowski', active: false },
      ],
      screens: [{ id: '10050', name: 'GB Prüfmaske' }],
      resolutions: [{ id: '10000', name: 'Done' }, { id: '10001', name: "Won't Do" }],
      permissions: { CREATE_ISSUES: { name: 'Create issues' }, ADMINISTER_PROJECTS: { name: 'Administer projects' } },
      capabilities: {
        systemRules: [],
        connectRules: [
          { addonKey: WE, ruleType: 'Validator', name: 'Workflow Enhancer Validator', moduleKey: 'workflow-enhancer-validator' },
          { addonKey: JSU, ruleType: 'Validator', name: 'Fields Required (JSU)', moduleKey: 'fields-required' },
          { addonKey: SR, ruleType: 'Function', name: 'ScriptRunner Script Post Function', moduleKey: 'script-postfunction' },
        ],
        forgeRules: [],
      },
    },
    warnings: [],
  };
}

export const IDS = { G_PROC, G_WGB, G_RECHT, G_DELETED, U_RENE, U_BERNAR };
