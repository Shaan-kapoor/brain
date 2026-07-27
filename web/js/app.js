/* Interactive viewer for a personal brain MRI reconstruction.
 *
 * Geometry arrives already in glTF axes: +X = patient RIGHT, +Y = SUPERIOR,
 * +Z = POSTERIOR (see pipeline/05_export.py). Units are millimetres, recentred
 * on the brain centroid, so distances shown in the UI are real.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

// Brute-force raycasting tested every triangle of every visible mesh on every
// pointermove - 1.3 M triangles, ~92 ms per event. A BVH turns that into a
// tree descent costing well under a millisecond.
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const $ = (s) => document.querySelector(s);
const stage = $('#stage');

/* ---------------------------------------------------------------- renderer */
const renderer = new THREE.WebGLRenderer({
  canvas: $('#view'), antialias: true, preserveDrawingBuffer: true, alpha: true,
});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearAlpha(0);
renderer.localClippingEnabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 6000);
camera.position.set(-360, 90, 150);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.075;
controls.rotateSpeed = 0.85;
controls.zoomSpeed = 0.9;
// Deliberately tiny: you can fly the camera right inside the brain.
controls.minDistance = 0.6;
controls.maxDistance = 1600;
controls.autoRotateSpeed = 0.34;

/* Studio environment, generated rather than downloaded. */
function studioEnvironment() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0.00, '#cfe4f2');
  grad.addColorStop(0.42, '#5d6b78');
  grad.addColorStop(0.62, '#232a30');
  grad.addColorStop(1.00, '#0a0d10');
  g.fillStyle = grad; g.fillRect(0, 0, 512, 256);
  for (const [x, y, r, col] of [[150, 60, 130, '255,255,255,.95'], [390, 130, 110, '120,205,235,.55']]) {
    const s = g.createRadialGradient(x, y, 6, x, y, r);
    s.addColorStop(0, `rgba(${col})`);
    s.addColorStop(1, `rgba(${col.split(',').slice(0, 3).join(',')},0)`);
    g.fillStyle = s; g.fillRect(0, 0, 512, 256);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromEquirectangular(tex).texture;
  pmrem.dispose(); tex.dispose();
  return env;
}
scene.environment = studioEnvironment();

scene.add(new THREE.HemisphereLight(0xbcd4e6, 0x14181c, 0.35));
const key = new THREE.DirectionalLight(0xfff2e8, 1.15); key.position.set(-1, 1.15, 0.75);
const fill = new THREE.DirectionalLight(0x9fc4dd, 0.30); fill.position.set(1, 0.25, 0.6);
const rim = new THREE.DirectionalLight(0x7fd9ec, 0.55); rim.position.set(0.4, -0.6, -1);
scene.add(key, fill, rim);

/* ------------------------------------------------------------------- state */
const root = new THREE.Group();
scene.add(root);

const parts = new Map();
let manifest = null, anatomy = null;
let selected = null, pinMode = false, pins = [];
let baseDist = 400;

const clipPlane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);
let clipAxis = 'off', clipFlip = false;

/* ------------------------------------------------------------------ loading */
const loader = new GLTFLoader();
const loadEl = $('#loader'), loadBar = loadEl.querySelector('.bar i'), loadTxt = loadEl.querySelector('span');

const SURFACE = {
  brain: { roughness: 0.66, clearcoat: 0.22, clearcoatRoughness: 0.55,
           sheen: 0.45, sheenRoughness: 0.85, sheenColor: 0xffb9a8, env: 0.55 },
  deep: { roughness: 0.44, clearcoat: 0.45, clearcoatRoughness: 0.35,
          sheen: 0.25, sheenRoughness: 0.7, sheenColor: 0xffffff, env: 0.75 },
  vessels: { roughness: 0.26, clearcoat: 0.7, clearcoatRoughness: 0.22,
             sheen: 0.0, sheenRoughness: 1, sheenColor: 0xffffff, env: 1.0 },
  surface: { roughness: 0.86, clearcoat: 0.08, clearcoatRoughness: 0.8,
             sheen: 0.3, sheenRoughness: 0.9, sheenColor: 0xffd9c4, env: 0.4 },
};

