/**
 * File downloads from the Custom UI iframe (the sandbox allows them on a user gesture), with a capture hook for
 * mock-mode UI tests and consistent export file names.
 *
 * @file        static/app/src/lib/download.js
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-24
 * @updated     2026-11-05
 */

export function downloadBlob(blob, filename) {
  // Test hook (mock mode / automated UI tests): capture instead of downloading
  if (typeof window !== 'undefined' && Array.isArray(window.__WFA_CAPTURE__)) {
    window.__WFA_CAPTURE__.push({ blob, filename });
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 4000);
}

export function downloadText(text, filename, mime = 'text/plain;charset=utf-8') {
  downloadBlob(new Blob([text], { type: mime }), filename);
}

const sanitize = (s) => String(s || '').trim().replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^_+|_+$/g, '');

// Legacy naming convention: YYMMDD_<CUSTOMER>_Workflow_<name>.<ext>
export function exportFilename({ customer, label, fallback, ext, date = new Date() }) {
  const yy = String(date.getFullYear()).slice(2);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const parts = [`${yy}${mm}${dd}`];
  if (sanitize(customer)) parts.push(sanitize(customer).toUpperCase());
  parts.push('Workflow');
  parts.push(sanitize(label) || sanitize(fallback) || 'unbenannt');
  return `${parts.join('_')}.${ext}`;
}
