/**
 * Settings card for Jira admins on the site-wide admin page: the per-site AI switch (off by default) and this
 * month's Forge LLM usage against the limits SUPERPORT sets via App Status (AI_BUDGET), with a notice while
 * SUPERPORT has the AI turned off. The server checks "Administer Jira" again on every change.
 *
 * @file        static/app/src/components/AiSettings.jsx
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-11-16
 * @updated     2026-11-16
 */

import { useEffect, useState } from 'react';
import { useT } from '../lib/i18n.jsx';
import { call } from '../lib/api.js';
import Icon from './Icon.jsx';
import { Skeleton } from './common.jsx';

export default function AiSettings({ onChange, style }) {
  const t = useT();
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    call('getAiSettings').then(setS).catch((e) => setError(e.message));
  }, []);

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await call('setAiSettings', { enabled: !s.enabled });
      setS(next);
      onChange?.(next.enabled && !next.stopped, !!next.stopped);
    } catch (e) {
      setError(e.code === 'FORBIDDEN_SITE' ? t('app.forbiddenSite') : e.message);
    } finally {
      setBusy(false);
    }
  };

  const n = (v) => Number(v || 0).toLocaleString(t.lang === 'de' ? 'de-DE' : 'en-US');
  const u = s?.usage;
  return (
    <section className="card" style={style} aria-labelledby="ai-settings-title">
      {!s && !error && <div role="status" aria-label="…"><Skeleton h={40} /></div>}
      {s && (
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'nowrap', alignItems: 'flex-start', gap: 16 }}>
          <div>
            <strong id="ai-settings-title" className="row" style={{ gap: 8, display: 'inline-flex' }}><Icon name="sparkle" size={16} style={{ color: 'var(--accent)' }} />{t('aiset.title')}</strong>{' '}
            <span className={`chip ${s.enabled && !s.stopped ? 'good' : ''}`}>{s.enabled ? t('aiset.on') : t('aiset.offState')}</span>
            <div className="small muted" style={{ marginTop: 4 }}>{t('aiset.intro')}</div>
            {s.stopped && <div className="alert info" role="status" style={{ marginTop: 8 }}><Icon name="lock" size={18} /><span className="small">{t('aiset.stopped')}</span></div>}
            {u && (
              <div className="small" style={{ marginTop: 6 }}>
                {t('aiset.usage', { calls: n(u.calls), maxCalls: n(u.limits?.calls), tokens: n(u.tokens), maxTokens: n(u.limits?.tokens) })}
                <span className="muted"> · {t('aiset.usageHint')}</span>
              </div>
            )}
            {u?.exhausted && <div className="small" style={{ marginTop: 4, color: 'var(--high)' }}>{t('ai.quota')}</div>}
            {s.updatedAt && <div className="small muted" style={{ marginTop: 4 }}>{t('aiset.changed', { date: t.date(s.updatedAt), name: s.updatedByName || '–' })}</div>}
          </div>
          <button type="button" className={`btn ${s.enabled ? '' : 'primary'} ${busy ? 'busy' : ''}`} disabled={busy} aria-pressed={s.enabled} onClick={toggle}>{s.enabled ? t('aiset.disable') : t('aiset.enable')}</button>
        </div>
      )}
      {error && <div className="alert error" style={{ marginTop: s ? 10 : 0 }}>{error}</div>}
    </section>
  );
}
