// النموذج ثلاثي الأبعاد ومحاكاة 4D
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { TRADE } from './library.js';
import { plannedFrac } from './scheduler.js';

// عند غياب نشاط يبني فئة معينة، يرتبط العنصر بأقرب نشاط بديل
const CAT_FALLBACK = {
  pcc: ['footing'], neck: ['footing', 'column'], tiebeam: ['footing', 'slab'], wp_sub: ['tiebeam', 'footing'],
  sog: ['backfill', 'footing'], footing: ['column'], column: ['slab'], slab: ['column'], wall: ['plaster', 'column'],
  ceiling: ['paint', 'plaster'], floorfinish: ['paint', 'plaster'], door: ['floorfinish', 'paint', 'plaster'],
  window: ['plaster', 'wall'], mep: ['wall', 'plaster'], fixture: ['paint', 'mep'], roofwp: ['slab'],
  facade: ['wall'], external: ['facade', 'backfill'], elevator: ['slab'], excavation: ['footing'],
  backfill: ['tiebeam', 'footing'], site: [],
};

export const STATE_COLORS = { active: 0x2ecc71, delayed: 0xe53935, ahead: 0x1e88e5 };

export class Viewer {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.setClearColor(0xe9eef2);
    container.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    this.camera.position.set(40, 30, 40);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7f70, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(60, 100, 40);
    this.scene.add(sun);
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshLambertMaterial({ color: 0xd9cfbf }));
    this.ground.rotation.x = -Math.PI / 2;
    this.scene.add(this.ground);
    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.elements = [];
    this.matCache = new Map();
    this.ghost = new THREE.MeshLambertMaterial({ color: 0x90a4ae, transparent: true, opacity: 0.07, depthWrite: false });
    this.stateMat = Object.fromEntries(Object.entries(STATE_COLORS).map(([k, c]) =>
      [k, new THREE.MeshLambertMaterial({ color: c, emissive: c, emissiveIntensity: 0.35 })]));
    this.showGhost = true;
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    const loop = () => { requestAnimationFrame(loop); this.controls.update(); this.renderer.render(this.scene, this.camera); };
    loop();
  }

  resize() {
    const w = this.container.clientWidth || 600, h = this.container.clientHeight || 400;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  mat(color, opacity = 1) {
    const k = color + '|' + opacity;
    if (!this.matCache.has(k)) {
      this.matCache.set(k, new THREE.MeshLambertMaterial({ color, transparent: opacity < 1, opacity, side: THREE.DoubleSide }));
    }
    return this.matCache.get(k);
  }

  clear() {
    this.root.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    this.root.clear();
    this.elements = [];
  }

  addElement(meshes, cat, level, info = {}) {
    const el = { meshes, cat, level, info };
    for (const m of meshes) { m.userData.orig = m.material; m.userData.el = el; this.root.add(m); }
    const b = new THREE.Box3();
    meshes.forEach(m => b.expandByObject(m));
    el.box = b;
    el.center = b.getCenter(new THREE.Vector3());
    this.elements.push(el);
    return el;
  }

  box(cat, level, sx, sy, sz, x, y, z, color, opacity = 1) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), this.mat(color, opacity));
    m.position.set(x, y + sy / 2, z);
    m.updateMatrixWorld();
    return this.addElement([m], cat, level);
  }

  fit() {
    const b = new THREE.Box3();
    this.elements.forEach(e => b.union(e.box));
    if (b.isEmpty()) return;
    const c = b.getCenter(new THREE.Vector3()), s = b.getSize(new THREE.Vector3());
    const r = Math.max(s.x, s.y, s.z);
    this.ground.scale.set(r * 4, r * 4, 1);
    this.ground.position.set(c.x, b.min.y - 0.02, c.z);
    this.controls.target.copy(c);
    this.camera.position.set(c.x + r * 0.75, c.y + r * 0.55, c.z + r * 0.85);
    this.camera.near = r / 500; this.camera.far = r * 50;
    this.camera.updateProjectionMatrix();
  }

  // ---------- نموذج تلقائي من أبعاد المبنى ----------
  buildParametric(p) {
    this.clear();
    const { L = 30, W = 20, floors = 3, h = 3.5, nx = 5, nz = 4 } = p;
    const xs = [...Array(nx + 1)].map((_, i) => -L / 2 + (L * i) / nx);
    const zs = [...Array(nz + 1)].map((_, i) => -W / 2 + (W * i) / nz);
    const grid = xs.flatMap(x => zs.map(z => [x, z]));
    const D = 1.6; // عمق التأسيس
    // الموقع
    [[L + 14, 0.1, -W / 2 - 7], [L + 14, 0.1, W / 2 + 7]].forEach(([sx, , z]) => this.box('site', 'P', sx, 2, 0.08, 0, 0, z, 0x607d8b));
    [-L / 2 - 7, L / 2 + 7].forEach(x => this.box('site', 'P', 0.08, 2, W + 14, x, 0, 0, 0x607d8b));
    this.box('site', 'P', 6, 2.6, 2.4, -L / 2 - 2, 0, W / 2 + 4.5, 0xf5f5f5);
    this.box('site', 'P', 6, 2.6, 2.4, -L / 2 + 5, 0, W / 2 + 4.5, 0xf5f5f5);
    // الحفر
    for (const [x, z] of grid) this.box('excavation', 'P', 3.2, 0.04, 3.2, x, -0.02, z, 0x5d4037);
    this.box('excavation', 'P', L + 4, 0.03, W + 4, 0, -0.06, 0, 0x6d4c41, 0.9);
    // الأساسات
    for (const [x, z] of grid) {
      this.box('pcc', -1, 2.6, 0.1, 2.6, x, -D, z, 0xbdbdbd);
      this.box('footing', -1, 2.2, 0.6, 2.2, x, -D + 0.1, z, 0x8a9ba8);
      this.box('wp_sub', -1, 2.26, 0.64, 2.26, x, -D + 0.08, z, 0x263238);
      this.box('neck', -1, 0.45, D - 0.7, 0.45, x, -D + 0.7, z, 0x78909c);
    }
    for (const z of zs) this.box('tiebeam', -1, L, 0.5, 0.3, 0, -0.6, z, 0x6f8592);
    for (const x of xs) this.box('tiebeam', -1, 0.3, 0.5, W, x, -0.6, 0, 0x6f8592);
    this.box('backfill', 'P', L + 4, D - 0.25, W + 4, 0, -D, 0, 0xc8a27a);
    this.box('sog', -1, L + 0.3, 0.15, W + 0.3, 0, -0.15, 0, 0xa7a7a7);
    // الأدوار
    const sx = L / nx, sz = W / nz;
    for (let f = 0; f < floors; f++) {
      const y0 = f * h;
      for (const [x, z] of grid) this.box('column', f, 0.4, h - 0.2, 0.4, x, y0, z, 0x9eaab3);
      this.box('slab', f, L + 0.4, 0.2, W + 0.4, 0, y0 + h - 0.2, 0, 0xb8c3ca);
      for (const z of zs) this.box('slab', f, L, 0.45, 0.3, 0, y0 + h - 0.6, z, 0xaab5bc);
      for (const x of xs) this.box('slab', f, 0.3, 0.45, W, x, y0 + h - 0.6, 0, 0xaab5bc);
      // الجدران الخارجية مع فتحات النوافذ والجدران الداخلية
      const wh = h - 0.6;
      for (let i = 0; i < nx; i++) {
        const cx = (xs[i] + xs[i + 1]) / 2;
        for (const z of [-W / 2, W / 2]) {
          this.box('wall', f, sx - 0.4, wh, 0.2, cx, y0, z, 0xc9b7a7);
          if (i % 2 === 0) this.box('window', f, sx * 0.5, 1.4, 0.06, cx, y0 + 1, z + (z < 0 ? -0.14 : 0.14), 0x6ec6ff, 0.75);
          else this.box('facade', f, sx - 0.4, wh, 0.06, cx, y0, z + (z < 0 ? -0.14 : 0.14), 0xd8c3a5);
        }
      }
      for (let j = 0; j < nz; j++) {
        const cz = (zs[j] + zs[j + 1]) / 2;
        for (const x of [-L / 2, L / 2]) {
          this.box('wall', f, 0.2, wh, sz - 0.4, x, y0, cz, 0xc9b7a7);
          if (j % 2 === 1) this.box('window', f, 0.06, 1.4, sz * 0.5, x + (x < 0 ? -0.14 : 0.14), y0 + 1, cz, 0x6ec6ff, 0.75);
          else this.box('facade', f, 0.06, wh, sz - 0.4, x + (x < 0 ? -0.14 : 0.14), y0, cz, 0xd8c3a5);
        }
      }
      const zi = zs[Math.floor(nz / 2)];
      for (let i = 0; i < nx; i++) {
        const cx = (xs[i] + xs[i + 1]) / 2;
        this.box('wall', f, sx - 0.4, wh, 0.15, cx, y0, zi, 0xc9b7a7);
        this.box('door', f, 0.9, 2.1, 0.08, cx, y0, zi + 0.12, 0x8d6e63);
      }
      this.box('floorfinish', f, L - 0.2, 0.04, W - 0.2, 0, y0, 0, 0xd7c8b6);
      this.box('ceiling', f, L - 0.3, 0.03, W - 0.3, 0, y0 + h - 0.85, 0, 0xfafafa, 0.9);
      for (const z of [zs[1], zs[nz - 1]]) this.box('mep', f, L - 1, 0.25, 0.4, 0, y0 + h - 1.15, z, 0x4fc3f7);
      this.box('mep', f, 0.15, 0.15, W - 1, xs[1] + 0.6, y0 + h - 1.05, 0, 0xff8a65);
      for (let i = 0; i < nx; i++) this.box('fixture', f, 0.6, 0.8, 0.5, (xs[i] + xs[i + 1]) / 2, y0, zi - 0.5, 0xffffff);
      // بيت الدرج والمصعد
      this.box('elevator', f, 1.6, h - 0.2, 1.6, xs[nx - 1] + sx / 2, y0, zs[1] - sz / 2, 0x7e57c2);
    }
    this.box('roofwp', floors, L + 0.4, 0.12, W + 0.4, 0, floors * h, 0, 0x546e7a);
    this.box('roofwp', floors, L + 0.4, 1, 0.2, 0, floors * h, -W / 2 - 0.1, 0xb0a090);
    this.box('roofwp', floors, L + 0.4, 1, 0.2, 0, floors * h, W / 2 + 0.1, 0xb0a090);
    // الأعمال الخارجية
    this.box('external', 'P', L + 12, 0.05, 3, 0, 0, -W / 2 - 4, 0x9e9e9e);
    this.box('external', 'P', L + 12, 0.05, 3, 0, 0, W / 2 + 4, 0x9e9e9e);
    for (let i = 0; i < 6; i++) {
      const tree = new THREE.Mesh(new THREE.ConeGeometry(1.2, 3.5, 8), this.mat(0x43a047));
      tree.position.set(-L / 2 + (L * i) / 5, 2, -W / 2 - 6.2);
      tree.updateMatrixWorld();
      this.addElement([tree], 'external', 'P');
    }
    this.floors = floors;
    this.source = 'parametric';
    this.fit();
  }

  // ---------- تحميل ملف IFC ----------
  async loadIFC(buffer, onProgress = () => {}) {
    const WebIFC = await import('../vendor/web-ifc/web-ifc-api.js');
    if (!this.ifc) {
      this.ifc = new WebIFC.IfcAPI();
      this.ifc.SetWasmPath(new URL('../vendor/web-ifc/', import.meta.url).href, true);
      await this.ifc.Init(undefined, true);
    }
    const api = this.ifc;
    const id = api.OpenModel(new Uint8Array(buffer), { COORDINATE_TO_ORIGIN: true });
    this.clear();
    const vec = v => { const a = []; for (let i = 0; i < v.size(); i++) a.push(v.get(i)); return a; };
    // العنصر ← الطابق
    const storeyOf = new Map();
    for (const rid of vec(api.GetLineIDsWithType(id, WebIFC.IFCRELCONTAINEDINSPATIALSTRUCTURE))) {
      const r = api.GetLine(id, rid);
      const s = r.RelatingStructure?.value;
      for (const e of r.RelatedElements || []) storeyOf.set(e.value, s);
    }
    for (let pass = 0; pass < 3; pass++) {
      for (const rid of vec(api.GetLineIDsWithType(id, WebIFC.IFCRELAGGREGATES))) {
        const r = api.GetLine(id, rid);
        const s = storeyOf.get(r.RelatingObject?.value);
        if (s !== undefined) for (const e of r.RelatedObjects || []) if (!storeyOf.has(e.value)) storeyOf.set(e.value, s);
      }
    }
    const storeyIds = vec(api.GetLineIDsWithType(id, WebIFC.IFCBUILDINGSTOREY));
    const storeyName = {};
    for (const s of storeyIds) { const l = api.GetLine(id, s); storeyName[s] = l.Name?.value || l.LongName?.value || `Storey ${s}`; }

    const T = WebIFC;
    const typeCat = new Map([
      [T.IFCWALL, 'wall'], [T.IFCWALLSTANDARDCASE, 'wall'], [T.IFCSLAB, 'slab'], [T.IFCCOLUMN, 'column'],
      [T.IFCBEAM, 'beam'], [T.IFCFOOTING, 'footing'], [T.IFCPILE, 'footing'], [T.IFCDOOR, 'door'], [T.IFCWINDOW, 'window'],
      [T.IFCSTAIR, 'slab'], [T.IFCSTAIRFLIGHT, 'slab'], [T.IFCRAMP, 'slab'], [T.IFCRAMPFLIGHT, 'slab'], [T.IFCRAILING, 'fixture'],
      [T.IFCROOF, 'roofwp'], [T.IFCCOVERING, 'covering'], [T.IFCPLATE, 'facade'], [T.IFCMEMBER, 'facade'],
      [T.IFCCURTAINWALL, 'window'], [T.IFCFLOWSEGMENT, 'mep'], [T.IFCFLOWFITTING, 'mep'], [T.IFCPIPESEGMENT, 'mep'],
      [T.IFCPIPEFITTING, 'mep'], [T.IFCDUCTSEGMENT, 'mep'], [T.IFCDUCTFITTING, 'mep'], [T.IFCCABLESEGMENT, 'mep'],
      [T.IFCCABLECARRIERSEGMENT, 'mep'], [T.IFCFLOWTERMINAL, 'fixture'], [T.IFCSANITARYTERMINAL, 'fixture'],
      [T.IFCLIGHTFIXTURE, 'fixture'], [T.IFCAIRTERMINAL, 'fixture'], [T.IFCFURNISHINGELEMENT, 'fixture'],
      [T.IFCTRANSPORTELEMENT, 'elevator'], [T.IFCBUILDINGELEMENTPROXY, 'proxy'],
    ].filter(([k]) => k !== undefined));
    const skip = new Set([T.IFCOPENINGELEMENT, T.IFCSPACE, T.IFCSITE, T.IFCANNOTATION].filter(Boolean));

    const raw = [];
    let n = 0;
    api.StreamAllMeshes(id, mesh => {
      const eid = mesh.expressID;
      const type = api.GetLineType(id, eid);
      if (skip.has(type)) return;
      const meshes = [];
      const pgs = mesh.geometries;
      for (let i = 0; i < pgs.size(); i++) {
        const pg = pgs.get(i);
        const g = api.GetGeometry(id, pg.geometryExpressID);
        const v = api.GetVertexArray(g.GetVertexData(), g.GetVertexDataSize());
        const ix = api.GetIndexArray(g.GetIndexData(), g.GetIndexDataSize());
        const pos = new Float32Array(v.length / 2), nor = new Float32Array(v.length / 2);
        for (let k = 0, j = 0; k < v.length; k += 6, j += 3) {
          pos[j] = v[k]; pos[j + 1] = v[k + 1]; pos[j + 2] = v[k + 2];
          nor[j] = v[k + 3]; nor[j + 1] = v[k + 4]; nor[j + 2] = v[k + 5];
        }
        const bg = new THREE.BufferGeometry();
        bg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        bg.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
        bg.setIndex(new THREE.BufferAttribute(new Uint32Array(ix), 1));
        const c = pg.color;
        const color = new THREE.Color(c.x, c.y, c.z).getHex();
        const m = new THREE.Mesh(bg, this.mat(color, Math.max(0.25, c.w)));
        m.matrixAutoUpdate = false;
        m.matrix.fromArray(pg.flatTransformation);
        m.updateMatrixWorld(true);
        meshes.push(m);
        g.delete();
      }
      if (!meshes.length) return;
      let cat = typeCat.get(type) || 'proxy';
      if (cat === 'covering') {
        const pt = String(api.GetLine(id, eid).PredefinedType?.value || '');
        cat = pt === 'CEILING' ? 'ceiling' : pt === 'CLADDING' ? 'facade' : pt === 'ROOFING' ? 'roofwp' : 'floorfinish';
      }
      const slabType = cat === 'slab' && type === T.IFCSLAB ? String(api.GetLine(id, eid).PredefinedType?.value || '') : '';
      raw.push({ meshes, cat, eid, storey: storeyOf.get(eid), slabType });
      if (++n % 200 === 0) onProgress(n);
    });
    api.CloseModel(id);

    // حساب منسوب كل طابق من العناصر الرأسية
    const bb = r => { const b = new THREE.Box3(); r.meshes.forEach(m => b.expandByObject(m)); return b; };
    raw.forEach(r => (r.box = bb(r)));
    const base = {};
    for (const r of raw) {
      if (r.storey === undefined || !['wall', 'column'].includes(r.cat)) continue;
      (base[r.storey] ||= []).push(r.box.min.y);
    }
    for (const r of raw) if (r.storey !== undefined && !base[r.storey]) (base[r.storey] ||= []).push(r.box.min.y);
    const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    const storeys = Object.keys(base).map(s => ({ s: +s, y: median(base[s]), vertical: raw.some(r => r.storey === +s && ['wall', 'column'].includes(r.cat)) }))
      .sort((a, b) => a.y - b.y);
    const floorStoreys = storeys.filter(s => s.vertical);
    const floors = Math.max(1, floorStoreys.length);
    const levelOfY = y => { let L = 0; floorStoreys.forEach((s, i) => { if (y >= s.y - 0.4) L = i; }); return L; };
    const groundY = floorStoreys.length ? floorStoreys[0].y : 0;
    const topY = r => r.box.max.y, botY = r => r.box.min.y;

    for (const r of raw) {
      let { cat } = r, level;
      if (cat === 'footing') level = -1;
      else if (botY(r) < groundY - 0.6 && topY(r) <= groundY + 0.3) {
        level = -1;
        cat = { column: 'neck', beam: 'tiebeam', slab: r.slabType === 'BASESLAB' ? 'sog' : 'footing', wall: 'footing' }[cat] || cat;
      } else if (cat === 'slab' || cat === 'beam' || cat === 'roofwp') {
        // البلاطة التي تقع عند قاعدة الطابق هي سقف الطابق الذي تحته
        const t = topY(r);
        let k = 0; storeys.forEach((s, i) => { if (t >= s.y - 0.6) k = i; });
        const st = storeys[k];
        const nearBase = st && Math.abs(t - st.y) < 0.6;
        const fIdx = st ? floorStoreys.findIndex(s => s.s === st.s) : -1;
        let L = fIdx >= 0 ? fIdx : floors;
        if (nearBase) L -= 1;
        if (cat === 'roofwp') level = floors;
        else if (L < 0) { cat = 'sog'; level = -1; }
        else { cat = 'slab'; level = Math.min(L, floors - 1); }
      } else if (cat === 'proxy') {
        cat = 'wall'; level = levelOfY(botY(r));
      } else level = levelOfY(botY(r));
      const el = this.addElement(r.meshes, cat, level, { eid: r.eid, storey: storeyName[r.storey] });
      el.box = r.box;
    }
    this.floors = floors;
    this.source = 'ifc';
    this.fit();
    return { elements: this.elements.length, floors, storeys: storeys.map(s => storeyName[s.s]) };
  }

  // ---------- ربط العناصر بالأنشطة ----------
  link(sched) {
    const floors = this.floors;
    const tasks = sched.tasks;
    const find = (cat, level) => {
      const lv = [level];
      if (level === floors) lv.push(floors - 1);
      for (const c of [cat, ...(CAT_FALLBACK[cat] || [])]) {
        const owners = tasks.filter(t => TRADE[t.trade].cat === c);
        if (!owners.length) continue;
        for (const L of lv) {
          const hit = owners.find(t => t.level === L) || owners.find(t => t.level === 'P');
          if (hit) return hit;
        }
        if (level === 'P') return owners[owners.length - 1];
      }
      return null;
    };
    const painters = tasks.filter(t => TRADE[t.trade].paint);
    const groups = new Map();
    let unlinked = 0;
    for (const el of this.elements) {
      el.mods = []; el._mr = {};
      el.task = find(el.cat, el.level);
      if (!el.task) { unlinked++; continue; }
      el.mods = painters.filter(t => TRADE[t.trade].paint.cat === el.cat && (t.level === el.level || t.level === 'P'))
        .map(t => ({ task: t, color: new THREE.Color(TRADE[t.trade].paint.color).getHex() }))
        .sort((a, b) => a.task.ES - b.task.ES);
      (groups.get(el.task.key) || groups.set(el.task.key, []).get(el.task.key)).push(el);
    }
    // ترتيب العناصر داخل النشاط ليظهر البناء تدريجيًا (من الأسفل ومن جهة إلى أخرى)
    for (const arr of groups.values()) {
      arr.sort((a, b) => a.center.y - b.center.y || a.center.x - b.center.x || a.center.z - b.center.z);
      arr.forEach((e, i) => (e.rank = arr.length > 1 ? i / arr.length : 0));
    }
    // ترتيب المعدلات (اللياسة والدهان) لكل عنصر
    const modGroups = new Map();
    for (const el of this.elements) for (const m of el.mods || []) (modGroups.get(m.task.key) || modGroups.set(m.task.key, []).get(m.task.key)).push(el);
    for (const [key, arr] of modGroups) {
      arr.sort((a, b) => a.center.y - b.center.y || a.center.x - b.center.x);
      arr.forEach((e, i) => { e._mr = e._mr || {}; e._mr[key] = arr.length > 1 ? i / arr.length : 0; });
    }
    this.groups = groups;
    return { linked: this.elements.length - unlinked, unlinked };
  }

  // fracFn(task) => نسبة الإنجاز المعروضة؛ planFn(task) => النسبة المخططة (للمقارنة)
  apply(fracFn, planFn = null) {
    const stats = { active: 0, done: 0, future: 0, delayed: 0 };
    for (const el of this.elements) {
      let mat = null, visible = true;
      if (!el.task) { mat = this.ghost; visible = this.showGhost; }
      else {
        const f = fracFn(el.task);
        const r = el.rank || 0;
        const built = f >= 1 || (f > 0 && f > r);
        const planBuilt = planFn ? (planFn(el.task) >= 1 || (planFn(el.task) > 0 && planFn(el.task) > r)) : built;
        if (built) {
          if (f < 1) { mat = this.stateMat.active; stats.active++; }
          else {
            stats.done++;
            mat = null;
            for (const m of el.mods || []) {
              const mf = fracFn(m.task), mr = el._mr?.[m.task.key] || 0;
              if (mf >= 1 || (mf > 0 && mf > mr)) mat = this.mat(m.color);
            }
          }
        } else if (planBuilt) { mat = this.stateMat.delayed; stats.delayed++; }
        else { mat = this.ghost; visible = this.showGhost; stats.future++; }
      }
      for (const m of el.meshes) { m.visible = visible; m.material = mat || m.userData.orig; }
    }
    return stats;
  }

  snapshot() { this.renderer.render(this.scene, this.camera); return this.renderer.domElement.toDataURL('image/png'); }

  view(name) {
    const b = new THREE.Box3(); this.elements.forEach(e => b.union(e.box));
    if (b.isEmpty()) return;
    const c = b.getCenter(new THREE.Vector3()), r = b.getSize(new THREE.Vector3()).length();
    const dirs = { iso: [1, 0.7, 1.2], front: [0, 0.25, 1.4], side: [1.4, 0.25, 0], top: [0.001, 1.6, 0.001] };
    const d = dirs[name] || dirs.iso;
    this.camera.position.set(c.x + d[0] * r * 0.6, c.y + d[1] * r * 0.6, c.z + d[2] * r * 0.6);
    this.controls.target.copy(c);
  }
}
