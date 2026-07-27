/* Minimal static server for web/.
 * ES modules and fetch() do not work from file:// URLs, so the viewer needs
 * to be served over http even when it is only ever used locally.
 *
 *   npm run serve     ->  http://localhost:8080
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'web');
const PORT = Number(process.env.PORT) || 8080;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const rel = path.normalize(url);
  let file = path.join(ROOT, rel);

  // never serve outside web/
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }

  // Directory -> index.html, the way a static host does it. Without this
  // /docs/ 404s locally while working fine once deployed, which is exactly
  // the sort of difference you want the dev server not to have.
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  } catch { /* fall through to the 404 below */ }

  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
});

// 8080 is a popular port; step forward rather than dying on EADDRINUSE.
let port = PORT;
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && port < PORT + 20) {
    console.log(`port ${port} busy, trying ${port + 1}`);
    server.listen(++port);
  } else {
    throw e;
  }
});
server.on('listening', () => {
  console.log(`brain viewer -> http://localhost:${port}`);
});
server.listen(port);
