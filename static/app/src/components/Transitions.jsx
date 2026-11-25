/**
 * Transitions tab: the per-status table with conditions (AND/OR groups), validators, post functions, screens,
 * properties and team notes, with vendor filter, search highlighting and multi-select actions. Also exports the
 * transition detail drawer and the section builder used by the HTML export.
 *
 * @file        static/app/src/components/Transitions.jsx
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-24
 * @updated     2026-11-25
 */

import { useMemo, useState, useEffect, useRef } from 'react';
import { useT } from '../lib/i18n.jsx';
import { useApp, useAiOn, Hl, StatusPill, RuleList, ConditionTree, VendorBadge, SevBadge, EmptyState } from './common.jsx';
import { findingText } from '../../../../src/shared/i18n.js';
import { allRules, flattenConditions } from '../../../../src/shared/engine.js';
import { describeRule, describeTransition } from '../../../../src/shared/explain.js';
import Icon from './Icon.jsx';
import { countTransitions } from '../lib/transitionCount.js';

const COLS = ['id', 'source', 'transition', 'target', 'screen', 'properties', 'conditions', 'validators', 'postfunctions', 'note'];
const DEFAULT_HIDDEN = ['properties'];
const WIDTHS = { id: 70, source: 130, transition: 150, target: 130, screen: 110, properties: 130, conditions: 260, validators: 260, postfunctions: 260, note: 170 };
const COL_KEY = 'superport.wfa.cols';

function loadCols() {
  try {
    const v = JSON.parse(localStorage.getItem(COL_KEY));
    if (Array.isArray(v)) return new Set(v);
  } catch { /* ignore */ }
  return new Set(COLS.filter((c) => !DEFAULT_HIDDEN.includes(c)));
}

// Sections per source status (legacy layout): Initial, each status, Global
export function buildSections(wf, t) {
  const sections = [];
  const initial = wf.transitions.filter((x) => x.isInitial);
  if (initial.length) sections.push({ id: `${wf.id}|init`, wf, title: t('tt.initial'), status: null, rows: initial.map((tr) => ({ tr, source: null })) });
  for (const st of wf.statuses) {
    const rows = wf.transitions.filter((x) => x.from.some((f) => f.ref === st.ref)).map((tr) => ({ tr, source: st }));
    if (rows.length) sections.push({ id: `${wf.id}|${st.ref}`, wf, title: st.name, status: st, rows });
  }
  const global = wf.transitions.filter((x) => x.isGlobal);
  if (global.length) sections.push({ id: `${wf.id}|global`, wf, title: t('tt.global'), status: null, rows: global.map((tr) => ({ tr, source: null })) });
  return sections;
}

function searchBlob(tr, lang, note) {
  const parts = [tr.id, tr.name, tr.description, tr.to?.name, ...tr.from.map((f) => f.name), tr.screen?.name, note?.text];
  for (const r of allRules(tr)) {
    parts.push(r.label, r.fallbackName, r.vendor.name, describeRule(r, lang), ...r.messages, ...r.expressions.map((e) => e.code), ...r.refs.map((x) => `${x.name} ${x.id}`));
    for (const d of r.details) parts.push(String(d.value));
  }
  return parts.filter(Boolean).join('\n').toLowerCase();
}

