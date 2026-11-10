// تشغيل المنصة وربط الواجهة
import { TRADES, TRADE, levelName } from './library.js';
import { readBoqFile, parseRows, SAMPLE_BOQ } from './boq.js';
import { schedule, plannedFrac, toISO, parseISO } from './scheduler.js';
import { Viewer } from './model.js';
import { renderGantt, sCurveSVG, barsSVG, fmtDate, fmtShort, money } from './charts.js';
import { toMSPXML, toExcel, download } from './export.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pct = v => `${(100 * (v || 0)).toFixed(1)}%`;
const UNIT_AR = { m3: 'م³', m2: 'م²', m: 'م.ط', t: 'طن', kg: 'كجم', no: 'عدد', ls: 'مقطوعية' };
const STORE = 'bim4d.project.v1';

const today = () => toISO(new Date());
const defaults = () => ({
  name: '', startDate: today(), floors: 3, weekend: [5], holidays: '',
  building: { L: 30, W: 20, h: 3.5, nx: 5, nz: 4 }, modelSrc: 'parametric',
  items: [], trades: {}, durOverride: {}, progress: {}, dataDate: today(), actualCost: '', history: [],
});

let P = defaults();
let S = null;            // البرنامج الزمني المحسوب
let viewer = null;
let ifcFile = null, ifcLoadedName = null, ifcInfo = null;
let simW = 0, playing = false, simMode = 'plan', pxDay = 5, selectedKey = null;

function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}
function save() { try { localStorage.setItem(STORE, JSON.stringify(P)); } catch { /* المساحة ممتلئة */ } }
function status(el, msg, cls = '') { const e = $(el); e.className = 'status ' + cls; e.innerHTML = msg; }

// ---------- النماذج ----------
function writeForm() {
  $('#projName').value = P.name;
  $('#startDate').value = P.startDate;
  $('#floors').value = P.floors;
  $('#weekend').value = P.weekend.join(',');
  $('#holidays').value = P.holidays;
  $('#bL').value = P.building.L; $('#bW').value = P.building.W; $('#bH').value = P.building.h;
  $('#bNx').value = P.building.nx; $('#bNz').value = P.building.nz;
  $('#dataDate').value = P.dataDate;
  $('#actualCost').value = P.actualCost;
  setModelSrc(P.modelSrc);
}
function readForm() {
  P.name = $('#projName').value.trim();
  P.startDate = $('#startDate').value || today();
  P.floors = Math.max(1, Math.min(40, +$('#floors').value || 1));
  P.weekend = $('#weekend').value ? $('#weekend').value.split(',').map(Number) : [];
  P.holidays = $('#holidays').value;
  P.building = { L: +$('#bL').value || 30, W: +$('#bW').value || 20, h: +$('#bH').value || 3.5, nx: Math.max(1, +$('#bNx').value || 1), nz: Math.max(1, +$('#bNz').value || 1) };
  P.dataDate = $('#dataDate').value || today();
  P.actualCost = $('#actualCost').value;
}
function setModelSrc(src) {
  P.modelSrc = src;
  $$('#modelSrc button').forEach(b => b.classList.toggle('on', b.dataset.src === src));
  $('#srcParametric').classList.toggle('hidden', src !== 'parametric');
  $('#srcIfc').classList.toggle('hidden', src !== 'ifc');
}

function showTab(name) {
  $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  $$('.tab').forEach(t => t.classList.toggle('on', t.id === 'tab-' + name));
  if (name === 'sim') { viewer?.resize(); applySim(); }
  if (name === 'gantt') drawGantt();
}

// ---------- جدول الكميات ----------
function setItems(items, label) {
  P.items = items;
  P.progress = {}; P.history = []; P.durOverride = {};
  const total = items.reduce((s, i) => s + i.amount, 0);
  const other = items.filter(i => i.trade === 'other').length;
  status('#boqStatus', `تمت قراءة <b>${items.length}</b> بندًا من «${esc(label)}» بإجمالي <b>${money(total)}</b>.` +
    (other ? `<br>${other} بند لم يُصنف تلقائيًا، راجعها في تبويب جدول الكميات.` : ''), 'ok');
  // اقتراح عدد الأدوار من وصف البنود
  const lv = items.map(i => i.level).filter(l => typeof l === 'number');
  if (lv.length) { const f = Math.max(...lv) + 1; if (f > P.floors) { P.floors = f; $('#floors').value = f; } }
  save();
  renderBoq();
}

function levelOptions(it) {
  const T = TRADE[it.trade];
  if (!T || T.scope !== 'floor') return '<option value="">—</option>';
  const cur = it.levelOverride ?? '';
  const det = it.level === null || it.level === undefined ? 'كل الأدوار' : it.level === 'roof' ? 'السطح' : it.level === 'top' ? 'الدور الأخير' : levelName(it.level, P.floors);
  let o = `<option value="" ${cur === '' ? 'selected' : ''}>تلقائي (${det})</option><option value="all" ${cur === 'all' ? 'selected' : ''}>توزيع على كل الأدوار</option>`;
  for (let f = 0; f < P.floors; f++) o += `<option value="${f}" ${cur === f ? 'selected' : ''}>${levelName(f, P.floors)}</option>`;
  o += `<option value="roof" ${cur === 'roof' ? 'selected' : ''}>السطح</option>`;
  return o;
}

