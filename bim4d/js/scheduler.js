// توليد البرنامج الزمني من جدول الكميات وحساب المسار الحرج (CPM)
import { TRADES, TRADE, ALWAYS, levelName } from './library.js';

// ---------- التقويم ----------
export class Calendar {
  constructor(startISO, weekend = [5], holidays = []) {
    this.weekend = new Set(weekend.map(Number));
    this.holidays = new Set(holidays);
    this.days = [];          // التواريخ الفعلية لأيام العمل
    let d = parseISO(startISO);
    this.start = new Date(d);
    this._d = d;
    this.extend(400);
  }
  isWork(d) { return !this.weekend.has(d.getDay()) && !this.holidays.has(toISO(d)); }
  extend(n) {
    let d = this._d;
    while (this.days.length < n) {
      if (this.isWork(d)) this.days.push(new Date(d));
      d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    }
    this._d = d;
  }
  // تاريخ يوم العمل رقم i (يبدأ من صفر)
  date(i) {
    i = Math.max(0, Math.floor(i));
    if (i >= this.days.length) this.extend(i + 200);
    return this.days[i];
  }
  // عدد أيام العمل المنقضية حتى تاريخ معين (بشكل مستمر)
  index(date) {
    const t = +stripTime(date);
    if (t <= +this.days[0]) return 0;
    while (+this.days[this.days.length - 1] < t) this.extend(this.days.length + 200);
    let lo = 0, hi = this.days.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (+this.days[m] <= t) lo = m; else hi = m - 1; }
    return +this.days[lo] === t ? lo : lo + 1;
  }
}

export const parseISO = s => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, (m || 1) - 1, d || 1); };
export const toISO = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const stripTime = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());

export function parseHolidays(text) {
  const out = [];
  for (const line of String(text || '').split(/\n|;|،/)) {
    const m = line.trim().match(/(\d{4}-\d{2}-\d{2})(?:\s*(?:\.\.|إلى|الى|to|-{1,2}>|–)\s*(\d{4}-\d{2}-\d{2}))?/);
    if (!m) continue;
    let a = parseISO(m[1]); const b = m[2] ? parseISO(m[2]) : a;
    while (a <= b) { out.push(toISO(a)); a = new Date(a.getFullYear(), a.getMonth(), a.getDate() + 1); }
  }
  return out;
}

