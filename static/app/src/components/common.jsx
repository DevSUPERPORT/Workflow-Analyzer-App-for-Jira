import { createContext, useContext, Fragment } from 'react';
import { useT } from '../lib/i18n.jsx';
import { vendorColor } from '../../../../src/shared/vendors.js';
import { describeRule, ruleTitle } from '../../../../src/shared/explain.js';
import Icon from './Icon.jsx';

// Model + navigation actions available to every view (and to the static export render).
export const AppContext = createContext({ model: null, notes: {}, actions: {}, caps: {}, staticRender: false });
export const useApp = () => useContext(AppContext);

export function Hl({ text, q }) {
  const s = String(text ?? '');
  if (!q || q.length < 2) return s;
  const lower = s.toLowerCase();
  const needle = q.toLowerCase();
  const out = [];
  let i = 0;
  let k = 0;
  while (true) {
    const j = lower.indexOf(needle, i);
    if (j < 0) break;
    out.push(s.slice(i, j), <mark className="hl" key={k++}>{s.slice(j, j + needle.length)}</mark>);
    i = j + needle.length;
  }
  out.push(s.slice(i));
  return <>{out}</>;
}

export function VendorBadge({ vendor }) {
  const { model } = useApp();
  if (!vendor.thirdParty) return <span className="badge jira" data-vendor={vendor.key}>{vendor.name}</span>;
  const keys = model ? model.vendors.map((v) => v.key) : [];
  return (
    <span className="badge vendor" data-vendor={vendor.key} style={{ background: vendorColor(vendor.key, keys) }} title={vendor.appKey || ''}>
      {vendor.name}
    </span>
  );
}

export function StatusPill({ status, q }) {
  if (!status) return null;
  return (
    <span className={`status ${status.category}`} title={status.name}>
      <Hl text={status.name} q={q} />
    </span>
  );
}

export function SevBadge({ sev }) {
  const t = useT();
  return <span className={`sev ${sev}`}>{t(`ov.severity.${sev}`)}</span>;
}

export function RefChip({ r, q }) {
  const t = useT();
  const { actions, staticRender } = useApp();
  const cls = `chip ref ${r.resolved === false ? 'bad' : r.inactive ? 'warn' : ''}`;
  const title = `${t(`ref.${r.type}`)} · ${r.id}${r.resolved === false ? ` · ${t('im.unresolved')}` : ''}${r.inactive ? ` · ${t('im.inactive')}` : ''}`;
  const label = (
    <>
      <span className="muted small">{t(`ref.${r.type}`)}</span> <Hl text={r.name} q={q} />
      {r.resolved === false && <Icon name="alert" size={13} label={t('im.unresolved')} />}
    </>
  );
  if (staticRender || !actions.openRef) return <span className={cls} title={title} data-ref={`${r.type}|${r.id}`}>{label}</span>;
  return (
    <button type="button" className={cls} title={title} onClick={(e) => { e.stopPropagation(); actions.openRef(r.type, r.id); }}>
      {label}
    </button>
  );
}

const SKIP_DETAIL = new Set(['disabled', 'id', 'tag', 'appKey', 'key', 'config']);

export function RuleView({ rule, q }) {
  const t = useT();
  const title = ruleTitle(rule, t.lang);
  const sentence = describeRule(rule, t.lang);
  const refs = rule.refs.filter((r) => r.type !== 'app');
  const freeDetails = rule.vendor.thirdParty ? rule.details.filter((d) => !SKIP_DETAIL.has(d.key)).slice(0, 8) : [];
  return (
    <li data-vendor={rule.vendor.key} data-kind={rule.kind}>
      <div className="rule-head">
        <VendorBadge vendor={rule.vendor} />
        <span className="rule-title"><Hl text={title} q={q} /></span>
        {rule.disabled && <span className="badge disabled">{t('ov.disabled')}</span>}
      </div>
      {sentence && sentence !== title && <div className="rule-desc"><Hl text={sentence} q={q} /></div>}
      {(refs.length > 0 || freeDetails.length > 0 || rule.messages.length > 0 || rule.expressions.length > 0) && (
        <div className="rule-details">
          {refs.length > 0 && <div className="row" style={{ gap: 4 }}>{refs.map((r) => <RefChip key={`${r.type}|${r.id}|${r.via}`} r={r} q={q} />)}</div>}
          {freeDetails.map((d, i) => (
            <div key={i}><span className="muted">{d.key}:</span> <code><Hl text={String(d.value).slice(0, 200)} q={q} /></code></div>
          ))}
          {rule.expressions.map((e, i) => (
            <code className="code-block" key={`e${i}`}><Hl text={e.code} q={q} /></code>
          ))}
          {rule.messages.map((m, i) => (
            <div className="rule-msg" key={`m${i}`}>„<Hl text={m} q={q} />“</div>
          ))}
        </div>
      )}
      <div className="rule-key">{rule.ruleKey}{rule.vendor.appKey ? ` · ${rule.vendor.appKey}` : ''}</div>
    </li>
  );
}

export function RuleList({ rules, q }) {
  const t = useT();
  if (!rules.length) return <span className="muted">{t('tt.noRules')}</span>;
  return <ul className="rules">{rules.map((r, i) => <RuleView key={r.id || i} rule={r} q={q} />)}</ul>;
}

