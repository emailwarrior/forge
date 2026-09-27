// Stamp sw.js with a content-hash VERSION and the precache list of every public app file.
// Run before each deploy: node tools/build-sw.mjs
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';

const root = new URL('..', import.meta.url).pathname;
const INCLUDE = [/^index\.html$/, /^callback\.html$/, /^manifest\.webmanifest$/, /^css\/.+\.css$/, /^js\/.+\.js$/, /^icons\/.+\.(png|svg)$/];
const EXCLUDE = [/^js\/dev\//]; // demo generator: loaded only with ?demo, fetched on demand

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(relative(root, p).split('\\').join('/'));
  }
  return out;
}

const files = walk(root).filter((f) => INCLUDE.some((re) => re.test(f)) && !EXCLUDE.some((re) => re.test(f))).sort();
const hash = createHash('sha256');
for (const f of files) { hash.update(f + '\0'); hash.update(readFileSync(join(root, f))); }
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version + '-' + hash.digest('hex').slice(0, 10);
const precache = ['./', ...files.map((f) => './' + f)];

const swPath = join(root, 'sw.js');
let sw = readFileSync(swPath, 'utf8');
const vRe = /^const VERSION = .*; \/\/ @build$/m; const pRe = /^const PRECACHE = .*; \/\/ @build$/m;
if (!vRe.test(sw) || !pRe.test(sw)) throw new Error('sw.js is missing the @build markers');
sw = sw.replace(vRe, `const VERSION = '${version}'; // @build`).replace(pRe, `const PRECACHE = ${JSON.stringify(precache)}; // @build`);
writeFileSync(swPath, sw);
console.log(`build-sw: ${version}, ${precache.length} files`);