function makeMaterial(meta) {
  const s = SURFACE[meta.group] || SURFACE.deep;
  const common = {
    color: new THREE.Color(meta.color),
    vertexColors: true,              // baked AO lives in COLOR_0
    roughness: s.roughness, metalness: 0.0,
    envMapIntensity: s.env,
    transparent: false, opacity: 1,
    // Must stay DoubleSide. Backface culling would be free performance on a
    // consistently wound mesh, but these come from marching cubes on a
    // non-watertight mask and their triangle winding is mixed - culling
    // punched visible holes straight through the cortex. Do not "optimise"
    // this to FrontSide without first making the meshes watertight and
    // consistently oriented in the pipeline.
    side: THREE.DoubleSide,
    clippingPlanes: [],
  };
  // Clearcoat and sheen are the expensive part of MeshPhysicalMaterial. The
  // scalp is a large, nearly-transparent shell that covers the whole screen -
  // paying for a second specular lobe there is what wrecked the close-up
  // framerate, and at 28% opacity it is not visible anyway.
  if (meta.group === 'surface') return new THREE.MeshStandardMaterial(common);
  return new THREE.MeshPhysicalMaterial({
    ...common,
    clearcoat: s.clearcoat, clearcoatRoughness: s.clearcoatRoughness,
    sheen: s.sheen, sheenRoughness: s.sheenRoughness,
    sheenColor: new THREE.Color(s.sheenColor),
  });
}

async function boot() {
  [manifest, anatomy] = await Promise.all([
    fetch('manifest.json').then((r) => r.json()),
    fetch('anatomy.json').then((r) => r.json()),
  ]);
  try { pins = await (await fetch('pins.json')).json(); } catch { pins = []; }

  const list = manifest.parts;
  let done = 0;
  for (const meta of list) {
    loadTxt.textContent = meta.label;
    await new Promise((res) => {
      loader.load(meta.file, (gltf) => {
        const src = gltf.scene.getObjectByProperty('isMesh', true);
        const geom = src.geometry;
        if (!geom.attributes.normal) geom.computeVertexNormals();
        geom.computeBoundsTree();
        const material = makeMaterial(meta);
        const mesh = new THREE.Mesh(geom, material);
        mesh.name = meta.name;
        mesh.userData.meta = meta;
        mesh.visible = meta.defaultVisible;
        mesh.renderOrder = meta.group === 'surface' ? 10 : (meta.group === 'brain' ? 5 : 0);
        root.add(mesh);
        parts.set(meta.name, { mesh, meta, material });
        res();
      }, undefined, (e) => { console.warn('failed', meta.file, e); res(); });
    });
    loadBar.style.width = `${(++done / list.length) * 100}%`;
  }

  frameAll();
  buildLayerUI();
  renderPinList();
  loadEl.classList.add('done');
  setTimeout(() => loadEl.remove(), 800);
  startIntro();
}

function frameAll() {
  const box = new THREE.Box3();
  const hero = parts.get('brain');
  if (hero) box.expandByObject(hero.mesh);
  else for (const { mesh } of parts.values()) box.expandByObject(mesh);
  const sph = box.getBoundingSphere(new THREE.Sphere());
  const c = sph.center, r = sph.radius;
  const fovV = THREE.MathUtils.degToRad(camera.fov);
  const fovH = 2 * Math.atan(Math.tan(fovV / 2) * camera.aspect);
  baseDist = (r / Math.sin(Math.min(fovV, fovH) / 2)) * 1.06;
  controls.target.copy(c);
  camera.position.copy(c).add(
    new THREE.Vector3(-0.90, 0.20, 0.38).normalize().multiplyScalar(baseDist));
  camera.near = r / 100; camera.far = baseDist + r * 8;
  camera.updateProjectionMatrix();
  const s = $('#clippos'); s.min = -r; s.max = r;
}

