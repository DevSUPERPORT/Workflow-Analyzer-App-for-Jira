/**
 * UI side of the SUPERPORT kill switch: the full-page "temporarily unavailable" notice when APP_MAINTENANCE is
 * on and the slim banner while changes are paused, both linking to the public status page via router.open.
 *
 * @file        static/app/src/components/Maintenance.jsx
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-24
 * @updated     2026-11-05
 */

import { router } from '@forge/bridge';
import Icon from './Icon.jsx';

const STATUS_PAGE_URL = 'https://superapps.statuspage.io';

/** Opens the public status page through Jira's router (a new tab outside Jira). */
async function openStatus(url) {
  try {
    await router.open(url || STATUS_PAGE_URL);
  } catch {
    window.open(url || STATUS_PAGE_URL, '_blank', 'noopener,noreferrer');
  }
}

/** Full-page notice while SUPERPORT has taken the app down (APP_MAINTENANCE=on). Purely informational. */
export function Unavailable({ statusUrl, t }) {
  return (
    <section className="card view maint" role="status" aria-live="polite">
      <div className="empty-state maint-body">
        {/* Maintenance mark: a wrench on the orange tint, with a shield badge for "paused to keep your data safe" */}
        <div className="maint-mark" aria-hidden="true">
          <Icon name="wrench" size={34} />
          <span className="maint-shield"><Icon name="shieldCheck" size={18} /></span>
        </div>
        <span className="maint-pill"><span className="dot" aria-hidden="true" />{t('maint.badge')}</span>
        <h2>{t('maint.title')}</h2>
        <p className="muted">{t('maint.body')}</p>
        <button type="button" className="btn primary" onClick={() => openStatus(statusUrl)}>
          {t('maint.status')}<Icon name="external" />
        </button>
      </div>
    </section>
  );
}

/** Slim banner on every page while changes are paused (APP_MAINTENANCE=readonly). */
export function ReadonlyBanner({ statusUrl, t }) {
  return (
    <div className="alert view maint-banner" role="status">
      <Icon name="pause" size={18} />
      <span style={{ flex: 1 }}>{t('maint.readonly')}</span>
      <button type="button" className="btn small ghost" onClick={() => openStatus(statusUrl)}>
        {t('maint.statusShort')}<Icon name="external" size={14} />
      </button>
    </div>
  );
}