// ---------- بناء الأنشطة ----------
export function buildTasks(items, cfg) {
  const floors = Math.max(1, cfg.floors | 0);
  const tasks = new Map();
  const tget = (trade, level) => {
    const key = `${trade}@${level}`;
    if (!tasks.has(key)) {
      const T = TRADE[trade];
      tasks.set(key, { key, trade, level, name: T.name, phase: T.phase, qty: {}, cost: 0, items: [], color: T.color, milestone: !!T.milestone });
    }
    return tasks.get(key);
  };
  const add = (t, it, share) => {
    t.qty[it.unit] = (t.qty[it.unit] || 0) + it.qty * share;
    t.cost += it.amount * share;
    t.items.push({ id: it.id, share });
  };

  const distributed = [];
  for (const it of items) {
    if (it.excluded) continue;
    const T = TRADE[it.trade] || TRADE.other;
    if (T.scope === 'distribute') { distributed.push(it); continue; }
    let lv = it.levelOverride ?? it.level;
    if (lv === 'all') lv = null;
    if (T.scope === 'site') add(tget(T.key, 'P'), it, 1);
    else if (T.scope === 'sub') add(tget(T.key, -1), it, 1);
    else if (T.scope === 'roof') add(tget(T.key, floors), it, 1);
    else { // floor
      let L = lv;
      if (L === 'roof') L = ['columns', 'slab'].includes(T.key) ? floors - 1 : floors;
      else if (L === 'top') L = floors - 1;
      if (L === null || L === undefined || L === '') {
        for (let f = 0; f < floors; f++) add(tget(T.key, f), it, 1 / floors);
      } else add(tget(T.key, Math.min(Math.max(+L, 0), floors)), it, 1);
    }
  }
  // توزيع تكلفة الحديد والشدات على عناصر الخرسانة
  for (const it of distributed) {
    const T = TRADE[it.trade];
    const lv = it.levelOverride ?? it.level;
    let targets = [...tasks.values()].filter(t => T.distribute.includes(t.trade));
    if (typeof lv === 'number') { const f = targets.filter(t => t.level === lv); if (f.length) targets = f; }
    if (!targets.length) { add(tget('slab', 0), it, 1); continue; }
    const sum = targets.reduce((s, t) => s + (t.cost || 1), 0);
    for (const t of targets) { t.cost += it.amount * (t.cost || 1) / sum; t.items.push({ id: it.id, share: (t.cost || 1) / sum, cost: true }); }
  }
  for (const k of ALWAYS) if (![...tasks.values()].some(t => t.trade === k)) tget(k, 'P');

  // المدد
  for (const t of tasks.values()) {
    const T = TRADE[t.trade];
    const ts = cfg.trades?.[t.trade] || {};
    const crews = Math.max(1, +(ts.crews ?? T.crews ?? 1));
    let dur = null;
    if (T.prod) {
      for (const [u, p] of Object.entries(T.prod)) {
        const prod = ts.prod?.[u] ?? p;
        if (t.qty[u] > 0 && prod) { dur = Math.ceil(t.qty[u] / (prod * crews)); t.driver = { unit: u, qty: t.qty[u], prod, crews }; break; }
      }
    }
    if (dur === null) dur = +(ts.fixedDays ?? T.fixedDays ?? 10);
    if (T.milestone) dur = 0;
    else dur = Math.max(1, dur);
    if (cfg.durOverride?.[t.key] > 0) dur = +cfg.durOverride[t.key];
    t.dur = dur;
    t.levelName = t.level === 'P' ? 'المشروع' : levelName(t.level, floors);
    t.fullName = t.level === 'P' ? t.name : `${t.name} - ${t.levelName}`;
  }

  // العلاقات
  const list = [...tasks.values()];
  const byTrade = {};
  for (const t of list) (byTrade[t.trade] ||= []).push(t);
  const levelsMatch = (trade, spec, L) => {
    const arr = byTrade[trade] || [];
    if (spec === 'all' || spec === 'any') return arr;
    let want = spec === 'same' ? L : spec === 'prev' ? (typeof L === 'number' ? L - 1 : null)
      : spec === 'sub' ? -1 : spec === 'top' ? floors - 1 : null;
    if (want === null) return [];
    // نشاط على مستوى المشروع يطابق أي مستوى
    return arr.filter(t => t.level === want || t.level === 'P');
  };
  const resolve = (trade, spec, L, depth = 0) => {
    const found = levelsMatch(trade, spec, L);
    if (found.length || depth > 10) return found;
    const T = TRADE[trade];
    if (!T) return [];
    // النشاط غير موجود: نتجاوزه إلى الأنشطة التي تسبقه منطقيًا
    let concrete = L;
    if (spec === 'prev') concrete = L - 1; else if (spec === 'sub') concrete = -1; else if (spec === 'top') concrete = floors - 1;
    if (spec === 'prev' && concrete < 0) return [];
    const out = new Set();
    for (const r of T.preds) {
      if (r.onlyLevel !== undefined && concrete !== r.onlyLevel && !(spec === 'all' || spec === 'any')) continue;
      const nspec = (spec === 'all' || spec === 'any') ? (r.lvl === 'top' || r.lvl === 'sub' ? r.lvl : 'all') : r.lvl;
      for (const x of resolve(r.t, nspec, concrete, depth + 1)) out.add(x);
    }
    return [...out];
  };

  const links = [];
  const seen = new Set();
  const link = (p, s, type, lag) => {
    if (p === s) return;
    const id = p.key + '>' + s.key;
    if (seen.has(id)) return;
    seen.add(id);
    links.push({ from: p.key, to: s.key, type, lag });
  };
  for (const t of list) {
    const T = TRADE[t.trade];
    for (const r of T.preds) {
      if (r.onlyLevel !== undefined && t.level !== r.onlyLevel) continue;
      if (r.lvl === 'prev' && !(typeof t.level === 'number' && t.level > 0)) continue;
      const direct = levelsMatch(r.t, r.lvl, t.level);
      const preds = direct.length ? direct : resolve(r.t, r.lvl, t.level);
      for (const p of preds) {
        const lag = direct.length ? (r.lagPct ? Math.round(r.lagPct * p.dur) : (r.lag || 0)) : 0;
        link(p, t, direct.length ? r.type : 'FS', lag);
      }
    }
  }
  // كل نشاط بلا سابق يرتبط بالتجهيز، وكل نشاط بلا لاحق يرتبط بالتسليم
  const prelim = list.find(t => t.trade === 'prelim');
  const handover = list.find(t => t.trade === 'handover');
  const hasPred = new Set(links.map(l => l.to)), hasSucc = new Set(links.map(l => l.from));
  for (const t of list) {
    if (t !== prelim && !hasPred.has(t.key)) link(prelim, t, 'FS', 0);
    if (t !== handover && !hasSucc.has(t.key)) link(t, handover, 'FS', 0);
  }
  (cfg.extraLinks || []).forEach(l => { if (tasks.has(l.from) && tasks.has(l.to)) link(tasks.get(l.from), tasks.get(l.to), l.type || 'FS', +l.lag || 0); });

  // ترتيب العرض: حسب المرحلة ثم المستوى ثم ترتيب المكتبة
  const tradeOrder = Object.fromEntries(TRADES.map((t, i) => [t.key, i]));
  const lvOrder = l => (l === 'P' ? -2 : l);
  list.sort((a, b) => tradeOrder[a.trade] - tradeOrder[b.trade] || lvOrder(a.level) - lvOrder(b.level));
  return { tasks: list, links };
}

