/**
 * Generates docs/USER-GUIDE.md (German and English) from the in-app guide content in
 * static/app/src/lib/guide-content.js.
 *
 * @file        scripts/build-user-guide.mjs
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-24
 * @updated     2026-11-05
 */

import fs from 'node:fs';
import { GUIDE } from '../static/app/src/lib/guide-content.js';

const md = [];
for (const lang of ['de', 'en']) {
  const g = GUIDE[lang];
  md.push(`# ${g.title}`, '', g.intro, '', `## ⚠ ${g.golden.title}`, '', ...g.golden.rules.map((r, i) => `${i + 1}. ${r}`), '');
  g.chapters.forEach((c, i) => {
    md.push(`## ${i + 1}. ${c.title}`, '');
    if (c.intro) md.push(c.intro, '');
    c.steps.forEach((s, j) => md.push(`${j + 1}. **${s.title}** – ${s.text}`));
    md.push('');
    if (c.tip) md.push(`> 💡 ${g.tip} ${c.tip}`, '');
    if (c.warning) md.push(`> ⚠ ${c.warning}`, '');
  });
  md.push(`## ${g.faq.title}`, '', ...g.faq.items.flatMap((f) => [`**${f.q}**`, '', f.a, '']), '---', '');
}
fs.mkdirSync(new URL('../docs/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('../docs/USER-GUIDE.md', import.meta.url), md.join('\n'));
console.log('docs/USER-GUIDE.md written', md.length, 'lines');
