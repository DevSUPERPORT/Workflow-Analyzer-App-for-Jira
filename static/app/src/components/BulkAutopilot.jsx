/**
 * Site-wide bulk changes for Jira admins: pick target workflows, describe the change (templates, AI or auto-fix
 * from the health check), then plan, validate, apply and roll back each workflow on its own with live progress.
 * The "Describe (AI)" template is offered only while AI is effectively on (hidden otherwise, no notice).
 *
 * @file        static/app/src/components/BulkAutopilot.jsx
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-24
 * @updated     2026-11-16
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../lib/i18n.jsx';
import { call } from '../lib/api.js';
import { REF_TYPES } from '../../../../src/shared/rules.js';
import Icon from './Icon.jsx';
import { useApp, useAiOn, LifecycleRail, AiLabel, aiErrorText } from './common.jsx';
import { PlanStatus } from './Autopilot.jsx';

const TEMPLATES = ['removeRef', 'replaceRef', 'resolutionDone', 'restrict', 'requireFields', 'ai', 'json'];

/** Build operations from a template form. */
export function templateOps(tpl, f) {
  switch (tpl) {
    case 'removeRef': return f.ref ? [{ op: 'removeReference', refType: f.refType, ref: f.ref }] : [];
    case 'replaceRef': return f.ref && f.with ? [{ op: 'replaceReference', refType: f.refType, ref: f.ref, with: f.with }] : [];
    case 'resolutionDone': return [{ op: 'setResolution', transition: '@done', resolution: f.resolution || 'Done' }];
    case 'restrict': return f.selector && (f.group || f.role) ? [{ op: 'restrictTransition', transition: f.selector, groups: f.group ? [f.group] : [], roles: f.role ? [f.role] : [] }] : [];
    case 'requireFields': return f.selector && f.fields ? [{ op: 'requireFields', transition: f.selector, fields: f.fields.split(',').map((x) => x.trim()).filter(Boolean), message: f.message || undefined }] : [];
    default: return [];
  }
}

