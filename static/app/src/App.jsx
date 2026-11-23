/**
 * Root of the Custom UI: asks the server for the kill-switch state, boots the user's role and language, loads
 * the project or scans the site, and hosts the header, grouped tabs, drawer, tour and toast. Shows the
 * "temporarily unavailable" page or the read-only banner when SUPERPORT has paused the app.
 *
 * @file        static/app/src/App.jsx
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-24
 * @updated     2026-11-16
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { view } from '@forge/bridge';
import { LangContext, readStoredLang, storeLang } from './lib/i18n.jsx';
import { t as translate, normalizeLang, formatDate } from '../../../src/shared/i18n.js';
import { normalize, searchModel, collectRawRefs } from '../../../src/shared/engine.js';
import { call, setMaintenanceMode, onMaintenanceRefusal, onLicenseRefusal } from './lib/api.js';
import { effectiveAi, fetchEffectiveAi, AI_RECHECK_MS } from './lib/aiState.js';
import { AppContext, Skeleton } from './components/common.jsx';
import { Unavailable, Unlicensed, ReadonlyBanner } from './components/Maintenance.jsx';
import Icon from './components/Icon.jsx';
import Overview from './components/Overview.jsx';
import Diagram from './components/Diagram.jsx';
import Transitions, { TransitionDetails } from './components/Transitions.jsx';
import Impact from './components/Impact.jsx';
import Health from './components/Health.jsx';
import Changes from './components/Changes.jsx';
import Assistant, { openRovo } from './components/Assistant.jsx';
import ExportPanel, { runExport, defaultExportOpts } from './components/ExportPanel.jsx';
import Access from './components/Access.jsx';
import Autopilot from './components/Autopilot.jsx';
import Guide from './components/Guide.jsx';
import BulkAutopilot from './components/BulkAutopilot.jsx';
import AiSettings from './components/AiSettings.jsx';
import Flow from './components/Flow.jsx';
import Compare from './components/Compare.jsx';
import Remediate from './components/Remediate.jsx';
import Resolutions from './components/Resolutions.jsx';
import Tour, { tourDone } from './components/Tour.jsx';
import { collectPrincipals, simulatePersona, personaFromSelection, findingFingerprint, findingKey } from '../../../src/shared/insights.js';
import appIcon from './assets/app-icon.png';

const SITE_LIMIT = 600;
const STATUS_PAGE_URL = 'https://superapps.statuspage.io';
const NO_CAPS = { role: 'none', jiraAdmin: false, projectAdmin: false, changeShared: false, changeProjectScoped: false, createTasks: false, bulk: false };

export default function App() {
  const [ctx, setCtx] = useState(null);
  const [boot, setBoot] = useState(null);
  // Effective AI state from bootstrap: on only when the site's switch is on and the vendor has not stopped the AI
  // (server: ai-settings && !AI_BUDGET stop). Off by default and on any error; while off, no AI control is shown.
  const [aiOn, setAiOn] = useState(false);
  const [aiStopped, setAiStopped] = useState(false);
  const [lang, setLangState] = useState(() => readStoredLang() || 'en');
  const [phase, setPhase] = useState('boot'); // boot | forbidden | loading | ready | error | site-start | scanning | unavailable
  const [maint, setMaint] = useState({ mode: 'off', statusUrl: STATUS_PAGE_URL }); // SUPERPORT kill switch, from the server
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);
  const [bundle, setBundle] = useState(null);
  const [notes, setNotes] = useState({});
  const [tab, setTab] = useState('overview');
  const [wfSel, setWfSel] = useState('all');
  const [drawer, setDrawer] = useState(null);
  const [search, setSearch] = useState('');
  const [refType, setRefType] = useState('app');
  const [refId, setRefId] = useState(null);
  const [sev, setSev] = useState('all');
  const [toastMsg, setToastMsg] = useState(null);
  const [persona, setPersona] = useState({ selected: new Set() });
  const [load, setLoad] = useState(null);
  const [loadState, setLoadState] = useState(null);
  const [overlayMode, setOverlayMode] = useState('none');
  const [impactOverlay, setImpactOverlay] = useState(null);
  const [remediation, setRemediation] = useState({});
  const [remFindings, setRemFindings] = useState(null);
  const [visit, setVisit] = useState(null);
  const [tourOpen, setTourOpen] = useState(false);
  const [bulkPrefill, setBulkPrefill] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [hcFocus, setHcFocus] = useState(null); // finding code the Health tab is narrowed to
  const [apIntent, setApIntent] = useState(null); // hand-off to Autopilot: { planId } or { text, wfId }
  const [resAudit, setResAudit] = useState(null); // issue resolution check: counts, false when unavailable
  const [resOpen, setResOpen] = useState(false);
  const bootRef = useRef(null);
  const t = useCallback((k, v) => translate(lang, k, v), [lang]);

  // A toast may carry one action (e.g. Undo); it then stays long enough to reach it
  const toast = useCallback((m, action = null) => {
    setToastMsg({ text: m, id: Date.now(), action });
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => setToastMsg(null), action ? 9000 : 3600);
  }, []);

  // Kill switch: the server refused a call because SUPERPORT paused changes (toast) or took the app down
  // (full-page notice). Registered before start-up so the very first refusal is handled too.
  const tRef = useRef(t);
  tRef.current = t;
  useEffect(() => {
    onMaintenanceRefusal((e, _name, background) => {
      setMaintenanceMode(e.mode);
      setMaint((m) => ({ ...m, mode: e.mode }));
      if (e.mode === 'on') {
        setBundle(null);
        setDrawer(null);
        setTourOpen(false);
        setRemFindings(null);
        setPhase('unavailable');
        return tRef.current('maint.title');
      }
      if (!background) toast(tRef.current('maint.readonlyToast'));
      return tRef.current('maint.readonlyToast');
    });
    // The licence ended while the page was open: the same full-page notice as on start-up
    onLicenseRefusal(() => {
      setBundle(null);
      setDrawer(null);
      setTourOpen(false);
      setRemFindings(null);
      setPhase('unlicensed');
    });
    return () => {
      onMaintenanceRefusal(null);
      onLicenseRefusal(null);
    };
  }, [toast]);

  const setLang = (l) => {
    setLangState(l);
    storeLang(l);
    document.documentElement.lang = l;
    call('setPrefs', { lang: l }).catch(() => {});
  };

  // ---------------------------------------------------------------- loading
  const loadProject = useCallback(async (opts) => {
    const silent = opts?.silent === true;
    if (!silent) setPhase('loading');
    else setRefreshing(true);
    setError(null);
    try {
      const data = await call('getProjectData');
      setBundle(data.bundle);
      setNotes(data.notes || {});
      setPhase('ready');
      call('getRemediation').then(setRemediation).catch(() => {});
      if (!tourDone() && !bootRef.current?.prefs?.tourDone) setTourOpen(true);
    } catch (e) {
      if (e?.code === 'UNAVAILABLE') return; // the kill-switch handler has already switched the page
      setError(e);
      setPhase(e.code?.startsWith('FORBIDDEN') ? 'forbidden' : 'error');
    } finally {
      setRefreshing(false);
    }
  }, []);

  const scanSite = useCallback(async () => {
    setPhase('scanning');
    setError(null);
    try {
      let startAt = 0;
      let total = 0;
      const workflows = [];
      const statuses = new Map();
      const warnings = [];
      while (workflows.length < SITE_LIMIT) {
        const page = await call('siteScanPage', { startAt });
        total = page.total;
        workflows.push(...page.workflows);
        for (const s of page.statuses) statuses.set(String(s.id), s);
        setProgress({ key: 'site.scanning', done: workflows.length, total });
        if (page.isLast || !page.workflows.length) break;
        startAt = page.nextStartAt;
      }
      if (total > workflows.length) warnings.push(translate(lang, 'site.limit', { n: workflows.length }));
      setProgress({ key: 'app.loadingRefs' });
      const refs = await call('siteRefs', { ids: collectRawRefs(workflows), firstWorkflowId: workflows[0]?.id });
      setProgress({ key: 'site.projectsLoading' });
      const workflowProjects = {};
      const ids = workflows.map((w) => String(w.id));
      for (let i = 0; i < ids.length; i += 40) {
        const res = await call('siteProjects', { workflowIds: ids.slice(i, i + 40) });
        Object.assign(workflowProjects, res.usage);
        setProgress({ key: 'site.projectsLoading', done: Math.min(i + 40, ids.length), total: ids.length });
      }
      setBundle({ kind: 'site', generatedAt: new Date().toISOString(), workflows, statuses: [...statuses.values()], ref: refs.ref, workflowProjects, warnings: [...warnings, ...(refs.warnings || [])] });
      const n = await call('getNotes', { workflowIds: ids }).catch(() => ({}));
      setNotes(n || {});
      setPhase('ready');
    } catch (e) {
      if (e?.code === 'UNAVAILABLE') return; // the kill-switch handler has already switched the page
      setError(e);
      setPhase(e.code?.startsWith('FORBIDDEN') ? 'forbidden' : 'error');
    }
  }, [lang]);

  // Start-up: theme, context, the kill switch and the user's role. The bridge handshake with Jira can time out when
  // the page is opened in a background tab or a slow host, so it is retried before an error is shown.
  const start = useCallback(async () => {
    setPhase('boot');
    setError(null);
    try { await view.theme?.enable?.(); } catch { /* theming optional */ }
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // Ask the server first whether SUPERPORT has paused or taken down the app, before loading anything
        const [c, av] = await Promise.all([view.getContext(), call('availability')]);
        setCtx(c);
        setMaintenanceMode(av.mode);
        setMaint({ mode: av.mode, statusUrl: av.statusUrl || STATUS_PAGE_URL });
        if (av.mode === 'on' || av.licensed === false) {
          const l = readStoredLang() || normalizeLang(c.locale);
          setLangState(l);
          document.documentElement.lang = l;
          return setPhase(av.mode === 'on' ? 'unavailable' : 'unlicensed');
        }
        const b = await call('bootstrap');
        setBoot(b);
        const aiState = effectiveAi(b);
        setAiOn(aiState.enabled);
        setAiStopped(aiState.stopped);
        bootRef.current = b;
        const l = readStoredLang() || b.prefs?.lang || normalizeLang(b.user?.locale || c.locale);
        setLangState(l);
        storeLang(l);
        document.documentElement.lang = l;
        if (!b.allowed) return setPhase('forbidden');
        if (b.mode === 'site') return setPhase('site-start');
        return loadProject();
      } catch (e) {
        if (e?.code === 'UNAVAILABLE') return setPhase('unavailable');
        if (e?.code === 'LICENSE_INACTIVE') return setPhase('unlicensed');
        lastError = e;
        if (e?.code?.startsWith?.('FORBIDDEN')) break;
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }
    setError(lastError);
    setPhase(lastError?.code?.startsWith?.('FORBIDDEN') ? 'forbidden' : 'error');
  }, [loadProject]);

  useEffect(() => { start(); }, [start]);

  // A Jira admin may turn the AI on or off on the site page (or the vendor may stop it) while this page stays open:
  // re-check the effective state when the page gets focus or becomes visible again (at most every 15 s). An error
  // counts as off, like at start-up.
  const aiCheckedAt = useRef(0);
  useEffect(() => {
    if (!boot) return undefined;
    aiCheckedAt.current = Date.now();
    const recheck = async () => {
      if (document.visibilityState === 'hidden' || Date.now() - aiCheckedAt.current < AI_RECHECK_MS) return;
      aiCheckedAt.current = Date.now();
      const next = await fetchEffectiveAi(() => call('bootstrap'));
      setAiOn(next.enabled);
      setAiStopped(next.stopped);
    };
    window.addEventListener('focus', recheck);
    document.addEventListener('visibilitychange', recheck);
    return () => {
      window.removeEventListener('focus', recheck);
      document.removeEventListener('visibilitychange', recheck);
    };
  }, [boot]);

  const model = useMemo(() => (bundle ? normalize(bundle) : null), [bundle]);
  const allWorkflows = model?.workflows || [];
  const workflows = wfSel === 'all' ? allWorkflows : allWorkflows.filter((w) => w.id === wfSel);
  const diagramWf = workflows[0] || null;
  const principals = useMemo(() => collectPrincipals(allWorkflows), [allWorkflows]);
  const personaSim = useMemo(() => (diagramWf && overlayMode === 'persona' ? simulatePersona(diagramWf, personaFromSelection(principals, persona.selected)) : null), [diagramWf, overlayMode, principals, persona]);
  // Older backends only report isJiraAdmin/allowed: derive the same capabilities (the server enforces them anyway)
  const caps = boot?.caps || (boot ? { ...NO_CAPS, role: boot.isJiraAdmin ? 'jira-admin' : boot.allowed ? 'project-admin' : 'none', jiraAdmin: !!boot.isJiraAdmin, projectAdmin: !!boot.allowed, changeShared: !!boot.isJiraAdmin, changeProjectScoped: !!boot.allowed, createTasks: !!boot.allowed, bulk: !!boot.isJiraAdmin && boot.mode === 'site' } : NO_CAPS);

  const fetchLoad = async (days) => {
    setLoadState('loading');
    try {
      const ids = [...new Set(allWorkflows.flatMap((w) => w.statuses.map((s) => s.id)).filter(Boolean))];
      setLoad(await call('getStatusLoad', { statusIds: ids, staleDays: days }));
      setLoadState('ready');
    } catch {
      setLoadState('error');
    }
  };

  // Issue resolution check: two approximate counts, refreshed with every analysis and after each repair
  const fetchResAudit = useCallback(() => call('resolutionAudit').then(setResAudit).catch(() => setResAudit(false)), []);
  useEffect(() => { if (model) fetchResAudit(); }, [model, fetchResAudit]);
  const resWrong = resAudit ? resAudit.doneUnresolved + resAudit.openResolved : 0;

  // No Rovo hand-off while AI is off (every such button is hidden then; the Rovo actions refuse on the server too)
  const askRovo = (prompt) => (aiOn ? openRovo(prompt).catch(() => toast(t('app.rovoUnavailable'))) : Promise.resolve(false));

  // Sticky toolbars sit under the nav, whose height changes when it wraps. A callback ref attaches the observer
  // exactly when the nav mounts. --nav-h only positions elements BELOW the nav; nothing inside the nav may use
  // it, otherwise measuring would feed back into the nav's own height.
  const navObserver = useRef(null);
  const navRef = useCallback((el) => {
    navObserver.current?.disconnect();
    navObserver.current = null;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let last = 0;
    const measure = () => {
      const h = Math.round(el.getBoundingClientRect().height);
      if (h && h !== last) { last = h; document.documentElement.style.setProperty('--nav-h', `${h}px`); }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    navObserver.current = ro;
  }, []);

  // Keyboard shortcuts: "/" search, Alt+1..9 tabs, "?" tour, Esc closes overlays
  const tabsRef = useRef([]);
  useEffect(() => {
    const onKey = (e) => {
      const typing = /input|textarea|select/i.test(e.target?.tagName || '');
      if (e.key === 'Escape') { setDrawer(null); setTourOpen(false); setRemFindings(null); return; }
      if (typing) return;
      if (e.key === '/') { e.preventDefault(); document.getElementById('wfa-omnibox')?.focus(); }
      else if (e.key === '?') setTourOpen(true);
      else if (e.altKey && /^[1-9]$/.test(e.key)) { const id = tabsRef.current[Number(e.key) - 1]; if (id) { e.preventDefault(); setTab(id); } }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Once per session: record this visit with the current findings; the answer says what is new / resolved since the last one
  const visitSent = useRef(false);
  useEffect(() => {
    if (!model || model.kind !== 'project' || visitSent.current) return;
    visitSent.current = true;
    const keys = model.findings.filter((f) => f.severity !== 'info').map(findingKey);
    call('touchVisit', { findings: keys }).then(setVisit).catch(() => {});
  }, [model]);
  const digest = useMemo(() => {
    const prev = visit?.previous;
    if (!model || !prev?.keys || visit.digestSeen) return null;
    const before = new Set(prev.keys);
    const current = model.findings.filter((f) => f.severity !== 'info');
    const now = new Set(current.map(findingKey));
    const added = current.filter((f) => !before.has(findingKey(f)));
    const resolved = prev.keys.filter((k) => !now.has(k)).length;
    return added.length || resolved ? { added, resolved, since: prev.at } : null;
  }, [model, visit]);

  // Come back to where you left off: last tab and workflow, per project (site page separately)
  const placeKey = boot ? `wfa.place.${boot.mode === 'site' ? 'site' : boot.project?.id || boot.project?.key || 'project'}` : null;
  const placeRestored = useRef(false);
  useEffect(() => {
    if (!model || !placeKey || placeRestored.current) return;
    placeRestored.current = true;
    try {
      const s = JSON.parse(window.localStorage.getItem(placeKey) || 'null');
      if (s?.wfSel && (s.wfSel === 'all' || model.workflows.some((w) => w.id === s.wfSel))) setWfSel(s.wfSel);
      if (s?.tab && tabsRef.current.includes(s.tab)) setTab(s.tab);
    } catch { /* storage unavailable: start on the overview */ }
  }, [model, placeKey]);
  // A new tab starts at the top; layout effect so views can still scroll to a target afterwards
  useLayoutEffect(() => {
    const root = document.getElementById('root');
    if (root?.scrollTop) root.scrollTo({ top: 0, behavior: 'instant' });
  }, [tab]);
  useEffect(() => {
    if (!placeKey || !placeRestored.current) return;
    try { window.localStorage.setItem(placeKey, JSON.stringify({ tab, wfSel })); } catch { /* not essential */ }
  }, [tab, wfSel, placeKey]);

  // ---------------------------------------------------------------- actions
  const findTransition = (tKey) => {
    for (const wf of allWorkflows) {
      const tr = wf.transitions.find((x) => x.key === tKey);
      if (tr) return { wf, tr };
    }
    return null;
  };

  const actions = {
    setTab,
    openTransition: (tKey) => setDrawer(tKey),
    openRef: (type, id) => { setRefType(type); setRefId(id); setTab('impact'); setDrawer(null); },
    openRefType: (type) => { setRefType(type); setRefId(null); setTab('impact'); },
    goHealth: (s) => { setHcFocus(null); setSev(s); setTab('health'); },
    // Narrow the health check to one kind of finding (from the action plan)
    focusHealth: (code) => { setHcFocus(code); setSev('all'); setTab('health'); },
    clearHealthFocus: () => setHcFocus(null),
    // Open Autopilot with a plan selected, or with a request typed in for the Copilot
    planChange: (intent) => { setApIntent({ ...intent, at: Date.now() }); setTab('autopilot'); },
    // One plan per affected workflow with only the chosen findings' fixes; opens the first in Autopilot
    fixFindings: async (findings) => {
      // Site page: one bulk change, each workflow planned with its own fixes, then validated, applied and rolled back per workflow
      if (boot?.mode === 'site') {
        setBulkPrefill({ autofix: { fingerprints: findings.map(findingFingerprint), workflowIds: [...new Set(findings.map((f) => f.wfId))], n: findings.length }, at: Date.now() });
        setTab('bulk');
        return null;
      }
      const byWf = new Map();
      for (const f of findings) byWf.set(f.wfId, [...(byWf.get(f.wfId) || []), findingFingerprint(f)]);
      const created = [];
      let lastError = null;
      for (const [workflowId, fingerprints] of byWf) {
        try { created.push(await call('autofixPlan', { workflowId, fingerprints, lang })); } catch (e) { lastError = e; }
      }
      if (!created.length) {
        toast(lastError?.code === 'NOTHING_TO_FIX' ? t('fix.none') : lastError?.code === 'FORBIDDEN_CHANGE_GLOBAL' ? t('role.cannotChange') : lastError?.message || t('fix.none'));
        return null;
      }
      setApIntent({ planId: created[0].id, at: Date.now() });
      setTab('autopilot');
      toast(created.length === 1 ? t('fix.planReady') : t('fix.plansReady', { n: created.length }));
      return created;
    },
    selectWorkflow: (id, nextTab) => { setWfSel(id); if (nextTab) setTab(nextTab); },
    saveNote: async (workflowId, transitionId, text) => {
      const saved = await call('saveNote', { workflowId, transitionId, text });
      setNotes((n) => {
        const w = { ...(n[workflowId] || {}) };
        if (saved) w[transitionId] = saved; else delete w[transitionId];
        return { ...n, [workflowId]: w };
      });
    },
    showOverlay: (mode) => { setOverlayMode(mode); setTab('diagram'); },
    showImpact: (entry) => {
      setImpactOverlay({ keys: new Set(entry.usages.map((u) => u.tKey)), label: entry.name });
      setOverlayMode('impact');
      if (entry.workflowIds?.length) setWfSel(entry.workflowIds[0]);
      setTab('diagram');
    },
    openRemediation: (findings) => setRemFindings(findings),
    // Existing issues whose resolution does not match their status (Health tab, repair panel open)
    openResolutions: () => { setResOpen(true); setHcFocus(null); setTab('health'); },
    resAudit,
    openBulk: (prefill) => { setBulkPrefill({ ...prefill, at: Date.now() }); setTab('bulk'); },
    askRovo,
    exportSelection: (keys) => {
      const set = new Set(keys);
      const wfs = allWorkflows.filter((w) => w.transitions.some((x) => set.has(x.key)));
      const file = runExport('html', { model, workflows: wfs, notes, opts: { ...defaultExportOpts(lang), onlyKeys: keys } });
      toast(translate(lang, 'ex.done', { file }));
    },
    // Can the current user change this workflow? Mirrors the server rule; the server checks again on every call.
    canChange: (wf) => (!wf ? false : wf.scope === 'PROJECT' ? caps.changeProjectScoped : caps.changeShared),
  };

  // ---------------------------------------------------------------- render
  // Before bootstrap (e.g. while the app is unavailable) the Forge context still says which page this is
  const site = boot ? boot.mode === 'site' : String(ctx?.moduleKey || '').endsWith('workflow-analyzer-admin');
  const project = model?.project || boot?.project || ctx?.extension?.project || null;
  const tabGroups = [
    [
      ['overview', t('tab.overview'), 'layers'],
      ['diagram', t('tab.diagram'), 'diagram'],
      ['transitions', t('tab.transitions'), 'list', model?.stats.transitions],
    ],
    [
      ['impact', t('tab.impact'), 'link'],
      ['health', t('tab.health'), 'pulse', model?.stats.findings.high, model?.stats.findings.high > 0],
    ],
    [
      site ? ['bulk', t('tab.bulk'), aiOn ? 'sparkle' : 'layers'] : ['autopilot', 'Autopilot', aiOn ? 'sparkle' : 'wand'],
      ...(site ? [] : [['changes', t('tab.changes'), 'history']]),
    ],
    [
      ['access', t('tab.access'), 'shieldCheck'],
      ...(site ? [] : [['flow', t('tab.flow'), 'flow']]),
      ...(allWorkflows.length > 1 ? [['compare', t('tab.compare'), 'compare']] : []),
    ],
    [
      // Without AI the tab keeps only its plain-language explanations, under a name that promises no AI
      ['assistant', aiOn ? t('tab.assistant') : t('tab.explain'), aiOn ? 'message' : 'info'],
      ['export', t('tab.export'), 'download'],
      ['guide', t('tab.guide'), 'book'],
      ...(site && caps.jiraAdmin ? [['settings', t('tab.settings'), 'wrench']] : []),
    ],
  ];
  const tabs = tabGroups.flat();
  const drawerData = drawer ? findTransition(drawer) : null;
  tabsRef.current = tabs.map((x) => x[0]);
  const changedSinceVisit = visit?.state?.lastChangeAt && (!visit.lastSeen || visit.state.lastChangeAt > visit.lastSeen);
  const heading = site ? t('app.subtitleSite') : project?.name || ctx?.extension?.project?.key || t('app.title');
  const refresh = site ? scanSite : () => loadProject({ silent: true });

  return (
    <LangContext.Provider value={lang}>
      <AppContext.Provider value={{ model, notes, actions, caps, ai: { enabled: aiOn, stopped: aiStopped, set: setAiOn, setStopped: setAiStopped }, staticRender: false }}>
        <header className="apphead">
          <div className="head-inner">
            <img className="brand-icon" src={appIcon} alt={t('app.title')} width="44" height="44" />
            <div className="head-title">
              <nav className="crumb" aria-label={t('app.title')}>
                <span>{t('app.title')}</span>
                <span className="sep" aria-hidden="true">/</span>
                <strong>{site ? t('app.siteCrumb') : project?.key || '…'}</strong>
                {phase === 'ready' && <RolePill caps={caps} t={t} />}
              </nav>
              <h1 title={heading}>{heading}</h1>
            </div>
            <div className="head-actions">
              {model && <Omnibox model={model} t={t} onPick={(r) => {
                if (r.type === 'ref') return actions.openRef(r.refType, r.refId);
                if (r.tKey) return actions.openTransition(r.tKey);
                actions.selectWorkflow(r.wfId, r.type === 'status' ? 'diagram' : 'overview');
              }} />}
              {model && !site && aiOn && (
                <button type="button" className="hbtn" onClick={() => askRovo(translate(lang, 'as.s1', { key: model.project?.key }))}>
                  <Icon name="sparkle" /><span className="hide-md">{t('app.askRovo')}</span>
                </button>
              )}
              {model && (
                <button type="button" className="hbtn only" onClick={refresh} aria-label={t('app.refresh')} title={t('app.refresh')} disabled={refreshing}>
                  <Icon name="refresh" className={refreshing ? 'spin' : ''} style={refreshing ? { animation: 'spin 0.9s linear infinite' } : undefined} />
                </button>
              )}
              {model && (
                <button type="button" className="hbtn only" onClick={() => setTourOpen(true)} aria-label={t('tour.title')} title={`${t('tour.title')} (?)`}>
                  <Icon name="help" />
                </button>
              )}
              <div className="seg" role="group" aria-label={t('app.lang')}>
                <button type="button" aria-pressed={lang === 'de'} onClick={() => setLang('de')}>DE</button>
                <button type="button" aria-pressed={lang === 'en'} onClick={() => setLang('en')}>EN</button>
              </div>
            </div>
          </div>
        </header>

        {phase === 'ready' && model && (
          <nav className="navbar" aria-label={t('app.title')} ref={navRef}>
            <div className="nav-inner">
              <Tabs groups={tabGroups} tab={tab} setTab={setTab} lang={lang} t={t} />
              {allWorkflows.length > 0 && (
                <div className="wf-select" title={t('app.workflowHint')}>
                  <label className="small muted" htmlFor="wf-sel">{t('app.workflow')}</label>
                  <select id="wf-sel" value={wfSel} onChange={(e) => setWfSel(e.target.value)}>
                    {allWorkflows.length > 1 && <option value="all">{t('app.allWorkflows', { n: allWorkflows.length })}</option>}
                    {allWorkflows.map((w) => {
                      const scope = site ? w.projects.map((p) => p.key) : w.issueTypes.map((i) => i.name);
                      return <option key={w.id} value={w.id}>{w.name}{scope.length ? ` (${scope.slice(0, 4).join(', ')}${scope.length > 4 ? ' …' : ''})` : ''}</option>;
                    })}
                  </select>
                </div>
              )}
            </div>
          </nav>
        )}

        <main className="page">
          {maint.mode === 'readonly' && phase !== 'unavailable' && <ReadonlyBanner statusUrl={maint.statusUrl} t={t} />}
          {phase === 'unavailable' && <Unavailable statusUrl={maint.statusUrl} t={t} />}
          {phase === 'unlicensed' && <Unlicensed t={t} />}

          {(phase === 'boot' || phase === 'loading') && <LoadingState t={t} />}

          {phase === 'scanning' && (
            <div className="loading" role="status">
              <img src={appIcon} alt="" width="40" height="40" className="pulse-logo" />
              <div>{progress ? t(progress.key, progress) : t('app.loading')}</div>
              {progress?.total ? <div className="bar progress" aria-hidden="true"><span style={{ width: `${(100 * (progress.done || 0)) / progress.total}%`, animation: 'none', transition: 'width 400ms var(--ease)' }} /></div> : null}
            </div>
          )}

          {phase === 'forbidden' && (
            <div className="card view" style={{ maxWidth: 720, margin: '32px auto' }}>
              <div className="row" style={{ gap: 12, alignItems: 'flex-start', flexWrap: 'nowrap' }}>
                <Icon name="lock" size={22} style={{ color: 'var(--text-muted)', marginTop: 2 }} />
                <div className="stack" style={{ gap: 6 }}>
                  <h2 style={{ margin: 0 }}>{t('app.forbiddenTitle')}</h2>
                  <p className="muted" style={{ margin: 0 }}>{site || error?.code === 'FORBIDDEN_SITE' ? t('app.forbiddenSite') : t('app.forbidden')}</p>
                </div>
              </div>
            </div>
          )}

          {phase === 'error' && (
            <div className="alert error view">
              <Icon name="alert" size={18} />
              <div className="stack" style={{ gap: 8 }}>
                <strong>{t('app.error')}</strong>
                <div className="small">{error?.message}</div>
                <div><button type="button" className="btn small" onClick={!boot ? start : site ? scanSite : () => loadProject()}><Icon name="refresh" />{t('app.retry')}</button></div>
              </div>
            </div>
          )}

          {phase === 'site-start' && (
            <section className="decision view" style={{ maxWidth: 920, margin: '24px auto' }}>
              <div className="body">
                <h2 style={{ margin: 0 }}>{t('app.subtitleSite')}</h2>
                <p style={{ margin: 0 }}>{t('site.intro')}</p>
                <p className="small muted" style={{ margin: 0 }}>{t('site.introHint')}</p>
              </div>
              <div className="aside" style={{ justifyContent: 'center', gap: 10 }}>
                <button type="button" className="btn primary" onClick={scanSite}><Icon name="search" />{t('site.scan')}</button>
                <span className="small muted">{t('site.scanReadOnly')}</span>
              </div>
            </section>
          )}
          {phase === 'site-start' && caps.jiraAdmin && <AiSettings onChange={(on, stopped) => { setAiOn(on); setAiStopped(stopped); }} style={{ maxWidth: 920, margin: '0 auto 24px' }} />}

          {phase === 'ready' && model && (
            <>
              {digest && (
                <div className="alert info view digest">
                  <Icon name="pulse" size={18} />
                  <span style={{ flex: 1 }}>
                    {t('dig.since', { date: formatDate(lang, digest.since) })}{' '}
                    {digest.added.length > 0 && <strong>{digest.added.length === 1 ? t('dig.new1') : t('dig.new', { n: digest.added.length })}</strong>}
                    {digest.added.length > 0 && digest.resolved > 0 && ' · '}
                    {digest.resolved > 0 && <span>{digest.resolved === 1 ? t('dig.resolved1') : t('dig.resolved', { n: digest.resolved })}</span>}
                  </span>
                  {digest.added.length > 0 && <button type="button" className="btn small" onClick={() => { setHcFocus({ keys: new Set(digest.added.map(findingKey)), label: t('dig.focus') }); setSev('all'); setTab('health'); }}>{t('dig.show')}</button>}
                  <button type="button" className="btn small ghost" aria-label={t('app.dismiss')} onClick={() => setVisit({ ...visit, digestSeen: true })}><Icon name="x" /></button>
                </div>
              )}
              {changedSinceVisit && (
                <div className="alert info view">
                  <Icon name="bell" size={18} />
                  <span style={{ flex: 1 }}>{t('mon.banner', { date: formatDate(lang, visit.state.lastChangeAt), n: visit.state.lastChangeCount || 0 })}{visit.state.newHigh ? ` · ${t('mon.newHigh', { n: visit.state.newHigh })}` : ''}</span>
                  <button type="button" className="btn small" onClick={() => { setTab('changes'); setVisit({ ...visit, lastSeen: visit.state.lastChangeAt }); }}>{t('mon.show')}</button>
                  <button type="button" className="btn small ghost" aria-label={t('app.dismiss')} onClick={() => setVisit({ ...visit, lastSeen: visit.state.lastChangeAt })}><Icon name="x" /></button>
                </div>
              )}
              {resWrong > 0 && tab === 'overview' && (
                <div className="alert view">
                  <Icon name="alert" size={18} />
                  <span style={{ flex: 1 }}>{resWrong === 1 ? t('rs.banner1') : t('rs.banner', { n: resWrong })}</span>
                  <button type="button" className="btn small primary" onClick={actions.openResolutions}><Icon name="wand" />{t('rs.bannerAction')}</button>
                </div>
              )}
              {model.warnings?.length > 0 && (
                <details className="alert info">
                  <summary><span className="small">{t('app.warning')}: {model.warnings.length}</span></summary>
                  <ul className="small" style={{ margin: '8px 0 0', paddingLeft: 18 }}>{model.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
                </details>
              )}
              {allWorkflows.length === 0 && (
                <div className="card empty-state">
                  <Icon name="workflow" size={36} />
                  <strong>{t('app.noWorkflows')}</strong>
                </div>
              )}
              {allWorkflows.length > 0 && (
                <div className="view" key={tab}>
                  {tab === 'overview' && <Overview model={model} workflows={workflows} />}
                  {tab === 'diagram' && (diagramWf ? (
                    <>
                      {workflows.length > 1 && <div className="small muted" style={{ marginBottom: 10 }}>{t('dg.selectWorkflow')} · <strong>{diagramWf.name}</strong></div>}
                      <Diagram wf={diagramWf} model={model} setOverlayMode={setOverlayMode} overlay={{ mode: overlayMode, load, sim: personaSim, impact: impactOverlay?.keys, impactLabel: impactOverlay?.label }} />
                    </>
                  ) : <div className="empty">{t('dg.selectWorkflow')}</div>)}
                  {tab === 'transitions' && <Transitions model={model} workflows={workflows} search={search} setSearch={setSearch} />}
                  {tab === 'impact' && <Impact model={model} refType={refType} setRefType={setRefType} refId={refId} setRefId={setRefId} refData={bundle?.ref} />}
                  {tab === 'health' && <Health model={model} workflows={workflows} sev={sev} setSev={setSev} focus={hcFocus} remediation={remediation} siteUrl={ctx?.siteUrl} resolutions={bundle?.ref?.resolutions} dataCard={resAudit === false ? null : <Resolutions audit={resAudit} refreshAudit={fetchResAudit} resolutions={bundle?.ref?.resolutions || []} siteUrl={ctx?.siteUrl} open={resOpen} setOpen={setResOpen} />} />}
                  {tab === 'access' && <Access model={model} workflows={workflows} persona={persona} setPersona={setPersona} />}
                  {tab === 'flow' && <Flow model={model} workflows={workflows} load={load} loadState={loadState} fetchLoad={fetchLoad} />}
                  {tab === 'compare' && <Compare model={model} />}
                  {tab === 'guide' && <Guide onTour={() => setTourOpen(true)} />}
                  {tab === 'bulk' && <BulkAutopilot model={model} refData={bundle?.ref} prefill={bulkPrefill} toast={toast} />}
                  {tab === 'autopilot' && <Autopilot model={model} workflows={workflows.length ? workflows : allWorkflows} allWorkflows={allWorkflows} bundle={bundle} toast={toast} intent={apIntent} reload={() => loadProject({ silent: true })} />}
                  {tab === 'changes' && <Changes model={model} toast={toast} />}
                  {tab === 'assistant' && <Assistant model={model} workflows={workflows} />}
                  {tab === 'settings' && <AiSettings onChange={(on, stopped) => { setAiOn(on); setAiStopped(stopped); }} />}
                  {tab === 'export' && <ExportPanel model={model} workflows={workflows} allWorkflows={allWorkflows} notes={notes} toast={toast} />}
                </div>
              )}
            </>
          )}
        </main>
        {phase === 'ready' && model && (
          <footer className="footer">
            <span className="dot" aria-hidden="true" />
            <span>{t('app.poweredBy')} · {t('app.generated', { date: formatDate(lang, model.generatedAt) })}</span>
          </footer>
        )}

        {drawerData && <TransitionDetails wf={drawerData.wf} tr={drawerData.tr} model={model} onClose={() => setDrawer(null)} />}
        {remFindings && model && (
          <Remediate findings={remFindings} projectKey={model.project?.key} siteUrl={ctx?.siteUrl} remediation={remediation} onClose={() => setRemFindings(null)} onDone={() => call('getRemediation').then(setRemediation).catch(() => {})} />
        )}
        {tourOpen && model && <Tour mode={boot?.mode} onClose={() => { setTourOpen(false); call('setPrefs', { tourDone: true }).catch(() => {}); }} onGoTab={(id) => setTab(id)} />}
        {toastMsg && (
          <div className="toast" role="status" key={toastMsg.id}>
            <span className="dot" aria-hidden="true" />
            <span>{toastMsg.text}</span>
            {toastMsg.action && <button type="button" className="toast-act" onClick={() => { setToastMsg(null); toastMsg.action.run(); }}>{toastMsg.action.icon && <Icon name={toastMsg.action.icon} size={14} />}{toastMsg.action.label}</button>}
          </div>
        )}
      </AppContext.Provider>
    </LangContext.Provider>
  );
}

/**
 * Underline tabs in groups; one orange rule slides to the selected tab. When the row is wider than the space,
 * edge fades and round arrow buttons appear, the mouse wheel scrolls it sideways and the selected tab is centred.
 */
function Tabs({ groups, tab, setTab, lang, t }) {
  const wrap = useRef(null);
  const [ind, setInd] = useState(null);
  const [edges, setEdges] = useState({ l: false, r: false });
  const place = useCallback(() => {
    const w = wrap.current;
    if (!w) return;
    const l = w.scrollLeft > 2;
    const r = w.scrollLeft + w.clientWidth < w.scrollWidth - 2;
    w.classList.toggle('fade-l', l);
    w.classList.toggle('fade-r', r);
    setEdges((p) => (p.l === l && p.r === r ? p : { l, r }));
    const el = w.querySelector('[aria-selected="true"]');
    if (!el) return setInd(null);
    setInd({ x: el.offsetLeft, w: el.offsetWidth });
  }, []);
  // bring the selected tab into view only when it is (partly) hidden – a row that moves under the pointer
  // after every click invites mis-clicks
  useLayoutEffect(() => {
    place();
    const w = wrap.current;
    const el = w?.querySelector('[aria-selected="true"]');
    if (w && el && w.scrollWidth > w.clientWidth) {
      const pad = 44;
      const hidden = el.offsetLeft < w.scrollLeft + pad || el.offsetLeft + el.offsetWidth > w.scrollLeft + w.clientWidth - pad;
      if (hidden) w.scrollTo({ left: Math.max(0, el.offsetLeft - (w.clientWidth - el.offsetWidth) / 2), behavior: 'smooth' });
    }
  }, [tab, lang, groups.length, place]);
  useEffect(() => {
    const w = wrap.current;
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null;
    if (ro && w) ro.observe(w);
    document.fonts?.ready?.then(place);
    // vertical wheel over an overflowing row scrolls it sideways (only while there is room to scroll)
    const onWheel = (e) => {
      if (!w || w.scrollWidth <= w.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      const atStart = w.scrollLeft <= 0 && e.deltaY < 0;
      const atEnd = w.scrollLeft + w.clientWidth >= w.scrollWidth - 1 && e.deltaY > 0;
      if (atStart || atEnd) return;
      e.preventDefault();
      w.scrollBy({ left: e.deltaY, behavior: 'auto' });
    };
    w?.addEventListener('wheel', onWheel, { passive: false });
    return () => { ro?.disconnect(); w?.removeEventListener('wheel', onWheel); };
  }, [place]);
  const nudge = (dir) => {
    const w = wrap.current;
    if (w) w.scrollBy({ left: dir * Math.max(160, w.clientWidth * 0.66), behavior: 'smooth' });
  };
  const flat = groups.flat().map((x) => x[0]);
  const onKeyDown = (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = flat.indexOf(tab);
    const next = flat[(i + (e.key === 'ArrowRight' ? 1 : flat.length - 1)) % flat.length];
    setTab(next);
    requestAnimationFrame(() => wrap.current?.querySelector(`[data-tab="${next}"]`)?.focus());
  };
  return (
    <div className="tabs-shell">
      <button type="button" className={`tab-scroll l ${edges.l ? 'on' : ''}`} tabIndex={-1} aria-hidden={!edges.l} aria-label={t('app.scrollLeft')} onClick={() => nudge(-1)}>
        <Icon name="chevronRight" size={16} strokeWidth={2} style={{ transform: 'rotate(180deg)' }} />
      </button>
      <div className="tabs" role="tablist" ref={wrap} onKeyDown={onKeyDown} onScroll={place}>
        {groups.map((g, gi) => (
          <span key={gi} style={{ display: 'contents' }}>
            {gi > 0 && <span className="tab-sep" aria-hidden="true" />}
            {g.map(([id, label, icon, count, alert]) => (
              <button key={id} type="button" role="tab" data-tab={id} aria-selected={tab === id} tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)}>
                <Icon name={icon} size={16} />
                {label}
                {count ? <span className={`tab-count ${alert ? 'hot' : ''}`}>{count}</span> : null}
              </button>
            ))}
          </span>
        ))}
        {ind && <span className="tab-ind" aria-hidden="true" style={{ transform: `translateX(${ind.x}px)`, width: ind.w }} />}
      </div>
      <button type="button" className={`tab-scroll r ${edges.r ? 'on' : ''}`} tabIndex={-1} aria-hidden={!edges.r} aria-label={t('app.scrollRight')} onClick={() => nudge(1)}>
        <Icon name="chevronRight" size={16} strokeWidth={2} />
      </button>
    </div>
  );
}

function RolePill({ caps, t }) {
  const key = caps.jiraAdmin ? 'role.jiraAdmin' : caps.projectAdmin ? 'role.projectAdmin' : 'role.none';
  const tone = caps.jiraAdmin ? '' : caps.projectAdmin ? 'limited' : 'none';
  return (
    <span className={`role-pill ${tone}`} role="status" title={t(`${key}.hint`)} aria-label={`${t(key)}: ${t(`${key}.hint`)}`}>
      <Icon name={caps.jiraAdmin ? 'shieldCheck' : caps.projectAdmin ? 'shield' : 'lock'} size={15} />
      <span><strong>{t(key)}</strong><span className="what"> · {t(`${key}.short`)}</span></span>
    </span>
  );
}

function LoadingState({ t }) {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">{t('app.loading')}</span>
      <div className="grid kpis" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="skel-card">
            <Skeleton w="45%" h={11} />
            <Skeleton w="35%" h={30} />
            <Skeleton w="70%" h={12} />
          </div>
        ))}
      </div>
      <div className="split" aria-hidden="true">
        <div className="main skel-card" style={{ minHeight: 280 }}>
          <Skeleton w="30%" h={18} />
          {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} w={`${92 - i * 9}%`} h={12} />)}
        </div>
        <div className="side skel-card" style={{ minHeight: 280 }}>
          <Skeleton w="50%" h={18} />
          {[0, 1, 2].map((i) => <Skeleton key={i} w="100%" h={40} />)}
        </div>
      </div>
      <p className="small muted" style={{ textAlign: 'center', marginTop: 20 }}>{t('app.loading')}</p>
    </div>
  );
}

