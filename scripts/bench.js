/* Frame-time benchmark for the viewer.
 *
 * Runs headed so it uses the real GPU - headless SwiftShader is software
 * rasterisation and its numbers say nothing about what a user sees.
 */
const puppeteer = require('puppeteer');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// NB: these run inside the page via evaluate(), so they cannot close over
// anything defined here in Node - each one has to be self-contained.
const SCENES = {
  'brain only': () => {
    for (const c of document.querySelectorAll('.chip')) {
      if ((c.dataset.name === 'brain') !== c.classList.contains('on')) c.click();
    }
  },
  'default (brain+arteries)': () => {
    for (const c of document.querySelectorAll('.chip')) {
      const want = c.dataset.name === 'brain' || c.dataset.name === 'arteries';
      if (want !== c.classList.contains('on')) c.click();
    }
  },
  'lobes': () => document.querySelector('#presets button[data-preset="lobes"]').click(),
  'deep': () => document.querySelector('#presets button[data-preset="deep"]').click(),
  'everything on': () => document.querySelector('#presets button[data-preset="all"]').click(),
};

async function measure(page, seconds = 4) {
  return page.evaluate(async (secs) => {
    const v = window.__viewer;
    v.renderer.info.reset();
    const times = [];
    let last = performance.now();
    const t0 = last;
    await new Promise((done) => {
      const tick = () => {
        const now = performance.now();
        times.push(now - last);
        last = now;
        if (now - t0 < secs * 1000) requestAnimationFrame(tick); else done();
      };
      requestAnimationFrame(tick);
    });
    times.sort((a, b) => a - b);
    const med = times[Math.floor(times.length / 2)];
    const p95 = times[Math.floor(times.length * 0.95)];
    return {
      fps: +(1000 / med).toFixed(1),
      medMs: +med.toFixed(2),
      p95Ms: +p95.toFixed(2),
      drawCalls: v.renderer.info.render.calls,
      triangles: v.renderer.info.render.triangles,
      programs: v.renderer.info.programs.length,
      geometries: v.renderer.info.memory.geometries,
      pixelRatio: v.renderer.getPixelRatio(),
    };
  }, seconds);
}

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1600,950',
           '--enable-gpu-rasterization', '--ignore-gpu-blocklist'],
    defaultViewport: { width: 1600, height: 950 },
  });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(process.argv[2], { waitUntil: 'networkidle0', timeout: 120000 });
  await page.waitForFunction(() => {
    const el = document.querySelector('#loader');
    return (!el || el.classList.contains('done')) && window.__viewer;
  }, { timeout: 180000 });
  await wait(3000);   // let the intro animation finish

  const gpu = await page.evaluate(() => {
    const gl = window.__viewer.renderer.getContext();
    const d = gl.getExtension('WEBGL_debug_renderer_info');
    return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown';
  });
  console.log('GPU:', gpu);
  console.log('');
  console.log('scene                      fps   med ms  p95 ms  draws   triangles  progs');
  console.log('-'.repeat(78));

  const results = {};
  for (const [name, fn] of Object.entries(SCENES)) {
    await page.evaluate(fn);
    await wait(900);
    const r = await measure(page);
    results[name] = r;
    console.log(
      `${name.padEnd(26)} ${String(r.fps).padStart(5)}  ${String(r.medMs).padStart(6)}  ` +
      `${String(r.p95Ms).padStart(6)}  ${String(r.drawCalls).padStart(5)}  ` +
      `${String(r.triangles).padStart(9)}  ${String(r.programs).padStart(5)}`);
  }

  // fill-rate test: fly the camera in close so the brain covers the screen
  await page.evaluate(() => {
    const v = window.__viewer;
    const d = v.camera.position.clone().sub(v.controls.target).normalize();
    v.camera.position.copy(v.controls.target).add(d.multiplyScalar(105));
    v.controls.update();
  });
  await wait(3500);   // give adaptive resolution time to settle
  const close = await measure(page);
  const st = await page.evaluate(() => window.__viewer.stats?.() ?? null);
  console.log(`${'everything, close-up'.padEnd(26)} ${String(close.fps).padStart(5)}  ` +
    `${String(close.medMs).padStart(6)}  ${String(close.p95Ms).padStart(6)}  ` +
    `${String(close.drawCalls).padStart(5)}  ${String(close.triangles).padStart(9)}` +
    (st ? `   resScale=${st.resScale}` : ''));
  results['everything, close-up'] = { ...close, ...st };

  // Raycast cost measured in-page. Driving the mouse over CDP measures the
  // protocol round trip more than it measures the picking.
  const rc = await page.evaluate(() => {
    const v = window.__viewer;
    const meshes = [...v.parts.values()].filter((p) => p.mesh.visible).map((p) => p.mesh);
    const ray = new v.THREE.Raycaster();
    const ptr = new v.THREE.Vector2();
    const run = () => {
      const t = performance.now();
      for (let i = 0; i < 200; i++) {
        ptr.set((i % 17) / 17 - 0.5, (i % 13) / 13 - 0.5);
        ray.setFromCamera(ptr, v.camera);
        ray.intersectObjects(meshes, false);
      }
      return (performance.now() - t) / 200;
    };
    const withBvh = run();
    const saved = meshes.map((m) => m.geometry.boundsTree);
    meshes.forEach((m) => { m.geometry.boundsTree = null; });
    const without = run();
    meshes.forEach((m, i) => { m.geometry.boundsTree = saved[i]; });
    return { withBvh: +withBvh.toFixed(3), without: +without.toFixed(3),
             hasBvh: saved.every(Boolean) };
  });
  console.log(`\nraycast per pick: ${rc.withBvh} ms with BVH, ${rc.without} ms brute force ` +
    `(bvh present: ${rc.hasBvh})`);

  const geo = await page.evaluate(() => {
    const out = [];
    window.__viewer.parts.forEach((p, name) => {
      const g = p.mesh.geometry;
      out.push({
        name,
        indexed: !!g.index,
        verts: g.attributes.position.count,
        tris: g.index ? g.index.count / 3 : g.attributes.position.count / 3,
        attrs: Object.keys(g.attributes).join(','),
        colorType: g.attributes.color ? g.attributes.color.array.constructor.name : '-',
      });
    });
    return out;
  });
  console.log('\ngeometry:');
  for (const g of geo) {
    console.log(`  ${g.name.padEnd(12)} indexed=${String(g.indexed).padEnd(5)} ` +
      `verts=${String(g.verts).padStart(7)} tris=${String(g.tris).padStart(7)} ` +
      `attrs=${g.attrs} color=${g.colorType}`);
  }

  const mat = await page.evaluate(() => {
    const m = window.__viewer.parts.get('brain').material;
    return { type: m.type, transparent: m.transparent, side: m.side,
             clearcoat: m.clearcoat, sheen: m.sheen, opacity: m.opacity };
  });
  console.log('\nbrain material:', JSON.stringify(mat));
  console.log('errors:', errs.length ? errs.join(' | ') : 'none');

  require('fs').writeFileSync(process.argv[3], JSON.stringify(results, null, 2));
  await browser.close();
})();
