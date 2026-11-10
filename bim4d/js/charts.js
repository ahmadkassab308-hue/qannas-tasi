// مخطط جانت ومنحنى S
import { plannedFrac, toISO } from './scheduler.js';

const DAY = 86400000;
const AR_MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
export const fmtDate = d => (d ? `${d.getDate()} ${AR_MONTHS[d.getMonth()]} ${d.getFullYear()}` : '');
export const fmtShort = d => (d ? toISO(d) : '');
export const money = v => Math.round(v || 0).toLocaleString('en-US');
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function renderGantt(el, sched, opts = {}) {
  const { pxDay = 6, progress = {}, dataDate = null, cursorDate = null, showLinks = true, onSelect } = opts;
  const RH = 26, HEAD = 46;
  const start = new Date(sched.start.getFullYear(), sched.start.getMonth(), 1);
  const end = new Date(sched.finish.getFullYear(), sched.finish.getMonth() + 1, 1);
  const days = Math.round((end - start) / DAY);
  const W = days * pxDay;
  const x = d => Math.round(((d - start) / DAY) * pxDay);

  const rows = [];
  let phase = null;
  for (const t of sched.tasks) {
    if (t.phase !== phase) { phase = t.phase; rows.push({ phase }); }
    rows.push({ t });
  }
  const H = HEAD + rows.length * RH;
  const rowY = new Map();
  rows.forEach((r, i) => r.t && rowY.set(r.t.key, HEAD + i * RH));

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="Tahoma, Arial" font-size="11" direction="ltr">`;
  // الشهور والأسابيع
  for (let m = new Date(start); m < end; m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) {
    const x0 = x(m), x1 = x(new Date(m.getFullYear(), m.getMonth() + 1, 1));
    svg += `<rect x="${x0}" y="0" width="${x1 - x0}" height="22" fill="${m.getMonth() % 2 ? '#e8eef3' : '#dde6ed'}"/>`;
    svg += `<text x="${(x0 + x1) / 2}" y="15" text-anchor="middle" fill="#263238">${AR_MONTHS[m.getMonth()]} ${m.getFullYear()}</text>`;
    svg += `<line x1="${x0}" y1="0" x2="${x0}" y2="${H}" stroke="#cfd8dc"/>`;
  }
  if (pxDay >= 3) {
    for (let d = new Date(start); d < end; d = new Date(d.getTime() + 7 * DAY)) {
      svg += `<text x="${x(d) + 2}" y="38" fill="#78909c" font-size="9">${d.getDate()}</text>`;
      svg += `<line x1="${x(d)}" y1="24" x2="${x(d)}" y2="${H}" stroke="#eceff1"/>`;
    }
  }
  rows.forEach((r, i) => {
    const y = HEAD + i * RH;
    if (r.phase) svg += `<rect x="0" y="${y}" width="${W}" height="${RH}" fill="#f1f5f8"/>`;
  });
  // خطوط العلاقات
  if (showLinks) {
    const map = new Map(sched.tasks.map(t => [t.key, t]));
    for (const l of sched.links) {
      const a = map.get(l.from), b = map.get(l.to);
      if (!a || !b || b.trade === 'handover') continue;
      const ya = rowY.get(a.key) + RH / 2, yb = rowY.get(b.key) + RH / 2;
      const xa = l.type === 'SS' ? x(a.start) : x(a.finish) + pxDay;
      const xb = x(b.start);
      const col = a.critical && b.critical ? '#e57373' : '#90a4ae';
      svg += `<path d="M${xa},${ya} H${Math.max(xa + 4, Math.min(xb - 4, xa + 8))} V${yb} H${xb - 1}" fill="none" stroke="${col}" stroke-width="0.8" marker-end="url(#ar)"/>`;
    }
  }
  svg += `<defs><marker id="ar" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="#78909c"/></marker></defs>`;
  // الأشرطة
  rows.forEach((r, i) => {
    if (!r.t) return;
    const t = r.t, y = HEAD + i * RH;
    const x0 = x(t.start), x1 = x(t.finish) + pxDay;
    const pct = (progress[t.key]?.pct || 0) / 100;
    if (t.milestone) {
      const c = x0, m = y + RH / 2;
      svg += `<path d="M${c},${m - 7} L${c + 7},${m} L${c},${m + 7} L${c - 7},${m} z" fill="#212121"/>`;
      svg += `<text x="${c + 11}" y="${m + 4}" fill="#212121">${fmtShort(t.start)}</text>`;
      return;
    }
    const col = t.critical ? '#e53935' : '#1e88e5';
    svg += `<g class="bar" data-key="${t.key}" style="cursor:pointer"><rect x="${x0}" y="${y + 6}" width="${Math.max(2, x1 - x0)}" height="${RH - 12}" rx="3" fill="${col}" opacity="0.35"/>`;
    if (pct > 0) svg += `<rect x="${x0}" y="${y + 6}" width="${Math.max(1, (x1 - x0) * pct)}" height="${RH - 12}" rx="3" fill="${col}"/>`;
    svg += `<title>${esc(t.fullName)}\n${fmtShort(t.start)} ← ${fmtShort(t.finish)}\nالمدة ${t.dur} يوم عمل · السماح ${t.TF}</title></g>`;
    if (pxDay >= 2) svg += `<text x="${x1 + 4}" y="${y + 17}" fill="#546e7a" font-size="10">${pct ? Math.round(pct * 100) + '%' : ''}</text>`;
  });
  const vline = (d, color, label) => {
    if (!d) return '';
    const xx = x(d);
    return `<line x1="${xx}" y1="22" x2="${xx}" y2="${H}" stroke="${color}" stroke-width="2" stroke-dasharray="5 3"/>` +
      `<rect x="${xx - 34}" y="23" width="68" height="14" rx="3" fill="${color}"/><text x="${xx}" y="34" fill="#fff" text-anchor="middle" font-size="9">${label}</text>`;
  };
  svg += vline(dataDate, '#d81b60', 'تاريخ البيانات');
  svg += vline(cursorDate, '#2e7d32', 'المحاكاة');
  svg += '</svg>';

  // جدول الأنشطة
  let tbl = `<table class="gtable"><thead><tr style="height:${HEAD}px"><th>#</th><th>النشاط</th><th>المدة</th><th>البداية</th><th>النهاية</th><th>السماح</th><th>الإنجاز</th></tr></thead><tbody>`;
  for (const r of rows) {
    if (r.phase) { tbl += `<tr class="phase" style="height:${RH}px"><td colspan="7">${esc(r.phase)}</td></tr>`; continue; }
    const t = r.t;
    tbl += `<tr data-key="${t.key}" class="${t.critical ? 'crit' : ''}" style="height:${RH}px"><td>${t.id}</td><td class="nm" title="${esc(t.fullName)}">${esc(t.fullName)}</td><td>${t.dur}</td><td>${fmtShort(t.start)}</td><td>${fmtShort(t.finish)}</td><td>${t.TF}</td><td>${progress[t.key]?.pct || 0}%</td></tr>`;
  }
  tbl += '</tbody></table>';
  el.innerHTML = `<div class="gwrap"><div class="gleft">${tbl}</div><div class="gright">${svg}</div></div>`;
  if (onSelect) el.querySelectorAll('[data-key]').forEach(n => n.addEventListener('click', () => onSelect(n.dataset.key)));
  const right = el.querySelector('.gright');
  if (cursorDate || dataDate) right.scrollLeft = Math.max(0, x(cursorDate || dataDate) - right.clientWidth / 2);
}

