/**
 * SUPERPORT kill switch for incidents (e.g. a vulnerability): reads the Forge environment variable
 * APP_MAINTENANCE on the server and refuses requests while the app is down or paused. Called first by every
 * resolver, Rovo action and the scheduled monitor.
 *
 * Values of APP_MAINTENANCE in the app's Forge environment:
 *   off (or unset) - normal operation
 *   readonly       - everything can be viewed, nothing can be changed (no writes to Jira or the app's storage)
 *   on             - the app refuses every request; the UI shows "temporarily unavailable"
 *
 * Who can flip it: only the app's owner, with the Forge CLI (`forge variables set`) followed by a deploy - in
 * practice through the SUPERPORT ops panel. Customers, Jira admins and anyone who reads the Custom UI bundle
 * cannot: the value lives in Atlassian's runtime, is read only on the server, and the app has no resolver,
 * setting or URL that changes it. The app never contacts Statuspage and holds no Statuspage or Forge credentials.
 *
 * Fail closed: a value that isn't one of the known ones is treated as "on".
 *
 * @file        src/lib/maintenance.js
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-24
 * @updated     2026-11-05
 */

const APP_NAME = 'Workflow Analyzer for Jira';

/** Public status page shown to users while the app is unavailable. */
export const STATUS_PAGE_URL = 'https://superapps.statuspage.io';

const VAR = 'APP_MAINTENANCE';

/** @returns {'off' | 'readonly' | 'on'} */
export function maintenanceMode(env = process.env) {
  const raw = String(env?.[VAR] ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'off') return 'off';
  if (raw === 'readonly' || raw === 'read-only') return 'readonly';
  return 'on';
}

export const UNAVAILABLE_MESSAGE = `${APP_NAME} is temporarily unavailable. We've paused it for maintenance to keep your data safe. Nothing you've saved is lost, and we'll be back as soon as possible. Status page: ${STATUS_PAGE_URL}`;
export const READONLY_MESSAGE = `Changes are paused for maintenance to keep your data safe. You can still view everything; editing will be back as soon as possible. Status page: ${STATUS_PAGE_URL}`;

export class UnavailableError extends Error {
  constructor(mode, message) {
    super(message);
    this.code = 'UNAVAILABLE';
    this.mode = mode;
  }
}

/**
 * Call first in EVERY resolver, Rovo action and scheduled trigger.
 * Throws when the app is down (any request) or read-only (requests that change something).
 * @param {'read' | 'write'} kind
 */
export function requireAvailable(kind) {
  const mode = maintenanceMode();
  if (mode === 'on') throw new UnavailableError('on', UNAVAILABLE_MESSAGE);
  if (mode === 'readonly' && kind !== 'read') throw new UnavailableError('readonly', READONLY_MESSAGE);
}
