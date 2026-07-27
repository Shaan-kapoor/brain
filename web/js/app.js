/* Interactive viewer for a personal brain MRI reconstruction.
 *
 * Geometry arrives already in glTF axes: +X = patient RIGHT, +Y = SUPERIOR,
 * +Z = POSTERIOR (see pipeline/05_export.py). Units are millimetres, recentred
 * on the brain centroid, so distances shown in the UI are real.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const $ = (s) => document.querySelector(s);
const stage = $('#stage');

/* ---------------------------------------------------------------- renderer */
const renderer = new THREE.WebGLRenderer({
  canvas: $('#view'), antialias: true, preserveDrawingBuffer: true,
});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.localClippingEnabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0d0f);

const camera = new THREE.PerspectiveCamera(38, 1, 1, 4000);
camera.position.set(-360, 90, 150);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.075;
controls.rotateSpeed = 0.85;
controls.minDistance = 90;
controls.maxDistance = 1200;

/* ------------------------------------------------------------------ lights */
// Three-point rig. No HDR file: keeps the whole thing dependency-free and
// offline, and flat-ish clinical lighting suits an anatomical surface anyway.
scene.add(new THREE.HemisphereLight(0xbcd4e6, 0x14181c, 1.15));
const key = new THREE.DirectionalLight(0xffffff, 2.0);
key.position.set(-1, 1.15, 0.75);
scene.add(key);
const fill = new THREE.DirectionalLight(0x9fc4dd, 0.75);
fill.position.set(1, 0.25, 0.6);
scene.add(fill);
const rim = new THREE.DirectionalLight(0x7fd9ec, 0.9);
rim.position.set(0.4, -0.6, -1);
scene.add(rim);

/* ------------------------------------------------------------------- state */
const root = new THREE.Group();
scene.add(root);

const parts = new Map();          // name -> {mesh, meta, material}
let manifest = null;
let selected = null;
let pinMode = false;
let pins = [];

const clipPlane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);
let clipAxis = 'off', clipFlip = false;

/* ------------------------------------------------------------------ loading */
const loader = new GLTFLoader();
const loadEl = $('#loader'), loadBar = loadEl.querySelector('i'), loadTxt = loadEl.querySelector('span');

function makeMaterial(meta) {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(meta.color),
    roughness: meta.group === 'vessels' ? 0.42 : 0.78,
    metalness: 0.0,
    transparent: true,
    opacity: 1,
    side: THREE.DoubleSide,          // cross-sections stay solid-looking
    clippingPlanes: [],
    flatShading: false,
  });
}