export default function Transitions({ model, workflows, search, setSearch }) {
  const t = useT();
  const { actions, notes } = useApp();
  const [cols, setCols] = useState(loadCols);
  const [open, setOpen] = useState(() => new Set());
  const [panel, setPanel] = useState(null);
  const vendors = model.vendors;
  const [vendorSel, setVendorSel] = useState(() => new Set(vendors.map((v) => v.key)));
  const [kindSel, setKindSel] = useState(() => new Set(['condition', 'validator', 'postfunction']));
  const [selected, setSelected] = useState(() => new Set());
  const [hitIdx, setHitIdx] = useState(0);
  const tableRef = useRef(null);
  const q = search.trim();

  useEffect(() => {
    try { localStorage.setItem(COL_KEY, JSON.stringify([...cols])); } catch { /* ignore */ }
  }, [cols]);

  const sections = useMemo(() => workflows.flatMap((wf) => buildSections(wf, t)), [workflows, t.lang]);
  const blobs = useMemo(() => {
    const m = new Map();
    for (const wf of workflows) for (const tr of wf.transitions) m.set(tr.key, searchBlob(tr, t.lang, notes?.[wf.id]?.[tr.id]));
    return m;
  }, [workflows, t.lang, notes]);

  // Open all sections initially for small workflows, first ones for large
  useEffect(() => {
    const total = sections.reduce((a, s) => a + s.rows.length, 0);
    setOpen(new Set(total <= 60 ? sections.map((s) => s.id) : sections.slice(0, 3).map((s) => s.id)));
  }, [sections]);

  const allVendors = vendorSel.size === vendors.length;
  const allKinds = kindSel.size === 3;
  const rowVisible = (tr) => {
    if (!allVendors && !allRules(tr).some((r) => vendorSel.has(r.vendor.key))) return false;
    if (!allKinds && !allRules(tr).some((r) => kindSel.has(r.kind))) return false;
    if (q.length >= 2 && !blobs.get(tr.key)?.includes(q.toLowerCase())) return false;
    return true;
  };

  const visibleSections = sections.map((s) => ({ ...s, visRows: s.rows.filter((r) => rowVisible(r.tr)) })).filter((s) => s.visRows.length);
  // count transitions, not rows: a transition with several source statuses has one row per source
  const totalRows = countTransitions(sections);
  const shownRows = countTransitions(sections, rowVisible);
  const filterActive = !allVendors || !allKinds || q.length >= 2;

  // When searching, expand everything with hits
  useEffect(() => {
    if (q.length >= 2) setOpen(new Set(visibleSections.map((s) => s.id)));
    setHitIdx(0);
  }, [q]);

  const hits = q.length >= 2 ? visibleSections.flatMap((s) => s.visRows.map((r) => `${s.id}|${r.tr.key}`)) : [];
  const gotoHit = (i) => {
    if (!hits.length) return;
    const n = (i + hits.length) % hits.length;
    setHitIdx(n);
    const el = tableRef.current?.querySelector(`[data-row="${CSS.escape(hits[n])}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const vendorCounts = useMemo(() => {
    const c = {};
    for (const wf of workflows) for (const tr of wf.transitions) for (const k of new Set(allRules(tr).map((r) => r.vendor.key))) c[k] = (c[k] || 0) + 1;
    return c;
  }, [workflows]);
  const kindCounts = useMemo(() => {
    const c = { condition: 0, validator: 0, postfunction: 0 };
    for (const wf of workflows) for (const tr of wf.transitions) for (const k of ['condition', 'validator', 'postfunction']) if (tr.counts[k]) c[k]++;
    return c;
  }, [workflows]);

  const toggle = (set, setter, v) => {
    const n = new Set(set);
    if (n.has(v)) n.delete(v); else n.add(v);
    setter(n);
  };
  const toggleOpen = (id) => toggle(open, setOpen, id);
  const show = (c) => cols.has(c);
  const visibleCols = COLS.filter(show);

  return (
    <div ref={tableRef}>
      <div className="toolbar">
        <button type="button" className="btn small" onClick={() => setOpen(new Set(visibleSections.map((s) => s.id)))}><Icon name="chevronDown" />{t('tt.expandAll')}</button>
        <button type="button" className="btn small" onClick={() => setOpen(new Set())}><Icon name="chevronRight" />{t('tt.collapseAll')}</button>

        <div className="popover">
          <button type="button" className="btn small" aria-expanded={panel === 'cols'} onClick={() => setPanel(panel === 'cols' ? null : 'cols')}><Icon name="columns" />{t('tt.columns')}</button>
          {panel === 'cols' && (
            <div className="col-panel" onMouseLeave={() => setPanel(null)}>
              {COLS.map((c) => (
                <label key={c}><input type="checkbox" checked={show(c)} onChange={() => toggle(cols, setCols, c)} /> {t(`tt.col.${c}`)}</label>
              ))}
            </div>
          )}
        </div>

        <div className="popover">
          <button type="button" className={`btn small ${allVendors ? '' : 'on'}`} aria-expanded={panel === 'vendors'} onClick={() => setPanel(panel === 'vendors' ? null : 'vendors')}><Icon name="filter" />{t('tt.vendorFilter')}</button>
          {panel === 'vendors' && (
            <div className="col-panel" onMouseLeave={() => setPanel(null)}>
              {vendors.map((v) => (
                <label key={v.key}>
                  <input type="checkbox" checked={vendorSel.has(v.key)} onChange={() => toggle(vendorSel, setVendorSel, v.key)} />
                  <VendorBadge vendor={v} />
                  <span className="count">{vendorCounts[v.key] || 0}</span>
                </label>
              ))}
              <div className="quick">
                <button type="button" className="btn small" onClick={() => setVendorSel(new Set(vendors.map((v) => v.key)))}>{t('tt.all')}</button>
                <button type="button" className="btn small" onClick={() => setVendorSel(new Set())}>{t('tt.none')}</button>
                <button type="button" className="btn small" onClick={() => setVendorSel(new Set(vendors.filter((v) => v.thirdParty).map((v) => v.key)))}>{t('tt.onlyApps')}</button>
              </div>
            </div>
          )}
        </div>

        <div className="popover">
          <button type="button" className={`btn small ${allKinds ? '' : 'on'}`} aria-expanded={panel === 'kinds'} onClick={() => setPanel(panel === 'kinds' ? null : 'kinds')}><Icon name="filter" />{t('tt.elementFilter')}</button>
          {panel === 'kinds' && (
            <div className="col-panel" onMouseLeave={() => setPanel(null)}>
              {['condition', 'validator', 'postfunction'].map((k) => (
                <label key={k}><input type="checkbox" checked={kindSel.has(k)} onChange={() => toggle(kindSel, setKindSel, k)} /> {t(`tt.col.${k === 'condition' ? 'conditions' : k === 'validator' ? 'validators' : 'postfunctions'}`)}<span className="count">{kindCounts[k]}</span></label>
              ))}
              <div className="quick">
                <button type="button" className="btn small" onClick={() => setKindSel(new Set(['condition', 'validator', 'postfunction']))}>{t('tt.all')}</button>
                <button type="button" className="btn small" onClick={() => setKindSel(new Set())}>{t('tt.none')}</button>
              </div>
            </div>
          )}
        </div>

        <span className="grow" />
        {filterActive && <span className="small muted">{t('tt.filterActive', { n: shownRows, total: totalRows })}</span>}
        <div className="omnibox" style={{ flex: '0 1 260px' }}>
          <Icon name="search" className="icon" />
          <input type="search" aria-label={t('app.search')} placeholder={t('app.search')} value={search} onChange={(e) => setSearch(e.target.value)} style={{ paddingRight: 12 }} onKeyDown={(e) => { if (e.key === 'Enter') gotoHit(hitIdx + (e.shiftKey ? -1 : 1)); }} />
        </div>
        {q.length >= 2 && (
          <>
            <span className="small muted nowrap">{hits.length ? t('tt.searchHits', { i: hitIdx + 1, n: hits.length }) : t('app.searchNoResults')}</span>
            <button type="button" className="btn small" disabled={!hits.length} aria-label="previous" onClick={() => gotoHit(hitIdx - 1)}><Icon name="chevronDown" style={{ transform: 'rotate(180deg)' }} /></button>
            <button type="button" className="btn small" disabled={!hits.length} aria-label="next" onClick={() => gotoHit(hitIdx + 1)}><Icon name="chevronDown" /></button>
            <button type="button" className="btn small ghost" aria-label={t('tt.close')} onClick={() => setSearch('')}><Icon name="x" /></button>
          </>
        )}
      </div>

      {visibleSections.length === 0 && <div className="card"><EmptyState icon="search" title={t('app.searchNoResults')} /></div>}

      {visibleSections.map((s, si) => {
        const isOpen = open.has(s.id);
        const showWfHeader = workflows.length > 1 && (si === 0 || visibleSections[si - 1].wf.id !== s.wf.id);
        const sectionKeys = s.visRows.map((r) => r.tr.key);
        const allSel = sectionKeys.every((k) => selected.has(k));
        return (
          <div key={s.id}>
            {showWfHeader && <h2 style={{ margin: '16px 0 8px' }}>{s.wf.name}</h2>}
            <div className="sec">
              <div className={`sh ${isOpen ? 'open' : ''}`}>
                <input type="checkbox" checked={allSel} onChange={() => {
                  const n = new Set(selected);
                  for (const k of sectionKeys) if (allSel) n.delete(k); else n.add(k);
                  setSelected(n);
                }} aria-label={`${t('tt.selected', { n: sectionKeys.length })}: ${s.title}`} />
                <button type="button" className="sh-toggle" onClick={() => toggleOpen(s.id)} aria-expanded={isOpen}>
                  <span className="caret"><Icon name="chevronRight" /></span>
                  {s.status ? <StatusPill status={s.status} q={q} /> : null}
                  <span className="stit">{s.status ? `${t('tt.step')}: ` : ''}<Hl text={s.title} q={q} />{s.status?.id ? <span className="muted small"> ({s.status.id})</span> : null}</span>
                  <span className="smet">{s.visRows.length === 1 ? t('tt.transition1') : t('tt.transitionsN', { n: s.visRows.length })}</span>
                </button>
              </div>
              {isOpen && (
                <div className="tt-wrap">
                  <table className="tt">
                    <colgroup>
                      <col style={{ width: 30 }} />
                      {visibleCols.map((c) => <col key={c} style={{ width: WIDTHS[c] }} />)}
                    </colgroup>
                    <thead>
                      <tr>
                        <th />
                        {visibleCols.map((c) => <th key={c}>{t(`tt.col.${c}`)}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {s.visRows.map(({ tr }) => {
                        const rowId = `${s.id}|${tr.key}`;
                        const isHit = hits[hitIdx] === rowId;
                        const note = notes?.[s.wf.id]?.[tr.id];
                        return (
                          <tr key={rowId} data-row={rowId} className={selected.has(tr.key) ? 'selected' : ''} style={isHit ? { outline: '2px solid var(--sp-orange)', outlineOffset: -2 } : undefined}>
                            <td><input type="checkbox" checked={selected.has(tr.key)} onChange={() => toggle(selected, setSelected, tr.key)} aria-label={tr.name} /></td>
                            {show('id') && <td><span className="tid"><Hl text={tr.id} q={q} /></span><span className="small muted">{t(`tt.type.${tr.type}`)}</span></td>}
                            {show('source') && <td>{tr.isInitial ? <span className="muted">{t('dg.start')}</span> : tr.isGlobal ? <span className="muted">{t('tt.any')}</span> : <StatusPill status={s.status} q={q} />}</td>}
                            {show('transition') && (
                              <td>
                                <span className="tname" role="button" tabIndex={0} onClick={() => actions.openTransition(tr.key)} onKeyDown={(e) => e.key === 'Enter' && actions.openTransition(tr.key)}><Hl text={tr.name} q={q} /></span>
                                {tr.description && <div className="small muted"><Hl text={tr.description} q={q} /></div>}
                                {tr.thirdParty > 0 && <div className="small row" style={{ gap: 4, color: 'var(--text-muted)' }}><Icon name="layers" size={13} />{tr.thirdParty} app</div>}
                              </td>
                            )}
                            {show('target') && <td>{tr.to ? <StatusPill status={tr.to} q={q} /> : <span className="muted">{t('tt.loop')}</span>}</td>}
                            {show('screen') && <td>{tr.screen ? <span className={tr.screen.resolved === false ? 'chip bad' : ''}><Hl text={tr.screen.name} q={q} /></span> : <span className="muted">–</span>}</td>}
                            {show('properties') && <td>{Object.keys(tr.properties).length ? Object.entries(tr.properties).map(([k, v]) => <div key={k} className="small"><code>{k}</code> = {String(v)}</div>) : <span className="muted">–</span>}</td>}
                            {show('conditions') && <td><ConditionTree tree={tr.conditions} q={q} /></td>}
                            {show('validators') && <td><RuleList rules={tr.validators} q={q} /></td>}
                            {show('postfunctions') && <td><RuleList rules={[...tr.postFunctions, ...tr.triggers]} q={q} /></td>}
                            {show('note') && <td><NoteCell wfId={s.wf.id} tr={tr} note={note} /></td>}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        );
      })}

      {selected.size > 0 && (
        <div className="sel-bar">
          <span style={{ flex: 1 }}>{t('tt.selected', { n: selected.size })}</span>
          <button type="button" className="btn small" onClick={() => setSelected(new Set())}><Icon name="x" />{t('tt.clearSelection')}</button>
          <button type="button" className="btn primary" onClick={() => actions.exportSelection([...selected])}><Icon name="download" />{t('tt.exportSelected')}</button>
        </div>
      )}
    </div>
  );
}

function NoteCell({ wfId, tr, note }) {
  const t = useT();
  const { actions } = useApp();
  const [val, setVal] = useState(note?.text || '');
  const [state, setState] = useState('');
  useEffect(() => setVal(note?.text || ''), [note?.text]);
  const save = async () => {
    if ((note?.text || '') === val) return;
    setState('…');
    try {
      await actions.saveNote(wfId, tr.id, val);
      setState(t('tt.noteSaved'));
      setTimeout(() => setState(''), 1800);
    } catch {
      setState(t('tt.noteFailed'));
    }
  };
  return (
    <div>
      <textarea className="note-input" aria-label={t('tt.notePlaceholder')} value={val} placeholder={t('tt.notePlaceholder')} onChange={(e) => setVal(e.target.value)} onBlur={save} />
      <div className="note-meta">{state || (note?.at ? t('tt.noteBy', { name: note.byName || '', date: t.date(note.at, false) }) : '')}</div>
    </div>
  );
}

export function TransitionDetails({ wf, tr, model, onClose }) {
  const t = useT();
  const { notes, actions } = useApp();
  const aiOn = useAiOn(); // "Ask Rovo" exists only while AI is on
  const note = notes?.[wf.id]?.[tr.id];
  const findings = model.findings.filter((f) => f.tKey === tr.key);
  const lines = describeTransition(wf, tr, t.lang, model.findings);
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
        <div className="drawer-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="small muted">{wf.name} · ID {tr.id} · {t(`tt.type.${tr.type}`)}</div>
            <h2 id="drawer-title" style={{ margin: '2px 0 0' }}>{tr.name}</h2>
            <div className="row" style={{ marginTop: 10 }}>
              {tr.isInitial ? <span className="chip">{t('dg.start')}</span> : tr.isGlobal ? <span className="chip">{t('tt.any')}</span> : tr.from.map((f) => <StatusPill key={f.ref} status={f} />)}
              <span>→</span>
              {tr.to ? <StatusPill status={tr.to} /> : <span className="chip">{t('tt.loop')}</span>}
            </div>
          </div>
          {aiOn && <button type="button" className="hbtn" onClick={() => actions.askRovo(t('tt.askRovo', { name: tr.name, wf: wf.name }))}><Icon name="sparkle" />{t('app.askRovo')}</button>}
          <button type="button" className="hbtn only" autoFocus onClick={onClose} aria-label={t('tt.close')}><Icon name="x" /></button>
        </div>
        <div className="drawer-body">
          <h3 className="ai-badge" style={{ margin: '0 0 8px' }}><Icon name="sparkle" />{t('tt.explainTitle')}</h3>
          <div className="explain">{lines.map((l, i) => <p key={i}>{l}</p>)}</div>
          {findings.length > 0 && (
            <div className="card" style={{ background: 'var(--high-bg)', borderColor: 'transparent', padding: '16px 18px' }}>
              <h3 style={{ margin: '0 0 8px' }}>{t('tab.health')}</h3>
              {findings.map((f) => <FindingLine key={f.id} f={f} />)}
            </div>
          )}
          {tr.screen && <p><strong>{t('tt.col.screen')}:</strong> {tr.screen.name} <span className="muted small">({tr.screen.id})</span></p>}
          <h3 style={{ margin: '18px 0 8px' }}>{t('tt.col.conditions')} ({flattenConditions(tr.conditions).length})</h3>
          <div style={{ marginBottom: 12 }}><ConditionTree tree={tr.conditions} /></div>
          <h3 style={{ margin: '18px 0 8px' }}>{t('tt.col.validators')} ({tr.validators.length})</h3>
          <div style={{ marginBottom: 12 }}><RuleList rules={tr.validators} /></div>
          <h3 style={{ margin: '18px 0 8px' }}>{t('tt.col.postfunctions')} ({tr.postFunctions.length})</h3>
          <div style={{ marginBottom: 12 }}><RuleList rules={[...tr.postFunctions, ...tr.triggers]} /></div>
          {Object.keys(tr.properties).length > 0 && (
            <>
              <h3 style={{ margin: '18px 0 8px' }}>{t('tt.col.properties')}</h3>
              {Object.entries(tr.properties).map(([k, v]) => <div key={k} className="small"><code>{k}</code> = {String(v)}</div>)}
            </>
          )}
          {note?.text && (
            <>
              <h3 style={{ margin: '18px 0 8px' }}>{t('tt.col.note')}</h3>
              <p style={{ whiteSpace: 'pre-wrap' }}>{note.text}</p>
            </>
          )}
        </div>
      </aside>
    </>
  );
}

function FindingLine({ f }) {
  const t = useT();
  const ft = findingText(t.lang, f);
  return (
    <div style={{ marginBottom: 8 }}>
      <SevBadge sev={f.severity} /> <strong>{ft.title}</strong>
      <div className="small muted">{ft.fix}</div>
    </div>
  );
}
