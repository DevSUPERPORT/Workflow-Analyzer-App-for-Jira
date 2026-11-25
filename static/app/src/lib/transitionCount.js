/**
 * Counts transitions in the Transitions tab sections. A transition with several source statuses appears in one
 * section per source, so rows are counted once per transition key (matches the tab badge and the Overview).
 *
 * @file        static/app/src/lib/transitionCount.js
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-11-25
 */

/** @param {{ rows: { tr: { key: string } }[] }[]} sections @param {(tr: object) => boolean} [visible] */
export function countTransitions(sections, visible) {
  const keys = new Set();
  for (const s of sections) for (const r of s.rows) if (!visible || visible(r.tr)) keys.add(r.tr.key);
  return keys.size;
}