function renderBoq() {
  const q = $('#boqFilter').value.trim();
  const tradeOpts = TRADES.map(t => `<option value="${t.key}">${t.name}</option>`).join('');
  let h = '<thead><tr><th>البند</th><th>الوصف</th><th>الوحدة</th><th>الكمية</th><th>السعر</th><th>الإجمالي</th><th>النشاط</th><th>المستوى</th><th>استبعاد</th></tr></thead><tbody>';
  for (const it of P.items) {
    if (q && !it.desc.includes(q) && !String(it.code).includes(q)) continue;
    h += `<tr data-id="${it.id}" class="${it.excluded ? 'excluded' : ''}"><td>${esc(it.code)}</td><td>${esc(it.desc)}</td><td>${esc(it.unitRaw || UNIT_AR[it.unit] || it.unit)}</td>` +
      `<td class="n">${it.qty.toLocaleString('en-US')}</td><td class="n">${money(it.rate)}</td><td class="n">${money(it.amount)}</td>` +
      `<td><select data-f="trade">${tradeOpts.replace(`value="${it.trade}"`, `value="${it.trade}" selected`)}</select></td>` +
      `<td><select data-f="level">${levelOptions(it)}</select></td><td><input type="checkbox" data-f="ex" ${it.excluded ? 'checked' : ''}></td></tr>`;
  }
  $('#boqTable').innerHTML = h + '</tbody>';
  const by = {};
  for (const it of P.items) if (!it.excluded) by[it.trade] = (by[it.trade] || 0) + it.amount;
  const tot = Object.values(by).reduce((a, b) => a + b, 0) || 1;
  $('#boqSummary').innerHTML = TRADES.filter(t => by[t.key]).map(t =>
    `<span class="chip ${t.key === 'other' ? 'warn' : ''}">${t.name} <b>${(100 * by[t.key] / tot).toFixed(1)}%</b></span>`).join('');
}

$('#boqTable').addEventListener('change', e => {
  const tr = e.target.closest('tr'); if (!tr) return;
  const it = P.items.find(i => i.id === +tr.dataset.id);
  const f = e.target.dataset.f;
  if (f === 'trade') { it.trade = e.target.value; it.levelOverride = undefined; }
  if (f === 'level') { const v = e.target.value; it.levelOverride = v === '' ? undefined : v === 'all' || v === 'roof' ? v : +v; }
  if (f === 'ex') it.excluded = e.target.checked;
  save(); renderBoq();
});
$('#boqFilter').addEventListener('input', renderBoq);

// ---------- الإنتاجية ----------
function renderRates() {
  const used = new Set(P.items.filter(i => !i.excluded).map(i => i.trade));
  let h = '<thead><tr><th>النشاط</th><th>الإنتاجية اليومية للطاقم</th><th>الطواقم</th><th>مدة ثابتة</th></tr></thead><tbody>';
  for (const T of TRADES) {
    if (T.scope === 'distribute' || T.milestone) continue;
    if (!used.has(T.key) && !['prelim', 'testing'].includes(T.key)) continue;
    const ts = P.trades[T.key] || {};
    const prod = Object.entries(T.prod || {}).filter(([, v]) => v).map(([u, v]) =>
      `<label class="inline"><input class="num" type="number" min="0" step="any" data-t="${T.key}" data-u="${u}" value="${ts.prod?.[u] ?? v}"> ${UNIT_AR[u]}</label>`).join(' ');
    h += `<tr><td>${T.name}</td><td><div class="row">${prod || '<span class="muted">مدة ثابتة</span>'}</div></td>` +
      `<td><input class="num" type="number" min="1" data-t="${T.key}" data-f="crews" value="${ts.crews ?? T.crews ?? 1}"></td>` +
      `<td>${T.fixedDays !== undefined ? `<input class="num" type="number" min="1" data-t="${T.key}" data-f="fixedDays" value="${ts.fixedDays ?? T.fixedDays}">` : ''}</td></tr>`;
  }
  $('#ratesTable').innerHTML = h + '</tbody>';
  if (!S) { $('#durTable').innerHTML = ''; return; }
  let d = '<thead><tr><th>#</th><th>النشاط</th><th>الكمية الحاكمة</th><th>المدة المحسوبة</th><th>مدة يدوية</th></tr></thead><tbody>';
  for (const t of S.tasks) {
    if (t.milestone) continue;
    const drv = t.driver ? `${t.driver.qty.toLocaleString('en-US', { maximumFractionDigits: 1 })} ${UNIT_AR[t.driver.unit]}` : 'مدة ثابتة';
    d += `<tr><td>${t.id}</td><td>${esc(t.fullName)}</td><td class="n">${drv}</td><td>${t.dur}</td><td><input class="num" type="number" min="1" data-k="${t.key}" value="${P.durOverride[t.key] ?? ''}"></td></tr>`;
  }
  $('#durTable').innerHTML = d + '</tbody>';
}
$('#ratesTable').addEventListener('change', e => {
  const i = e.target, k = i.dataset.t; if (!k) return;
  const ts = (P.trades[k] ||= {});
  if (i.dataset.u) (ts.prod ||= {})[i.dataset.u] = +i.value;
  else ts[i.dataset.f] = +i.value;
  save();
});
$('#durTable').addEventListener('change', e => {
  const k = e.target.dataset.k; if (!k) return;
  if (+e.target.value > 0) P.durOverride[k] = +e.target.value; else delete P.durOverride[k];
  save();
});

