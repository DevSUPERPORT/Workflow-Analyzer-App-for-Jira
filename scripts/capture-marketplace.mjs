/**
 * Captures the Marketplace screenshots (1840×900) from the click-dummy's demo data and renders the hero (960×600)
 * and banner (1120×548) images. Drives a local headless Chrome over the DevTools protocol (no extra packages).
 *
 * Usage: start the click-dummy (`npm run dev:ui`, http://localhost:5174), then
 *   node scripts/capture-marketplace.mjs [shot ...]
 * Output: docs/marketplace/screenshots/*.png, docs/marketplace/hero-960x600.png, docs/marketplace/banner-1120x548.png
 *
 * @file        scripts/capture-marketplace.mjs
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-11-23
 * @updated     2026-11-23
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'marketplace');
const SHOTS_DIR = path.join(OUT, 'screenshots');
const BASE = process.env.WFA_MOCK_URL || 'http://localhost:5174/';
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9333;
const PROJECT_ID = '10100';
const PROCUREMENT = 'b7a1d1c0-0000-4000-8000-000000000001';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ minimal CDP client
async function launch() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wfa-shots-'));
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--force-color-profile=srgb', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return { proc, ws: page.webSocketDebuggerUrl, profile };
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('Chrome did not start');
}

function client(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  };
  const ready = new Promise((r) => { ws.onopen = r; });
  const send = async (method, params = {}) => {
    await ready;
    const n = ++id;
    ws.send(JSON.stringify({ id: n, method, params }));
    return new Promise((resolve, reject) => pending.set(n, { resolve, reject }));
  };
  return { send, close: () => ws.close() };
}

// ------------------------------------------------------------------ page helpers (run inside the page)
const HELPERS = `
window.__q = (text, sel = 'button, a, [role=tab], [role=button], li, label, summary') => {
  const all = [...document.querySelectorAll(sel)].filter((e) => e.offsetParent !== null);
  return all.find((e) => e.textContent.trim() === text) || all.find((e) => e.textContent.trim().startsWith(text)) || all.find((e) => e.textContent.includes(text));
};
window.__click = (text, sel) => { const e = window.__q(text, sel); if (!e) throw new Error('not found: ' + text); e.scrollIntoView({ block: 'center' }); e.click(); return true; };
window.__type = (selector, value) => {
  const el = document.querySelector(selector);
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
};
window.__top = () => { window.scrollTo(0, 0); document.querySelectorAll('*').forEach((e) => { if (e.scrollTop) e.scrollTop = 0; }); return true; };
`;

async function evaluate(send, expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
}

async function open(send, { hash = '', tab = 'overview', wf = 'all', width = 1840, height = 900 }) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: BASE });
  await sleep(800);
  const place = hash.startsWith('admin') ? 'wfa.place.site' : `wfa.place.${PROJECT_ID}`;
  await evaluate(send, `localStorage.clear();
    localStorage.setItem('superport.wfa.lang', 'en');
    localStorage.setItem('superport.wfa.tourDone', '1');
    localStorage.setItem(${JSON.stringify(place)}, JSON.stringify({ tab: ${JSON.stringify(tab)}, wfSel: ${JSON.stringify(wf)} }));
    true`);
  await send('Page.navigate', { url: `${BASE}#${hash}` });
  await sleep(500);
  await evaluate(send, `location.reload(); true`).catch(() => {});
  await sleep(4500);
  await evaluate(send, HELPERS + 'true');
}

async function shot(send, file, clip) {
  const r = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  console.log('wrote', path.relative(ROOT, file));
}

// ------------------------------------------------------------------ the shots
const SHOTS = {
  overview: { tab: 'overview' },
  diagram: { tab: 'diagram', wf: PROCUREMENT, steps: [`__click('Fit')`], wait: 2000 },
  dependencies: { tab: 'impact', steps: [`__click('Groups')`, `document.querySelector('.impact-list button, .list button, [data-entry]')?.click() || __click('legal')`] },
  health: { tab: 'health' },
  autofix: { tab: 'autopilot', wf: PROCUREMENT, steps: [`__click('Auto-fix findings')`], wait: 3500 },
  aiplan: { hash: 'ai=on', tab: 'autopilot', wf: PROCUREMENT, steps: [`__type('textarea', 'Add a status "Escalated" reachable from "Business case review" and "Business case clarification", only for the project role Administrators, with a way back')`, `__click('Plan with AI')`], wait: 5000 },
  access: { tab: 'access', wf: PROCUREMENT },
  assistant: { hash: 'ai=on', tab: 'assistant', wf: PROCUREMENT, steps: [`__type('textarea, input[type=text]', 'Who can close an issue, and which transitions skip the review?')`, `(document.querySelector('form button[type=submit]') || __q('Send') || __q('Ask')).click()`], wait: 5000 },
  changes: { tab: 'changes' },
  export: { tab: 'export' },
  site: { hash: 'admin', tab: 'overview', steps: [`__click('Scan all workflows')`], wait: 6000 },
  settings: { hash: 'admin&ai=on', tab: 'settings' },
};

// ------------------------------------------------------------------ hero and banner (composed from the screenshots)
const fileUrl = (p) => `file:///${p.replace(/\\/g, '/')}`;
const LOGO = fileUrl(path.join(OUT, 'app-logo-512.png'));
const SHOT = (n) => fileUrl(path.join(SHOTS_DIR, `${n}.png`));
const BASE_CSS = `
  * { box-sizing: border-box; margin: 0; }
  body { font-family: 'Segoe UI Variable Display', 'Segoe UI', system-ui, sans-serif; color: #1f1d1a; overflow: hidden;
    background: radial-gradient(circle at 85% 110%, #fbe3d6 0, rgba(251,227,214,0) 45%), #f6f3ee; }
  .dots { position: absolute; inset: 0; background-image: radial-gradient(#d9d3ca 1px, transparent 1px); background-size: 18px 18px; opacity: .55; }
  .frame { position: absolute; border-radius: 14px; overflow: hidden; background: #fff;
    box-shadow: 0 30px 60px -20px rgba(40, 30, 20, .35), 0 0 0 1px rgba(40, 30, 20, .08); }
  .frame img { display: block; }
`;
const ART = {
  hero: {
    file: 'hero-960x600.png', width: 960, height: 600,
    html: () => `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
      .brand { position: absolute; top: 44px; left: 0; right: 0; display: flex; align-items: center; justify-content: center; gap: 14px; }
      .brand img { width: 44px; height: 44px; border-radius: 10px; }
      .brand span { letter-spacing: .14em; font-size: 15px; color: #b5410c; font-weight: 600; }
      h1 { position: absolute; top: 108px; left: 0; right: 0; text-align: center; font-size: 36px; font-weight: 700; letter-spacing: -.01em; }
      .frame { left: 90px; top: 178px; width: 780px; height: 380px; }
      .frame { background: #fff url('${SHOT('autofix')}') no-repeat -141px 0 / 1067px auto; }
    </style></head><body><div class="dots"></div>
      <div class="brand"><img src="${LOGO}"><span>WORKFLOW ANALYZER FOR JIRA</span></div>
      <h1>See every workflow. Change it safely.</h1>
      <div class="frame"></div>
    </body></html>`,
  },
  banner: {
    file: 'banner-1120x548.png', width: 1120, height: 548,
    html: () => `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
      .logo { position: absolute; left: 64px; top: 116px; width: 88px; height: 88px; border-radius: 18px; }
      h1 { position: absolute; left: 64px; top: 228px; width: 420px; font-size: 44px; line-height: 1.12; font-weight: 700; letter-spacing: -.015em; }
      p { position: absolute; left: 64px; top: 344px; width: 430px; font-size: 20px; line-height: 1.5; color: #57524b; }
      .frame { left: 540px; top: 62px; width: 640px; height: 374px; border-radius: 14px 0 0 14px; }
      .frame { background: #fff url('${SHOT('overview')}') no-repeat -146px 0 / 1104px auto; }
    </style></head><body><div class="dots"></div>
      <img class="logo" src="${LOGO}">
      <h1>Workflow Analyzer for Jira</h1>
      <p>Understand, check and safely change your Jira workflows, with a health check, impact analysis and one-click rollback.</p>
      <div class="frame"></div>
    </body></html>`,
  },
};

async function run() {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  const only = process.argv.slice(2);
  const { proc, ws, profile } = await launch();
  const { send, close } = client(ws);
  try {
    await send('Page.enable');
    await send('Runtime.enable');
    for (const [name, s] of Object.entries(SHOTS)) {
      if (only.length && !only.includes(name)) continue;
      await open(send, { hash: s.hash ? `${s.hash}&demo=en` : 'demo=en', tab: s.tab, wf: s.wf });
      for (const step of s.steps || []) {
        try { await evaluate(send, step); } catch (e) { console.warn(`[${name}] step failed: ${e.message}`); }
        await sleep(1200);
      }
      await sleep(s.wait || 1200);
      for (const step of s.after || []) {
        try { await evaluate(send, step); } catch (e) { console.warn(`[${name}] after-step failed: ${e.message}`); }
        await sleep(1500);
      }
      if (!s.keepScroll) await evaluate(send, `__top()`);
      await sleep(300);
      await shot(send, path.join(SHOTS_DIR, `${name}.png`));
    }
    for (const [name, art] of Object.entries(ART)) {
      if (only.length && !only.includes(name)) continue;
      const html = path.join(os.tmpdir(), `wfa-${name}.html`);
      fs.writeFileSync(html, art.html());
      await send('Emulation.setDeviceMetricsOverride', { width: art.width, height: art.height, deviceScaleFactor: 1, mobile: false });
      await send('Page.navigate', { url: `file:///${html.replace(/\\/g, '/')}` });
      await sleep(1500);
      await shot(send, path.join(OUT, art.file));
    }
  } finally {
    close();
    proc.kill();
    await sleep(500);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome may still hold files */ }
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
