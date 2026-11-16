/**
 * Autopilot tab: create change plans from templates, the Copilot or auto-fix, review the dry run (diff and
 * health before/after), apply after confirmation and roll back. Handles hand-offs from other tabs, expired or
 * outdated plans and shared-workflow confirmation. While AI is effectively off, the free-text request, its
 * examples and "Plan with AI" / "Plan in Rovo chat" are not rendered (no notice): the tab then offers its non-AI
 * tools only – auto-fix, templates and the review/apply/rollback of plans.
 *
 * @file        static/app/src/components/Autopilot.jsx
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-24
 * @updated     2026-11-16
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../lib/i18n.jsx';
import { useApp, useAiOn, LifecycleRail, EmptyState, Skeleton, AiLabel, aiErrorText } from './common.jsx';
import Icon from './Icon.jsx';
import { call } from '../lib/api.js';
import { openRovo } from './Assistant.jsx';
import { findingText } from '../../../../src/shared/i18n.js';

// Status pills: quiet tint + ink text (reference), the meaning carried by the word and a dot
export const STATUS_TINT = { planned: 'var(--tint-blue)', applying: 'var(--tint-orange)', applied: 'var(--tint-green)', failed: 'var(--high-bg)', invalid: 'var(--high-bg)', rolledback: 'var(--tint-amber)', discarded: 'var(--tint-stone)', nochange: 'var(--tint-stone)', pending: 'var(--tint-stone)' };
export const STATUS_DOT = { planned: 'var(--low)', applying: 'var(--accent)', applied: 'var(--ok)', failed: 'var(--high)', invalid: 'var(--high)', rolledback: 'var(--medium)', discarded: 'var(--text-faint)', nochange: 'var(--text-faint)', pending: 'var(--text-faint)' };
const SOURCE_ICON = { copilot: 'sparkle', rovo: 'message', autofix: 'wand', ui: 'list', bulk: 'layers' };
const PLAN_TTL_MS = 7 * 24 * 3600 * 1000; // the server refuses to apply older plans
export const isExpired = (p) => p?.status === 'planned' && Date.now() - new Date(p.createdAt).getTime() > PLAN_TTL_MS;
const versionOf = (v) => (v && typeof v === 'object' ? v.versionNumber : v) ?? null;
// Hand-offs from other tabs are handled once, even when the tab is opened again later
let handledIntentAt = 0;

export function PlanStatus({ status, label }) {
  return (
    <span className="chip" style={{ background: STATUS_TINT[status] || 'var(--tint-stone)' }}>
      <span className="dot" style={{ background: STATUS_DOT[status] || 'var(--text-faint)' }} />
      {label}
    </span>
  );
}

export default function Autopilot({ model, workflows, allWorkflows = workflows, bundle, toast, intent, reload }) {
  const t = useT();
  const { actions, ai } = useApp();
  const aiOn = useAiOn();
  const [wfId, setWfId] = useState(workflows.length === 1 ? workflows[0].id : workflows[0]?.id || '');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(null);
  const [plans, setPlans] = useState(null);
  const [sel, setSel] = useState(null);
  const [plan, setPlan] = useState(null);
  const [aiNote, setAiNote] = useState(null);
  const [confirmShared, setConfirmShared] = useState(false);
  const [error, setError] = useState(null);
  const [tpl, setTpl] = useState(null);
  const [confirming, setConfirming] = useState(null); // 'apply' | 'rollback' | 'overwrite' – inline confirmation
  const [reuseTo, setReuseTo] = useState(null); // target workflow id while 'use on another workflow' is open
  const pendingConfirm = useRef(null);
  const scrollToPlan = useRef(null);
  const textRef = useRef(null);
  const wf = workflows.find((w) => w.id === wfId) || workflows[0];

  const refresh = useCallback(async () => {
    try { setPlans(await call('listPlans')); } catch { setPlans([]); }
  }, []);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 8000); // pick up plans created by the Rovo agent
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    if (!sel) { setPlan(null); return; }
    setConfirmShared(false);
    setConfirming(null);
    setReuseTo(null);
    call('getPlan', { id: sel }).then((p) => {
      setPlan(p);
      if (p && pendingConfirm.current?.id === p.id) { setConfirming(pendingConfirm.current.what); pendingConfirm.current = null; }
      // A plan handed over from another tab sits below the request form: bring it into view
      if (p && scrollToPlan.current === p.id) {
        scrollToPlan.current = null;
        setTimeout(() => document.getElementById('ap-plan-title')?.closest('article')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
      }
    }).catch((e) => setError(e.message));
  }, [sel, plans?.find((p) => p.id === sel)?.status]);

  // Arrivals from Health (a fix plan, or a request for the Copilot) and from the Undo button of a toast
  useEffect(() => {
    if (!intent || intent.at <= handledIntentAt) return;
    handledIntentAt = intent.at;
    if (intent.planId) {
      if (intent.confirm && plan?.id === intent.planId) setConfirming(intent.confirm);
      else {
        pendingConfirm.current = intent.confirm ? { id: intent.planId, what: intent.confirm } : null;
        scrollToPlan.current = intent.planId;
        refresh().then(() => setSel(intent.planId));
      }
    }
    // A request for the Copilot is only taken over while AI is on (its sender is hidden otherwise)
    if (intent.text && aiOn) {
      setText(intent.text);
      if (intent.wfId && workflows.some((w) => w.id === intent.wfId)) setWfId(intent.wfId);
      setTimeout(() => { textRef.current?.focus(); textRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, 60);
    }
  }, [intent]);

  const run = async (label, fn) => {
    setBusy(label);
    setError(null);
    try { return await fn(); } catch (e) { setError(e.code === 'SHARED_CONFIRM' ? t('ap.sharedConfirm') : e.code === 'FORBIDDEN_CHANGE_GLOBAL' ? t('role.cannotChange') : aiErrorText(t, e, ai)); return null; } finally { setBusy(null); }
  };

  const planWithCopilot = () => aiOn && run('ai', async () => {
    const res = await call('aiPlan', { instructions: text, workflowId: wf?.id, lang: t.lang });
    setAiNote({ explanation: res.explanation, model: res.model });
    if (res.plan) { await refresh(); setSel(res.plan.id); }
  });
  const planInRovo = () => aiOn && openRovo(t('ap.rovoPrompt', { key: model.project?.key, wf: wf?.name, text })).catch(() => toast(t('app.rovoUnavailable')));
  const autofix = () => run('autofix', async () => { const p = await call('autofixPlan', { workflowId: wf?.id, lang: t.lang }); await refresh(); setSel(p.id); });
  const createFromOps = (ops, instructions) => run('tpl', async () => { const p = await call('createPlan', { workflowId: wf?.id, ops, instructions, lang: t.lang }); setTpl(null); await refresh(); setSel(p.id); });
  // Same operations on the workflow as it is now (plan expired, or the workflow changed since planning)
  const replan = () => run('replan', async () => {
    const p = await call('replanPlan', { id: plan.id, lang: t.lang });
    await refresh();
    setSel(p.id);
    toast(t('ap.replanned'));
  });
  const reuse = () => run('reuse', async () => {
    const target = allWorkflows.find((w) => w.id === reuseTo);
    const p = await call('createPlan', { workflowId: reuseTo, ops: plan.ops, instructions: plan.instructions || plan.title, lang: t.lang });
    setReuseTo(null);
    await refresh();
    setSel(p.id);
    toast(t('ap.reused', { wf: target?.name || p.workflowName }));
  });
  const apply = () => run('apply', async () => {
    setConfirming(null);
    setPlan((p) => ({ ...p, status: 'applying' }));
    const p = await call('applyPlan', { id: plan.id, confirmShared }).catch((e) => { setPlan((x) => ({ ...x, status: 'planned' })); throw e; });
    setPlan(p);
    await refresh();
    // Undo right where the success is reported; it opens the rollback confirmation of this plan
    toast(p.status === 'applied' ? t('ap.applied') : t('ap.failed'), p.status === 'applied' && mayChange ? { label: t('ap.undo'), icon: 'undo', run: () => actions.planChange({ planId: p.id, confirm: 'rollback' }) } : null);
    if (p.status === 'applied') reload();
  });
  const rollback = (confirmOverwrite = false) => run('rollback', async () => {
    setConfirming(null);
    let p;
    try {
      p = await call('rollbackPlan', { id: plan.id, confirmOverwrite });
    } catch (e) {
      // Someone changed the workflow after the apply: ask again before also undoing their changes
      if (e.code === 'ROLLBACK_CONFIRM') { setConfirming('overwrite'); return; }
      throw e;
    }
    setPlan(p);
    await refresh();
    toast(t('ap.rolledBack'));
    reload();
  });
  const discard = () => run('discard', async () => { await call('discardPlan', { id: plan.id }); await refresh(); setSel(null); });

  // Examples built from this workflow's real names
  const exStatus = wf?.statuses.find((s) => s.category === 'IN_PROGRESS')?.name || wf?.statuses[0]?.name || '';
  const exTransition = wf?.transitions.find((x) => x.to && wf.statuses.find((s) => s.ref === x.to.ref)?.category === 'DONE')?.name || wf?.transitions[0]?.name || '';
  const exDone = wf?.statuses.find((s) => s.category === 'DONE')?.name || 'Done';
  // Team-managed spaces set the resolution automatically – offer a restriction example instead
  const exampleTexts = [t('ap.ex1', { status: exStatus }), t('ap.ex2', { transition: exTransition }), wf?.scope === 'PROJECT' ? t('ap.ex3tm', { status: exDone }) : t('ap.ex3'), t('ap.ex4')];
  const delta = plan ? plan.healthAfter - plan.healthBefore : 0;
  // The user's right to change the plan's workflow (server checks again on apply/rollback)
  const planWf = plan ? model.workflows.find((w) => String(w.id) === String(plan.workflowId)) || { scope: plan.scope } : null;
  const mayChange = plan ? actions.canChange?.(planWf) !== false : true;
  const sharedNamed = plan ? plan.sharedProjects.filter((p) => p.key).map((p) => p.key) : [];
  const sharedHidden = plan ? plan.sharedProjects.length - sharedNamed.length : 0;
  // Is the plan still current? Expired plans cannot be applied; a newer workflow version is re-checked on apply
  const expired = isExpired(plan);
  const outdated = plan?.status === 'planned' && !expired && planWf?.version != null && versionOf(plan.baseVersion) != null && String(versionOf(plan.baseVersion)) !== String(planWf.version);
  // Auto-fix plans address transitions by this workflow's IDs, so they do not carry over to another workflow
  const reuseTargets = plan && plan.source !== 'autofix' ? allWorkflows.filter((w) => String(w.id) !== String(plan.workflowId) && actions.canChange?.(w)) : [];

  return (
    <div>
      <section className="card" aria-labelledby="ap-title">
        <div className="card-head">
          <h2 id="ap-title" className="row" style={{ gap: 10 }}><Icon name={aiOn ? 'sparkle' : 'wand'} size={20} style={{ color: 'var(--accent)' }} />{aiOn ? t('ap.title') : t('ap.titleNoAi')}</h2>
          {workflows.length > 1 && (
            <select value={wf?.id} onChange={(e) => setWfId(e.target.value)} aria-label={t('app.workflow')} style={{ maxWidth: 360 }}>{workflows.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
          )}
        </div>
        <p className="muted" style={{ marginTop: -6, maxWidth: '75ch' }}>{aiOn ? t('ap.intro') : t('ap.introNoAi')}</p>
        {wf && !actions.canChange?.(wf) && (
          <div className="alert info"><Icon name="lock" size={18} /><span className="small">{t('role.cannotChange')}</span></div>
        )}
        {aiOn && (
          <>
            <label htmlFor="ap-text" className="sr-only">{t('ap.placeholder')}</label>
            <textarea id="ap-text" ref={textRef} autoFocus rows={4} style={{ width: '100%', fontSize: 15 }} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('ap.placeholder')} />
            <div className="row" style={{ marginTop: 10, gap: 6 }}>
              {exampleTexts.map((x) => <button key={x} type="button" className="chip ref" onClick={() => setText(x)}>{x}</button>)}
            </div>
          </>
        )}
        <div className="row" style={{ marginTop: aiOn ? 16 : 4, gap: 10 }}>
          {aiOn && <button type="button" className={`btn primary ${busy === 'ai' ? 'busy' : ''}`} disabled={!text.trim() || !!busy} onClick={planWithCopilot}><Icon name="sparkle" />{t('ap.planCopilot')}</button>}
          {aiOn && <button type="button" className="btn dark" disabled={!text.trim()} onClick={planInRovo}><Icon name="message" />{t('ap.planRovo')}</button>}
          {aiOn && <span className="spacer" />}
          <button type="button" className={`btn ${aiOn ? '' : 'primary'} ${busy === 'autofix' ? 'busy' : ''}`} disabled={!!busy} onClick={autofix}><Icon name="wand" />{t('ap.autofix')}</button>
          <button type="button" className={`btn ${tpl ? 'on' : ''}`} aria-expanded={!!tpl} onClick={() => setTpl(tpl ? null : 'cancel')}><Icon name="file" />{t('ap.templates')}</button>
        </div>
        {aiOn && busy === 'ai' && (
          <div className="note-box" style={{ marginTop: 14 }} role="status">
            <span className="row" style={{ gap: 10 }}><span className="typing" aria-hidden="true"><i /><i /><i /></span>{t('ap.thinking')}</span>
          </div>
        )}
        {aiOn && aiNote && busy !== 'ai' && (
          <div className="note-box view" style={{ marginTop: 14 }}>
            <p className="ai-badge" style={{ margin: '0 0 6px', flexWrap: 'wrap' }}><Icon name="sparkle" />Copilot <span className="small muted" style={{ fontWeight: 400 }}>({aiNote.model})</span><AiLabel /></p>
            <p style={{ margin: 0, maxWidth: '75ch' }}>{aiNote.explanation}</p>
          </div>
        )}
        {tpl && <Templates wf={wf} bundle={bundle} tpl={tpl} setTpl={setTpl} onCreate={createFromOps} busy={busy === 'tpl'} />}
      </section>

      {error && <div className="alert error view"><Icon name="alert" size={18} /><span>{error}</span></div>}

      <div className="split">
        <section className="side card flush plans-side" aria-labelledby="ap-plans">
          <div className="card-head" style={{ padding: '18px 18px 0', marginBottom: 10 }}>
            <h2 id="ap-plans" style={{ fontSize: 15 }}>{t('ap.plans')}</h2>
            <button type="button" className="btn small ghost" onClick={refresh} aria-label={t('app.refresh')}><Icon name="refresh" /></button>
          </div>
          {plans === null && <div className="stack" style={{ padding: '0 18px 18px' }}>{[0, 1, 2].map((i) => <Skeleton key={i} h={44} />)}</div>}
          {plans?.length === 0 && <EmptyState icon={aiOn ? 'sparkle' : 'file'} title={aiOn ? t('ap.noPlans') : t('ap.noPlansNoAi')} />}
          <div role="listbox" aria-label={t('ap.plans')} style={{ maxHeight: 'calc(100vh - 260px)', overflow: 'auto', borderTop: plans?.length ? '1px solid var(--border)' : 0 }}>
            {plans?.map((p) => (
              <button key={p.id} type="button" role="option" className="impact-item" aria-selected={sel === p.id} onClick={() => setSel(p.id)} style={{ alignItems: 'flex-start' }}>
                <Icon name={SOURCE_ICON[p.source] || 'list'} style={{ color: 'var(--text-muted)', marginTop: 3 }} label={t(`ap.source.${p.source}`)} />
                <span className="name" style={{ whiteSpace: 'normal', flex: 1 }}>
                  <span className="clamp-2" title={p.title} style={{ fontWeight: 500, lineHeight: 1.35 }}>{p.title}</span>
                  <span className="small muted" style={{ display: 'block' }}>{p.opCount === 1 ? t('ap.opCount1') : t('ap.opCount', { n: p.opCount ?? '–' })} · {t.date(p.createdAt)}</span>
                </span>
                <span className="plan-status" style={{ flex: 'none' }}>{isExpired(p) ? <PlanStatus status="discarded" label={t('ap.status.expired')} /> : <PlanStatus status={p.status} label={t(`ap.status.${p.status}`)} />}</span>
              </button>
            ))}
          </div>
        </section>

        <div className="main">
          {!plan && (
            <div className="card dashed">
              <EmptyState icon="arrowRight" title={t('ap.pickPlan')} />
            </div>
          )}
          {plan && (
            <article className="card view" key={plan.id} aria-labelledby="ap-plan-title">
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'nowrap', gap: 16 }}>
                <div style={{ minWidth: 0 }}>
                  <div className="small muted row" style={{ gap: 6 }}><Icon name={SOURCE_ICON[plan.source] || 'list'} size={14} />{t(`ap.source.${plan.source}`)} · {t.date(plan.createdAt)}{plan.createdByName ? ` · ${plan.createdByName}` : ''}{plan.source === 'copilot' && <AiLabel />}</div>
                  <h2 id="ap-plan-title" className="clamp-3" title={plan.instructions || plan.title} style={{ margin: '4px 0 4px', fontSize: 20 }}>{plan.title}</h2>
                  <div className="small">{t('app.workflow')}: <strong>{plan.workflowName}</strong></div>
                </div>
                <span className="plan-status" style={{ flex: 'none' }}>{expired ? <PlanStatus status="discarded" label={t('ap.status.expired')} /> : <PlanStatus status={plan.status} label={t(`ap.status.${plan.status}`)} />}</span>
              </div>

              {(expired || outdated) && (
                <div className="alert view" style={{ marginTop: 18 }}>
                  <Icon name="history" size={18} />
                  <div className="stack" style={{ gap: 8, flex: 1 }}>
                    <span>{expired ? t('ap.expiredHint') : t('ap.outdatedHint', { from: versionOf(plan.baseVersion), to: planWf.version })}</span>
                    {mayChange && <div><button type="button" className={`btn small primary ${busy === 'replan' ? 'busy' : ''}`} disabled={!!busy} onClick={replan}><Icon name="refresh" />{t('ap.replan')}</button></div>}
                  </div>
                </div>
              )}

              <div style={{ marginTop: 22 }}>
                <LifecycleRail status={plan.status} validation={plan.validation} />
              </div>

              {plan.explanation && (
                <div className="note-box" style={{ marginBottom: 16 }}>
                  {plan.explanationLang && plan.explanationLang !== t.lang && <p className="small muted" style={{ margin: '0 0 6px' }}>{t('ap.writtenIn', { lang: t(`lang.${plan.explanationLang}`) })}</p>}
                  <p style={{ margin: 0, maxWidth: '75ch' }} lang={plan.explanationLang || undefined}>{plan.explanation}</p>
                </div>
              )}

              <div className="grid kpis compact">
                <div className="tile ink">
                  <span className="l">{t('ov.health')}</span>
                  <span className="v">{plan.healthBefore} <span style={{ color: 'var(--tile-muted)' }}>→</span> {plan.healthAfter}</span>
                  <span className="s">{delta >= 0 ? `+${delta}` : delta}</span>
                </div>
                <div className="tile"><span className="l">{t('ap.changes')}</span><span className="v">{plan.changes.length}</span></div>
                <div className="tile"><span className="l">{t('ap.fixed')}</span><span className="v">{plan.fixed.length}</span></div>
                <div className="tile"><span className="l">{t('ap.introduced')}</span><span className="v" style={{ color: plan.introduced.length ? 'var(--high)' : undefined }}>{plan.introduced.length}</span></div>
              </div>

              {plan.validation?.ok === true && plan.status === 'planned' && (
                <div className="alert ok"><Icon name="shieldCheck" size={18} /><span>{t('ap.validOk')}</span></div>
              )}
              {plan.validation?.ok === false && (
                <div className="alert error">
                  <Icon name="alert" size={18} />
                  <div className="stack" style={{ gap: 4 }}>
                    <strong>{t('ap.validFail')}</strong>
                    {plan.validation.errors.map((e, i) => <div key={i} className="small">{e}</div>)}
                    {plan.scope === 'PROJECT' && <div className="small muted">{t('ap.teamManagedHint')}</div>}
                  </div>
                </div>
              )}
              {plan.validation?.unavailable && <div className="alert info"><Icon name="info" size={18} /><span className="small">{t('ap.validUnavailable')}</span></div>}
              {plan.sharedProjects.length > 1 && (
                <div className="alert">
                  <Icon name="users" size={18} />
                  <div className="stack" style={{ gap: 8 }}>
                    <span>{t('ap.shared', { list: [...sharedNamed, ...(sharedHidden ? [t('ap.sharedHidden', { n: sharedHidden })] : [])].join(', ') })}</span>
                    {plan.status === 'planned' && mayChange && <label className="row" style={{ gap: 10, cursor: 'pointer' }}><input type="checkbox" checked={confirmShared} onChange={(e) => setConfirmShared(e.target.checked)} /> {t('ap.sharedCheck')}</label>}
                  </div>
                </div>
              )}

              <h3 style={{ margin: '20px 0 8px' }}>{t('ap.operations')}</h3>
              <ul className="op-list">
                {(plan.applyResults || plan.results).map((r, i) => (
                  <li key={i} className={r.ok ? 'ok' : 'bad'}>
                    <Icon name={r.ok ? 'check' : 'x'} size={15} strokeWidth={2.25} label={r.ok ? 'OK' : t('ap.failed')} />
                    <code>{r.op.op}</code>
                    <span className="small">{r.message}</span>
                  </li>
                ))}
              </ul>

              {plan.changes.length > 0 && (
                <>
                  <h3 style={{ margin: '20px 0 8px' }}>{t('ap.preview')}</h3>
                  <div className="card preview flush" style={{ marginBottom: 16 }}>
                    <table className="data">
                      <tbody>
                        {plan.changes.map((c, i) => (
                          <tr key={i}>
                            <td className="nowrap" style={{ paddingLeft: 16, width: 1 }}><span className={`chip ${c.op === 'added' ? 'green' : c.op === 'removed' ? 'orange' : 'amber'}`}>{t(`ch.op.${c.op}`)}</span></td>
                            <td className="nowrap small muted" style={{ width: 1 }}>{t(`ch.type.${c.type}`)}</td>
                            <td className="small" style={{ paddingRight: 16 }}><strong>{c.name}</strong>{c.detail?.rule ? ` · ${c.detail.rule.replace(/rule\.\w+/, (k) => t(k))}` : ''}{c.detail?.field ? ` · ${t(`ch.field.${c.detail.field}`)}: ${c.detail.from ?? '–'} → ${c.detail.to ?? '–'}` : ''}{c.detail?.path ? ` · ${c.detail.path}` : ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              {(plan.fixed.length > 0 || plan.introduced.length > 0 || plan.manual?.length > 0) && (
                <div className="grid two" style={{ marginBottom: 16, gap: 12 }}>
                  {(plan.fixed.length > 0 || plan.introduced.length > 0) && (
                    <div className="note-box">
                      {plan.fixed.length > 0 && <div className="small cap-first" style={{ fontWeight: 500, marginBottom: 4 }}>{t('ap.fixed')}</div>}
                      {plan.fixed.map((f) => <div key={f.id} className="small row" style={{ gap: 6, flexWrap: 'nowrap' }}><Icon name="check" size={14} style={{ color: 'var(--ok)' }} />{findingText(t.lang, f).title}</div>)}
                      {plan.introduced.length > 0 && <div className="small cap-first" style={{ fontWeight: 500, margin: '8px 0 4px' }}>{t('ap.introduced')}</div>}
                      {plan.introduced.map((f) => <div key={f.id} className="small row" style={{ gap: 6, flexWrap: 'nowrap' }}><Icon name="alert" size={14} style={{ color: 'var(--high)' }} />{findingText(t.lang, f).title}</div>)}
                    </div>
                  )}
                  {plan.manual?.length > 0 && (
                    <div className="note-box">
                      <div className="small" style={{ fontWeight: 500, marginBottom: 4 }}>{t('ap.manual')}</div>
                      {plan.manual.map((f) => <div key={f.id} className="small">{findingText(t.lang, f).title}</div>)}
                    </div>
                  )}
                </div>
              )}

              {/* The workflow fix only helps future transitions: point at the existing issues that are still wrong */}
              {plan.status === 'applied' && plan.fixed.some((f) => /RESOLUTION/.test(f.code)) && actions.resAudit && actions.resAudit.doneUnresolved + actions.resAudit.openResolved > 0 && (
                <div className="alert">
                  <Icon name="info" size={18} />
                  <span style={{ flex: 1 }}>{actions.resAudit.doneUnresolved + actions.resAudit.openResolved === 1 ? t('rs.afterFix1') : t('rs.afterFix', { n: actions.resAudit.doneUnresolved + actions.resAudit.openResolved })}</span>
                  <button type="button" className="btn small primary" onClick={actions.openResolutions}><Icon name="wand" />{t('rs.bannerAction')}</button>
                </div>
              )}
              {plan.errors?.length > 0 && <div className="alert error"><Icon name="alert" size={18} /><div className="stack" style={{ gap: 4 }}>{plan.errors.map((e, i) => <div key={i}>{e}</div>)}</div></div>}
              {plan.warnings?.length > 0 && <div className="alert"><Icon name="info" size={18} /><div className="stack" style={{ gap: 4 }}>{plan.warnings.map((e, i) => <div key={i}>{e}</div>)}</div></div>}

              <div className="action-bar">
                {!mayChange && ['planned', 'applied'].includes(plan.status) && (
                  <span className="row small" style={{ gap: 8, flexWrap: 'nowrap', color: 'var(--text-muted)' }}><Icon name="lock" />{t('role.cannotChange')}</span>
                )}
                {mayChange && plan.status === 'planned' && !confirming && (
                  <button type="button" className="btn primary" disabled={!!busy || expired || (plan.sharedProjects.length > 1 && !confirmShared) || !plan.results.some((r) => r.ok && !r.noop)} onClick={() => setConfirming('apply')}>
                    <Icon name="play" size={14} />{t('ap.apply')}
                  </button>
                )}
                {busy === 'apply' && <button type="button" className="btn primary busy" disabled>{t('ap.applying')}</button>}
                {confirming && (
                  <div className="confirm" role="alertdialog" aria-label={t('ap.confirmApply', { wf: plan.workflowName })}>
                    <Icon name={confirming === 'apply' ? 'play' : 'undo'} size={16} />
                    <span className="small">{confirming === 'apply' ? t('ap.confirmApply', { wf: plan.workflowName }) : confirming === 'overwrite' ? t('ap.confirmOverwrite') : t('ap.confirmRollback')}</span>
                    <button type="button" className="btn small primary" autoFocus onClick={confirming === 'apply' ? apply : () => rollback(confirming === 'overwrite')}>{confirming === 'apply' ? t('ap.confirmYes') : confirming === 'overwrite' ? t('ap.confirmOverwriteYes') : t('ap.confirmRollbackYes')}</button>
                    <button type="button" className="btn small" onClick={() => setConfirming(null)}>{t('ap.confirmNo')}</button>
                  </div>
                )}
                {(plan.status === 'planned' || plan.status === 'invalid' || plan.status === 'nochange') && !confirming && <button type="button" className="btn" disabled={!!busy} onClick={discard}>{t('ap.discard')}</button>}
                {mayChange && plan.status === 'applied' && !confirming && <button type="button" className={`btn ${busy === 'rollback' ? 'busy' : ''}`} disabled={!!busy} onClick={() => setConfirming('rollback')}><Icon name="undo" />{t('ap.rollback')}</button>}
                {plan.status === 'applied' && <button type="button" className="btn ghost" onClick={() => actions.setTab('diagram')}><Icon name="diagram" />{t('tab.diagram')}</button>}
                {!confirming && reuseTo === null && reuseTargets.length > 0 && plan.ops.length > 0 && plan.status !== 'applying' && (
                  <button type="button" className="btn ghost" disabled={!!busy} onClick={() => setReuseTo(reuseTargets[0].id)}><Icon name="copy" />{t('ap.reuse')}</button>
                )}
                {reuseTo !== null && (
                  <div className="confirm" role="group" aria-label={t('ap.reuse')}>
                    <Icon name="copy" size={16} />
                    <label className="small" htmlFor="ap-reuse">{t('ap.reuseTo')}</label>
                    <select id="ap-reuse" value={reuseTo} onChange={(e) => setReuseTo(e.target.value)} style={{ maxWidth: 260 }}>{reuseTargets.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
                    <button type="button" className={`btn small primary ${busy === 'reuse' ? 'busy' : ''}`} disabled={!!busy} onClick={reuse}>{t('ap.createPlan')}</button>
                    <button type="button" className="btn small" onClick={() => setReuseTo(null)}>{t('ap.confirmNo')}</button>
                  </div>
                )}
                <span className="small muted" style={{ marginLeft: 'auto' }}>{t('ap.safety')}</span>
              </div>
            </article>
          )}
        </div>
      </div>
    </div>
  );
}