// ---------- التوليد ----------
async function generate({ silent = false } = {}) {
  readForm();
  if (!P.items.length) { status('#genStatus', 'ارفع جدول الكميات أولًا أو حمّل المشروع التجريبي.', 'err'); return false; }
  status('#genStatus', 'جاري التحليل...');
  try {
    if (!viewer) viewer = new Viewer($('#viewer'));
    if (P.modelSrc === 'ifc' && ifcFile) {
      if (ifcLoadedName !== ifcFile.name) {
        status('#ifcStatus', 'جاري قراءة النموذج...');
        ifcInfo = await viewer.loadIFC(await ifcFile.arrayBuffer(), n => status('#ifcStatus', `تمت قراءة ${n} عنصر...`));
        ifcLoadedName = ifcFile.name;
        status('#ifcStatus', `النموذج: ${ifcInfo.elements} عنصر · ${ifcInfo.floors} دور (${ifcInfo.storeys.map(esc).join('، ')})`, 'ok');
      }
      P.floors = ifcInfo.floors; $('#floors').value = P.floors;
    } else {
      if (P.modelSrc === 'ifc') toast('لم يُرفع ملف IFC، استُخدم النموذج التلقائي.');
      viewer.buildParametric({ ...P.building, floors: P.floors });
      ifcLoadedName = null;
    }
    S = schedule(P.items, { startDate: P.startDate, floors: P.floors, weekend: P.weekend, holidays: P.holidays, trades: P.trades, durOverride: P.durOverride });
    const lk = viewer.link(S);
    $('#linkStatus').textContent = `عناصر مرتبطة بالأنشطة: ${lk.linked}` + (lk.unlinked ? ` · غير مرتبطة: ${lk.unlinked}` : '');
    $('#slider').max = S.duration;
    simW = Math.min(simW, S.duration);
    save();
    renderBoq(); renderRates(); drawGantt(); renderSchedKpis(); renderTrack(); applySim();
    status('#genStatus', `تم توليد ${S.tasks.length} نشاطًا. مدة المشروع ${S.duration} يوم عمل، من ${fmtDate(S.start)} إلى ${fmtDate(S.finish)}.`, 'ok');
    if (!silent) showTab('gantt');
    return true;
  } catch (err) {
    console.error(err);
    status('#genStatus', 'تعذر التوليد: ' + esc(err.message), 'err');
    return false;
  }
}

function renderSchedKpis() {
  const crit = S.tasks.filter(t => t.critical && !t.milestone).length;
  const months = (S.finish - S.start) / (30.44 * 86400000);
  $('#kpiSched').innerHTML = [
    ['البداية', fmtShort(S.start)], ['النهاية', fmtShort(S.finish)], ['المدة', `${S.duration} يوم عمل`],
    ['بالأشهر', months.toFixed(1)], ['عدد الأنشطة', S.tasks.length], ['الأنشطة الحرجة', crit], ['قيمة الأعمال', money(S.bac)],
  ].map(([a, b]) => `<div class="kpi"><span>${a}</span><b>${b}</b></div>`).join('');
}

function drawGantt() {
  if (!S) return;
  renderGantt($('#gantt'), S, {
    pxDay, progress: P.progress, dataDate: parseISO(P.dataDate), cursorDate: simW > 0 ? S.cal.date(simW) : null,
    showLinks: $('#showLinks').checked,
    onSelect: key => {
      selectedKey = key;
      const t = S.tasks.find(x => x.key === key);
      $$('#gantt tr.sel').forEach(r => r.classList.remove('sel'));
      $$(`#gantt tr[data-key="${CSS.escape(key)}"]`).forEach(r => r.classList.add('sel'));
      simW = t.ES + t.dur / 2;
      toast(`${t.fullName}: ${fmtShort(t.start)} ← ${fmtShort(t.finish)} · السماح ${t.TF} يوم`);
    },
  });
}

