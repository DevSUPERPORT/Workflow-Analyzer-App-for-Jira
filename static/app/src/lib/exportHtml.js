/**
 * Builds the single-file interactive HTML export (Confluence-ready): renders ExportDocument to static markup,
 * inlines the app stylesheet and adds a small script for collapsible sections, search and filters.
 *
 * @file        static/app/src/lib/exportHtml.js
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-24
 * @updated     2026-11-05
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import css from '../styles.css?raw';
import { ExportDocument } from '../components/ExportDocument.jsx';
import { t } from '../../../../src/shared/i18n.js';

const EXPORT_CSS = `
html,body{height:auto;overflow:visible}
body{background:var(--bg)}
.toolbar{top:52px}
.sh{top:96px}
.sh:not(.open)+.sb{display:none}
.sh .caret{transition:none}
.col-panel[hidden]{display:none}
tr.hidden-row{display:none}
.sec.empty-sec{display:none}
mark.hl{padding:0}
.page{max-width:none}
@media print{.export-tools{display:none!important}.sh+.sb{display:block!important}.topbar{position:static}}
`;

// Small vanilla script: collapsible sections, search with highlight + navigation, vendor & element filter.
const SCRIPT = `
(function(){
  var $=function(s,r){return Array.prototype.slice.call((r||document).querySelectorAll(s));};
  $('[data-toggle]').forEach(function(h){h.addEventListener('click',function(){h.classList.toggle('open');});});
  function act(a){return document.querySelector('[data-act="'+a+'"]');}
  act('expand').onclick=function(){$('[data-toggle]').forEach(function(h){h.classList.add('open');});};
  act('collapse').onclick=function(){$('[data-toggle]').forEach(function(h){h.classList.remove('open');});};
  ['vendors','kinds'].forEach(function(p){act(p).onclick=function(e){e.stopPropagation();var el=document.querySelector('[data-panel="'+p+'"]');el.hidden=!el.hidden;};});
  document.addEventListener('click',function(e){ if(!e.target.closest('.col-panel')) $('.col-panel').forEach(function(p){p.hidden=true;}); });
  var input=document.querySelector('[data-search]'), info=document.querySelector('[data-info]'), hits=[], cur=-1;
  function clearMarks(){ $('mark.hl').forEach(function(m){var p=m.parentNode;p.replaceChild(document.createTextNode(m.textContent),m);p.normalize();}); }
  function mark(root,q){
    var w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,null),nodes=[],n;
    while((n=w.nextNode())) if(n.nodeValue.toLowerCase().indexOf(q)>=0) nodes.push(n);
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
    var shown=0,total=0;
    $('table.tt tbody tr').forEach(function(tr){
      total++;
      var ok=true,vs=(tr.getAttribute('data-vendors')||'').split(' '),ks=(tr.getAttribute('data-kinds')||'').split(' ');
      if(vsel.length!==vend.length) ok=vs.some(function(v){return vsel.indexOf(v)>=0;});
      if(ok&&ksel.length!==kind.length) ok=ks.some(function(k){return ksel.indexOf(k)>=0;});
      if(ok&&q.length>=2) ok=tr.textContent.toLowerCase().indexOf(q)>=0;
      tr.classList.toggle('hidden-row',!ok); if(ok) shown++;
    });
    $('.sec').forEach(function(sec){var rows=$('table.tt tbody tr',sec);if(!rows.length)return;var vis=rows.some(function(r){return !r.classList.contains('hidden-row');});sec.classList.toggle('empty-sec',!vis);if(q.length>=2&&vis)sec.querySelector('[data-toggle]').classList.add('open');});
    if(q.length>=2) mark(document.querySelector('main'),q);
    info.textContent=(q.length>=2?(hits.length+' ⌕ · '):'')+shown+' / '+total;
  }
  function go(d){ if(!hits.length) return; if(cur>=0) hits[cur].classList.remove('cur'); cur=(cur+d+hits.length)%hits.length; hits[cur].classList.add('cur'); hits[cur].scrollIntoView({block:'center'}); }
  var timer; input.addEventListener('input',function(){clearTimeout(timer);timer=setTimeout(apply,200);});
  input.addEventListener('keydown',function(e){if(e.key==='Enter'){go(e.shiftKey?-1:1);}});
  act('next').onclick=function(){go(1);}; act('prev').onclick=function(){go(-1);};
  $('[data-vendor-filter],[data-kind-filter]').forEach(function(c){c.addEventListener('change',apply);});
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
