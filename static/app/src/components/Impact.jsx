import { useMemo, useState } from 'react';
import { useT } from '../lib/i18n.jsx';
import { useApp, VendorBadge, EmptyState } from './common.jsx';
import { REF_TYPES } from '../../../../src/shared/rules.js';
import { downloadText } from '../lib/download.js';
import { toCsv } from '../lib/exportCsv.js';
import Icon from './Icon.jsx';

export default function Impact({ model, refType, setRefType, refId, setRefId, refData }) {
  const t = useT();
  const { actions } = useApp();
  const [filter, setFilter] = useState('');
  const types = REF_TYPES.filter((rt) => model.index[rt] && Object.keys(model.index[rt]).length);
  const type = types.includes(refType) ? refType : types[0];
  const items = useMemo(() => {
    const list = Object.values(model.index[type] || {});
    const f = filter.trim().toLowerCase();
    return list
      .filter((e) => !f || String(e.name).toLowerCase().includes(f) || String(e.id).toLowerCase().includes(f))
      .sort((a, b) => (b.resolved === false || !!b.inactive) - (a.resolved === false || !!a.inactive) || b.transitionCount - a.transitionCount || String(a.name).localeCompare(String(b.name)));
  }, [model, type, filter]);
  const sel = (refId && model.index[type]?.[refId]) || null;
  const vendorOf = (key) => model.vendors.find((v) => v.key === key);

  const projects = useMemo(() => {
    if (!sel || model.kind !== 'site') return [];
    const m = new Map();
    for (const wfId of sel.workflowIds) for (const p of model.workflows.find((w) => w.id === wfId)?.projects || []) m.set(p.id, p);
    return [...m.values()].sort((a, b) => a.key.localeCompare(b.key));
  }, [sel, model]);

  const exportMatrix = () => {
    const rows = [[t('im.col.type'), t('im.col.name'), 'ID', t('im.col.workflow'), t('im.col.transition'), t('im.col.path'), t('im.col.rule'), t('im.col.vendor'), t('im.col.status')]];
    for (const rt of types) {
      for (const e of Object.values(model.index[rt])) {
        for (const u of e.usages) {
          rows.push([t(`ref.${rt}`), e.name, e.id, u.wfName, u.tName, `${u.from.join(', ') || '*'} -> ${u.to || '-'}`, `${t(`kind.${u.kind}`)}${u.ruleLabel ? `: ${u.ruleLabel}` : ''}`, u.vendor, e.resolved === false ? t('im.unresolved') : e.inactive ? t('im.inactive') : 'OK']);
        }
      }
    }
    downloadText(toCsv(rows), `${model.project?.key || 'site'}_workflow_dependencies.csv`, 'text/csv;charset=utf-8');
  };

  return (
    <div>
      <section className="card">
        <div className="card-head" style={{ marginBottom: 6 }}>
          <h2 style={{ margin: 0 }}>{t('im.title')}</h2>
          <button type="button" className="btn small" onClick={exportMatrix}><Icon name="download" />{t('im.exportCsv')}</button>
        </div>
        <p className="muted" style={{ margin: 0, maxWidth: '75ch' }}>{t('im.intro')}</p>
      </section>
      <BulkCheck model={model} refData={refData} onPick={(type, id) => { setRefType(type); setRefId(id); }} />
      <div className="impact-types">
        {types.map((rt) => {
          const bad = Object.values(model.index[rt]).filter((e) => e.resolved === false || e.inactive).length;
          return (
            <button key={rt} type="button" aria-pressed={rt === type} className={`chip ${rt === type ? 'on' : ''}`} onClick={() => { setRefType(rt); setRefId(null); }}>
              {t(`refs.${rt}`)} <strong className="num">{Object.keys(model.index[rt]).length}</strong>
              {bad > 0 && <span className="tab-count hot" title={t('im.unresolved')}>{bad}</span>}
            </button>
          );
        })}
      </div>
      {types.length === 0 && <div className="empty">{t('im.empty')}</div>}
      {types.length > 0 && (
        <div className="impact">
          <div className="impact-list">
            <div style={{ padding: 10, borderBottom: '1px solid var(--border)', position: 'sticky', top: 0, background: 'var(--surface)', zIndex: 1 }}>
              <div className="omnibox" style={{ width: '100%', flex: 'none' }}>
                <Icon name="search" className="icon" />
                <input type="search" aria-label={t('im.filter')} placeholder={t('im.filter')} value={filter} onChange={(e) => setFilter(e.target.value)} style={{ paddingRight: 12 }} />
              </div>
            </div>
            {items.map((e) => (
              <button key={e.id} type="button" className="impact-item" aria-selected={sel?.id === e.id} onClick={() => setRefId(e.id)}>
                {type === 'app' && vendorOf(e.id) ? <VendorBadge vendor={vendorOf(e.id)} /> : null}
                <span className="name" title={`${e.name} (${e.id})`}>{type === 'app' ? '' : e.name}</span>
                {e.resolved === false && <span className="chip bad">{t('im.unresolved')}</span>}
                {e.inactive && <span className="chip warn">{t('im.inactive')}</span>}
                <span className="n">{e.transitionCount}</span>
              </button>
            ))}
            {items.length === 0 && <div className="empty" style={{ padding: 10 }}>{t('app.searchNoResults')}</div>}
          </div>
          <div>
            {!sel && <div className="card dashed"><EmptyState icon="link" title={t('im.selectHint')} /></div>}
            {sel && (
              <div className="card view" key={sel.id}>
                <div className="muted small">{t(`ref.${type}`)} · <code>{sel.id}</code></div>
                <h2 style={{ margin: '4px 0' }}>
                  {type === 'app' && vendorOf(sel.id) ? <VendorBadge vendor={vendorOf(sel.id)} /> : sel.name}
                  {sel.resolved === false && <span className="chip bad" style={{ marginLeft: 8 }}>{t('im.unresolved')}</span>}
                  {sel.inactive && <span className="chip warn" style={{ marginLeft: 8 }}>{t('im.inactive')}</span>}
                </h2>
                <div className="row" style={{ justifyContent: 'space-between' }}><span className="muted">{t('im.usedIn', { t: sel.transitionCount, w: sel.workflowCount })}</span><button type="button" className="btn small dark" onClick={() => actions.showImpact(sel)}><Icon name="diagram" />{t('acc.showInDiagram')}</button></div>
                {sel.resolved === false && <div className="alert error" style={{ marginTop: 12 }}><Icon name="alert" size={18} /><span>{t('im.unresolvedHint')}</span></div>}
                {projects.length > 0 && (
                  <>
                    <h3 style={{ margin: '20px 0 8px' }}>{t('im.projectsAffected')} ({projects.length})</h3>
                    <div className="row">{projects.map((p) => <span key={p.id} className="chip" title={p.name}><strong>{p.key}</strong>&nbsp;{p.name}</span>)}</div>
                  </>
                )}
                <h3 style={{ margin: '20px 0 8px' }}>{t('im.affected')}</h3>
                <div className="table-wrap"><table className="data" style={{ minWidth: 620 }}>
                  <thead>
                    <tr>
                      <th>{t('im.col.workflow')}</th>
                      <th>{t('im.col.transition')}</th>
                      <th>{t('im.col.path')}</th>
                      <th>{t('im.col.rule')}</th>
                      <th>{t('im.col.vendor')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sel.usages.map((u, i) => (
                      <tr key={i} className="clickable" onClick={() => actions.openTransition(u.tKey)}>
                        <td>{u.wfName}</td>
                        <td><strong>{u.tName}</strong> <span className="muted small">({u.tId})</span></td>
                        <td className="small">{u.from.join(', ') || '*'} → {u.to || t('tt.loop')}</td>
                        <td className="small">{t(`kind.${u.kind}`)}{u.ruleLabel && u.vendor !== 'Jira' ? `: ${u.ruleLabel}` : u.ruleNameKey ? `: ${t(u.ruleNameKey)}` : u.ruleLabel ? `: ${u.ruleLabel}` : ''}{u.via ? <span className="muted"> · {t('im.via', { param: t(`param.${u.via}`) !== `param.${u.via}` ? t(`param.${u.via}`) : u.via })}</span> : null}</td>
                        <td className="small">{u.vendor}</td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * "Check a list": paste names (e.g. groups to be deleted) and see for each one whether workflows use it.
 */
function BulkCheck({ model, refData, onPick }) {
  const t = useT();
  const { actions } = useApp();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState('group');
  const [text, setText] = useState('');
  const [rows, setRows] = useState(null);

  const check = () => {
    const names = [...new Set(text.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean))];
    const entries = Object.values(model.index[type] || {});
    const siteList = type === 'group' ? refData?.groups?.map((g) => ({ id: g.groupId, name: g.name })) : type === 'role' ? refData?.roles : type === 'field' ? refData?.fields : type === 'user' ? refData?.users?.map((u) => ({ id: u.accountId, name: u.displayName })) : null;
    setRows(names.map((n) => {
      const lc = n.toLowerCase();
      const e = entries.find((x) => String(x.name).toLowerCase() === lc || String(x.id).toLowerCase() === lc);
      const exists = siteList ? siteList.some((x) => String(x.name).toLowerCase() === lc || String(x.id).toLowerCase() === lc) : null;
      const projects = e && model.kind === 'site' ? [...new Set(e.workflowIds.flatMap((id) => (model.workflows.find((w) => w.id === id)?.projects || []).map((p) => p.key)))] : [];
      return { name: n, entry: e, exists: e ? e.resolved !== false : exists, projects };
    }));
  };

  const usagesText = (e) => [...new Set(e.usages.map((u) => `${u.wfName} › ${u.tName}${u.kind === 'property' ? ` (${t('kind.property')})` : ''}`))];

  const exportCsv = () => {
    const out = [[t('im.col.type'), t('im.col.name'), t('im.col.status'), t('ov.transitions'), t('ov.workflows'), t('ov.projects'), t('im.affected')]];
    for (const r of rows) {
      out.push([t(`ref.${type}`), r.name, r.entry ? t('bulk.inUse') : r.exists === false ? t('bulk.notFound') : t('bulk.unused'), r.entry?.transitionCount || 0, r.entry?.workflowCount || 0, r.projects.join(', '), r.entry ? usagesText(r.entry).join(' | ') : '']);
    }
    downloadText(toCsv(out), `${model.project?.key || 'site'}_${type}_check.csv`, 'text/csv;charset=utf-8');
  };

  if (!open) {
    return (
      <section className="decision">
        <div className="body"><h3>{t('bulk.title')}</h3><p className="small muted" style={{ margin: 0 }}>{t('bulk.teaser')}</p></div>
        <div className="aside" style={{ justifyContent: 'center' }}><button type="button" className="btn primary" style={{ alignSelf: 'flex-start' }} onClick={() => setOpen(true)}><Icon name="check" />{t('bulk.open')}</button></div>
      </section>
    );
  }
  const used = rows?.filter((r) => r.entry).length || 0;
  return (
    <section className="card view" aria-labelledby="bulk-check">
      <div className="card-head" style={{ marginBottom: 6 }}>
        <h2 id="bulk-check" style={{ margin: 0, fontSize: 17 }}>{t('bulk.title')}</h2>
        <button type="button" className="btn small ghost" onClick={() => setOpen(false)} aria-label={t('tt.close')}><Icon name="x" /></button>
      </div>
      <p className="small muted">{model.kind === 'site' ? t('bulk.introSite') : t('bulk.introProject')}</p>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <select value={type} onChange={(e) => { setType(e.target.value); setRows(null); }} aria-label={t('im.col.type')} style={{ flex: '0 0 auto' }}>
          {['group', 'role', 'field', 'user', 'app'].map((x) => <option key={x} value={x}>{t(`refs.${x}`)}</option>)}
        </select>
        <textarea rows={4} aria-label={t('bulk.placeholder')} style={{ flex: 1, minWidth: 240 }} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('bulk.placeholder')} />
        <button type="button" className="btn primary" disabled={!text.trim()} onClick={check}>{t('bulk.check')}</button>
      </div>
      {rows && (
        <>
          <div className="row" style={{ margin: '10px 0 6px', justifyContent: 'space-between' }}>
            <strong>{t('bulk.summary', { used, free: rows.length - used })}</strong>
            <button type="button" className="btn small" onClick={exportCsv}><Icon name="download" />CSV</button>
          </div>
          <table className="data">
            <thead><tr><th>{t('im.col.name')}</th><th>{t('im.col.status')}</th><th>{t('im.affected')}</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name} className={r.entry ? 'clickable' : ''} onClick={() => r.entry && onPick(type, r.entry.id)}>
                  <td><strong>{r.name}</strong></td>
                  <td className="nowrap">
                    {r.entry ? <span className="sev high">{t('bulk.inUse')}</span> : r.exists === false ? <span className="sev info">{t('bulk.notFound')}</span> : <span className="chip good">{t('bulk.unused')}</span>}
                  </td>
                  <td className="small">
                    {r.entry ? (
                      <>
                        {t('im.usedIn', { t: r.entry.transitionCount, w: r.entry.workflowCount })}{r.projects.length ? ` · ${t('ov.projects')}: ${r.projects.join(', ')}` : ''}
                        <div className="muted">{usagesText(r.entry).slice(0, 6).join(' · ')}</div>
                        {model.kind === 'site' && ['group', 'role', 'user'].includes(type) && (
                          <div className="row" style={{ marginTop: 4 }} onClick={(e) => e.stopPropagation()}>
                            <button type="button" className="btn small" onClick={() => actions.openBulk({ template: 'removeRef', refType: type, refId: r.entry.id, refName: r.entry.name })}><Icon name="layers" />{t('bulk.removeAll')}</button>
                            <button type="button" className="btn small" onClick={() => actions.openBulk({ template: 'replaceRef', refType: type, refId: r.entry.id, refName: r.entry.name })}><Icon name="layers" />{t('bulk.replaceAll')}</button>
                          </div>
                        )}
                      </>
                    ) : r.exists === false ? t('bulk.notFoundHint') : t('bulk.unusedHint')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small muted" style={{ marginBottom: 0 }}>{t('bulk.scopeNote')}</p>
        </>
      )}
    </section>
  );
}