// ---------- المحاكاة ----------
function wAtDataDate() {
  const d = parseISO(P.dataDate);
  return S.cal.index(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1));
}
function applySim() {
  if (!S || !viewer) return;
  let stats, date, planP;
  if (simMode === 'actual') {
    const w = wAtDataDate();
    stats = viewer.apply(t => (P.progress[t.key]?.pct || 0) / 100, t => plannedFrac(t, w));
    date = parseISO(P.dataDate);
    planP = S.tasks.reduce((s, t) => s + t.cost * (P.progress[t.key]?.pct || 0) / 100, 0) / (S.bac || 1);
    $('#slider').value = w;
  } else {
    stats = viewer.apply(t => plannedFrac(t, simW));
    date = S.cal.date(Math.min(simW, S.duration - 0.001));
    planP = S.tasks.reduce((s, t) => s + t.cost * plannedFrac(t, simW), 0) / (S.bac || 1);
    $('#slider').value = simW;
  }
  const w = simMode === 'actual' ? wAtDataDate() : simW;
  const active = S.tasks.filter(t => {
    const f = simMode === 'actual' ? (P.progress[t.key]?.pct || 0) / 100 : plannedFrac(t, w);
    return f > 0 && f < 1;
  });
  $('#simDate').textContent = fmtDate(date);
  $('#simOverlay').innerHTML = `<div class="d">${fmtDate(date)}</div>` +
    `<div>اليوم ${Math.floor(w)} من ${S.duration}</div>` +
    `<div>${simMode === 'actual' ? 'الإنجاز الفعلي' : 'الإنجاز المخطط'}: <b>${pct(planP)}</b></div>` +
    `<div>أنشطة جارية: <b>${active.length}</b>${stats.delayed ? ` · عناصر متأخرة: <b style="color:#e53935">${stats.delayed}</b>` : ''}</div>`;
  $('#activeList').innerHTML = active.length ? active.map(t => {
    const f = simMode === 'actual' ? (P.progress[t.key]?.pct || 0) / 100 : plannedFrac(t, w);
    return `<div class="it"><div>${esc(t.fullName)}</div><div class="pb"><i style="width:${f * 100}%;background:${t.critical ? '#e53935' : ''}"></i></div></div>`;
  }).join('') : '<p class="muted">لا توجد أنشطة جارية في هذا التاريخ.</p>';
}

let lastT = 0, recorder = null, recCanvas = null;
function tick(ts) {
  if (!playing) return;
  const dt = lastT ? (ts - lastT) / 1000 : 0; lastT = ts;
  simW += dt * (+$('#speed').value) * S.duration / 60;
  if (simW >= S.duration) { simW = S.duration; playing = false; $('#btnPlay').textContent = 'تشغيل'; if (recorder) recorder.stop(); }
  applySim();
  if (recorder) compositeFrame();
  if (playing) requestAnimationFrame(tick);
}
function play() {
  if (!S) return;
  if (simMode !== 'plan') setSimMode('plan');
  if (simW >= S.duration) simW = 0;
  playing = !playing;
  $('#btnPlay').textContent = playing ? 'إيقاف' : 'تشغيل';
  lastT = 0;
  if (playing) requestAnimationFrame(tick);
}
function setSimMode(m) {
  simMode = m;
  $$('#simMode button').forEach(b => b.classList.toggle('on', b.dataset.m === m));
  $('#slider').disabled = m === 'actual';
  applySim();
}
function compositeFrame() {
  const src = viewer.renderer.domElement;
  const ctx = recCanvas.getContext('2d');
  ctx.drawImage(src, 0, 0, recCanvas.width, recCanvas.height);
  const date = S.cal.date(Math.min(simW, S.duration - 0.001));
  const pv = S.tasks.reduce((s, t) => s + t.cost * plannedFrac(t, simW), 0) / (S.bac || 1);
  ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.fillRect(recCanvas.width - 330, 16, 314, 78);
  ctx.fillStyle = '#0b3d55'; ctx.font = 'bold 22px Tahoma'; ctx.textAlign = 'right'; ctx.direction = 'rtl';
  ctx.fillText(fmtDate(date), recCanvas.width - 30, 48);
  ctx.font = '16px Tahoma'; ctx.fillStyle = '#37474f';
  ctx.fillText(`الإنجاز المخطط ${pct(pv)} · ${P.name || 'المشروع'}`, recCanvas.width - 30, 78);
}
function record() {
  if (!S || recorder) return;
  const src = viewer.renderer.domElement;
  recCanvas = document.createElement('canvas');
  recCanvas.width = src.width; recCanvas.height = src.height;
  const stream = recCanvas.captureStream(30);
  const type = ['video/webm;codecs=vp9', 'video/webm', 'video/mp4'].find(t => window.MediaRecorder?.isTypeSupported(t));
  if (!type) { toast('المتصفح لا يدعم تسجيل الفيديو.'); return; }
  const chunks = [];
  recorder = new MediaRecorder(stream, { mimeType: type });
  recorder.ondataavailable = e => e.data.size && chunks.push(e.data);
  recorder.onstop = () => {
    download(`${P.name || 'project'}-4D.${type.includes('mp4') ? 'mp4' : 'webm'}`, new Blob(chunks, { type }));
    recorder = null; $('#btnRec').textContent = 'تسجيل فيديو';
  };
  recorder.start();
  $('#btnRec').textContent = 'جاري التسجيل...';
  simW = 0; playing = false; play();
}