/* ---------------------------------------------------------- intro animation */
// Parts fade and lift into place while the camera eases in. Purely cosmetic,
// but it turns a hard cut into an arrival.
let intro = null;
function startIntro() {
  intro = { t0: performance.now(), dur: 1700 };
}
function applyIntro(now) {
  if (!intro) return;
  const p = Math.min((now - intro.t0) / intro.dur, 1);
  const e = 1 - Math.pow(1 - p, 3);              // ease-out cubic
  root.position.y = (1 - e) * -30;
  root.scale.setScalar(0.93 + 0.07 * e);
  const dir = camera.position.clone().sub(controls.target).normalize();
  camera.position.copy(controls.target).add(dir.multiplyScalar(baseDist * (1.30 - 0.30 * e)));
  applyOpacity(e);
  if (p >= 1) { intro = null; root.position.y = 0; root.scale.setScalar(1); applyOpacity(1); }
}

/* ----------------------------------------------------------------- layer UI */
const GROUPS = [
  ['brain', 'Brain'], ['deep', 'Deep structures'],
  ['vessels', 'Vasculature'], ['surface', 'Outer surface'],
];

function buildLayerUI() {
  const host = $('#layerlist');
  host.innerHTML = '';
  for (const [gid, gname] of GROUPS) {
    const items = manifest.parts.filter((p) => p.group === gid);
    if (!items.length) continue;
    const wrap = document.createElement('div');
    wrap.className = 'lgroup';
    wrap.innerHTML = `<b>${gname}</b>`;
    for (const meta of items) {
      const rec = parts.get(meta.name);
      if (!rec) continue;
      const row = document.createElement('div');
      row.className = 'layer' + (rec.mesh.visible ? '' : ' off');
      row.dataset.name = meta.name;
      row.innerHTML =
        `<span class="dot" style="background:${meta.color}"></span>` +
        `<span class="nm">${meta.label}</span>` +
        `<span class="vol">${meta.volume_cm3} cm³</span>`;
      row.addEventListener('click', () => {
        rec.mesh.visible = !rec.mesh.visible;
        row.classList.toggle('off', !rec.mesh.visible);
        invalidatePickList();
        if (!rec.mesh.visible && selected?.name === meta.name) select(null);
        autoTransparency();
      });
      wrap.appendChild(row);
    }
    host.appendChild(wrap);
  }
}

function markSelectedRow(name) {
  document.querySelectorAll('.layer').forEach((r) =>
    r.classList.toggle('sel', r.dataset.name === name));
}

/* --------------------------------------------------------------- opacity */
function applyOpacity(scale = 1) {
  const b = +$('#opbrain').value / 100, h = +$('#ophead').value / 100;
  for (const { meta, material } of parts.values()) {
    let o = 1;
    if (meta.name === 'brain') o = b;
    else if (meta.name === 'head') o = h;
    material.opacity = o * scale;
    // Flagging a material transparent puts it in the sorted blend pass and
    // gives up early-Z. With eleven nested shells that is enormous overdraw,
    // so only opt in when the surface is actually see-through.
    const wantTransparent = material.opacity < 0.995;
    if (material.transparent !== wantTransparent) {
      material.transparent = wantTransparent;
      material.needsUpdate = true;
    }
    material.depthWrite = !wantTransparent;

    // A clearcoat highlight and a sheen lobe are invisible through a surface
    // you can already see straight through, but they still cost a second
    // specular evaluation per fragment. Drop them once the shell goes faint.
    if (material.isMeshPhysicalMaterial) {
      const s = SURFACE[meta.group] || SURFACE.deep;
      const faint = material.opacity < 0.5;
      const cc = faint ? 0 : s.clearcoat;
      const sh = faint ? 0 : s.sheen;
      if ((material.clearcoat > 0) !== (cc > 0) || (material.sheen > 0) !== (sh > 0)) {
        material.needsUpdate = true;
      }
      material.clearcoat = cc;
      material.sheen = sh;
    }
  }
}

$('#opbrain').addEventListener('input', () => applyOpacity());
$('#ophead').addEventListener('input', () => applyOpacity());

