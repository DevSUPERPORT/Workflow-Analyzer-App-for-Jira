/**
 * English demo for the click-dummy (`#demo=en`, used for the Marketplace screenshots): the demo data stays German
 * inside the mock (the tests share it), responses are translated on the way out and requests mapped back on the
 * way in, so names the UI sends back still match the fixture.
 *
 * @file        static/app/src/mock/demoEn.js
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-11-23
 * @updated     2026-11-23
 */

const EN = {
  // project, workflows, issue types
  'IT-Bedarf': 'IT Requests',
  'IDE: Bedarfsworkflow': 'IDE: Procurement workflow',
  'Bestellprozess für IT-Bedarfe': 'Ordering process for IT equipment',
  Bedarf: 'Request',
  Unteraufgabe: 'Sub-task',
  // statuses
  'Bedarfsanfrage stellen': 'Request submitted',
  'Freigabe notwendig': 'Approval needed',
  'Lagerbestand prüfen': 'Check stock',
  'Ist lagernd': 'In stock',
  'Bestellung notwendig': 'Order needed',
  'Angebote einholen': 'Get quotes',
  'Ware geliefert': 'Delivered',
  'GB-Erstellung': 'Business case',
  'GB-Kontrolle': 'Business case review',
  'GB-Klärung': 'Business case clarification',
  'GB-Unterzeichnung': 'Business case sign-off',
  'Geschaeftsleitung Pruefung': 'Management approval',
  'Bestellung abgeschlossen': 'Order completed',
  'Nicht genehmigt': 'Rejected',
  Archiv: 'Archive',
  // transitions
  'Zur Freigabe': 'Submit for approval',
  Freigeben: 'Approve',
  'Freigeben (alt)': 'Approve (old)',
  'Alte Abkürzung': 'Old shortcut',
  Bestellen: 'Order',
  'GB erstellen': 'Create business case',
  'Zur GB-Kontrolle': 'To business case review',
  'GB OK': 'Business case OK',
  'GB prüfen': 'Review business case',
  'zurück GB Erstellung': 'Back to business case',
  'Zur Geschäftsleitung': 'To management',
  'Bestellung abschließen': 'Complete order',
  Ablehnen: 'Reject',
  Eskaliert: 'Escalated',
  Eskalieren: 'Escalate',
  Deeskalieren: 'De-escalate',
  // fields, groups, screens, messages
  Warengruppe: 'Product group',
  'Standard Sortiment': 'Standard range',
  'Vorgang für Kst.': 'Cost centre',
  'Product Owner/ Projektverantw.': 'Product owner',
  'GB Prüfmaske': 'Business case check',
  'GB erforderlich?': 'Business case needed?',
  recht: 'legal',
  'unit.jira-buy-warengruppe-b': 'unit.jira-buy-group-b',
  'Bestellungen fuer die Materialgruppe B können nur von der Warengruppe B durchgeführt werden': 'Orders for product group B can only be placed by group B buyers',
  'Im Feld Standard Sortiment muss Ja oder Nein stehen.': 'Standard range must be Yes or No.',
  'Sortiment und Warengruppe angeben': 'Enter range and product group',
  'Bitte Warengruppe und GB angeben': 'Please enter the product group and business case',
  // issue summaries (resolution check)
  'Laptop für Neuzugang': 'Laptop for new hire',
  'Monitor 27 Zoll': '27-inch monitor',
  'Lizenz Adobe CC': 'Adobe CC licence',
  'Headset Vertrieb': 'Headset for sales',
  'Docking-Station': 'Docking station',
  'Tastatur DE': 'Keyboard (German layout)',
  'iPhone Ersatz': 'Replacement iPhone',
  'Beamer Raum 4': 'Projector room 4',
  'Server-RAM': 'Server RAM',
  'Webcam HR': 'Webcam for HR',
  'Wieder geöffnet: Drucker': 'Reopened: printer',
  // mock AI texts
  '(Mock) Ich lege den Status „Eskaliert“ an, erlaube die Eskalation aus GB-Kontrolle und GB-Klärung nur für Administratoren und ergänze einen Rückweg.':
    'I add the status "Escalated", allow escalating from Business case review and Business case clarification for the project role Administrators only, and add a way back.',
  '(Mock) Die Anfrage ist nicht eindeutig – bitte Status und Transition nennen.': 'The request is not clear: please name the status and the transition.',
  'claude-sonnet-5 (mock)': 'claude-sonnet-5',
  'Mock Admin': 'Alex Morgan',
};
const DE = Object.fromEntries(Object.entries(EN).map(([de, en]) => [en, de]));

// Names inside longer strings ("IDE-101 · Ware geliefert", "Workflow „…“"), longest first so "GB-Kontrolle" wins over "GB"
const PHRASES = Object.keys(EN).filter((k) => k.length >= 5 && !k.startsWith('(Mock)')).sort((a, b) => b.length - a.length);
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PHRASE_RE = new RegExp(`(?<![\\p{L}\\p{N}])(?:${PHRASES.map(escape).join('|')})(?![\\p{L}\\p{N}])`, 'gu');

const ANSWER = /^\(Mock\) Zur Frage „([\s\S]*)“:/;

function toEn(s) {
  if (Object.hasOwn(EN, s)) return EN[s];
  if (ANSWER.test(s)) {
    return 'The workflow "IDE: Procurement workflow" has 15 statuses. Only members of "Procurement" may run the transition "Business case OK", and in addition only "legal" or the reporter. No transition skips the business case review: every path to "Order completed" passes "Business case review".';
  }
  return s.replace(PHRASE_RE, (m) => EN[m]);
}
const toDe = (s) => (Object.hasOwn(DE, s) ? DE[s] : s);

function deep(v, fn) {
  if (typeof v === 'string') return fn(v);
  if (Array.isArray(v)) return v.map((x) => deep(x, fn));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x, fn)]));
  return v;
}

export const demoEn = () => /demo=en/.test(window.location.hash);
export const outgoing = (res) => deep(res, toEn);
export const incoming = (payload) => deep(payload, toDe);