// ---------- المتابعة ----------
function evm() {
  const w = wAtDataDate();
  const bac = S.bac || 1;
  const pv = S.tasks.reduce((s, t) => s + t.cost * plannedFrac(t, w), 0);
  const ev = S.tasks.reduce((s, t) => s + t.cost * (P.progress[t.key]?.pct || 0) / 100, 0);
  const ac = +P.actualCost || 0;
  const spi = pv ? ev / pv : 1, cpi = ac ? ev / ac : null;
  let forecastFinish = null;
  if (ev > 0 && spi > 0) forecastFinish = toISO(S.cal.date(Math.max(w, Math.round(S.duration / spi)) - 1));
  return { dataDate: P.dataDate, w, bac, pv, ev, ac, spi, cpi, eac: cpi ? bac / cpi : null, planPct: pv / bac, actPct: ev / bac, forecastFinish };
}

function taskStatus(t, w) {
  const a = (P.progress[t.key]?.pct || 0) / 100, p = plannedFrac(t, w);
  if (a >= 1) return ['منجز', 'good'];
  if (a + 0.05 < p) return ['متأخر', 'bad'];
  if (a > p + 0.05) return ['متقدم', 'good'];
  if (a > 0) return ['جاري', ''];
  return [p > 0 ? 'متأخر' : 'لم يبدأ', p > 0 ? 'bad' : ''];
}

function phaseRows(w) {
  const ph = {};
  for (const t of S.tasks) {
    const r = (ph[t.phase] ||= { label: t.phase, cost: 0, p: 0, a: 0 });
    r.cost += t.cost; r.p += t.cost * plannedFrac(t, w); r.a += t.cost * (P.progress[t.key]?.pct || 0) / 100;
  }
  return Object.values(ph).filter(r => r.cost > 0).map(r => ({ ...r, plan: r.p / r.cost, actual: r.a / r.cost }));
}

function kpiCls(v, good = 0.98, bad = 0.9) { return v === null ? '' : v >= good ? 'good' : v < bad ? 'bad' : 'mid'; }

function renderTrack() {
  if (!S) return;
  const E = evm();
  $('#kpiTrack').innerHTML = [
    ['الإنجاز المخطط', pct(E.planPct), ''], ['الإنجاز الفعلي', pct(E.actPct), kpiCls(E.actPct / (E.planPct || 1))],
    ['الانحراف', `${(100 * (E.actPct - E.planPct)).toFixed(1)}`, E.actPct >= E.planPct ? 'good' : 'bad'],
    ['القيمة المخططة PV', money(E.pv), ''], ['القيمة المكتسبة EV', money(E.ev), ''],
    ['مؤشر الجدول SPI', E.spi.toFixed(2), kpiCls(E.spi)], ['مؤشر التكلفة CPI', E.cpi ? E.cpi.toFixed(2) : '—', kpiCls(E.cpi)],
    ['الانتهاء المتوقع', E.forecastFinish || fmtShort(S.finish), E.forecastFinish && E.forecastFinish > toISO(S.finish) ? 'bad' : ''],
  ].map(([a, b, c]) => `<div class="kpi ${c}"><span>${a}</span><b>${b}</b></div>`).join('');
  $('#scurve').innerHTML = sCurveSVG(S, P.history, parseISO(P.dataDate));
  $('#phaseBars').innerHTML = barsSVG(phaseRows(E.w));
  const q = $('#trackFilter').value.trim();
  let h = '<thead><tr><th>#</th><th>النشاط</th><th>البداية</th><th>النهاية</th><th>الوزن</th><th>المخطط</th><th>الفعلي %</th><th>الانحراف</th><th>الحالة</th></tr></thead><tbody>';
  for (const t of S.tasks) {
    if (q && !t.fullName.includes(q)) continue;
    const p = plannedFrac(t, E.w), a = (P.progress[t.key]?.pct || 0) / 100;
    const [st, cls] = taskStatus(t, E.w);
    h += `<tr class="${cls === 'bad' ? 'late' : ''}"><td>${t.id}</td><td>${esc(t.fullName)}${t.critical ? ' <span style="color:#e53935">●</span>' : ''}</td><td class="n">${fmtShort(t.start)}</td><td class="n">${fmtShort(t.finish)}</td>` +
      `<td class="n">${(100 * t.cost / (S.bac || 1)).toFixed(2)}%</td><td class="n">${Math.round(p * 100)}%</td>` +
      `<td><input class="num" type="number" min="0" max="100" step="1" data-k="${t.key}" value="${P.progress[t.key]?.pct ?? ''}"></td>` +
      `<td class="n" style="color:${a < p ? '#e53935' : '#2e9d57'}">${Math.round((a - p) * 100)}</td><td>${st}</td></tr>`;
  }
  $('#trackTable').innerHTML = h + '</tbody>';
}
$('#trackTable').addEventListener('change', e => {
  const k = e.target.dataset.k; if (!k) return;
  const v = Math.max(0, Math.min(100, +e.target.value || 0));
  if (e.target.value === '') delete P.progress[k]; else P.progress[k] = { pct: v };
  save(); renderTrack(); if (simMode === 'actual') applySim();
});
$('#trackFilter').addEventListener('input', renderTrack);
['#dataDate', '#actualCost'].forEach(s => $(s).addEventListener('change', () => { readForm(); save(); renderTrack(); drawGantt(); applySim(); }));

