'use strict';
// npm run check -> parses every .js file so typos are caught before deploying.
const fs = require('fs'); const path = require('path'); const { execFileSync } = require('child_process');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.name === 'node_modules' ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []);
let bad = 0;
for (const f of walk(path.join(__dirname, '..'))) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); } catch (e) { bad++; console.error(`FAIL ${f}\n${e.stderr}`); }
}
console.log(bad ? `${bad} file(s) failed` : 'all files parse OK'); process.exit(bad ? 1 : 0);