function Templates({ wf, bundle, tpl, setTpl, onCreate, busy }) {
  const t = useT();
  const doneStatuses = wf.statuses.filter((s) => s.category === 'DONE');
  const roles = bundle?.ref?.roles || [];
  const groups = bundle?.ref?.groups || [];
  const fields = useMemo(() => (bundle?.ref?.fields || []).filter((f) => f.custom || ['assignee', 'duedate', 'description', 'components', 'fixVersions', 'priority', 'labels'].includes(f.id)).sort((a, b) => a.name.localeCompare(b.name)), [bundle]);
  const [f, setF] = useState({ name: t('ap.tpl.cancelName'), to: doneStatuses[0]?.name || '', role: '', group: '', transition: wf.transitions[0]?.id || '', fields: [], message: '' });
  const set = (p) => setF((x) => ({ ...x, ...p }));
  const tabs = ['cancel', 'require', 'restrict'];
  const build = () => {
    if (tpl === 'cancel') return [{ op: 'addTransition', name: f.name, from: 'any', to: f.to }, ...(f.role || f.group ? [{ op: 'restrictTransition', transition: f.name, roles: f.role ? [f.role] : [], groups: f.group ? [f.group] : [] }] : [])];
    if (tpl === 'require') return [{ op: 'requireFields', transition: f.transition, fields: f.fields, message: f.message || undefined }];
    return [{ op: 'restrictTransition', transition: f.transition, roles: f.role ? [f.role] : [], groups: f.group ? [f.group] : [] }];
  };
  return (
    <div className="note-box view" style={{ marginTop: 16, padding: 20 }}>
      <div className="seg" role="group" aria-label={t('ap.templates')} style={{ marginBottom: 16, background: 'var(--surface)' }}>
        {tabs.map((k) => <button key={k} type="button" aria-pressed={tpl === k} onClick={() => setTpl(k)}>{t(`ap.tpl.${k}`)}</button>)}
      </div>
      <div className="form-grid">
        {tpl === 'cancel' && (
          <>
            <div className="field"><label htmlFor="tpl-name">{t('tt.col.transition')}</label><input id="tpl-name" type="text" value={f.name} onChange={(e) => set({ name: e.target.value })} /></div>
            <div className="field"><label htmlFor="tpl-to">{t('tt.col.target')}</label><select id="tpl-to" value={f.to} onChange={(e) => set({ to: e.target.value })}>{wf.statuses.map((s) => <option key={s.ref} value={s.name}>{s.name}</option>)}</select></div>
          </>
        )}
        {tpl !== 'cancel' && (
          <div className="field"><label htmlFor="tpl-tr">{t('tt.col.transition')}</label><select id="tpl-tr" value={f.transition} onChange={(e) => set({ transition: e.target.value })}>{wf.transitions.map((x) => <option key={x.key} value={x.id}>{x.name} ({x.from.map((s) => s.name).join(', ') || '*'} → {x.to?.name})</option>)}</select></div>
        )}
        {tpl !== 'require' && (
          <>
            <div className="field"><label htmlFor="tpl-role">{t('ref.role')}</label><select id="tpl-role" value={f.role} onChange={(e) => set({ role: e.target.value })}><option value="">–</option>{roles.map((r) => <option key={r.id} value={r.name}>{r.name}</option>)}</select></div>
            <div className="field"><label htmlFor="tpl-group">{t('ref.group')}</label><select id="tpl-group" value={f.group} onChange={(e) => set({ group: e.target.value })}><option value="">–</option>{groups.slice(0, 500).map((g) => <option key={g.groupId} value={g.name}>{g.name}</option>)}</select></div>
          </>
        )}
        {tpl === 'require' && (
          <>
            <div className="field"><label htmlFor="tpl-fields">{t('refs.field')}</label><select id="tpl-fields" multiple size={5} value={f.fields} onChange={(e) => set({ fields: [...e.target.selectedOptions].map((o) => o.value) })} style={{ width: '100%', padding: 6, backgroundImage: 'none' }}>{fields.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></div>
            <div className="field"><label htmlFor="tpl-msg">{t('ap.tpl.message')}</label><input id="tpl-msg" type="text" value={f.message} onChange={(e) => set({ message: e.target.value })} /></div>
          </>
        )}
      </div>
      <div className="row" style={{ marginTop: 16 }}>
        <button type="button" className={`btn primary ${busy ? 'busy' : ''}`} disabled={busy || (tpl === 'require' && !f.fields.length) || (tpl === 'restrict' && !f.role && !f.group)} onClick={() => onCreate(build(), `${t(`ap.tpl.${tpl}`)}: ${tpl === 'cancel' ? f.name : wf.transitions.find((x) => x.id === f.transition)?.name || ''}`)}>{t('ap.createPlan')}</button>
        <button type="button" className="btn ghost" onClick={() => setTpl(null)}>{t('tt.close')}</button>
      </div>
    </div>
  );
}