function autoTransparency() {
  const anyDeep = [...parts.values()].some((p) => p.meta.group === 'deep' && p.mesh.visible);
  const brain = parts.get('brain');
  if (anyDeep && brain && brain.mesh.visible && +$('#opbrain').value > 60) {
    $('#opbrain').value = 22;
    applyOpacity();
  }
}

/* -------------------------------------------------------------- selection */
const ray = new THREE.Raycaster();
const ptr = new THREE.Vector2();
const tip = $('#hovertip');

// Cached list of pickable meshes; visibility changes invalidate it.
let pickList = null;
function invalidatePickList() { pickList = null; }
function pickable() {
  if (!pickList) pickList = [...parts.values()].filter((p) => p.mesh.visible).map((p) => p.mesh);
  return pickList;
}

function pick(ev) {
  const r = renderer.domElement.getBoundingClientRect();
  ptr.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
  ptr.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
  ray.setFromCamera(ptr, camera);
  return ray.intersectObjects(pickable(), false)[0] || null;
}

// Pointermove fires far faster than the display refreshes, so the raycast is
// deferred and coalesced to one per frame - and skipped entirely mid-drag,
// where the result would be thrown away anyway.
let hoverEv = null, dragging = false;
renderer.domElement.addEventListener('pointermove', (ev) => { hoverEv = ev; });

function processHover() {
  if (!hoverEv || dragging) return;
  const ev = hoverEv; hoverEv = null;
  const hit = pick(ev);
  if (hit) {
    tip.hidden = false;
    tip.textContent = hit.object.userData.meta.label;
    tip.style.left = `${ev.clientX}px`;
    tip.style.top = `${ev.clientY}px`;
    renderer.domElement.style.cursor = pinMode ? 'crosshair' : 'pointer';
  } else {
    tip.hidden = true;
    renderer.domElement.style.cursor = pinMode ? 'crosshair' : 'grab';
  }
}

let downAt = null;
renderer.domElement.addEventListener('pointerdown', (e) => {
  downAt = [e.clientX, e.clientY]; dragging = true; tip.hidden = true;
});
renderer.domElement.addEventListener('pointerup', (ev) => {
  dragging = false;
  if (!downAt) return;
  const moved = Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]);
  downAt = null;
  if (moved > 4) return;
  const hit = pick(ev);
  if (pinMode && hit) { addPin(hit.point, hit.object.userData.meta.label); return; }
  select(hit ? hit.object.userData.meta : null, hit);
});

/* --------------------------------------------------- callout + leader line */
const calloutGroup = new THREE.Group();
scene.add(calloutGroup);
let calloutAnchor = null;      // world point on the surface the line starts at

// depthTest off: the leader has to stay visible even where it passes back
// through the structure it is pointing at.
const leaderMat = new THREE.LineBasicMaterial({
  color: 0x4cc9e0, transparent: true, opacity: 0.9, depthTest: false });
const anchorMat = new THREE.MeshBasicMaterial({ color: 0x4cc9e0, depthTest: false });
const anchorGeo = new THREE.SphereGeometry(1.6, 14, 10);
let leaderLine = null;

function clearCallout() {
  calloutGroup.clear();
  calloutAnchor = null; leaderLine = null;
  $('#calloutlayer').innerHTML = '';
}

function showCallout(meta, hit) {
  clearCallout();
  const info = anatomy.parts[meta.name];
  if (!info || !hit) return;

  calloutAnchor = hit.point.clone();
  const dot = new THREE.Mesh(anchorGeo, anchorMat);
  dot.position.copy(calloutAnchor);
  dot.renderOrder = 999;
  calloutGroup.add(dot);

  leaderLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([calloutAnchor.clone(), calloutAnchor.clone()]),
    leaderMat);
  leaderLine.renderOrder = 999;
  leaderLine.frustumCulled = false;
  calloutGroup.add(leaderLine);

  const card = document.createElement('div');
  card.className = 'callout';
  card.innerHTML = `<h3>${meta.label}</h3>` + info.lines.map((l) => `<p>${l}</p>`).join('');
  $('#calloutlayer').appendChild(card);
}