export function ConditionTree({ tree, q, root = true }) {
  const t = useT();
  const count = tree.rules.length + tree.groups.length;
  if (root && count === 0) return <span className="muted">{t('tt.noRules')}</span>;
  if (root && tree.groups.length === 0 && tree.op === 'ALL') return <RuleList rules={tree.rules} q={q} />;
  return (
    <div className={`cond-group ${tree.op}`}>
      <span className="cond-op">{t(`tt.cond.${tree.op}`)} ({count})</span>
      {tree.rules.length > 0 && <ul className="rules">{tree.rules.map((r, i) => <RuleView key={r.id || i} rule={r} q={q} />)}</ul>}
      {tree.groups.map((g, i) => <Fragment key={i}><ConditionTree tree={g} q={q} root={false} /></Fragment>)}
    </div>
  );
}

export function ScoreRing({ score, size = 84, inverted = false }) {
  const t = useT();
  const r = size / 2 - 6;
  const c = 2 * Math.PI * r;
  const col = score >= 80 ? 'var(--ok)' : score >= 55 ? 'var(--accent)' : 'var(--high)';
  return (
    <svg className="score-ring" viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img" aria-label={`${t('ov.health')} ${score}`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={inverted ? 'color-mix(in srgb, var(--tile-text) 18%, transparent)' : 'var(--surface-2)'} strokeWidth="6" />
      <circle className="arc" cx={size / 2} cy={size / 2} r={r} fill="none" stroke={col} strokeWidth="6" strokeDasharray={`${(c * score) / 100} ${c}`} strokeLinecap="round" transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      <text x="50%" y="55%" textAnchor="middle" dominantBaseline="middle" fontSize={size * 0.3} fontWeight="500" fill={inverted ? 'var(--tile-text)' : 'var(--text)'} style={{ fontVariantNumeric: 'tabular-nums' }}>{score}</text>
    </svg>
  );
}

export function scoreLabelKey(score) {
  return score >= 80 ? 'ov.scoreGood' : score >= 55 ? 'ov.scoreFair' : 'ov.scorePoor';
}

/** Metric tile (reference: stat tiles). ink = the one emphasised tile on a screen. Clickable tiles are real buttons. */
export function Kpi({ value, label, sub, accent, ink, onClick, title }) {
  const cls = `tile ${accent || ink ? 'ink' : ''}`;
  const body = (
    <>
      <span className="l">{label}</span>
      <span className="v">{value}</span>
      {sub ? <span className="s">{sub}</span> : null}
    </>
  );
  return onClick ? <button type="button" className={cls} onClick={onClick} title={title}>{body}</button> : <div className={cls} title={title}>{body}</div>;
}

export function Skeleton({ w = '100%', h = 12, r }) {
  return <span className="skel" style={{ display: 'block', width: w, height: h, borderRadius: r }} />;
}

export function EmptyState({ icon = 'info', title, children, action }) {
  return (
    <div className="empty-state">
      <Icon name={icon} size={34} />
      {title && <strong>{title}</strong>}
      {children && <div className="small" style={{ maxWidth: 460 }}>{children}</div>}
      {action}
    </div>
  );
}

/**
 * The change lifecycle rail (signature): Planned → Validated by Jira → Applied → Rollback ready.
 * status: planned | nochange | invalid | applying | applied | failed | rolledback | discarded
 */
export function LifecycleRail({ status, validation }) {
  const t = useT();
  const validated = validation?.ok === true;
  const failedValidation = status === 'invalid' || validation?.ok === false;
  const applied = ['applied', 'rolledback'].includes(status);
  const steps = [
    { key: 'planned', done: true },
    { key: 'validated', done: validated || applied, fail: failedValidation },
    { key: 'applied', done: applied, fail: status === 'failed', current: status === 'applying' },
    { key: status === 'rolledback' ? 'rolledback' : 'restorable', done: applied },
  ];
  let reached = 0;
  steps.forEach((s, i) => { if (s.done) reached = i; });
  const current = steps.findIndex((s) => !s.done && !s.fail);
  return (
    <div className="rail" style={{ '--p': reached / (steps.length - 1) }} role="list" aria-label={t('rail.label')}>
      <span className="rail-fill" aria-hidden="true" />
      {steps.map((s, i) => (
        <div key={s.key} role="listitem" className={`rail-step ${i === 0 ? 'start' : i === steps.length - 1 ? 'end' : ''} ${s.fail ? 'fail' : s.done ? 'done' : i === current ? 'current' : ''}`}>
          <span className="rail-dot">{s.fail ? <Icon name="x" size={13} strokeWidth={2.5} /> : <Icon name="check" size={13} strokeWidth={2.5} />}</span>
          <span>{t(`rail.${s.key}`)}</span>
        </div>
      ))}
    </div>
  );
}

export function transitionPath(t, tt) {
  const from = t.isInitial ? tt('dg.start') : t.isGlobal ? tt('tt.any') : t.from.map((f) => f.name).join(', ');
  return `${from} → ${t.to?.name || tt('tt.loop')}`;
}
