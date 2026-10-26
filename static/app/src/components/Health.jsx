import { useMemo, useState } from 'react';
import { useT } from '../lib/i18n.jsx';
import { useApp, SevBadge, ScoreRing, scoreLabelKey, EmptyState } from './common.jsx';
import Icon from './Icon.jsx';
import { findingText } from '../../../../src/shared/i18n.js';
import { findingFingerprint, findingKey } from '../../../../src/shared/insights.js';
import { autofixOperations } from '../../../../src/shared/autopilot.js';
import { openIssue } from './Remediate.jsx';

export default function Health({ model, workflows, sev, setSev, focus = null, remediation = {}, siteUrl, resolutions = [], dataCard = null }) {
  const t = useT();
  const { actions, caps } = useApp();
  const [busy, setBusy] = useState(null); // 'all' or a finding id while its fix plan is created
  const ids = new Set(workflows.map((w) => w.id));
  const inScope = model.findings.filter((f) => ids.has(f.wfId));
  // focus: a finding code (from the action plan) or { keys, label } (e.g. the findings new since the last visit)
  const inFocus = (f) => (typeof focus === 'string' ? f.code === focus : focus.keys.has(findingKey(f)));
  const all = focus ? inScope.filter(inFocus) : inScope;
  const list = sev === 'all' ? all : all.filter((f) => f.severity === sev);
  const counts = { high: 0, medium: 0, low: 0, info: 0 };
  for (const f of all) counts[f.severity]++;
  // Remediation tasks are created with the user's own Jira permission (Create issues)
  const canRemediate = model.kind === 'project' && caps?.createTasks !== false;
  // Project page: Autopilot plans per workflow; site page: a bulk change (Jira admins). The server checks the role again.
  const mayChange = (f) => (model.kind === 'project' ? actions.canChange?.(model.workflows.find((w) => w.id === f.wfId)) === true : caps?.bulk === true);
  const fixable = useMemo(() => {
    const out = new Set();
    for (const f of model.findings) if (f.severity !== 'info' && autofixOperations(model, [f], resolutions || []).ops.length) out.add(f.id);
    return out;
  }, [model, resolutions]);
  const fixNow = list.filter((f) => fixable.has(f.id) && mayChange(f));

  const fix = async (key, findings) => {
    setBusy(key);
    try { await actions.fixFindings(findings); } finally { setBusy(null); }
  };
  // The request names the exact workflow, transition and statuses, so the Copilot does not have to guess
  const fixWithAi = (f, ft) => {
    const wf = model.workflows.find((w) => w.id === f.wfId);
    const tr = f.tKey ? wf?.transitions.find((x) => x.key === f.tKey) : null;
    const q = (s) => (t.lang === 'de' ? `„${s}“` : `"${s}"`);
    const origin = tr?.isInitial ? t('fix.onCreate') : tr?.from.length ? tr.from.map((s) => q(s.name)).join(', ') : t('fix.anyStatus');
    const path = tr ? `${origin} → ${q(tr.to?.name || '?')}` : '';
    const where = tr ? t('fix.aiWhereTr', { tr: tr.name, path }) : t('fix.aiWhereWf');
    actions.planChange({ wfId: f.wfId, text: t('fix.aiPrompt', { title: ft.title, fix: ft.fix, wf: f.wfName, where }) });
  };

  return (
    <div>
      <section className="decision" aria-labelledby="hc-title">
        <div className="body" style={{ flexDirection: 'row', alignItems: 'center', gap: 20 }}>
          <ScoreRing score={model.stats.healthScore} />
          <div style={{ minWidth: 0 }}>
            <h2 id="hc-title" style={{ margin: 0 }}>{t('hc.title')} · {t(scoreLabelKey(model.stats.healthScore))}</h2>
            <p className="muted" style={{ margin: '6px 0 0', maxWidth: '70ch' }}>{t('hc.intro')}</p>
          </div>
        </div>
        <div className="aside" style={{ justifyContent: 'center' }}>
          <span className="label">{focus ? t('fix.inFocus') : t('hc.filterAll')}</span>
          <span style={{ fontSize: 30, fontWeight: 500, lineHeight: 1.1 }} className="num">{all.length}</span>
          {fixNow.length > 0 && (
            <button type="button" className={`btn primary ${busy === 'all' ? 'busy' : ''}`} disabled={!!busy} style={{ marginTop: 8, alignSelf: 'flex-start' }} onClick={() => fix('all', fixNow)}>
              <Icon name="wand" />{fixNow.length === 1 ? t('fix.one') : t('fix.many', { n: fixNow.length })}
            </button>
          )}
          {canRemediate && list.some((f) => f.severity !== 'info') && (
            <button type="button" className={`btn ${fixNow.length ? 'small' : 'primary'}`} style={{ marginTop: 8, alignSelf: 'flex-start' }} onClick={() => actions.openRemediation(list.filter((f) => f.severity !== 'info'))}><Icon name="plus" />{t('plan.createTasks')}</button>
          )}
        </div>
      </section>

      {/* Live issue data: the consequences of resolution findings in existing issues */}
      {(!focus || (typeof focus === 'string' && /RESOLUTION/.test(focus))) && dataCard}

      <div className="toolbar" role="group" aria-label={t('tab.health')}>
        {focus && (
          <span className="chip on focus-chip">
            <Icon name="filter" size={14} />
            <span className="clamp-1">{typeof focus === 'string' ? t(`plan.action.${focus}`) : focus.label}</span>
            <button type="button" className="chip-x" onClick={() => actions.clearHealthFocus()} aria-label={t('fix.clearFocus')} title={t('fix.clearFocus')}><Icon name="x" size={13} /></button>
          </span>
        )}
        <button type="button" aria-pressed={sev === 'all'} className={`chip ${sev === 'all' ? 'on' : ''}`} onClick={() => setSev('all')}>{t('hc.filterAll')} <strong className="num">{all.length}</strong></button>
        {['high', 'medium', 'low', 'info'].map((s) => (
          <button key={s} type="button" aria-pressed={sev === s} className={`chip ${sev === s ? 'on' : ''}`} onClick={() => setSev(s)} style={sev === s ? undefined : { background: `var(--${s}-bg)` }}>
            <span className="dot" style={{ background: s === 'info' ? 'var(--text-faint)' : `var(--${s})` }} />
            {t(`ov.severity.${s}`)} <strong className="num">{counts[s]}</strong>
          </button>
        ))}
      </div>

      {list.length === 0 && (
        <div className="card">
          <EmptyState icon="check" title={t('hc.none')} action={focus ? <button type="button" className="btn small" onClick={() => actions.clearHealthFocus()}>{t('fix.showAll')}</button> : null} />
        </div>
      )}
      {list.map((f, i) => {
        const ft = findingText(t.lang, f);
        const task = remediation[findingFingerprint(f)];
        const canFix = fixable.has(f.id) && mayChange(f);
        const canAi = !canFix && f.severity !== 'info' && model.kind === 'project' && mayChange(f);
        return (
          <article key={f.id} className="decision finding" style={{ animationDelay: `${Math.min(i, 8) * 30}ms` }}>
            <div className="body">
              <div className="row" style={{ gap: 10 }}>
                <SevBadge sev={f.severity} />
                <span className="small muted">{f.wfName}{f.tName ? ` › ${f.tName}` : ''}{f.vendor && f.vendor !== 'Jira' ? ` · ${f.vendor}` : ''}</span>
                {canFix && <span className="chip green small-chip"><Icon name="wand" size={12} />{t('fix.badge')}</span>}
              </div>
              <h3>{ft.title}</h3>
              <p style={{ margin: 0, maxWidth: '75ch' }}><span style={{ fontWeight: 500 }}>{t('hc.recommendation')}:</span> {ft.fix}</p>
            </div>
            <div className="aside" style={{ gap: 8 }}>
              {canFix && (
                <button type="button" className={`btn small accent ${busy === f.id ? 'busy' : ''}`} disabled={!!busy} onClick={() => fix(f.id, [f])}><Icon name="wand" />{t('fix.auto')}</button>
              )}
              {canAi && <button type="button" className="btn small" onClick={() => fixWithAi(f, ft)}><Icon name="sparkle" />{t('fix.ai')}</button>}
              {f.tKey && <button type="button" className="btn small" onClick={() => actions.openTransition(f.tKey)}><Icon name="arrowRight" />{t('hc.goTo')}</button>}
              {task && <button type="button" className="btn small" onClick={() => openIssue(siteUrl, task.key)}><Icon name="external" />{task.key}</button>}
              {!task && canRemediate && f.severity !== 'info' && <button type="button" className="btn small" onClick={() => actions.openRemediation([f])}><Icon name="plus" />{t('hc.task')}</button>}
              {!canFix && !canAi && <button type="button" className="btn small ghost" onClick={() => actions.askRovo(t('hc.askFix', { title: ft.title, wf: f.wfName, tr: f.tName || '-' }))}><Icon name="sparkle" />{t('app.askRovo')}</button>}
            </div>
          </article>
        );
      })}
    </div>
  );
}