function recordUpdate() {
  if (!S) return;
  readForm();
  const E = evm();
  P.history = P.history.filter(h => h.date !== P.dataDate);
  P.history.push({ date: P.dataDate, pv: E.pv, ev: E.ev, ac: E.ac || null, progress: JSON.parse(JSON.stringify(P.progress)) });
  P.history.sort((a, b) => a.date.localeCompare(b.date));
  save(); renderTrack();
  toast('تم اعتماد تحديث الإنجاز بتاريخ ' + P.dataDate);
}

// ---------- التقرير ----------
function report() {
  if (!S) return;
  readForm();
  const E = evm(), w = E.w;
  const behind = E.actPct + 0.005 < E.planPct;
  const late = S.tasks.filter(t => !t.milestone && taskStatus(t, w)[0] === 'متأخر')
    .map(t => ({ t, gap: plannedFrac(t, w) - (P.progress[t.key]?.pct || 0) / 100 })).sort((a, b) => b.gap - a.gap);
  const horizon = w + 26;
  const look = S.tasks.filter(t => !t.milestone && t.ES <= horizon && t.EF >= w && (P.progress[t.key]?.pct || 0) < 100).sort((a, b) => a.ES - b.ES);
  // صور المحاكاة: المخطط والفعلي عند تاريخ البيانات
  const keep = { mode: simMode, w: simW };
  viewer.view('iso');
  viewer.apply(t => plannedFrac(t, w));
  const imgPlan = viewer.snapshot();
  viewer.apply(t => (P.progress[t.key]?.pct || 0) / 100, t => plannedFrac(t, w));
  const imgAct = viewer.snapshot();
  simMode = keep.mode; simW = keep.w; applySim();

  const state = E.ev === 0 ? 'لم تُسجَّل نسب إنجاز بعد' : behind ? 'متأخر عن الخطة' : E.actPct > E.planPct + 0.005 ? 'متقدم على الخطة' : 'وفق الخطة';
  const k = (a, b, c = '') => `<div><span>${a}</span><b class="${c}">${b}</b></div>`;
  const rec = [];
  if (behind) rec.push(`تسريع الأنشطة الحرجة المتأخرة بزيادة الطواقم أو ساعات العمل، وأولها: ${late.filter(x => x.t.critical).slice(0, 3).map(x => esc(x.t.fullName)).join('، ') || esc(late[0]?.t.fullName || '')}.`);
  if (E.cpi && E.cpi < 0.95) rec.push('مراجعة التكاليف الفعلية مقابل المكتسبة، فمؤشر أداء التكلفة أقل من 0.95.');
  if (E.forecastFinish && E.forecastFinish > toISO(S.finish)) rec.push(`بالمعدل الحالي يتوقع الانتهاء في ${E.forecastFinish} بدل ${toISO(S.finish)}. يلزم برنامج استدراك.`);
  if (!rec.length) rec.push('الاستمرار بالمعدل الحالي ومتابعة الأنشطة الحرجة القادمة خلال الشهر.');

  $('#printArea').innerHTML = `<div class="rep">
  <div class="rh"><div><h1>تقرير متابعة المشروع</h1><div>${esc(P.name || 'المشروع')}</div></div>
  <div style="text-align:left">تاريخ البيانات: <b>${fmtDate(parseISO(P.dataDate))}</b><br>تاريخ الإصدار: ${fmtDate(new Date())}</div></div>
  <h2>الملخص التنفيذي</h2>
  <div class="note">بلغت نسبة الإنجاز الفعلية <b dir="ltr">${pct(E.actPct)}</b> مقابل <b dir="ltr">${pct(E.planPct)}</b> مخططة، أي بانحراف <b dir="ltr" class="${behind ? 'bad' : 'good'}">${(100 * (E.actPct - E.planPct)).toFixed(1)}</b> نقطة. الوضع العام: <b>${state}</b>.
  مؤشر أداء الجدول ${E.spi.toFixed(2)}${E.cpi ? ` ومؤشر أداء التكلفة ${E.cpi.toFixed(2)}` : ''}. تاريخ الانتهاء التعاقدي ${fmtDate(S.finish)}${E.forecastFinish ? ` والمتوقع ${fmtDate(parseISO(E.forecastFinish))}` : ''}.</div>
  <h2>مؤشرات الأداء</h2>
  <div class="kgrid">${k('قيمة الأعمال BAC', money(E.bac))}${k('القيمة المخططة PV', money(E.pv))}${k('القيمة المكتسبة EV', money(E.ev))}${k('التكلفة الفعلية AC', E.ac ? money(E.ac) : '—')}
  ${k('الإنجاز المخطط', pct(E.planPct))}${k('الإنجاز الفعلي', pct(E.actPct), behind ? 'bad' : 'good')}${k('SPI', E.spi.toFixed(2), E.spi < 0.95 ? 'bad' : 'good')}${k('CPI', E.cpi ? E.cpi.toFixed(2) : '—', E.cpi && E.cpi < 0.95 ? 'bad' : 'good')}
  ${k('البداية', fmtShort(S.start))}${k('النهاية المخططة', fmtShort(S.finish))}${k('النهاية المتوقعة', E.forecastFinish || '—')}${k('المدة', S.duration + ' يوم عمل')}</div>
  <h2>منحنى S</h2>${sCurveSVG(S, P.history, parseISO(P.dataDate), 760, 260)}
  <h2>المحاكاة رباعية الأبعاد عند تاريخ البيانات</h2>
  <div class="shots"><div><img src="${imgPlan}"><p>الوضع المخطط</p></div><div><img src="${imgAct}"><p>الوضع الفعلي (الأحمر متأخر)</p></div></div>
  <h2 class="page-break">الإنجاز حسب المرحلة</h2>
  <table><tr><th>المرحلة</th><th>القيمة</th><th>الوزن</th><th>المخطط</th><th>الفعلي</th><th>الانحراف</th></tr>
  ${phaseRows(w).map(r => `<tr><td>${esc(r.label)}</td><td class="n">${money(r.cost)}</td><td class="n">${pct(r.cost / E.bac)}</td><td class="n">${pct(r.plan)}</td><td class="n">${pct(r.actual)}</td><td class="n ${r.actual + 0.005 < r.plan ? 'bad' : 'good'}">${(100 * (r.actual - r.plan)).toFixed(1)}</td></tr>`).join('')}</table>
  <h2>الأنشطة المتأخرة</h2>
  ${late.length ? `<table><tr><th>#</th><th>النشاط</th><th>النهاية المخططة</th><th>المخطط</th><th>الفعلي</th><th>حرج</th></tr>
  ${late.slice(0, 25).map(({ t }) => `<tr><td>${t.id}</td><td>${esc(t.fullName)}</td><td class="n">${fmtShort(t.finish)}</td><td class="n">${Math.round(plannedFrac(t, w) * 100)}%</td><td class="n">${P.progress[t.key]?.pct || 0}%</td><td>${t.critical ? '<b class="bad">نعم</b>' : ''}</td></tr>`).join('')}</table>` : '<p>لا توجد أنشطة متأخرة.</p>'}
  <h2>أنشطة الشهر القادم</h2>
  <table><tr><th>#</th><th>النشاط</th><th>البداية</th><th>النهاية</th><th>السماح</th></tr>
  ${look.slice(0, 25).map(t => `<tr><td>${t.id}</td><td>${esc(t.fullName)}</td><td class="n">${fmtShort(t.start)}</td><td class="n">${fmtShort(t.finish)}</td><td class="n ${t.critical ? 'bad' : ''}">${t.TF}</td></tr>`).join('')}</table>
  <h2>التوصيات</h2><div class="note">${rec.map(r => '• ' + r).join('<br>')}</div>
  </div>`;
  document.body.classList.add('printing');
  setTimeout(() => window.print(), 300);
}
window.addEventListener('afterprint', () => document.body.classList.remove('printing'));

