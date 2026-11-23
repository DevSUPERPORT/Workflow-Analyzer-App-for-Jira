/**
 * Marketplace licence (paid via Atlassian, `app.licensing.enabled` in the manifest). Forge passes context.license
 * to resolvers and Rovo actions; on a site without an active licence every request is refused with
 * LICENSE_INACTIVE, so nothing is analysed, changed or sent to the AI there. The daily monitor is skipped by Forge
 * itself (filter.appIsLicensed on the scheduled trigger). Saved data stays untouched and is used again once the
 * licence is active.
 *
 * No license object (development and staging installs, or before the app is listed) is not "inactive": those
 * installs keep working, as Atlassian documents for Forge licensing.
 *
 * @file        src/lib/license.js
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-11-23
 * @updated     2026-11-23
 */

import { t, normalizeLang } from '../shared/i18n.js';

/** True when Forge reports that the site has no active Marketplace licence (license.active or the older isActive). */
export function isLicenseInactive(license) {
  return Boolean(license) && typeof license === 'object' && (license.active === false || license.isActive === false);
}

export class LicenseError extends Error {
  constructor(lang = 'en') {
    super(t(normalizeLang(lang), 'lic.inactive'));
    this.code = 'LICENSE_INACTIVE';
  }
}

/** Throws LICENSE_INACTIVE on a site without an active licence. */
export function requireLicense(context, lang) {
  if (isLicenseInactive(context?.license)) throw new LicenseError(lang);
}
