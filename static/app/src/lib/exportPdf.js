/**
 * Branded PDF export with jsPDF: cover with KPIs, verdict and top improvements; per workflow the plain-language
 * guide (usual path, other routes, improvements, every transition explained), diagram and rule table; dependencies,
 * health findings and glossary, with header and footer on every page. Diagrams are rasterised up front so the PDF can be
 * built synchronously inside the click handler.
 *
 * @file        static/app/src/lib/exportPdf.js
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-24
 * @updated     2026-11-24
 */

import { jsPDF } from 'jspdf';
import { autoTable } from 'jspdf-autotable';
import { t as tr, findingText, formatDate } from '../../../../src/shared/i18n.js';
import { layoutWorkflow, diagramSvg } from '../../../../src/shared/diagram.js';
import { describeRule, describeConditionTree } from '../../../../src/shared/explain.js';
import { flattenConditions } from '../../../../src/shared/engine.js';
import { workflowStory, siteStory, exportGlossary, exportScope } from '../../../../src/shared/story.js';
import { REF_TYPES } from '../../../../src/shared/rules.js';

const INK = [38, 39, 41];
const ORANGE = [227, 75, 4];
const SAND = [245, 244, 241];
const LINE = [202, 198, 187];
const SEV = { high: [201, 55, 44], medium: [182, 92, 2], low: [47, 111, 222], info: [107, 106, 103] };

// Standard PDF fonts only cover WinAnsi – map typographic characters to safe equivalents.
export function pdfText(s) {
  return String(s ?? '')
    .replace(/[„“”]/g, '"')
    .replace(/[‚‘’]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/→/g, '->')
    .replace(/[›»]/g, '>')
    .replace(/[‹«]/g, '<')
    .replace(/↓/g, 'v')
    .replace(/↺/g, '(loop)')
    .replace(/[⚠✦◆▶▼▲✓✕]/g, '')
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF€]/g, '?');
}

