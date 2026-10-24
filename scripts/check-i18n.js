// Verifies every translation key used in the code exists in both dictionaries (EN + DE).
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.join(__dirname, '..');
const files = [];
const walk = (d) => {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) {
      if (!/node_modules|dist/.test(f)) walk(p);
    } else if (/\.(jsx?|mjs)$/.test(f)) files.push(p);
  }
};
walk(path.join(root, 'src'));
walk(path.join(root, 'static', 'app', 'src'));

import(pathToFileURL(path.join(root, 'src', 'shared', 'i18n.js')).href).then(({ DICT }) => {
  const missing = new Set();
  const re = /\b(?:t|L|tr|translate)\(\s*(?:lang,\s*|t\.lang,\s*|opts\.lang,\s*)?'([a-zA-Z]+\.[\w.]+)'/g;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(re)) {
      const k = m[1];
      if (!DICT.en[k] || !DICT.de[k]) missing.add(`${k}  (${path.relative(root, f)})`);
    }
  }
  if (missing.size) {
    console.log(`Missing keys:\n${[...missing].join('\n')}`);
    process.exit(1);
  }
  console.log(`i18n OK - ${Object.keys(DICT.en).length} keys, ${files.length} files scanned`);
});