// ---------- المسار الحرج ----------
export function cpm(tasks, links) {
  const map = new Map(tasks.map(t => [t.key, t]));
  const succ = new Map(tasks.map(t => [t.key, []]));
  const pred = new Map(tasks.map(t => [t.key, []]));
  for (const l of links) { succ.get(l.from)?.push(l); pred.get(l.to)?.push(l); }
  // ترتيب طوبولوجي
  const indeg = new Map(tasks.map(t => [t.key, pred.get(t.key).length]));
  const q = tasks.filter(t => !indeg.get(t.key)).map(t => t.key);
  const order = [];
  while (q.length) {
    const k = q.shift(); order.push(k);
    for (const l of succ.get(k)) { indeg.set(l.to, indeg.get(l.to) - 1); if (!indeg.get(l.to)) q.push(l.to); }
  }
  if (order.length !== tasks.length) throw new Error('توجد علاقة دائرية بين الأنشطة. راجع العلاقات المضافة يدويًا.');
  for (const k of order) {
    const t = map.get(k);
    let es = t.constraintStart || 0;
    for (const l of pred.get(k)) {
      const p = map.get(l.from);
      es = Math.max(es, l.type === 'SS' ? p.ES + l.lag : p.EF + l.lag);
    }
    t.ES = es; t.EF = es + t.dur;
  }
  const end = Math.max(...tasks.map(t => t.EF));
  for (const k of order.slice().reverse()) {
    const t = map.get(k);
    let lf = end;
    for (const l of succ.get(k)) {
      const s = map.get(l.to);
      lf = Math.min(lf, l.type === 'SS' ? s.LS - l.lag + t.dur : s.LS - l.lag);
    }
    t.LF = lf; t.LS = lf - t.dur; t.TF = t.LS - t.ES;
    t.critical = t.TF <= 0;
  }
  return { duration: end, order };
}

export function schedule(items, cfg) {
  const { tasks, links } = buildTasks(items, cfg);
  const { duration } = cpm(tasks, links);
  const cal = new Calendar(cfg.startDate, cfg.weekend, parseHolidays(cfg.holidays));
  for (const t of tasks) {
    t.start = cal.date(t.ES);
    t.finish = t.dur ? cal.date(t.EF - 1) : cal.date(t.ES);
    t.id = 0;
  }
  tasks.forEach((t, i) => (t.id = i + 1));
  const bac = tasks.reduce((s, t) => s + t.cost, 0);
  return { tasks, links, duration, cal, bac, start: cal.date(0), finish: cal.date(Math.max(0, duration - 1)) };
}

// نسبة الإنجاز المخططة لنشاط عند يوم عمل w (مستمر)
export const plannedFrac = (t, w) => (t.dur === 0 ? (w >= t.ES ? 1 : 0) : Math.min(1, Math.max(0, (w - t.ES) / t.dur)));

export function plannedValue(sched, w) {
  return sched.tasks.reduce((s, t) => s + t.cost * plannedFrac(t, w), 0);
}
