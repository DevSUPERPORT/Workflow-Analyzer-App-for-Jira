/**
 * Minimal Markdown renderer for AI answers: headings, lists, tables, bold, italic and code. Builds React
 * elements only and never injects HTML.
 *
 * @file        static/app/src/components/Markdown.jsx
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-24
 * @updated     2026-11-05
 */

function inline(text, key = 0) {
  const out = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const s = m[0];
    const k = `${key}-${m.index}`;
    if (s.startsWith('**')) out.push(<strong key={k}>{s.slice(2, -2)}</strong>);
    else if (s.startsWith('`')) out.push(<code key={k}>{s.slice(1, -1)}</code>);
    else out.push(<em key={k}>{s.slice(1, -1)}</em>);
    last = m.index + s.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
const isRule = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

export default function Markdown({ text }) {
  const lines = String(text || '').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { blocks.push(<p key={i} className="md-h"><strong>{inline(h[2], i)}</strong></p>); i++; continue; }
    if (line.trim().startsWith('|') && isRule(lines[i + 1] || '')) {
      const head = cells(line);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(cells(lines[i++]));
      blocks.push(
        <div key={i} className="md-table">
          <table>
            <thead><tr>{head.map((c, k) => <th key={k}>{inline(c, k)}</th>)}</tr></thead>
            <tbody>{rows.map((r, n) => <tr key={n}>{r.map((c, k) => <td key={k}>{inline(c, k)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*•]|\d+[.)])\s+/, ''));
      const List = ordered ? 'ol' : 'ul';
      blocks.push(<List key={i} className="md-list">{items.map((it, k) => <li key={k}>{inline(it, k)}</li>)}</List>);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4})\s/.test(lines[i]) && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i]) && !lines[i].trim().startsWith('|')) para.push(lines[i++]);
    if (!para.length) para.push(lines[i++]);
    blocks.push(<p key={i} className="md-p">{para.map((p, k) => <span key={k}>{k > 0 && <br />}{inline(p, k)}</span>)}</p>);
  }
  return <div className="md">{blocks}</div>;
}
