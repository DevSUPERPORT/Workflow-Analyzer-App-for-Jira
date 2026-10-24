import { useEffect, useState } from 'react';
import { router } from '@forge/bridge';
import { useT } from '../lib/i18n.jsx';
import { SevBadge } from './common.jsx';
import { call } from '../lib/api.js';
import { findingToIssue, findingFingerprint } from '../../../../src/shared/insights.js';
import { findingText } from '../../../../src/shared/i18n.js';
import Icon from './Icon.jsx';

export function openIssue(siteUrl, key) {
  const url = `${siteUrl || ''}/browse/${key}`;
  try { router.open(url); } catch { window.open(url, '_blank'); }
}

export default function Remediate({ findings, projectKey, siteUrl, remediation, onDone, onClose }) {
  const t = useT();
  const [selected, setSelected] = useState(() => new Set(findings.filter((f) => !remediation[findingFingerprint(f)]).map((f) => f.id)));
  const [types, setTypes] = useState(null);
  const [typeId, setTypeId] = useState('');
  const [target, setTarget] = useState(projectKey || '');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    setTypes(null);
    call('getIssueTypes', { projectKey: target })
      .then((list) => {
        if (!alive) return;
        setTypes(list);
        setTypeId((list.find((x) => /^(task|aufgabe)$/i.test(x.name)) || list[0])?.id || '');
      })
      .catch((e) => alive && (setTypes([]), setError(e.message)));
    return () => { alive = false; };
  }, [target]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const items = findings.filter((f) => selected.has(f.id)).map((f) => findingToIssue(f, t.lang, { projectKey }));
      const res = await call('createRemediation', { items, issueTypeId: typeId, projectKey: target });
      setResult(res);
      onDone?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={t('rem.title')}>
        <div className="drawer-head">
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 17, fontWeight: 700 }}>{t('rem.title')}</div>
            <div className="small muted">{t('rem.intro')}</div>
          </div>
          <button type="button" className="hbtn only" onClick={onClose} aria-label={t('tt.close')}><Icon name="x" /></button>
        </div>
        <div className="drawer-body">
          {result ? (
            <div>
              <div className="alert" style={{ borderColor: 'var(--ok)', background: 'var(--cat-done)' }}>{t('rem.created', { n: result.created.length })}{result.skipped.length ? ` · ${t('rem.skipped', { n: result.skipped.length })}` : ''}</div>
              {[...result.created, ...result.skipped].map((c) => (
                <button key={c.fingerprint} type="button" className="chip ref" style={{ margin: 3 }} onClick={() => openIssue(siteUrl, c.key)}><Icon name="external" size={13} />{c.key}</button>
              ))}
              <div style={{ marginTop: 14 }}><button type="button" className="btn" onClick={onClose}>{t('tt.close')}</button></div>
            </div>
          ) : (
            <>
              <div className="form-grid" style={{ marginBottom: 12 }}>
                <div className="field">
                  <label htmlFor="rem-project">{t('rem.project')}</label>
                  <input id="rem-project" type="text" value={target} onChange={(e) => setTarget(e.target.value.toUpperCase())} maxLength={20} />
                </div>
                <div className="field">
                  <label htmlFor="rem-type">{t('rem.issueType')}</label>
                  <select id="rem-type" value={typeId} onChange={(e) => setTypeId(e.target.value)} disabled={!types?.length}>
                    {(types || []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                  </select>
                </div>
              </div>
              {error && <div className="alert error">{error}</div>}
              <div className="row" style={{ marginBottom: 8 }}>
                <button type="button" className="btn small" onClick={() => setSelected(new Set(findings.map((f) => f.id)))}>{t('tt.all')}</button>
                <button type="button" className="btn small" onClick={() => setSelected(new Set())}>{t('tt.none')}</button>
                <span className="small muted">{t('tt.selected', { n: selected.size })}</span>
              </div>
              {findings.map((f) => {
                const ft = findingText(t.lang, f);
                const existing = remediation[findingFingerprint(f)];
                return (
                  <label key={f.id} className="row" style={{ flexWrap: 'nowrap', alignItems: 'flex-start', padding: '6px 0', borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
                    <input type="checkbox" checked={selected.has(f.id)} disabled={!!existing} onChange={() => { const n = new Set(selected); if (n.has(f.id)) n.delete(f.id); else n.add(f.id); setSelected(n); }} />
                    <SevBadge sev={f.severity} />
                    <span style={{ flex: 1 }}>{ft.title}<div className="small muted">{f.wfName}{f.tName ? ` › ${f.tName}` : ''}</div></span>
                    {existing && <span className="chip">{existing.key}</span>}
                  </label>
                );
              })}
              <div className="row" style={{ marginTop: 14 }}>
                <button type="button" className="btn primary" disabled={busy || !selected.size || !typeId} onClick={create}><Icon name="plus" />{t('rem.create', { n: selected.size })}</button>
                <span className="small muted">{t('rem.labels')}</span>
              </div>
            </>
          )}
        </div>
      </aside>
    </>
  );
}