export default function BulkAutopilot({ model, refData, prefill, toast }) {
  const t = useT();
  const { ai: aiSwitch } = useApp();
  const aiOn = useAiOn();
  const [filter, setFilter] = useState('');
  const [usesType, setUsesType] = useState(prefill?.refType || 'group');
  const [usesId, setUsesId] = useState(prefill?.refId || '');
  const [activeOnly, setActiveOnly] = useState(true);
  const [targets, setTargets] = useState(() => new Set());
  const [tpl, setTpl] = useState(prefill?.template || 'removeRef');
  const [form, setForm] = useState({ refType: prefill?.refType || 'group', ref: prefill?.refName || '', with: '', resolution: 'Done', selector: '@done', group: '', role: '', fields: '', message: '', instructions: '' });
  const [json, setJson] = useState('');
  const [ai, setAi] = useState(null);
  const [bulk, setBulk] = useState(null);
  const [history, setHistory] = useState([]);
  const [busy, setBusy] = useState(null);
  const [progress, setProgress] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [confirmShared, setConfirmShared] = useState(false);
  const [confirming, setConfirming] = useState(null); // 'apply' | 'rollback' – every Jira write is confirmed first
  const [error, setError] = useState(null);
  const stopRef = useRef(false);

  useEffect(() => { call('siteBulkList').then(setHistory).catch(() => {}); }, [bulk?.status]);

  const usageEntries = useMemo(() => Object.values(model.index[usesType] || {}).sort((a, b) => String(a.name).localeCompare(String(b.name))), [model, usesType]);
  const usedBy = usesId ? new Set(model.index[usesType]?.[usesId]?.workflowIds || []) : null;
  const candidates = model.workflows.filter((w) => (!activeOnly || w.projects.length) && (!usedBy || usedBy.has(w.id)) && (!filter || w.name.toLowerCase().includes(filter.toLowerCase())));

  // Prefill from the group cleanup assistant: select every workflow that uses the object
  useEffect(() => {
    if (prefill?.refId) setTargets(new Set(model.index[prefill.refType]?.[prefill.refId]?.workflowIds || []));
  }, [prefill, model]);

  // Auto-fix from the health check: plan the chosen findings' fixes in every affected workflow right away
  const handledAutofix = useRef(0);
  useEffect(() => {
    const af = prefill?.autofix;
    if (!af || prefill.at === handledAutofix.current || busy) return;
    handledAutofix.current = prefill.at;
    setTargets(new Set(af.workflowIds));
    setBulk(null);
    runPlanning({ workflowIds: af.workflowIds, autofix: { fingerprints: af.fingerprints }, instructions: t('fix.siteTitle', { n: af.n }), lang: t.lang });
  }, [prefill]);

  // "Describe (AI)" exists only while AI is on: when it goes off, fall back to the first template
  useEffect(() => { if (!aiOn && tpl === 'ai') setTpl('removeRef'); }, [aiOn, tpl]);

  const set = (p) => setForm((x) => ({ ...x, ...p }));
  const ops = tpl === 'json' ? safeJson(json) : tpl === 'ai' ? (aiOn && ai?.operations) || [] : templateOps(tpl, form);
  const opsValid = Array.isArray(ops) && ops.length > 0;

  const planAi = async () => {
    if (!aiOn) return;
    setBusy('ai');
    setError(null);
    try {
      const first = [...targets][0] || candidates[0]?.id;
      setAi(await call('siteBulkAi', { instructions: form.instructions, workflowId: first, lang: t.lang }));
    } catch (e) { setError(aiErrorText(t, e, aiSwitch)); } finally { setBusy(null); }
  };

  // `create` overrides what is sent to siteBulkCreate (auto-fix hand-off from the health check)
  const runPlanning = async (create = null) => {
    setBusy('plan');
    setError(null);
    stopRef.current = false;
    try {
      let b = await call('siteBulkCreate', create || { workflowIds: [...targets], ops, instructions: tpl === 'ai' ? form.instructions : t(`bulkap.tpl.${tpl}`) + summarize(ops), lang: t.lang });
      setBulk(b);
      while (b.children.some((c) => c.status === 'pending') && !stopRef.current) {
        setProgress({ done: b.children.filter((c) => c.status !== 'pending').length, total: b.children.length, label: t('bulkap.planning') });
        b = await call('siteBulkPlanBatch', { bulkId: b.id });
        setBulk(b);
      }
      setSelected(new Set(b.children.filter((c) => c.status === 'planned').map((c) => c.workflowId)));
    } catch (e) { setError(e.message); } finally { setBusy(null); setProgress(null); }
  };

  const runApply = async () => {
    setConfirming(null);
    setBusy('apply');
    setError(null);
    stopRef.current = false;
    const list = bulk.children.filter((c) => selected.has(c.workflowId) && c.status === 'planned');
    let i = 0;
    let ok = 0;
    let failed = 0;
    for (const ch of list) {
      if (stopRef.current) break;
      setProgress({ done: i, total: list.length, label: `${t('bulkap.applying')} ${ch.workflowName}` });
      try {
        const res = await call('siteBulkApply', { bulkId: bulk.id, workflowId: ch.workflowId, confirmShared });
        setBulk((b) => ({ ...b, children: b.children.map((c) => (c.workflowId === ch.workflowId ? { ...c, ...res } : c)) }));
        if (res.status === 'applied') ok++;
        else failed++;
        if (res.status === 'failed' && form.stopOnError !== false) { setError(`${ch.workflowName}: ${res.error || t('ap.failed')}`); break; }
      } catch (e) { failed++; setError(e.message); break; }
      i++;
    }
    setBusy(null);
    setProgress(null);
    toast(t('bulkap.result', { ok, failed }));
  };

  // Called with an explicit boolean only – never pass this function directly as onClick (it would get the event)
  const runRollback = async (confirmOverwrite) => {
    const overwrite = confirmOverwrite === true;
    setConfirming(null);
    setBusy('rollback');
    setError(null);
    const list = bulk.children.filter((c) => c.status === 'applied' && (!overwrite || c.needsConfirm));
    let i = 0;
    let ok = 0;
    let failed = 0;
    for (const ch of list) {
      setProgress({ done: i++, total: list.length, label: `${t('ap.rollback')} ${ch.workflowName}` });
      try {
        const res = await call('siteBulkRollback', { bulkId: bulk.id, workflowId: ch.workflowId, confirmOverwrite: overwrite });
        setBulk((b) => ({ ...b, children: b.children.map((c) => (c.workflowId === ch.workflowId ? { ...c, ...res } : c)) }));
        if (res.status === 'rolledback') ok++;
        else failed++;
      } catch (e) { failed++; setError(e.message); }
    }
    setBusy(null);
    setProgress(null);
    toast(t('bulkap.result', { ok, failed }));
  };

  const openBulk = async (id) => setBulk(await call('siteBulkGet', { id }));
  const counts = bulk ? bulk.children.reduce((a, c) => ({ ...a, [c.status]: (a[c.status] || 0) + 1 }), {}) : {};
  const sharedSelected = bulk?.children.some((c) => selected.has(c.workflowId) && (c.shared || []).length > 1);
  const toApply = bulk ? bulk.children.filter((c) => selected.has(c.workflowId) && c.status === 'planned') : [];
  const applied = bulk ? bulk.children.filter((c) => c.status === 'applied') : [];
  const projectsOf = (list) => {
    const keys = [...new Set(list.flatMap((c) => c.shared || []))];
    return keys.length > 8 ? `${keys.slice(0, 8).join(', ')} +${keys.length - 8}` : keys.join(', ') || '–';
  };

  const batchStatus = !bulk ? null : applied.length ? 'applied' : bulk.children.some((c) => c.status === 'rolledback') ? 'rolledback' : bulk.children.some((c) => c.status === 'failed') ? 'failed' : bulk.children.some((c) => c.status === 'planned') ? 'planned' : bulk.children.every((c) => c.status === 'invalid') ? 'invalid' : 'planned';
  const batchValid = !bulk ? null : { ok: bulk.children.some((c) => c.validationOk === true) ? true : bulk.children.some((c) => c.validationOk === false) ? false : null };
  const toggleTarget = (id) => { const n = new Set(targets); if (n.has(id)) n.delete(id); else n.add(id); setTargets(n); };
  const toggleSel = (id) => { const n = new Set(selected); if (n.has(id)) n.delete(id); else n.add(id); setSelected(n); };

  return (
    <div>
      <section className="card" aria-labelledby="bulk-title">
        <h2 id="bulk-title" className="row" style={{ gap: 10, margin: 0 }}><Icon name="layers" size={20} style={{ color: 'var(--accent)' }} />{t('bulkap.title')}</h2>
        <p className="muted" style={{ margin: '8px 0 0', maxWidth: '75ch' }}>{t('bulkap.intro')}</p>
      </section>
      {error && <div className="alert error view"><Icon name="alert" size={18} /><span>{error}</span></div>}
      {bulk?.children?.some((c) => c.needsConfirm && c.status === 'applied') && (
        <div className="alert view">
          <Icon name="alert" size={18} />
          <div className="row" style={{ flex: 1, justifyContent: 'space-between' }}>
            <span>{t('bulkap.overwriteHint', { n: bulk.children.filter((c) => c.needsConfirm && c.status === 'applied').length })}</span>
            <button type="button" className="btn small" disabled={!!busy} onClick={() => runRollback(true)}>{t('ap.confirmOverwriteYes')}</button>
          </div>
        </div>
      )}
      {progress && (
        <div className="card view" role="status" aria-live="polite">
          <div className="row" style={{ justifyContent: 'space-between' }}><span style={{ fontWeight: 500 }}>{progress.label}</span><span className="small muted num">{progress.done} / {progress.total}</span></div>
          <div className="bar" style={{ height: 8, margin: '10px 0 14px' }}><span style={{ width: `${(100 * progress.done) / Math.max(1, progress.total)}%`, animation: 'none', transition: 'width 500ms var(--ease)' }} /></div>
          <button type="button" className="btn small" onClick={() => { stopRef.current = true; }}><Icon name="stop" size={12} />{t('bulkap.stop')}</button>
        </div>
      )}

      {!bulk && (
        <div className="split">
          <section className="card side" style={{ marginBottom: 0 }} aria-labelledby="bulk-targets">
            <div className="card-head">
              <h2 id="bulk-targets" style={{ fontSize: 15 }}>{t('bulkap.targets')}</h2>
              <span className="tab-count">{targets.size}</span>
            </div>
            <div className="omnibox" style={{ width: '100%', flex: 'none', marginBottom: 10 }}>
              <Icon name="search" className="icon" />
              <input type="search" aria-label={t('im.filter')} placeholder={t('im.filter')} value={filter} onChange={(e) => setFilter(e.target.value)} style={{ paddingRight: 12 }} />
            </div>
            <div className="field" style={{ marginBottom: 10 }}>
              <span className="flabel small muted">{t('bulkap.uses')}</span>
              <div className="row" style={{ flexWrap: 'nowrap' }}>
                <select aria-label={t('im.col.type')} value={usesType} onChange={(e) => { setUsesType(e.target.value); setUsesId(''); }} style={{ flex: '0 0 auto' }}>{REF_TYPES.filter((x) => model.index[x]).map((x) => <option key={x} value={x}>{t(`ref.${x}`)}</option>)}</select>
                <select aria-label={t('bulkap.uses')} value={usesId} onChange={(e) => setUsesId(e.target.value)} style={{ flex: 1, minWidth: 0 }}><option value="">–</option>{usageEntries.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select>
              </div>
            </div>
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
              <label className="row" style={{ gap: 8, cursor: 'pointer' }}><input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} /> <span className="small">{t('bulkap.activeOnly')}</span></label>
              <span className="row" style={{ gap: 6 }}>
                <button type="button" className="btn small" onClick={() => setTargets(new Set([...targets, ...candidates.map((w) => w.id)]))}>{t('bulkap.selectShown', { n: candidates.length })}</button>
                <button type="button" className="btn small ghost" onClick={() => setTargets(new Set())}>{t('tt.none')}</button>
              </span>
            </div>
            <ul className="pick-list" aria-label={t('bulkap.targets')}>
              {candidates.map((w) => (
                <li key={w.id}>
                  <label className={targets.has(w.id) ? 'on' : ''}>
                    <input type="checkbox" checked={targets.has(w.id)} onChange={() => toggleTarget(w.id)} />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block' }}>{w.name}</span>
                      <span className="small muted">{w.projects.map((p) => p.key).join(', ') || t('site.inactive')} · {t(`ov.scope.${w.scope}`)}</span>
                    </span>
                  </label>
                </li>
              ))}
              {!candidates.length && <li className="empty" style={{ padding: 12 }}>{t('app.searchNoResults')}</li>}
            </ul>
          </section>

          <section className="card main" style={{ marginBottom: 0 }} aria-labelledby="bulk-change">
            <h2 id="bulk-change" style={{ fontSize: 15 }}>{t('bulkap.change')}</h2>
            <div className="row" style={{ gap: 6, marginBottom: 18 }} role="group" aria-label={t('bulkap.change')}>
              {TEMPLATES.filter((k) => aiOn || k !== 'ai').map((k) => <button key={k} type="button" aria-pressed={tpl === k} className={`chip ${tpl === k ? 'on' : ''}`} onClick={() => setTpl(k)}>{k === 'ai' && <Icon name="sparkle" size={13} />}{t(`bulkap.tpl.${k}`)}</button>)}
            </div>
            <div className="form-grid">
              {(tpl === 'removeRef' || tpl === 'replaceRef') && (
                <>
                  <div className="field"><label htmlFor="b-type">{t('im.col.type')}</label><select id="b-type" value={form.refType} onChange={(e) => set({ refType: e.target.value })}>{['group', 'role', 'user'].map((x) => <option key={x} value={x}>{t(`ref.${x}`)}</option>)}</select></div>
                  <div className="field"><label htmlFor="b-ref">{tpl === 'replaceRef' ? t('bulkap.replaceWhat') : t('bulkap.removeWhat')}</label><input id="b-ref" type="text" list="bulk-refs" value={form.ref} onChange={(e) => set({ ref: e.target.value })} /></div>
                  {tpl === 'replaceRef' && <div className="field"><label htmlFor="b-with">{t('bulkap.replaceWith')}</label><input id="b-with" type="text" list="bulk-targets" value={form.with} onChange={(e) => set({ with: e.target.value })} /></div>}
                  <datalist id="bulk-refs">{Object.values(model.index[form.refType] || {}).map((e) => <option key={e.id} value={e.name} />)}</datalist>
                  <datalist id="bulk-targets">{(form.refType === 'group' ? refData?.groups || [] : form.refType === 'role' ? refData?.roles || [] : refData?.users || []).slice(0, 800).map((e) => <option key={e.groupId || e.id || e.accountId} value={e.name || e.displayName} />)}</datalist>
                </>
              )}
              {tpl === 'resolutionDone' && <div className="field"><label htmlFor="b-res">Resolution</label><input id="b-res" type="text" value={form.resolution} onChange={(e) => set({ resolution: e.target.value })} /><span className="hint">{t('bulkap.tmSkipped')}</span></div>}
              {(tpl === 'restrict' || tpl === 'requireFields') && <div className="field"><label htmlFor="b-sel">{t('bulkap.selector')}</label><input id="b-sel" type="text" value={form.selector} onChange={(e) => set({ selector: e.target.value })} /><span className="hint">@all · @done · @global · @to:Status · @from:Status · @name:Text</span></div>}
              {tpl === 'restrict' && (
                <>
                  <div className="field"><label htmlFor="b-group">{t('ref.group')}</label><input id="b-group" type="text" list="bulk-targets-g" value={form.group} onChange={(e) => set({ group: e.target.value })} /><datalist id="bulk-targets-g">{(refData?.groups || []).slice(0, 800).map((g) => <option key={g.groupId} value={g.name} />)}</datalist></div>
                  <div className="field"><label htmlFor="b-role">{t('ref.role')}</label><input id="b-role" type="text" list="bulk-roles" value={form.role} onChange={(e) => set({ role: e.target.value })} /><datalist id="bulk-roles">{(refData?.roles || []).map((r) => <option key={r.id} value={r.name} />)}</datalist></div>
                </>
              )}
              {tpl === 'requireFields' && (
                <>
                  <div className="field"><label htmlFor="b-fields">{t('refs.field')}</label><input id="b-fields" type="text" value={form.fields} placeholder="Due date, customfield_10010" onChange={(e) => set({ fields: e.target.value })} /></div>
                  <div className="field"><label htmlFor="b-msg">{t('ap.tpl.message')}</label><input id="b-msg" type="text" value={form.message} onChange={(e) => set({ message: e.target.value })} /></div>
                </>
              )}
            </div>
            {aiOn && tpl === 'ai' && (
              <div className="stack">
                <label htmlFor="b-ai" className="sr-only">{t('bulkap.aiPlaceholder')}</label>
                <textarea id="b-ai" rows={3} style={{ width: '100%' }} value={form.instructions} placeholder={t('bulkap.aiPlaceholder')} onChange={(e) => set({ instructions: e.target.value })} />
                <div><button type="button" className={`btn primary ${busy === 'ai' ? 'busy' : ''}`} disabled={!form.instructions.trim() || !!busy} onClick={planAi}><Icon name="sparkle" />{t('ap.planCopilot')}</button></div>
                {ai?.explanation && <div className="note-box view"><AiLabel style={{ marginBottom: 6 }} /><p style={{ margin: 0 }}>{ai.explanation}</p></div>}
              </div>
            )}
            {tpl === 'json' && <><label htmlFor="b-json" className="sr-only">JSON</label><textarea id="b-json" rows={6} style={{ width: '100%', fontFamily: 'var(--mono)', fontSize: 12.5 }} value={json} placeholder='[{"op":"removeReference","refType":"group","ref":"old-group"}]' onChange={(e) => setJson(e.target.value)} /></>}
            <h3 style={{ margin: '20px 0 8px' }}>{t('ap.operations')}</h3>
            <code className="code-block">{opsValid ? JSON.stringify(ops, null, 1) : '–'}</code>
            <div className="action-bar">
              <button type="button" className={`btn primary ${busy === 'plan' ? 'busy' : ''}`} disabled={!opsValid || !targets.size || !!busy} onClick={runPlanning}><Icon name="eye" />{t('bulkap.dryRun', { n: targets.size })}</button>
              <span className="small muted">{t('bulkap.dryRunHint')}</span>
            </div>
          </section>
        </div>
      )}

      {bulk && (
        <section className="card view" aria-labelledby="bulk-run">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div style={{ minWidth: 0 }}>
              <h2 id="bulk-run" style={{ margin: 0 }}>{bulk.title}</h2>
              <div className="small muted">{t.date(bulk.createdAt)}{bulk.createdByName ? ` · ${bulk.createdByName}` : ''}</div>
            </div>
            <button type="button" className="btn small ghost" disabled={!!busy} onClick={() => { setBulk(null); setSelected(new Set()); }}><Icon name="undo" />{t('bulkap.new')}</button>
          </div>
          <div style={{ marginTop: 20 }}><LifecycleRail status={batchStatus} validation={batchValid} /></div>
          <div className="row" style={{ gap: 6, marginBottom: 14 }}>
            {Object.entries(counts).map(([k, v]) => <PlanStatus key={k} status={k} label={`${v} ${t(`ap.status.${k}`)}`} />)}
          </div>
          <div className="table-wrap">
            <table className="data" style={{ minWidth: 760 }}>
              <thead><tr><th style={{ width: 32 }}><span className="sr-only">{t('bulkap.targets')}</span></th><th>{t('app.workflow')}</th><th>{t('im.col.status')}</th><th>{t('ov.health')}</th><th className="num" style={{ textAlign: 'right' }}>{t('ap.changes')}</th><th>Jira</th><th>{t('ov.projects')}</th></tr></thead>
              <tbody>
                {bulk.children.map((c) => (
                  <tr key={c.workflowId} className={selected.has(c.workflowId) ? 'is-selected' : ''}>
                    <td><input type="checkbox" aria-label={c.workflowName || c.workflowId} disabled={c.status !== 'planned'} checked={selected.has(c.workflowId)} onChange={() => toggleSel(c.workflowId)} /></td>
                    <td><span style={{ fontWeight: 500 }}>{c.workflowName || c.workflowId}</span>{c.error && <div className="small" style={{ color: 'var(--high)' }}>{c.error}</div>}</td>
                    <td><PlanStatus status={c.status} label={t(`ap.status.${c.status}`)} /></td>
                    <td className="nowrap num">{c.healthBefore != null ? <>{c.healthBefore} <span className="muted">→</span> {c.healthAfter}</> : <span className="muted">–</span>}</td>
                    <td className="num" style={{ textAlign: 'right' }}>{c.changes ?? '–'}</td>
                    <td>{c.validationOk === true ? <Icon name="shieldCheck" label={t('ap.validOk')} style={{ color: 'var(--ok)' }} /> : c.validationOk === false ? <Icon name="alert" label={t('ap.validFail')} style={{ color: 'var(--high)' }} /> : <span className="muted">–</span>}</td>
                    <td className="small">{(c.shared || []).join(', ')}{(c.shared || []).length > 1 && <Icon name="users" size={13} label={t('bulkap.sharedConfirm')} style={{ marginLeft: 6, color: 'var(--medium)' }} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {sharedSelected && <label className="alert" style={{ marginTop: 14, cursor: 'pointer' }}><input type="checkbox" checked={confirmShared} onChange={(e) => setConfirmShared(e.target.checked)} /> <span>{t('bulkap.sharedConfirm')}</span></label>}

          {(toApply.length > 0 || applied.length > 0 || confirming) && (
            <div className="sel-bar" role="region" aria-label={t('bulkap.apply', { n: toApply.length })}>
              {confirming ? (
                <>
                  <span style={{ flex: '1 1 260px' }}>{confirming === 'apply' ? t('bulkap.confirmApply', { n: toApply.length, projects: projectsOf(toApply) }) : t('bulkap.confirmRollback', { n: applied.length, projects: projectsOf(applied) })}</span>
                  <button type="button" className="btn small" onClick={() => setConfirming(null)}>{t('ap.confirmNo')}</button>
                  <button type="button" className="btn primary" autoFocus onClick={() => (confirming === 'apply' ? runApply() : runRollback(false))}>{confirming === 'apply' ? t('ap.confirmYes') : t('ap.confirmRollbackYes')}</button>
                </>
              ) : (
                <>
                  <span>{t('bulkap.selected', { n: toApply.length })}</span>
                  <span className="muted small" style={{ flex: '1 1 200px' }}>{t('ap.safety')}</span>
                  {applied.length > 0 && <button type="button" className="btn small" disabled={!!busy} onClick={() => setConfirming('rollback')}><Icon name="undo" />{t('bulkap.rollbackAll', { n: applied.length })}</button>}
                  <button type="button" className={`btn primary ${busy === 'apply' ? 'busy' : ''}`} disabled={!!busy || !toApply.length || (sharedSelected && !confirmShared)} onClick={() => setConfirming('apply')}><Icon name="play" size={14} />{t('bulkap.apply', { n: toApply.length })}</button>
                </>
              )}
            </div>
          )}
        </section>
      )}

      {!bulk && history.length > 0 && (
        <section className="card flush" aria-labelledby="bulk-hist" style={{ marginTop: 20 }}>
          <h2 id="bulk-hist" style={{ fontSize: 15, padding: '18px 20px 10px', margin: 0 }}>{t('bulkap.history')}</h2>
          {history.map((h) => (
            <button key={h.id} type="button" className="impact-item" onClick={() => openBulk(h.id)}>
              <Icon name="layers" style={{ color: 'var(--text-muted)' }} />
              <span className="name" style={{ whiteSpace: 'normal', flex: 1 }}>
                <span style={{ display: 'block', fontWeight: 500 }}>{h.title}</span>
                <span className="small muted">{t.date(h.createdAt)} · {h.targets} {t('ov.workflows')}</span>
              </span>
              <span className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>{Object.entries(h.counts || {}).filter(([, v]) => v).map(([k, v]) => <PlanStatus key={k} status={k} label={`${v} ${t(`ap.status.${k}`)}`} />)}</span>
              <Icon name="chevronRight" style={{ color: 'var(--text-muted)' }} />
            </button>
          ))}
        </section>
      )}
    </div>
  );
}

function safeJson(s) {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : Array.isArray(v?.operations) ? v.operations : [];
  } catch {
    return [];
  }
}

function summarize(ops) {
  const o = ops[0] || {};
  return o.ref ? `: ${o.ref}${o.with ? ` → ${o.with}` : ''}` : o.transition ? ` (${o.transition})` : '';
}