function Omnibox({ model, t, onPick }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const ref = useRef(null);
  const results = useMemo(() => searchModel(model, q, 40), [model, q]);
  useEffect(() => {
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const pick = (r) => { onPick(r); setOpen(false); setQ(''); };
  const typeLabel = (r) => (r.type === 'ref' ? t(`ref.${r.refType}`) : r.type === 'workflow' ? t('app.workflow') : r.type === 'status' ? t('ref.status') : r.type === 'rule' ? t('ov.rules') : t('tt.col.transition'));
  const showing = open && q.trim().length >= 2;
  return (
    <div className="omnibox" ref={ref}>
      <Icon name="search" className="icon" />
      <input
        type="search"
        id="wfa-omnibox"
        value={q}
        placeholder={t('app.search')}
        role="combobox"
        aria-expanded={showing}
        aria-controls="wfa-omni-results"
        aria-autocomplete="list"
        onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(0); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          if (e.key === 'Enter' && results[active]) pick(results[active]);
          if (e.key === 'Escape') setOpen(false);
        }}
        aria-label={t('app.search')}
      />
      {!q && <kbd aria-hidden="true">/</kbd>}
      {showing && (
        <div className="omni-results" id="wfa-omni-results" role="listbox">
          {results.length === 0 && <div className="empty" style={{ padding: 12 }}>{t('app.searchNoResults')}</div>}
          {results.map((r, i) => (
            <button key={i} type="button" role="option" aria-selected={i === active} className={i === active ? 'active' : ''} onMouseEnter={() => setActive(i)} onClick={() => pick(r)}>
              <span className="omni-type">{typeLabel(r)}</span>
              <span><strong>{r.label}</strong>{r.sub ? <span className="small muted"> · {r.type === 'ref' ? `${r.sub} ${t('ov.transitions')}` : r.sub}</span> : null}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
