import { useEffect, useState } from 'react';
import { useT } from '../lib/i18n.jsx';
import { call } from '../lib/api.js';
import { makeSnapshot, diffSnapshots } from '../../../../src/shared/snapshot.js';
import Icon from './Icon.jsx';
import { Skeleton } from './common.jsx';

export default function Changes({ model, toast }) {
  const t = useT();
  const [list, setList] = useState(null);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [diff, setDiff] = useState(null);
  const [error, setError] = useState(null);

  const refresh = async () => {
    try {
      setList(await call('listSnapshots'));
    } catch (e) {
      setError(e.message);
      setList([]);
    }
  };
  const [mon, setMon] = useState(null);
  useEffect(() => {
    refresh();
    call('getMonitoring').then(setMon).catch(() => setMon(null));
  }, []);

  const toggleMon = async () => {
    setBusy(true);
    try {
      setMon(await call('setMonitoring', { enabled: !mon.enabled }));
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      await call('saveSnapshot', { label });
      setLabel('');
      toast(t('ch.saved'));
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const compare = async (entry) => {
    setBusy(true);
    try {
      const old = await call('getSnapshot', { id: entry.id });
      const current = makeSnapshot(model);
      setDiff({ entry, changes: diffSnapshots(old, current) });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const [confirmDel, setConfirmDel] = useState(null);
  const remove = async (entry) => {
    if (confirmDel !== entry.id) { setConfirmDel(entry.id); return; }
    setConfirmDel(null);
    await call('deleteSnapshot', { id: entry.id });
    if (diff?.entry.id === entry.id) setDiff(null);
    refresh();
  };

  const opColor = { added: 'var(--ok)', removed: 'var(--high)', changed: 'var(--medium)' };
  const ruleLabel = (s) => (/^\w+: rule\./.test(s) ? s.replace(/rule\.\w+/, (k) => t(k)) : s);

  return (
    <div>
      <div className="card accent">
        <h2 style={{ marginTop: 0 }}>{t('ch.title')}</h2>
        <p className="muted">{t('ch.intro')}</p>
        <div className="row">
          <input type="text" aria-label={t('ch.labelPlaceholder')} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('ch.labelPlaceholder')} style={{ flex: 1, minWidth: 220 }} maxLength={120} />
          <button type="button" className="btn primary" disabled={busy} onClick={save}><Icon name="camera" />{t('ch.save')}</button>
        </div>
      </div>
      {mon && (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
            <div>
              <strong>{t('mon.title')}</strong> <span className={`chip ${mon.enabled ? 'good' : ''}`}>{mon.enabled ? t('mon.on') : t('mon.off')}</span>
              <div className="small muted">{t('mon.intro')}</div>
              {mon.state && (
                <div className="small" style={{ marginTop: 4 }}>
                  {mon.state.lastRun && <span>{t('mon.lastRun', { date: t.date(mon.state.lastRun) })}</span>}
                  {mon.state.lastChangeAt && <span> · {t('mon.lastChange', { date: t.date(mon.state.lastChangeAt), n: mon.state.lastChangeCount || 0 })}</span>}
                </div>
              )}
            </div>
            <button type="button" className={`btn ${mon.enabled ? '' : 'primary'}`} disabled={busy} onClick={toggleMon}>{mon.enabled ? t('mon.disable') : t('mon.enable')}</button>
          </div>
        </div>
      )}
      {error && <div className="alert error">{error}</div>}
      <div className="grid" style={{ gridTemplateColumns: 'minmax(280px, 420px) 1fr', alignItems: 'start' }}>
        <div className="card">
          {list === null && <div className="stack" role="status" aria-label="…">{[0, 1, 2].map((i) => <Skeleton key={i} h={40} />)}</div>}
          {list?.length === 0 && <div className="empty">{t('ch.none')}</div>}
          {list?.map((s) => (
            <div key={s.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)', background: diff?.entry.id === s.id ? 'var(--hover)' : undefined }}>
              <div style={{ fontWeight: 700 }}>{s.label || t.date(s.takenAt)}</div>
              <div className="small muted">{t.date(s.takenAt)} · {t('ch.by', { name: s.by || '?' })} · {s.stats?.transitions} {t('ov.transitions')} · {t('ov.health')} {s.stats?.healthScore}</div>
              <div className="row" style={{ marginTop: 6 }}>
                <button type="button" className="btn small dark" disabled={busy} onClick={() => compare(s)}><Icon name="compare" />{t('ch.compare')}</button>
                <button type="button" className={`btn small ${confirmDel === s.id ? 'on' : ''}`} onClick={() => remove(s)}>{confirmDel === s.id ? t('ch.confirmDelete') : t('ch.delete')}</button>
              </div>
            </div>
          ))}
        </div>
        <div className="card">
          {!diff && <div className="empty">{list?.length ? t('ch.compare') + ' …' : ''}</div>}
          {diff && (
            <>
              <h3>{diff.changes.length ? t('ch.changesN', { n: diff.changes.length, date: t.date(diff.entry.takenAt) }) : t('ch.noChanges')}</h3>
              <table className="data">
                <tbody>
                  {diff.changes.map((c, i) => (
                    <tr key={i}>
                      <td className="nowrap"><span className="sev" style={{ background: opColor[c.op], color: '#fff' }}>{t(`ch.op.${c.op}`)}</span></td>
                      <td className="nowrap small muted">{t(`ch.type.${c.type}`)}</td>
                      <td>
                        <strong>{c.name}</strong> <span className="small muted">· {c.wf}</span>
                        {c.detail?.field && <div className="small">{t(`ch.field.${c.detail.field}`)}: <del>{String(c.detail.from ?? '–')}</del> → <strong>{String(c.detail.to ?? '–')}</strong></div>}
                        {c.detail?.path && <div className="small muted">{c.detail.path}</div>}
                        {c.detail?.rule && <div className="small">{t(`kind.${c.detail.kind}`)}: {ruleLabel(c.detail.rule)}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