const tmpV = new THREE.Vector3();
const tmpE = new THREE.Vector3();

function updateCallout() {
  const card = $('#calloutlayer').firstElementChild;
  if (!card || !calloutAnchor || !leaderLine) return;
  const w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight;

  tmpV.copy(calloutAnchor).project(camera);
  if (tmpV.z > 1) { card.style.display = 'none'; leaderLine.visible = false; return; }
  card.style.display = ''; leaderLine.visible = true;

  const sx = (tmpV.x * 0.5 + 0.5) * w;
  const sy = (-tmpV.y * 0.5 + 0.5) * h;
  const cw = card.offsetWidth || 268;
  const ch = card.offsetHeight || 150;

  // Route the leader out sideways in SCREEN space. Offsetting along the
  // surface normal instead looks fine in profile but collapses to zero length
  // whenever the normal happens to face the camera.
  const side = sx < w / 2 ? -1 : 1;
  let ex = sx + side * 132;
  let ey = sy - 74;
  ex = Math.max(cw / 2 + 24, Math.min(ex, w - cw / 2 - 24));
  ey = Math.max(ch / 2 + 80, Math.min(ey, h - ch / 2 - 80));

  // screen point back to world, at the anchor's depth, so the 3D line lands
  // exactly where the HTML card is drawn
  tmpE.set((ex / w) * 2 - 1, -(ey / h) * 2 + 1, tmpV.z).unproject(camera);
  const pos = leaderLine.geometry.attributes.position;
  pos.setXYZ(0, calloutAnchor.x, calloutAnchor.y, calloutAnchor.z);
  pos.setXYZ(1, tmpE.x, tmpE.y, tmpE.z);
  pos.needsUpdate = true;
  leaderLine.geometry.computeBoundingSphere();

  card.style.left = `${ex - cw / 2 + side * (cw / 2 + 10)}px`;
  card.style.top = `${ey}px`;
}

function select(meta, hit = null) {
  for (const { material, meta: m } of parts.values()) {
    material.emissive.setHex(meta && m.name === meta.name ? 0x123840 : 0x000000);
  }
  selected = meta;
  const box = $('#selinfo');
  if (!meta) {
    box.className = 'empty';
    box.textContent = 'Click any structure to read what it does.';
    markSelectedRow(null);
    clearCallout();
    return;
  }
  const info = anatomy.parts[meta.name];
  box.className = '';
  box.innerHTML =
    `<div class="t">${meta.label}</div>` +
    (info ? info.lines.map((l) => `<p>${l}</p>`).join('') : '') +
    `<table>` +
    `<tr><td>volume</td><td>${meta.volume_cm3} cm³</td></tr>` +
    `<tr><td>triangles</td><td>${meta.triangles.toLocaleString()}</td></tr>` +
    `</table>`;
  markSelectedRow(meta.name);
  showCallout(meta, hit);
}

/* left / right hemispheres explainer */
$('#hemi').addEventListener('click', () => {
  const h = anatomy.hemispheres;
  clearCallout();
  markSelectedRow(null);
  selected = null;
  for (const { material } of parts.values()) material.emissive.setHex(0x000000);
  const box = $('#selinfo');
  box.className = '';
  box.innerHTML = `<div class="t">${h.label}</div>` +
    h.lines.map((l) => `<p>${l}</p>`).join('') +
    `<div class="myth"><b>Common myth.</b> ${h.myth}</div>`;
});

/* -------------------------------------------------------------------- pins */
const pinGroup = new THREE.Group();
scene.add(pinGroup);
const pinGeo = new THREE.SphereGeometry(2.4, 16, 12);
const pinMat = new THREE.MeshBasicMaterial({ color: 0x4cc9e0 });

function addPin(point, near) {
  pins.push({
    id: `p${Date.now().toString(36)}`,
    label: `Pin ${pins.length + 1}`,
    note: near || '',
    p: [+point.x.toFixed(2), +point.y.toFixed(2), +point.z.toFixed(2)],
  });
  renderPinList();
  setPinMode(false);
}