// منحنى S: الخطة مقابل القيمة المكتسبة
export function sCurveSVG(sched, history = [], dataDate = null, w = 760, h = 300) {
  const P = { l: 52, r: 16, t: 18, b: 34 };
  const total = sched.duration;
  const bac = sched.bac || 1;
  const pts = [];
  const step = Math.max(1, Math.round(total / 60));
  for (let d = 0; d <= total; d += step) pts.push([d, sched.tasks.reduce((s, t) => s + t.cost * plannedFrac(t, d), 0) / bac]);
  pts.push([total, 1]);
  const X = d => P.l + (d / total) * (w - P.l - P.r);
  const Y = v => h - P.b - v * (h - P.t - P.b);
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="100%" font-family="Tahoma, Arial" font-size="11" direction="ltr">`;
  for (let i = 0; i <= 10; i += 2) {
    s += `<line x1="${P.l}" x2="${w - P.r}" y1="${Y(i / 10)}" y2="${Y(i / 10)}" stroke="#eceff1"/><text x="${P.l - 6}" y="${Y(i / 10) + 4}" text-anchor="end" fill="#78909c">${i * 10}%</text>`;
  }
  const months = [];
  for (let m = new Date(sched.start.getFullYear(), sched.start.getMonth() + 1, 1); m <= sched.finish; m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) months.push(m);
  const every = Math.ceil(months.length / 10);
  months.forEach((m, i) => {
    const d = sched.cal.index(m);
    if (i % every) return;
    s += `<line x1="${X(d)}" x2="${X(d)}" y1="${P.t}" y2="${h - P.b}" stroke="#f3f5f7"/><text x="${X(d)}" y="${h - P.b + 16}" text-anchor="middle" fill="#78909c" font-size="10">${m.getMonth() + 1}/${String(m.getFullYear()).slice(2)}</text>`;
  });
  s += `<polyline fill="none" stroke="#1e88e5" stroke-width="2.5" points="${pts.map(([d, v]) => `${X(d)},${Y(v)}`).join(' ')}"/>`;
  const hist = history.filter(hh => hh.ev !== undefined).map(hh => [sched.cal.index(new Date(hh.date)), hh.ev / bac, hh.ac !== undefined && hh.ac !== null ? hh.ac / bac : null]).sort((a, b) => a[0] - b[0]);
  if (hist.length) {
    const ev = [[0, 0], ...hist];
    s += `<polyline fill="none" stroke="#43a047" stroke-width="2.5" points="${ev.map(([d, v]) => `${X(d)},${Y(v)}`).join(' ')}"/>`;
    hist.forEach(([d, v]) => (s += `<circle cx="${X(d)}" cy="${Y(v)}" r="3.5" fill="#43a047"/>`));
    const ac = [[0, 0], ...hist.filter(x => x[2] !== null).map(x => [x[0], x[2]])];
    if (ac.length > 1) s += `<polyline fill="none" stroke="#fb8c00" stroke-width="2" stroke-dasharray="6 3" points="${ac.map(([d, v]) => `${X(d)},${Y(v)}`).join(' ')}"/>`;
  }
  if (dataDate) {
    const d = sched.cal.index(dataDate);
    s += `<line x1="${X(d)}" x2="${X(d)}" y1="${P.t}" y2="${h - P.b}" stroke="#d81b60" stroke-dasharray="5 3" stroke-width="1.5"/>`;
  }
  const lg = [['#1e88e5', 'القيمة المخططة PV'], ['#43a047', 'القيمة المكتسبة EV'], ['#fb8c00', 'التكلفة الفعلية AC']];
  lg.forEach(([c, t], i) => (s += `<rect x="${P.l + 10 + i * 150}" y="${P.t}" width="14" height="4" fill="${c}"/><text x="${P.l + 28 + i * 150}" y="${P.t + 6}" fill="#37474f">${t}</text>`));
  s += `<line x1="${P.l}" y1="${h - P.b}" x2="${w - P.r}" y2="${h - P.b}" stroke="#90a4ae"/></svg>`;
  return s;
}

export function barsSVG(rows, w = 760) {
  // rows: [{label, plan, actual}] بنسب من 0 إلى 1
  const RH = 30, h = rows.length * RH + 34, L = 200;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="100%" font-family="Tahoma, Arial" font-size="11" direction="ltr">`;
  const X = v => L + v * (w - L - 60);
  rows.forEach((r, i) => {
    const y = 10 + i * RH;
    s += `<text x="${L - 8}" y="${y + 15}" text-anchor="end" fill="#37474f">${esc(r.label)}</text>`;
    s += `<rect x="${L}" y="${y + 2}" width="${X(1) - L}" height="20" fill="#eceff1" rx="3"/>`;
    s += `<rect x="${L}" y="${y + 2}" width="${X(r.plan) - L}" height="9" fill="#90caf9" rx="2"/>`;
    s += `<rect x="${L}" y="${y + 12}" width="${X(r.actual) - L}" height="10" fill="${r.actual + 0.05 < r.plan ? '#e53935' : '#43a047'}" rx="2"/>`;
    s += `<text x="${X(1) + 6}" y="${y + 16}" fill="#37474f" direction="ltr">${Math.round(r.actual * 100)}% / ${Math.round(r.plan * 100)}%</text>`;
  });
  s += `<rect x="${L + 40}" y="${h - 16}" width="12" height="8" fill="#90caf9"/><text x="${L + 36}" y="${h - 8}" text-anchor="end" fill="#546e7a">مخطط</text>`;
  s += `<rect x="${L + 110}" y="${h - 16}" width="12" height="8" fill="#43a047"/><text x="${L + 106}" y="${h - 8}" text-anchor="end" fill="#546e7a">فعلي</text>`;
  return s + '</svg>';
}