/** data: URL → Blob without fetch() (blocked by Forge's content security policy). */
export function dataUrlToBlob(dataUrl) {
  const [head, body = ''] = String(dataUrl).split(',');
  const mime = (/^data:([^;,]+)/.exec(head) || [])[1] || 'application/octet-stream';
  const bin = /;base64/.test(head) ? atob(body) : decodeURIComponent(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export function svgToPng(svg, maxW = 3200) {
  return new Promise((resolve) => {
    const m = /viewBox="([-\d.]+) ([-\d.]+) ([\d.]+) ([\d.]+)"/.exec(svg);
    const w = m ? Number(m[3]) : 800;
    const h = m ? Number(m[4]) : 400;
    const scale = Math.min(2, maxW / w, maxW / h);
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w * scale));
      c.height = Math.max(1, Math.round(h * scale));
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      const data = c.toDataURL('image/png');
      // JPEG for the PDF: jsPDF embeds it as is, a large PNG is re-compressed and took seconds per diagram
      const jpeg = c.toDataURL('image/jpeg', 0.9);
      // The PNG as a Blob straight from the canvas: Forge's CSP blocks fetch() of data: URLs (connect-src has no data:)
      if (c.toBlob) c.toBlob((blob) => resolve({ data, jpeg, blob: blob || dataUrlToBlob(data), w, h }), 'image/png');
      else resolve({ data, jpeg, blob: dataUrlToBlob(data), w, h });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

/** Pre-render diagrams (async) so the PDF itself can be produced synchronously inside the click handler. */
export async function preparePdfAssets(model, workflows, lang) {
  const findingKeys = new Set(model.findings.filter((f) => f.tKey && f.severity !== 'info').map((f) => f.tKey));
  const diagrams = {};
  for (const wf of workflows) {
    const svg = diagramSvg(layoutWorkflow(wf, { mode: 'jira', findingKeys, wrap: 5 }), { anyLabel: pdfText(tr(lang, 'dg.any')) });
    diagrams[wf.id] = await svgToPng(svg);
  }
  return { diagrams };
}

function ruleLines(rules, lang) {
  return rules.map((r) => pdfText(`[${r.vendor.name}] ${describeRule(r, lang)}`)).join('\n');
}

const VERDICT = { good: [230, 241, 232], attention: [249, 238, 218], critical: [251, 227, 221] };
const VERDICT_DOT = { good: [46, 125, 74], attention: [166, 83, 0], critical: [196, 43, 28] };
const PRIO = { P1: SEV.high, P2: SEV.medium, P3: SEV.low };

export function buildPdf({ model, workflows, notes, opts, assets, logoWhite, logoDark }) {
  const lang = opts.lang;
  const L = (k, v) => pdfText(tr(lang, k, v));
  const P = (s) => pdfText(s);
  const inc = opts.include;
  const only = opts.onlyKeys ? new Set(opts.onlyKeys) : null;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4', compress: true });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 12;
  const TOP = 22;
  const BOTTOM = H - 16;
  const title = pdfText(opts.label || (workflows.length === 1 ? workflows[0].name : model.project ? `${model.project.key} - ${model.project.name}` : tr(lang, 'app.subtitleSite')));
  doc.setProperties({ title: `${title} - ${L('ex.documentation')}`, subject: L('ex.documentation'), creator: 'Superport Workflow Analyzer', author: 'Superport' });

  // Score, KPIs and apps of what is exported, not of the whole site
  const scope = exportScope(model, workflows, opts.onlyKeys);
  const sub = { ...model, findings: scope.findings };
  const shown = (w) => w.transitions.filter((x) => !only || only.has(x.key));
  const site = siteStory(sub, lang);

  let y = TOP;
  const ensure = (h) => { if (y + h > BOTTOM) { doc.addPage(); y = TOP; } };
  const heading = (text, size = 11.5) => {
    ensure(12);
    doc.setTextColor(...INK);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(size);
    doc.text(P(text), M, y);
    doc.setFont('helvetica', 'normal');
    y += size > 12 ? 7 : 5.5;
  };
  const para = (text, { size = 9, color = INK, indent = 0, bullet = false } = {}) => {
    doc.setFontSize(size);
    doc.setTextColor(...color);
    const lines = doc.splitTextToSize(P(text), W - 2 * M - indent - (bullet ? 4 : 0));
    const lh = size * 0.45;
    ensure(lines.length * lh + 1);
    if (bullet) doc.text('-', M + indent, y);
    doc.text(lines, M + indent + (bullet ? 4 : 0), y);
    y += lines.length * lh + 1.6;
  };
  const verdictBox = (v) => {
    doc.setFontSize(9.5);
    const lines = doc.splitTextToSize(P(v.text), W - 2 * M - 12);
    const h = lines.length * 4.4 + 4.5;
    ensure(h + 2);
    doc.setFillColor(...VERDICT[v.level]);
    doc.rect(M, y - 4, W - 2 * M, h, 'F');
    doc.setFillColor(...VERDICT_DOT[v.level]);
    doc.circle(M + 4, y - 0.2, 1.4, 'F');
    doc.setTextColor(...INK);
    doc.setFont('helvetica', 'bold');
    doc.text(lines, M + 8, y + 0.6);
    doc.setFont('helvetica', 'normal');
    y += h + 2;
  };
  const table = (cfg) => {
    autoTable(doc, { startY: y, ...tableStyle(), ...cfg });
    y = doc.lastAutoTable.finalY + 7;
  };
  const prioCell = (rows) => (d) => {
    if (d.section === 'body' && d.column.index === 0) {
      const r = rows[d.row.index];
      if (r) { d.cell.styles.textColor = [255, 255, 255]; d.cell.styles.fillColor = PRIO[r.priority] || SEV.info; d.cell.styles.fontStyle = 'bold'; }
    }
  };
  const impTable = (imps, showWhere) => {
    const head = [['', L('g.improve.title'), L('g.improve.matters'), L('g.improve.fix')]];
    if (showWhere) head[0].push(L('g.improve.where'));
    head[0].push(L('g.improve.effort'));
    table({
      head,
      body: imps.map((i) => {
        const row = [i.priority, P(`${i.title}${i.count > 1 ? ` (x${i.count})` : ''}`), P(i.matters), P(i.fix + (i.autofix ? `\n${tr(lang, i.autofix === 'some' ? 'g.improve.autofixSome' : 'g.improve.autofix')}` : ''))];
        if (showWhere) row.push(P(i.where.slice(0, 10).join(', ') + (i.where.length > 10 ? ' ...' : '')));
        row.push(P(i.effortText));
        return row;
      }),
      columnStyles: showWhere
        ? { 0: { cellWidth: 10, halign: 'center' }, 1: { cellWidth: 48, fontStyle: 'bold' }, 2: { cellWidth: 62 }, 3: { cellWidth: 70 }, 5: { cellWidth: 22 } }
        : { 0: { cellWidth: 10, halign: 'center' }, 1: { cellWidth: 55, fontStyle: 'bold' }, 2: { cellWidth: 80 }, 4: { cellWidth: 24 } },
      didParseCell: prioCell(imps),
    });
  };
  const list = (arr) => (arr.length ? P(arr.map((x) => `- ${x}`).join('\n')) : L('g.none'));

  // ------------------------------------------------ cover
  doc.setFillColor(...INK);
  doc.rect(0, 0, W, 62, 'F');
  if (logoWhite) doc.addImage(logoWhite, 'PNG', M, 14, 78, 9);
  doc.setFillColor(...ORANGE);
  doc.rect(M, 30, 62, 7, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.text(L('ex.documentation').toUpperCase(), M + 3, 34.8);
  doc.setFontSize(20);
  doc.text(doc.splitTextToSize(title, W - 2 * M)[0], M, 50);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(202, 198, 187);
  const meta = [opts.customer ? `${L('ex.customer')}: ${pdfText(opts.customer)}` : null, model.project ? `${pdfText(model.project.key)} · ${pdfText(model.project.name)}` : L('app.subtitleSite'), L('app.generated', { date: formatDate(lang, model.generatedAt) })].filter(Boolean).join('   |   ');
  doc.text(pdfText(meta), M, 58);

  // KPI tiles
  const s = scope.stats;
  const kpis = [
    [String(s.healthScore), L('ov.health')],
    [String(scope.workflows.length), L('ov.workflows')],
    [String(s.statuses), L('ov.statuses')],
    [String(s.transitions), L('ov.transitions')],
    [String(s.condition), L('ov.conditions')],
    [String(s.validator), L('ov.validators')],
    [String(s.postfunction), L('ov.postfunctions')],
    [String(s.apps), L('ov.apps')],
  ];
  const kw = (W - 2 * M - 7 * 4) / 8;
  kpis.forEach(([v, l], i) => {
    const x = M + i * (kw + 4);
    doc.setFillColor(...SAND);
    doc.setDrawColor(...LINE);
    doc.rect(x, 70, kw, 22, 'FD');
    if (i === 0) { doc.setFillColor(...ORANGE); doc.rect(x, 70, kw, 1.4, 'F'); }
    doc.setTextColor(...INK);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(16);
    doc.text(v, x + 3, 81);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(107, 106, 103);
    doc.text(l.toUpperCase(), x + 3, 88);
  });

  y = 103;
  verdictBox(site.verdict);
  heading(tr(lang, 'g.exec.top'));
  if (site.top.length) impTable(site.top, true);
  else para(tr(lang, 'g.exec.noTop'), { color: VERDICT_DOT.good });
  if (inc.explain) {
    heading(tr(lang, 'g.read.title'), 10);
    para(tr(lang, 'g.read.text'), { color: [107, 106, 103] });
  }
  const apps = scope.vendors.filter((v) => v.thirdParty);
  if (apps.length) {
    heading(tr(lang, 'ov.appsTitle'), 10);
    table({
      head: [[L('ref.app'), 'App key', L('ov.conditions'), L('ov.validators'), L('ov.postfunctions'), L('ov.transitions')]],
      body: apps.map((a) => [pdfText(a.name), pdfText(a.appKey || ''), a.condition, a.validator, a.postfunction, a.transitionCount]),
    });
  }

  // ------------------------------------------------ workflows
  for (const wf of workflows) {
    const rows = shown(wf);
    if (!rows.length) continue;
    const story = workflowStory(sub, wf, lang);
    doc.addPage();
    y = TOP;
    sectionTitle(doc, pdfText(wf.name), M);
    doc.setFontSize(8.5);
    doc.setTextColor(107, 106, 103);
    doc.text(pdfText([tr(lang, `ov.scope.${wf.scope}`), wf.issueTypes.map((i) => i.name).join(', '), wf.projects?.length ? wf.projects.map((p) => p.key).join(', ') : '', wf.updated ? `${tr(lang, 'ov.updated')}: ${formatDate(lang, wf.updated)}` : ''].filter(Boolean).join('  |  ')), M, 28);
    y = 36;

    if (inc.explain) {
      verdictBox(story.verdict);
      heading(tr(lang, 'g.inShort'), 10.5);
      for (const l of story.summary) para(l, { bullet: true });
      y += 2;
      if (!only) {
        heading(tr(lang, 'g.journey.title'), 10.5);
        if (!story.journey.length) para(tr(lang, 'g.journey.none'), { color: SEV.high });
        else {
          para(tr(lang, 'g.journey.intro'), { size: 8.5, color: [107, 106, 103] });
          table({
            head: [['#', L('tt.col.transition'), L('g.who'), L('g.checks'), L('g.auto'), L('g.why')]],
            body: story.journey.map((x) => [
              String(x.n),
              P(`${x.name}\n${x.from ? `${x.from} -> ` : ''}${x.to || ''}${x.screen ? `\n${x.screen}` : ''}`),
              P(x.who),
              list(x.checks),
              list(x.automatic),
              x.why.length ? list(x.why) : '',
            ]),
            columnStyles: { 0: { cellWidth: 8, halign: 'center', fontStyle: 'bold' }, 1: { cellWidth: 44, fontStyle: 'bold' }, 2: { cellWidth: 42 }, 3: { cellWidth: 56 }, 4: { cellWidth: 56 } },
          });
          if (story.journeyEnd) para(story.journeyEnd, { color: VERDICT_DOT.good });
          y += 2;
        }
        heading(tr(lang, 'g.other.title'), 10.5);
        if (!story.others.length) para(tr(lang, 'g.other.none'), { color: [107, 106, 103] });
        else {
          table({
            head: [['', L('tt.col.transition'), L('tt.col.source'), L('tt.col.target'), L('g.who')]],
            body: story.others.map((o) => [P(o.kindText), P(o.name), P(o.from || ''), P(o.to || tr(lang, 'tt.loop')), P(o.who)]),
            columnStyles: { 0: { cellWidth: 34 }, 1: { cellWidth: 50, fontStyle: 'bold' }, 2: { cellWidth: 60 }, 3: { cellWidth: 40 } },
          });
        }
      }
    }

    if (inc.health) {
      const imps = story.improvements;
      heading(tr(lang, 'g.improve.title'), 10.5);
      if (!imps.length) para(tr(lang, 'g.improve.none'), { color: VERDICT_DOT.good });
      else {
        para(tr(lang, 'g.improve.intro'), { size: 8.5, color: [107, 106, 103] });
        impTable(imps, true);
      }
    }

    const img = inc.diagram ? assets?.diagrams?.[wf.id] : null;
    if (img) {
      doc.addPage();
      sectionTitle(doc, `${pdfText(wf.name)} - ${L('tab.diagram')}`, M);
      const top = 28;
      const maxW = W - 2 * M;
      const maxH = BOTTOM - top - 4;
      const ratio = Math.min(maxW / img.w, maxH / img.h, 0.5);
      const iw = img.w * ratio;
      const ih = img.h * ratio;
      doc.setDrawColor(...LINE);
      doc.rect(M, top, maxW, ih + 4);
      if (img.jpeg) doc.addImage(img.jpeg, 'JPEG', M + (maxW - iw) / 2, top + 2, iw, ih, undefined, 'FAST');
      else doc.addImage(img.data, 'PNG', M + (maxW - iw) / 2, top + 2, iw, ih, undefined, 'FAST');
    }

    if (inc.explain) {
      doc.addPage();
      y = TOP;
      sectionTitle(doc, `${pdfText(wf.name)} - ${L('g.cards.title')}`, M);
      y = 28;
      para(tr(lang, 'g.cards.intro'), { size: 8.5, color: [107, 106, 103] });
      const cards = story.transitions.filter((x) => !only || only.has(x.key));
      table({
        head: [[L('tt.col.transition'), L('g.who'), L('g.checks'), L('g.auto'), L('g.why'), L('g.col.issues')]],
        body: cards.map((x) => [
          P(`${x.name} (ID ${x.id})\n${x.from ? `${x.from} -> ` : `${tr(lang, 'dg.start')} -> `}${x.to || tr(lang, 'tt.loop')}${x.onPath ? `\n[${tr(lang, 'g.col.path')}]` : ''}`),
          P(x.who + (x.screen ? `\n${x.screen}` : '')),
          list(x.checks),
          list(x.automatic),
          x.why.length ? list(x.why) : '',
          x.findings.length ? P(x.findings.map((f) => `${tr(lang, `ov.severity.${f.severity}`)}: ${f.title}\n> ${f.fix}`).join('\n')) : '-',
        ]),
        columnStyles: { 0: { cellWidth: 42, fontStyle: 'bold' }, 1: { cellWidth: 36 }, 2: { cellWidth: 48 }, 3: { cellWidth: 48 }, 5: { cellWidth: 60 } },
        didParseCell: (d) => {
          if (d.section === 'body' && d.column.index === 5 && cards[d.row.index]?.findings.length) d.cell.styles.fillColor = [251, 227, 221];
        },
      });
    }

    if (inc.transitions) {
      doc.addPage();
      sectionTitle(doc, `${pdfText(wf.name)} - ${L('g.tech.title')}`, M);
      y = 28;
      const head = [['ID', L('tt.col.source'), L('tt.col.transition'), L('tt.col.target'), L('tt.col.conditions'), L('tt.col.validators'), L('tt.col.postfunctions')]];
      if (inc.notes) head[0].push(L('tt.col.note'));
      const body = rows.map((x) => {
        const row = [
          `${x.id}\n${L(`tt.type.${x.type}`)}`,
          x.isInitial ? L('dg.start') : x.isGlobal ? L('tt.any') : pdfText(x.from.map((f) => f.name).join(', ')),
          pdfText(x.name) + (x.screen ? `\n[${L('tt.col.screen')}: ${pdfText(x.screen.name)}]` : ''),
          pdfText(x.to?.name || tr(lang, 'tt.loop')),
          flattenConditions(x.conditions).length ? pdfText(describeConditionTree(x.conditions, lang)) : '-',
          x.validators.length ? ruleLines(x.validators, lang) : '-',
          x.postFunctions.length || x.triggers.length ? ruleLines([...x.postFunctions, ...x.triggers], lang) : '-',
        ];
        if (inc.notes) row.push(pdfText(notes?.[wf.id]?.[x.id]?.text || ''));
        return row;
      });
      table({
        head,
        body,
        columnStyles: inc.notes
          ? { 0: { cellWidth: 16 }, 1: { cellWidth: 28 }, 2: { cellWidth: 32, fontStyle: 'bold' }, 3: { cellWidth: 28 }, 7: { cellWidth: 30 } }
          : { 0: { cellWidth: 16 }, 1: { cellWidth: 30 }, 2: { cellWidth: 34, fontStyle: 'bold' }, 3: { cellWidth: 30 } },
      });
    }
  }

  // ------------------------------------------------ dependencies
  if (inc.impact) {
    doc.addPage();
    sectionTitle(doc, L('im.title'), M);
    let first = true;
    for (const rt of REF_TYPES) {
      const items = Object.values(scope.index[rt] || {});
      if (!items.length) continue;
      autoTable(doc, {
        startY: first ? 26 : doc.lastAutoTable.finalY + 6,
        head: [[`${L(`refs.${rt}`)} (${items.length})`, 'ID', L('ov.transitions'), L('im.affected')]],
        body: items.sort((a, b) => b.transitionCount - a.transitionCount).map((e) => [
          pdfText(e.name) + (e.resolved === false ? ` (${L('im.unresolved')})` : e.inactive ? ` (${L('im.inactive')})` : ''),
          pdfText(e.id),
          e.transitionCount,
          pdfText([...new Set(e.usages.map((u) => `${u.wfName} > ${u.tName}`))].join('; ')),
        ]),
        ...tableStyle(),
        columnStyles: { 0: { cellWidth: 55, fontStyle: 'bold' }, 1: { cellWidth: 55 }, 2: { cellWidth: 22 } },
        didParseCell: (d) => {
          if (d.section === 'body' && d.column.index === 0 && /\((not found|nicht gefunden|inactive|inaktiv)\)$/.test(String(d.cell.raw))) d.cell.styles.textColor = SEV.high;
        },
      });
      first = false;
    }
  }

  // ------------------------------------------------ health
  if (inc.health) {
    doc.addPage();
    sectionTitle(doc, `${L('hc.title')} - ${s.healthScore}/100`, M);
    const flist = sub.findings;
    y = 26;
    table({
      head: [[L('hc.level'), L('g.col.problem'), L('g.improve.matters'), L('hc.recommendation')]],
      body: flist.map((f) => {
        const ft = findingText(lang, f);
        return [L(`ov.severity.${f.severity}`), pdfText(`${ft.title}\n${f.wfName}${f.tName ? ` > ${f.tName}` : ''}`), L(`why.finding.${f.code}`), pdfText(ft.fix)];
      }),
      columnStyles: { 0: { cellWidth: 22, fontStyle: 'bold' }, 1: { cellWidth: 80 }, 2: { cellWidth: 80 } },
      didParseCell: (d) => {
        if (d.section === 'body' && d.column.index === 0) {
          const f = flist[d.row.index];
          if (f) { d.cell.styles.textColor = [255, 255, 255]; d.cell.styles.fillColor = SEV[f.severity]; }
        }
      },
    });
  }

  // ------------------------------------------------ glossary
  if (inc.explain) {
    doc.addPage();
    sectionTitle(doc, L('g.glossary.title'), M);
    y = 26;
    table({
      body: exportGlossary(lang).map((g) => [P(g.term), P(g.text)]),
      columnStyles: { 0: { cellWidth: 50, fontStyle: 'bold' } },
    });
  }

  // ------------------------------------------------ header / footer on every page
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    if (p > 1) {
      doc.setFillColor(...INK);
      doc.rect(0, 0, W, 14, 'F');
      if (logoWhite) doc.addImage(logoWhite, 'PNG', M, 4.6, 40, 4.6);
      doc.setFontSize(8);
      doc.setTextColor(202, 198, 187);
      doc.text(pdfText(`${title}${opts.customer ? ` · ${opts.customer}` : ''}`), W - M, 8.8, { align: 'right' });
    }
    doc.setDrawColor(...ORANGE);
    doc.setLineWidth(0.6);
    doc.line(M, H - 9, W - M, H - 9);
    doc.setFontSize(7.5);
    doc.setTextColor(107, 106, 103);
    doc.text(L('ex.createdBy'), M, H - 5);
    doc.text(L('ex.page', { n: p, total: pages }), W - M, H - 5, { align: 'right' });
  }
  void logoDark;
  return doc;
}

function sectionTitle(doc, text, M) {
  doc.setTextColor(...INK);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.text(text, M, 22);
  doc.setFont('helvetica', 'normal');
}

function tableStyle() {
  return {
    theme: 'grid',
    rowPageBreak: 'avoid',
    margin: { top: 18, left: 12, right: 12, bottom: 14 },
    styles: { font: 'helvetica', fontSize: 7.2, cellPadding: 1.6, textColor: INK, lineColor: LINE, lineWidth: 0.15, valign: 'top', overflow: 'linebreak' },
    headStyles: { fillColor: INK, textColor: [202, 198, 187], fontStyle: 'bold', fontSize: 7 },
    alternateRowStyles: { fillColor: SAND },
  };
}