// ---------- الأحداث ----------
$$('#tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
$$('#modelSrc button').forEach(b => b.addEventListener('click', () => { setModelSrc(b.dataset.src); save(); }));
$$('#zoom button').forEach(b => b.addEventListener('click', () => {
  pxDay = +b.dataset.z; $$('#zoom button').forEach(x => x.classList.toggle('on', x === b)); drawGantt();
}));
$('#showLinks').addEventListener('change', drawGantt);
$$('#simMode button').forEach(b => b.addEventListener('click', () => setSimMode(b.dataset.m)));
$$('.views button').forEach(b => b.addEventListener('click', () => viewer?.view(b.dataset.v)));
$('#ghostToggle').addEventListener('change', e => { if (viewer) { viewer.showGhost = e.target.checked; applySim(); } });
$('#slider').addEventListener('input', e => { simW = +e.target.value; applySim(); });
$('#btnPlay').addEventListener('click', play);
$('#btnRec').addEventListener('click', record);
$('#btnShot').addEventListener('click', () => viewer && download(`${P.name || 'project'}-4D-${toISO(S.cal.date(simW))}.png`, dataURLtoBlob(viewer.snapshot())));
$('#btnGenerate').addEventListener('click', () => generate());
$('#btnRegen1').addEventListener('click', () => generate({ silent: true }).then(ok => ok && toast('تم تحديث البرنامج الزمني')));
$('#btnRegen2').addEventListener('click', () => generate({ silent: true }).then(ok => ok && toast('تم تحديث البرنامج الزمني')));
$('#btnRecord').addEventListener('click', recordUpdate);
$('#btnReport').addEventListener('click', report);
$('#btnAutoPlan').addEventListener('click', () => {
  if (!S) return;
  const w = wAtDataDate();
  for (const t of S.tasks) { const p = Math.round(plannedFrac(t, w) * 100); if (p > 0) P.progress[t.key] = { pct: p }; else delete P.progress[t.key]; }
  save(); renderTrack(); toast('عُبئت النسب الفعلية بالنسب المخططة. عدّل الأنشطة المختلفة فقط.');
});
$('#btnMsp').addEventListener('click', () => S && download(`${P.name || 'project'}.xml`, toMSPXML(S, P, P.progress), 'application/xml'));
$('#btnXlsx').addEventListener('click', () => S && download(`${P.name || 'project'}-schedule.xlsx`, toExcel(S, P, P.items, P.progress, evm())));
$('#btnSave').addEventListener('click', () => { readForm(); save(); download(`${P.name || 'project'}.4d.json`, JSON.stringify(P, null, 1), 'application/json'); });
$('#fileProject').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  try { P = { ...defaults(), ...JSON.parse(await f.text()) }; writeForm(); renderBoq(); save(); await generate({ silent: true }); toast('تم فتح المشروع'); }
  catch { toast('ملف المشروع غير صالح'); }
  e.target.value = '';
});
$('#projName').addEventListener('change', () => { P.name = $('#projName').value.trim(); save(); });
['#startDate', '#floors', '#weekend', '#holidays', '#bL', '#bW', '#bH', '#bNx', '#bNz'].forEach(s => $(s).addEventListener('change', () => { readForm(); save(); }));

