/**
 * Display names for the account IDs the app stores (plan authors, note authors, who changed the AI switch …).
 * The app stores account IDs only and looks names up when data is shown, so no profile data is kept and a renamed
 * or closed account shows its current state (Atlassian's user privacy guidelines; see lib/privacy.js).
 *
 * @file        src/lib/names.js
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-11-23
 * @updated     2026-11-23
 */

import { route, getAppContext } from '@forge/api';
import { jira } from './jira.js';

const TTL_MS = 10 * 60 * 1000;
const ID_RE = /^[A-Za-z0-9:_-]{1,128}$/;
const cache = new Map(); // installation + accountId -> { name, at }

// A runtime can serve several installations: names are cached per installation only
function scope() {
  try { const c = getAppContext(); return String(c?.installationAri || c?.installationId || c?.cloudId || ''); } catch { return ''; }
}

/** accountId -> display name (missing when Jira doesn't know the account). Never throws. */
export async function displayNames(ids) {
  const want = [...new Set((ids || []).filter((id) => typeof id === 'string' && ID_RE.test(id)))];
  const out = new Map();
  const missing = [];
  const now = Date.now();
  const s = scope();
  for (const id of want) {
    const c = cache.get(`${s}|${id}`);
    if (c && now - c.at < TTL_MS) { if (c.name) out.set(id, c.name); } else missing.push(id);
  }
  for (let i = 0; i < missing.length; i += 50) {
    const batch = missing.slice(i, i + 50);
    const params = new URLSearchParams();
    batch.forEach((id) => params.append('accountId', id));
    params.set('maxResults', '50');
    try {
      const res = await jira(route`/rest/api/3/user/bulk?${params}`);
      const found = new Map((res?.values || []).map((u) => [u.accountId, u.displayName || null]));
      for (const id of batch) {
        const name = found.get(id) || null;
        cache.set(`${s}|${id}`, { name, at: now });
        if (name) out.set(id, name);
      }
    } catch (e) {
      console.warn('[names] user lookup failed:', e?.message || e);
    }
  }
  return out;
}

const asList = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : []);

/**
 * Sets `nameField` from `idField` on every record (null when unknown), e.g. [['createdBy', 'createdByName']].
 * `records` is one record, a list, or null. Returns `records`.
 */
export async function withNames(records, pairs) {
  const list = asList(records);
  const names = await displayNames(list.flatMap((r) => pairs.map(([id]) => r?.[id])));
  for (const r of list) for (const [id, name] of pairs) if (r) r[name] = (r[id] && names.get(r[id])) || null;
  return records;
}

/** Test hook: forget cached names. */
export const clearNameCache = () => cache.clear();
