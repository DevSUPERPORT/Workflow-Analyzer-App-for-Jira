/**
 * Builds the single-file interactive HTML export (Confluence-ready): renders ExportDocument to static markup,
 * inlines the app stylesheet and adds a small script for collapsible sections, search and filters.
 *
 * @file        static/app/src/lib/exportHtml.js
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-24
 * @updated     2026-11-24
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import css from '../styles.css?raw';
import { ExportDocument } from '../components/ExportDocument.jsx';
import { t } from '../../../../src/shared/i18n.js';

const EXPORT_CSS = `
html,body{height:auto;overflow-x:hidden}
body{background:var(--bg);font-size:14px;line-height:1.55}
.topbar{position:relative}
.toolbar.export-tools{position:sticky;top:0;margin:0;padding:8px 24px;z-index:200}
.toolbar.export-tools input[type=search]{width:240px;max-width:40vw}
.page.ex{max-width:1180px;margin:0 auto;padding:28px 24px 8px}
.ex-cover{padding:8px 0 22px}
.ex-cover .eyebrow{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);font-weight:600}
.ex-cover h1{font-size:30px;line-height:1.2;margin:6px 0 6px;letter-spacing:-.02em}
.ex-h2{font-size:21px;margin:36px 0 14px;padding-bottom:8px;border-bottom:3px solid var(--accent);letter-spacing:-.01em}
section{scroll-margin-top:60px}
.toc ol{margin:0;padding-left:20px;columns:2;column-gap:32px}
.toc li{margin:3px 0;break-inside:avoid}
.toc a,.others a{color:var(--link);text-decoration:none}
.toc a:hover,.others a:hover{text-decoration:underline}
.exec{display:grid;grid-template-columns:minmax(260px,340px) 1fr;gap:16px;align-items:start}
.exec .card{margin-bottom:0}
.exec-score .score-label{font-size:17px;font-weight:600}
.kpis-mini{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:8px;margin-top:14px}
.kpis-mini div{background:var(--surface-3);border:1px solid var(--border);border-radius:var(--r-sm);padding:8px 10px;display:flex;flex-direction:column}
.kpis-mini b{font-size:20px;font-weight:500;font-variant-numeric:tabular-nums}
.kpis-mini span{font-size:10.5px;letter-spacing:.04em;text-transform:uppercase;color:var(--text-muted);overflow-wrap:anywhere;hyphens:auto}
.verdict{display:flex;gap:10px;align-items:flex-start;padding:10px 14px;border-radius:var(--r-sm);margin:14px 0 4px;font-weight:500}
.verdict .dot{width:10px;height:10px;border-radius:50%;flex:none;margin-top:6px}
.verdict.good{background:var(--ok-bg)}.verdict.good .dot{background:var(--ok)}
.verdict.attention{background:var(--medium-bg)}.verdict.attention .dot{background:var(--medium)}
.verdict.critical{background:var(--high-bg)}.verdict.critical .dot{background:var(--high)}
.note-box.howto{margin-top:16px}
.ok-line{color:var(--ok);font-weight:500;margin:0}
.wf{margin-top:8px}
.wf-head{margin:40px 0 14px}
.wf-head .ex-h2{margin:0 0 6px}
.bullets{margin:12px 0 0;padding-left:20px}
.bullets li{margin:4px 0}
.kv{display:grid;gap:6px;margin-top:8px}
.kv>div{display:grid;grid-template-columns:150px 1fr;gap:12px;align-items:baseline}
.kv .k,.tfind .k,.tnote .k{font-size:11.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted)}
.kv ul{margin:0;padding-left:18px}
.kv li{margin:2px 0}
.journey{list-style:none;margin:16px 0 0;padding:0;position:relative}
.journey::before{content:'';position:absolute;left:13px;top:14px;bottom:14px;width:2px;background:var(--border)}
.jnode{display:flex;align-items:center;gap:12px;padding:6px 0;position:relative}
.jnode .bullet{width:28px;height:28px;border-radius:50%;display:inline-grid;place-items:center;background:var(--surface);border:2px solid var(--border-strong);font-size:12px;color:var(--text-muted);flex:none;z-index:1}
.jnode.start .bullet{border-color:var(--accent);color:var(--accent)}
.jnode.end .bullet{background:var(--ok);border-color:var(--ok);color:#fff}
.jnode.end span:last-child{font-weight:600}
.jstep{padding:4px 0 4px 40px}
.jcard{border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:var(--r-sm);padding:12px 16px;background:var(--surface-3)}
.jtitle{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
.jtitle .num{font-size:11.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--accent);font-weight:600}
.jtitle strong{font-size:15px}
.imp{border:1px solid var(--border);border-left:4px solid var(--low);border-radius:var(--r-sm);padding:12px 16px;margin:10px 0;background:var(--surface)}
.imp.high{border-left-color:var(--high)}.imp.medium{border-left-color:var(--medium)}
.imp-head{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.prio{font-size:11.5px;font-weight:700;padding:1px 8px;border-radius:var(--pill);background:var(--low-bg)}
.prio.P1{background:var(--high-bg);color:var(--high)}.prio.P2{background:var(--medium-bg);color:var(--medium)}.prio.P3{color:var(--low)}
.imp .kv>div{grid-template-columns:130px 1fr}
.imp .row{display:flex;flex-wrap:wrap;gap:4px}
.autofix{margin-top:8px;font-size:12.5px;color:var(--ok)}
.sec{margin:14px 0}
.sh{top:50px}
.sh:not(.open)+.sb{display:none}
.sh .caret{transition:none}
.sb{padding:14px 18px}
.fold-intro{margin:0 0 12px}
.tcards{display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:12px}
.tcard{border:1px solid var(--border);border-radius:var(--r-sm);padding:12px 16px;background:var(--surface);scroll-margin-top:110px;break-inside:avoid}
.tcard:target{box-shadow:0 0 0 2px var(--accent)}
.tc-head{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
.tc-head strong{font-size:15px}
.tc-route{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:8px 0 4px}
.tc-route .arrow{color:var(--text-muted)}
.tcard .kv>div{grid-template-columns:120px 1fr}
.tfind{margin-top:10px;padding:10px 12px;background:var(--high-bg);border-radius:var(--r-sm)}
.tfind .tf{margin-top:6px}
.tnote{margin-top:10px;padding:8px 12px;background:var(--tint-amber);border-radius:var(--r-sm);white-space:pre-wrap}
.tsec{margin:0 0 18px}
.tsec-h{display:flex;gap:10px;align-items:center;margin:4px 0 8px}
table.tt{min-width:1100px}
table.tt th{position:static}
.diagram-box{overflow-x:auto}
.diagram-box svg{max-width:100%;height:auto}
table.data.health td{min-width:120px}
.gloss{display:grid;grid-template-columns:200px 1fr;gap:8px 18px;margin:0}
.gloss dt{font-weight:600}
.gloss dd{margin:0;color:var(--text)}
.col-panel[hidden]{display:none}
.hidden-row{display:none!important}
.sec.empty-sec{display:none}
mark.hl{padding:0}
mark.hl.cur{background:var(--accent);color:#fff}
.footer{margin:40px 0 24px;color:var(--text-muted);font-size:12px;text-align:center}
@media (max-width:820px){.exec{grid-template-columns:1fr}.kv>div,.imp .kv>div,.tcard .kv>div{grid-template-columns:1fr;gap:2px}.tcards{grid-template-columns:1fr}.toc ol{columns:1}.gloss{grid-template-columns:1fr}.toolbar.export-tools input[type=search]{width:100%;max-width:none}}
@media print{
  @page{size:A4;margin:14mm}
  body{background:#fff;font-size:11.5px}
  .export-tools{display:none!important}
  .sh+.sb{display:block!important}
  .sh{position:static}
  .sh .caret{display:none}
  .card,.imp,.jcard,.tcard,.tsec{break-inside:avoid}
  .wf{break-before:page}
  .tcards{grid-template-columns:1fr 1fr}
  table.tt{min-width:0;font-size:10px}
  .tt-wrap,.table-wrap,.diagram-box{overflow:visible}
  a{color:inherit;text-decoration:none}
}
`;

// Small vanilla script: collapsible sections, print, search with highlight + navigation, app & element filter.
// Filters apply to every [data-item] (journey steps, transition cards, rule table rows).
const SCRIPT = `
(function(){
  var $=function(s,r){return Array.prototype.slice.call((r||document).querySelectorAll(s));};
  $('[data-toggle]').forEach(function(h){h.addEventListener('click',function(){h.classList.toggle('open');});});
  function act(a){return document.querySelector('[data-act="'+a+'"]');}
  act('expand').onclick=function(){$('[data-toggle]').forEach(function(h){h.classList.add('open');});};
  act('collapse').onclick=function(){$('[data-toggle]').forEach(function(h){h.classList.remove('open');});};
  act('print').onclick=function(){window.print();};
  ['vendors','kinds'].forEach(function(p){act(p).onclick=function(e){e.stopPropagation();var el=document.querySelector('[data-panel="'+p+'"]');el.hidden=!el.hidden;};});
  document.addEventListener('click',function(e){ if(!e.target.closest('.col-panel')) $('.col-panel').forEach(function(p){p.hidden=true;}); });
  // open a collapsed block when a link or search hit points into it
  function reveal(el){ while(el){ if(el.classList&&el.classList.contains('sb')){var h=el.previousElementSibling;if(h&&h.hasAttribute('data-toggle'))h.classList.add('open');} el=el.parentElement; } }
  $('a[href^="#"]').forEach(function(a){a.addEventListener('click',function(){var el=document.getElementById(a.getAttribute('href').slice(1));if(el)reveal(el);});});
  var input=document.querySelector('[data-search]'), info=document.querySelector('[data-info]'), hits=[], cur=-1;
  function clearMarks(){ $('mark.hl').forEach(function(m){var p=m.parentNode;p.replaceChild(document.createTextNode(m.textContent),m);p.normalize();}); }
  function mark(root,q){
    var w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,null),nodes=[],n;
    while((n=w.nextNode())) if(n.nodeValue.toLowerCase().indexOf(q)>=0 && !n.parentNode.closest('svg,.hidden-row,.empty-sec')) nodes.push(n);
    nodes.forEach(function(node){
      var s=node.nodeValue,l=s.toLowerCase(),i=0,j,frag=document.createDocumentFragment();
      while((j=l.indexOf(q,i))>=0){frag.appendChild(document.createTextNode(s.slice(i,j)));var m=document.createElement('mark');m.className='hl';m.textContent=s.slice(j,j+q.length);frag.appendChild(m);hits.push(m);i=j+q.length;}
      frag.appendChild(document.createTextNode(s.slice(i)));node.parentNode.replaceChild(frag,node);
    });
  }
  function apply(){
    clearMarks();hits=[];cur=-1;
    var q=(input.value||'').trim().toLowerCase();
    var vend=$('[data-vendor-filter]'),vsel=vend.filter(function(c){return c.checked;}).map(function(c){return c.getAttribute('data-vendor-filter');});
    var kind=$('[data-kind-filter]'),ksel=kind.filter(function(c){return c.checked;}).map(function(c){return c.getAttribute('data-kind-filter');});
    var filtering=vsel.length!==vend.length||ksel.length!==kind.length||q.length>=2;
    var unit=$('.tcard[data-item]').length?'.tcard':'tr[data-item]';
    var shown=0,total=$(unit+'[data-item]').length;
    $('[data-item]').forEach(function(el){
      var ok=true,vs=(el.getAttribute('data-vendors')||'').split(' '),ks=(el.getAttribute('data-kinds')||'').split(' ');
      if(vsel.length!==vend.length) ok=vs.some(function(v){return vsel.indexOf(v)>=0;});
      if(ok&&ksel.length!==kind.length) ok=ks.some(function(k){return ksel.indexOf(k)>=0;});
      if(ok&&q.length>=2) ok=el.textContent.toLowerCase().indexOf(q)>=0;
      el.classList.toggle('hidden-row',!ok); if(ok&&el.matches(unit)) shown++;
    });
    // a filtered journey would read as a broken chain: hide its status lines while filtering
    $('.journey .jnode').forEach(function(n){n.classList.toggle('hidden-row',filtering);});
    $('.tsec').forEach(function(sec){var rows=$('[data-item]',sec);sec.classList.toggle('hidden-row',filtering&&!rows.some(function(r){return !r.classList.contains('hidden-row');}));});
    $('.sec').forEach(function(sec){var rows=$('[data-item]',sec);if(!rows.length)return;var vis=rows.some(function(r){return !r.classList.contains('hidden-row');});sec.classList.toggle('empty-sec',!vis);if(filtering&&vis)sec.querySelector('[data-toggle]').classList.add('open');});
    if(q.length>=2) mark(document.querySelector('main'),q);
    info.textContent=total?((q.length>=2?(hits.length+' ⌕ · '):'')+shown+' / '+total):'';
  }
  function go(d){ if(!hits.length) return; if(cur>=0) hits[cur].classList.remove('cur'); cur=(cur+d+hits.length)%hits.length; hits[cur].classList.add('cur'); reveal(hits[cur]); hits[cur].scrollIntoView({block:'center'}); }
  var timer; input.addEventListener('input',function(){clearTimeout(timer);timer=setTimeout(apply,200);});
  input.addEventListener('keydown',function(e){if(e.key==='Enter'){go(e.shiftKey?-1:1);}});
  act('next').onclick=function(){go(1);}; act('prev').onclick=function(){go(-1);};
  $('[data-vendor-filter],[data-kind-filter]').forEach(function(c){c.addEventListener('change',apply);});
  window.addEventListener('beforeprint',function(){$('[data-toggle]').forEach(function(h){h.classList.add('open');});});
  apply();
})();
`;

export function buildHtmlExport({ model, workflows, notes, opts, logo }) {
  const body = renderToStaticMarkup(createElement(ExportDocument, { model, workflows, notes, opts, logo }));
  const title = `${opts.label || (workflows.length === 1 ? workflows[0].name : model.project?.name || 'Workflows')} – ${t(opts.lang, 'ex.documentation')}`;
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  return `<!DOCTYPE html>
<html lang="${opts.lang}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="generator" content="Superport Workflow Analyzer"><title>${esc(title)}</title>
<style>${css}${EXPORT_CSS}</style></head>
<body>${body}<script>${SCRIPT}</script></body></html>`;
}