async function boot() {
  manifest = await (await fetch('manifest.json')).json();
  try { pins = await (await fetch('pins.json')).json(); } catch { pins = []; }

  const list = manifest.parts;
  let done = 0;
  for (const meta of list) {
    loadTxt.textContent = `loading ${meta.label}`;
    await new Promise((res) => {
      loader.load(meta.file, (gltf) => {
        const src = gltf.scene.getObjectByProperty('isMesh', true);
        const geom = src.geometry;
        // Without a NORMAL attribute every lit material shades pure black.
        if (!geom.attributes.normal) geom.computeVertexNormals();
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
    done++;
    loadBar.style.width = `${(done / list.length) * 100}%`;
  }

  frameAll();
  buildLayerUI();
  applyOpacity();
  renderPinList();
  loadEl.classList.add('done');
}

function frameAll() {
  // Frame on the brain, not on everything: the carotids run far down the neck
  // and would otherwise push the brain into a small blob in the centre.
  const box = new THREE.Box3();
  const hero = parts.get('brain');
  if (hero) box.expandByObject(hero.mesh);
  else for (const { mesh } of parts.values()) box.expandByObject(mesh);
  const sph = box.getBoundingSphere(new THREE.Sphere());
  const c = sph.center, r = sph.radius;

  // Fit the bounding sphere to whichever of the two field-of-view angles is
  // tighter, so the brain never gets clipped on a narrow window.
  const fovV = THREE.MathUtils.degToRad(camera.fov);
  const fovH = 2 * Math.atan(Math.tan(fovV / 2) * camera.aspect);
  const dist = (r / Math.sin(Math.min(fovV, fovH) / 2)) * 1.06;

  controls.target.copy(c);
  camera.position.copy(c).add(
    new THREE.Vector3(-0.90, 0.20, 0.38).normalize().multiplyScalar(dist));
  camera.near = r / 100; camera.far = dist + r * 8;
  camera.updateProjectionMatrix();
  const s = $('#clippos'); s.min = -r; s.max = r;
}

/* ----------------------------------------------------------------- layer UI */
const GROUPS = [
  ['brain', 'Brain'],
  ['deep', 'Deep structures'],
  ['vessels', 'Vasculature'],
  ['surface', 'Outer surface'],
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
function applyOpacity() {
  const b = +$('#opbrain').value / 100, h = +$('#ophead').value / 100;
  const brain = parts.get('brain'), head = parts.get('head');
  if (brain) { brain.material.opacity = b; brain.material.depthWrite = b > 0.97; }
  if (head) { head.material.opacity = h; head.material.depthWrite = h > 0.97; }
}
$('#opbrain').addEventListener('input', applyOpacity);
$('#ophead').addEventListener('input', applyOpacity);

// Turning on anything internal while the brain is fully opaque hides it, which
// looks broken. Fade the shell automatically the first time that happens.
function autoTransparency() {
  const anyDeep = [...parts.values()].some(
    (p) => p.meta.group === 'deep' && p.mesh.visible);
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

function pick(ev) {
  const r = renderer.domElement.getBoundingClientRect();
  ptr.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
  ptr.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
  ray.setFromCamera(ptr, camera);
  const meshes = [...parts.values()].filter((p) => p.mesh.visible).map((p) => p.mesh);
  return ray.intersectObjects(meshes, false)[0] || null;
}

renderer.domElement.addEventListener('pointermove', (ev) => {
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
});

let downAt = null;
renderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', (ev) => {
  if (!downAt) return;
  const moved = Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]);
  downAt = null;
  if (moved > 4) return;                      // that was an orbit drag
  const hit = pick(ev);
  if (pinMode && hit) { addPin(hit.point, hit.object.userData.meta.label); return; }
  select(hit ? hit.object.userData.meta : null);
});

function select(meta) {
  for (const { material, meta: m } of parts.values()) {
    material.emissive.setHex(meta && m.name === meta.name ? 0x123840 : 0x000000);
  }
  selected = meta;
  const box = $('#selinfo');
  if (!meta) {
    box.className = 'empty';
    box.textContent = 'Click any structure to identify it.';
    markSelectedRow(null);
    return;
  }
  box.className = '';
  box.innerHTML =
    `<div class="t">${meta.label}</div><table>` +
    `<tr><td>volume</td><td>${meta.volume_cm3} cm³</td></tr>` +
    `<tr><td>triangles</td><td>${meta.triangles.toLocaleString()}</td></tr>` +
    `<tr><td>group</td><td>${meta.group}</td></tr>` +
    `</table>`;
  markSelectedRow(meta.name);
}

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

    const row = document.createElement('div');
    row.className = 'pin-row';
    const inp = document.createElement('input');
    inp.value = pin.label;
    inp.style.cssText =
      'background:transparent;border:0;color:inherit;font:inherit;width:100%;outline:0';
    inp.addEventListener('input', () => { pin.label = inp.value; lab.textContent = inp.value; });
    const left = document.createElement('div');
    left.appendChild(inp);
    const sm = document.createElement('small');
    sm.textContent = `${pin.note || 'free'} · ${pin.p.map((v) => v.toFixed(0)).join(', ')} mm`;
    left.appendChild(sm);
    const del = document.createElement('span');
    del.className = 'x'; del.textContent = '✕';
    del.addEventListener('click', (e) => {
      e.stopPropagation(); pins.splice(i, 1); renderPinList();
    });
    row.append(left, del);
    row.addEventListener('click', () => {
      controls.target.set(...pin.p);
    });
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

/* ------------------------------------------------------------ cross-section */
const AXES = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

function applyClip() {
  const planes = clipAxis === 'off' ? [] : [clipPlane];
  for (const { material } of parts.values()) material.clippingPlanes = planes;
  if (clipAxis !== 'off') {
    const n = new THREE.Vector3(...AXES[clipAxis]).multiplyScalar(clipFlip ? -1 : 1);
    clipPlane.normal.copy(n);
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
// +X right, +Y superior, +Z posterior
const VIEWS = {
  L: [-1, 0, 0], R: [1, 0, 0],
  A: [0, 0, -1], P: [0, 0, 1],
  S: [0, 1, 0], I: [0, -1, 0],
};
$('#views').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const d = camera.position.distanceTo(controls.target);
  const v = new THREE.Vector3(...VIEWS[b.dataset.view]).multiplyScalar(d);
  camera.position.copy(controls.target).add(v);
  camera.up.set(0, (b.dataset.view === 'S' || b.dataset.view === 'I') ? 0 : 1,
    (b.dataset.view === 'S') ? -1 : (b.dataset.view === 'I' ? 1 : 0));
  controls.update();
});
$('#reset').addEventListener('click', () => { camera.up.set(0, 1, 0); frameAll(); });
$('#shot').addEventListener('click', () => {
  renderer.render(scene, camera);
  const a = document.createElement('a');
  a.href = renderer.domElement.toDataURL('image/png');
  a.download = `brain-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.png`;
  a.click();
});

/* ------------------------------------------------------- orientation gnomon */
const GNOMON = [
  ['R', 1, 0, 0], ['L', -1, 0, 0],
  ['S', 0, 1, 0], ['I', 0, -1, 0],
  ['P', 0, 0, 1], ['A', 0, 0, -1],
];
const gnomonEls = (() => {
  const host = $('#orient');
  host.innerHTML = '';
  return GNOMON.map(([t]) => {
    const s = document.createElement('span');
    s.textContent = t; host.appendChild(s); return s;
  });
})();

function updateGnomon() {
  const q = camera.quaternion.clone().invert();
  GNOMON.forEach(([, x, y, z], i) => {
    const v = new THREE.Vector3(x, y, z).applyQuaternion(q);
    const el = gnomonEls[i];
    el.style.left = `${44 + v.x * 32 - 5}px`;
    el.style.top = `${44 - v.y * 32 - 5}px`;
    el.style.opacity = `${0.35 + 0.65 * (v.z * 0.5 + 0.5)}`;
    el.style.color = v.z > 0.2 ? 'var(--accent)' : 'var(--ink-3)';
  });
}

/* --------------------------------------------------------------- pin labels */
const tmp = new THREE.Vector3();
function updatePinLabels() {
  const w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight;
  pinGroup.children.forEach((m) => {
    const el = $('#pinlayer').querySelector(`[data-id="${m.userData.pin.id}"]`);
    if (!el) return;
    tmp.copy(m.position).project(camera);
    const behind = tmp.z > 1;
    el.style.display = behind ? 'none' : '';
    el.style.left = `${(tmp.x * 0.5 + 0.5) * w}px`;
    el.style.top = `${(-tmp.y * 0.5 + 0.5) * h - 22}px`;
  });
}

/* ---------------------------------------------------------------- main loop */
function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

renderer.setAnimationLoop(() => {
  controls.update();
  updateGnomon();
  updatePinLabels();
  renderer.render(scene, camera);
});

addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { setPinMode(false); select(null); }
});

boot();