function dataURLtoBlob(u) {
  const [h, b] = u.split(','); const bin = atob(b); const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return new Blob([a], { type: h.match(/:(.*?);/)[1] });
}

async function onBoqFile(f) {
  if (!f) return;
  try { setItems(await readBoqFile(f), f.name); } catch (err) { status('#boqStatus', esc(err.message), 'err'); }
}
$('#fileBoq').addEventListener('change', e => onBoqFile(e.target.files[0]));
$('#fileIfc').addEventListener('change', e => {
  ifcFile = e.target.files[0] || null;
  if (ifcFile) { setModelSrc('ifc'); status('#ifcStatus', `تم اختيار ${esc(ifcFile.name)} (${(ifcFile.size / 1048576).toFixed(1)} ميجابايت). اضغط توليد البرنامج.`, 'ok'); }
});
for (const id of ['#dropBoq', '#dropIfc']) {
  const d = $(id);
  d.addEventListener('dragover', () => d.classList.add('over'));
  d.addEventListener('dragleave', () => d.classList.remove('over'));
  d.addEventListener('drop', () => d.classList.remove('over'));
}
$('#btnSample').addEventListener('click', async () => {
  P = { ...defaults(), name: 'مبنى سكني - ثلاثة أدوار (تجريبي)', floors: 3 };
  const d = new Date(); d.setDate(d.getDate() - 120);
  P.startDate = toISO(d);
  writeForm();
  setItems(parseRows(SAMPLE_BOQ), 'المشروع التجريبي');
  await generate();
});
$('#btnTemplate').addEventListener('click', () => {
  const XLSX = window.XLSX; const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(SAMPLE_BOQ); ws['!cols'] = [{ wch: 9 }, { wch: 55 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 14 }]; ws['!views'] = [{ RTL: true }];
  XLSX.utils.book_append_sheet(wb, ws, 'جدول الكميات');
  download('قالب-جدول-الكميات.xlsx', new Blob([XLSX.write(wb, { bookType: 'xlsx', type: 'array' })]));
});

// ---------- البدء ----------
try { const s = JSON.parse(localStorage.getItem(STORE) || 'null'); if (s) P = { ...defaults(), ...s }; } catch { /* تجاهل */ }
writeForm();
renderBoq();
if (P.items.length) {
  status('#boqStatus', `${P.items.length} بندًا محفوظًا من الجلسة السابقة.`, 'ok');
  if (P.modelSrc === 'ifc') status('#ifcStatus', 'أعد رفع ملف IFC لعرضه، فالنموذج لا يُحفظ في المتصفح.');
  generate({ silent: true });
}
window.__app = { get S() { return S; }, get P() { return P; }, get viewer() { return viewer; }, generate, showTab };
