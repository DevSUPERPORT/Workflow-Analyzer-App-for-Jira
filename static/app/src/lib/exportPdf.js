/**
 * Branded PDF export with jsPDF: cover with KPIs, workflows with diagrams and transitions, dependencies and
 * health findings, with header and footer on every page. Diagrams are rasterised up front so the PDF can be
 * built synchronously inside the click handler.
 *
 * @file        static/app/src/lib/exportPdf.js
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-24
 * @updated     2026-11-05
 */

import { jsPDF } from 'jspdf';
import { autoTable } from 'jspdf-autotable';
import { t as tr, findingText, formatDate } from '../../../../src/shared/i18n.js';
import { layoutWorkflow, diagramSvg } from '../../../../src/shared/diagram.js';
import { describeWorkflow, describeRule, describeConditionTree } from '../../../../src/shared/explain.js';
import { flattenConditions } from '../../../../src/shared/engine.js';
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
    .replace(/↺/g, '(loop)')
    .replace(/[⚠✦◆▶▼▲✓✕]/g, '')
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF€]/g, '?');
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
      resolve({ data: c.toDataURL('image/png'), w, h });
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

export function buildPdf({ model, workflows, notes, opts, assets, logoWhite, logoDark }) {
  const lang = opts.lang;
  const L = (k, v) => pdfText(tr(lang, k, v));
  const inc = opts.include;
  const only = opts.onlyKeys ? new Set(opts.onlyKeys) : null;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4', compress: true });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 12;
  const title = pdfText(opts.label || (workflows.length === 1 ? workflows[0].name : model.project ? `${model.project.key} - ${model.project.name}` : tr(lang, 'app.subtitleSite')));
  doc.setProperties({ title: `${title} - ${L('ex.documentation')}`, subject: L('ex.documentation'), creator: 'Superport Workflow Analyzer', author: 'Superport' });

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
  const s = model.stats;
  const kpis = [
    [String(s.healthScore), L('ov.health')],
    [String(workflows.length), L('ov.workflows')],
    [String(s.statuses), L('ov.statuses')],
    [String(workflows.reduce((a, w) => a + w.transitions.length, 0)), L('ov.transitions')],
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

  let y = 102;
  doc.setTextColor(...INK);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text(L('ov.summaryTitle'), M, y);
  y += 5;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  for (const wf of workflows) {
    const lines = doc.splitTextToSize(pdfText(`${wf.name}: ${describeWorkflow(model, wf, lang).join(' ')}`), W - 2 * M);
    if (y + lines.length * 4 > H - 18) { doc.addPage(); y = 22; }
    doc.text(lines, M, y);
    y += lines.length * 4 + 3;
  }

  const apps = model.vendors.filter((v) => v.thirdParty);
  if (apps.length) {
    autoTable(doc, {
      startY: y + 2,
      head: [[L('ref.app'), 'App key', L('ov.conditions'), L('ov.validators'), L('ov.postfunctions'), L('ov.transitions')]],
      body: apps.map((a) => [pdfText(a.name), pdfText(a.appKey || ''), a.condition, a.validator, a.postfunction, a.transitionCount]),
      ...tableStyle(),
    });
  }

  // ------------------------------------------------ workflows
  for (const wf of workflows) {
    const rows = wf.transitions.filter((x) => !only || only.has(x.key));
    if (!rows.length) continue;
    doc.addPage();
    sectionTitle(doc, pdfText(wf.name), M);
    doc.setFontSize(8.5);
    doc.setTextColor(107, 106, 103);
    doc.text(pdfText([tr(lang, `ov.scope.${wf.scope}`), wf.issueTypes.map((i) => i.name).join(', '), wf.projects?.length ? wf.projects.map((p) => p.key).join(', ') : ''].filter(Boolean).join('  |  ')), M, 28);
    let top = 32;
    const img = inc.diagram ? assets?.diagrams?.[wf.id] : null;
    if (img) {
      const maxW = W - 2 * M;
      const maxH = H - top - 16;
      const ratio = Math.min(maxW / img.w, maxH / img.h, 0.5);
      const iw = img.w * ratio;
      const ih = img.h * ratio;
      doc.setDrawColor(...LINE);
      doc.rect(M, top, maxW, ih + 4);
      doc.addImage(img.data, 'PNG', M + (maxW - iw) / 2, top + 2, iw, ih);
      doc.addPage();
      sectionTitle(doc, `${pdfText(wf.name)} - ${L('tab.transitions')}`, M);
      top = 26;
    }
    if (inc.transitions) {
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
      autoTable(doc, {
        startY: top,
        head,
        body,
        ...tableStyle(),
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
      const items = Object.values(model.index[rt] || {});
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
    const ids = new Set(workflows.map((w) => w.id));
    const list = model.findings.filter((f) => ids.has(f.wfId) && (!only || !f.tKey || only.has(f.tKey)));
    autoTable(doc, {
      startY: 26,
      head: [[L('hc.level'), L('app.workflow'), L('hc.title'), L('hc.recommendation')]],
      body: list.map((f) => {
        const ft = findingText(lang, f);
        return [L(`ov.severity.${f.severity}`), pdfText(`${f.wfName}${f.tName ? ` > ${f.tName}` : ''}`), pdfText(ft.title), pdfText(ft.fix)];
      }),
      ...tableStyle(),
      columnStyles: { 0: { cellWidth: 22, fontStyle: 'bold' }, 1: { cellWidth: 60 }, 2: { cellWidth: 80 } },
      didParseCell: (d) => {
        if (d.section === 'body' && d.column.index === 0) {
          const f = list[d.row.index];
          if (f) { d.cell.styles.textColor = [255, 255, 255]; d.cell.styles.fillColor = SEV[f.severity]; }
        }
      },
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
    margin: { top: 18, left: 12, right: 12, bottom: 14 },
    styles: { font: 'helvetica', fontSize: 7.2, cellPadding: 1.6, textColor: INK, lineColor: LINE, lineWidth: 0.15, valign: 'top', overflow: 'linebreak' },
    headStyles: { fillColor: INK, textColor: [202, 198, 187], fontStyle: 'bold', fontSize: 7 },
    alternateRowStyles: { fillColor: SAND },
  };
}