function renderPinList() {
  pinGroup.clear();
  $('#pinlayer').innerHTML = '';
  $('#pincount').textContent = pins.length ? `· ${pins.length}` : '';
  const host = $('#pinlist');
  host.innerHTML = '';
  pins.forEach((pin, i) => {
    const m = new THREE.Mesh(pinGeo, pinMat);
    m.position.fromArray(pin.p);
    m.userData.pin = pin;
    pinGroup.add(m);

    const lab = document.createElement('div');
    lab.className = 'pinlabel';
    lab.textContent = pin.label;
    lab.dataset.id = pin.id;
    $('#pinlayer').appendChild(lab);
    m.userData.el = lab;                 // cached; avoids a DOM query per frame

    const row = document.createElement('div');
    row.className = 'pin-row';
    const inp = document.createElement('input');
    inp.value = pin.label;
    inp.style.cssText = 'background:transparent;border:0;color:inherit;font:inherit;width:100%;outline:0';
    inp.addEventListener('input', () => { pin.label = inp.value; lab.textContent = inp.value; });
    const left = document.createElement('div');
    left.appendChild(inp);
    const sm = document.createElement('small');
    sm.textContent = `${pin.note || 'free'} · ${pin.p.map((v) => v.toFixed(0)).join(', ')} mm`;
    left.appendChild(sm);
    const del = document.createElement('span');
    del.className = 'x'; del.textContent = '✕';
    del.addEventListener('click', (e) => { e.stopPropagation(); pins.splice(i, 1); renderPinList(); });
    row.append(left, del);
    row.addEventListener('click', () => controls.target.set(...pin.p));
    host.appendChild(row);
  });
}

function setPinMode(on) {
  pinMode = on;
  $('#pinmode').classList.toggle('active', on);
  $('#pinmode').textContent = on ? '× cancel' : '＋ place pin';
}
$('#pinmode').addEventListener('click', () => setPinMode(!pinMode));
$('#pinsave').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(pins, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'pins.json'; a.click();
});

function updatePinLabels() {
  if (!pinGroup.children.length) return;
  const w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight;
  pinGroup.children.forEach((m) => {
    const el = m.userData.el;
    if (!el) return;
    tmpV.copy(m.position).project(camera);
    el.style.display = tmpV.z > 1 ? 'none' : '';
    el.style.left = `${(tmpV.x * 0.5 + 0.5) * w}px`;
    el.style.top = `${(-tmpV.y * 0.5 + 0.5) * h - 22}px`;
  });
}

/* ------------------------------------------------------------ cross-section */
const AXES = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
function applyClip() {
  const planes = clipAxis === 'off' ? [] : [clipPlane];
  for (const { material } of parts.values()) material.clippingPlanes = planes;
  if (clipAxis !== 'off') {
    clipPlane.normal.copy(new THREE.Vector3(...AXES[clipAxis]).multiplyScalar(clipFlip ? -1 : 1));
    clipPlane.constant = (clipFlip ? 1 : -1) * -(+$('#clippos').value);
  }
}
$('#clipaxis').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  clipAxis = b.dataset.axis;
  [...$('#clipaxis').children].forEach((c) => c.classList.toggle('on', c === b));
  $('#clippos').disabled = clipAxis === 'off';
  applyClip();
});
$('#clippos').addEventListener('input', applyClip);
$('#clipflip').addEventListener('change', (e) => { clipFlip = e.target.checked; applyClip(); });

/* ------------------------------------------------------------- camera tools */
const VIEWS = { L: [-1, 0, 0], R: [1, 0, 0], A: [0, 0, -1], P: [0, 0, 1], S: [0, 1, 0], I: [0, -1, 0] };
$('#views').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const v = b.dataset.view;
  const d = camera.position.distanceTo(controls.target);
  camera.up.set(0, v === 'S' || v === 'I' ? 0 : 1, v === 'S' ? -1 : (v === 'I' ? 1 : 0));
  camera.position.copy(controls.target).add(new THREE.Vector3(...VIEWS[v]).multiplyScalar(d));
  controls.update();
});
$('#reset').addEventListener('click', () => { camera.up.set(0, 1, 0); clearCallout(); select(null); frameAll(); });
$('#shot').addEventListener('click', () => {
  renderer.render(scene, camera);
  const a = document.createElement('a');
  a.href = renderer.domElement.toDataURL('image/png');
  a.download = `brain-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.png`;
  a.click();
});

