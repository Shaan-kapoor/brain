/* Stamp a content hash onto the CSS and JS URLs in the HTML.
 *
 * index.html always revalidates, but the files it references do not, so a
 * returning visitor could pair fresh HTML with a stale script. Changing the
 * URL whenever the content changes makes that impossible: a browser has never
 * seen app.js?v=<new hash>, so it cannot serve a cached copy of it.
 *
 * Runs as part of `npm run deploy`. Idempotent, so running it twice is fine.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const WEB = path.join(__dirname, '..', 'web');
const hash = (p) => crypto.createHash('md5')
  .update(fs.readFileSync(p)).digest('hex').slice(0, 8);

// html file -> assets referenced from it, relative to that html file
const PAGES = {
  'index.html': ['css/app.css', 'js/app.js'],
  'docs/index.html': ['docs.css'],
};

let changed = 0;
for (const [page, assets] of Object.entries(PAGES)) {
  const pagePath = path.join(WEB, page);
  if (!fs.existsSync(pagePath)) continue;
  let html = fs.readFileSync(pagePath, 'utf8');
  const before = html;

  for (const asset of assets) {
    const assetPath = path.join(path.dirname(pagePath), asset);
    if (!fs.existsSync(assetPath)) { console.warn(`  ! missing ${asset}`); continue; }
    const v = hash(assetPath);
    // match the reference with or without an existing ?v=
    const re = new RegExp(`(["'])${asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\?v=[a-f0-9]+)?\\1`, 'g');
    html = html.replace(re, `$1${asset}?v=${v}$1`);
    console.log(`  ${page.padEnd(16)} ${asset.padEnd(12)} v=${v}`);
  }

  if (html !== before) { fs.writeFileSync(pagePath, html); changed++; }
}
console.log(changed ? `stamped ${changed} page(s)` : 'nothing to stamp');