/* ------------------------------------------------------- orientation gnomon */
const GNOMON = [['R', 1, 0, 0], ['L', -1, 0, 0], ['S', 0, 1, 0], ['I', 0, -1, 0],
                ['P', 0, 0, 1], ['A', 0, 0, -1]];
const gnomonEls = GNOMON.map(([t]) => {
  const s = document.createElement('span'); s.textContent = t;
  $('#orient').appendChild(s); return s;
});
const gQ = new THREE.Quaternion(), gV = new THREE.Vector3();
function updateGnomon() {
  const q = gQ.copy(camera.quaternion).invert();
  GNOMON.forEach(([, x, y, z], i) => {
    const v = gV.set(x, y, z).applyQuaternion(q);
    const el = gnomonEls[i];
    el.style.left = `${44 + v.x * 32 - 5}px`;
    el.style.top = `${44 - v.y * 32 - 5}px`;
    el.style.opacity = `${0.3 + 0.7 * (v.z * 0.5 + 0.5)}`;
    el.style.color = v.z > 0.2 ? 'var(--accent)' : 'var(--ink-3)';
  });
}

/* ------------------------------------------------------ idle + focus + loop */
let lastInput = performance.now();
const IDLE_MS = 5000;
['pointerdown', 'wheel', 'pointermove'].forEach((ev) =>
  renderer.domElement.addEventListener(ev, () => { lastInput = performance.now(); }));
controls.addEventListener('start', () => { lastInput = performance.now(); });

renderer.domElement.addEventListener('dblclick', (ev) => {
  const hit = pick(ev);
  if (!hit) return;
  hit.object.geometry.computeBoundingSphere();
  const s = hit.object.geometry.boundingSphere;
  const dir = camera.position.clone().sub(controls.target).normalize();
  controls.target.copy(s.center);
  camera.position.copy(s.center).add(dir.multiplyScalar(Math.max(s.radius * 2.1, 6)));
});

function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

/* --------------------------------------------------- adaptive resolution */
// Last line of defence for the fill-rate-bound close-up case. This scales the
// framebuffer only - geometry, materials and the meshes themselves are never
// touched - and it only engages when frames are actually being missed.
const BASE_PR = Math.min(devicePixelRatio, 2);
const STEPS = [1, 0.85, 0.72];
let prStep = 0, frameAvg = 16.7, lastPrChange = 0, prevFrame = performance.now();

function adaptResolution(now) {
  const dt = now - prevFrame; prevFrame = now;
  if (dt > 200) return;                       // tab was backgrounded
  frameAvg += (dt - frameAvg) * 0.06;         // slow EMA, ignores single spikes
  if (now - lastPrChange < 1200) return;
  let next = prStep;
  if (frameAvg > 24 && prStep < STEPS.length - 1) next = prStep + 1;
  else if (frameAvg < 14 && prStep > 0) next = prStep - 1;
  if (next !== prStep) {
    prStep = next;
    lastPrChange = now;
    renderer.setPixelRatio(BASE_PR * STEPS[prStep]);
    frameAvg = 16.7;
  }
}

renderer.setAnimationLoop(() => {
  const now = performance.now();
  adaptResolution(now);
  applyIntro(now);
  controls.autoRotate = !intro && now - lastInput > IDLE_MS && !pinMode;
  controls.update();
  processHover();
  updateGnomon();
  updatePinLabels();
  updateCallout();
  renderer.render(scene, camera);
});

addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { setPinMode(false); select(null); }
});

// Handle for profiling and debugging from the console / headless benchmarks.
window.__viewer = { renderer, scene, camera, controls, parts, THREE,
                    stats: () => ({ frameAvg, resScale: STEPS[prStep] }) };

boot();
