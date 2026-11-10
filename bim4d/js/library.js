// مكتبة الأنشطة: تصنيف بنود جدول الكميات، معدلات الإنتاجية، والعلاقات المنطقية بين الأنشطة.
//
// scope:
//   site  نشاط واحد للمشروع كله
//   sub   أعمال الأساسات (مستوى الأساسات)
//   floor نشاط لكل دور
//   roof  نشاط على السطح
// prod: الإنتاجية اليومية لطاقم واحد لكل وحدة. أول وحدة متوفرة في البند هي التي تحدد المدة.
// preds: علاقات الأسبقية. lvl: same | prev | sub | top | all
//   type: FS (نهاية-بداية) أو SS (بداية-بداية). lag بالأيام أو lagPct نسبة من مدة النشاط السابق.
// cat: فئة العناصر ثلاثية الأبعاد التي يبنيها النشاط في المحاكاة.
// paint: لون تتحول إليه عناصر فئة أخرى عند تنفيذ النشاط (لياسة، دهان...).

export const TRADES = [
  { key: 'prelim', name: 'التجهيز والأعمال التمهيدية', phase: 'أعمال تمهيدية', scope: 'site', cat: 'site',
    fixedDays: 14, crews: 1, color: '#8d6e63',
    kw: ['تجهيز الموقع', 'تمهيد', 'مكتب الموقع', 'مكاتب الموقع', 'تسوير', 'سور مؤقت', 'أعمال عامة', 'متطلبات عامة', 'mobiliz', 'preliminar', 'site prep', 'general requirement', 'site office', 'هدم', 'إزالة'],
    preds: [] },
  { key: 'excavation', name: 'أعمال الحفر', phase: 'أعمال الأساسات', scope: 'site', cat: 'excavation',
    prod: { m3: 300, m2: 400 }, crews: 1, color: '#a1887f',
    kw: ['حفر', 'excavat', 'نزح المياه', 'dewater', 'تسوية', 'grading'],
    preds: [{ t: 'prelim', type: 'FS', lag: 0, lvl: 'any' }] },
  { key: 'pcc', name: 'خرسانة النظافة', phase: 'أعمال الأساسات', scope: 'sub', cat: 'pcc',
    prod: { m3: 30, m2: 250 }, crews: 1, color: '#bdbdbd',
    kw: ['خرسانة عادية', 'خرسانة نظافة', 'خرسانة النظافة', 'نظافة', 'plain concrete', 'blinding', 'lean concrete', 'pcc'],
    preds: [{ t: 'excavation', type: 'SS', lagPct: 0.5, lvl: 'any' }] },
  { key: 'footing', name: 'القواعد واللبشة', phase: 'أعمال الأساسات', scope: 'sub', cat: 'footing',
    prod: { m3: 25, m2: 60, t: 2.5, kg: 2500 }, crews: 1, color: '#78909c',
    kw: ['قواعد', 'القواعد', 'قاعدة', 'لبشة', 'اللبشة', 'خوازيق', 'footing', 'foundation', 'raft', 'pile', 'mat '],
    preds: [{ t: 'pcc', type: 'FS', lag: 1, lvl: 'sub' }] },
  { key: 'neck', name: 'رقاب الأعمدة', phase: 'أعمال الأساسات', scope: 'sub', cat: 'neck',
    prod: { m3: 8, m2: 40, t: 1.2, kg: 1200 }, crews: 1, color: '#607d8b',
    kw: ['رقاب الأعمدة', 'رقاب', 'رقبة', 'neck column', 'column neck', 'stub column', 'pedestal'],
    preds: [{ t: 'footing', type: 'FS', lag: 2, lvl: 'sub' }] },
  { key: 'tiebeam', name: 'الميدات والسملات', phase: 'أعمال الأساسات', scope: 'sub', cat: 'tiebeam',
    prod: { m3: 12, m2: 50, m: 40, t: 1.5, kg: 1500 }, crews: 1, color: '#546e7a',
    kw: ['ميدة', 'ميدات', 'سملات', 'سملة', 'شدادات', 'tie beam', 'grade beam', 'ground beam', 'plinth beam'],
    preds: [{ t: 'neck', type: 'FS', lag: 1, lvl: 'sub' }] },
  { key: 'wp_sub', name: 'عزل الأساسات', phase: 'أعمال الأساسات', scope: 'sub', cat: 'wp_sub',
    prod: { m2: 150 }, crews: 1, color: '#37474f',
    kw: ['عزل الأساسات', 'عزل القواعد', 'بيتومين', 'دهان بيتوميني', 'عزل مائي للأساسات', 'bitumen', 'foundation waterproof', 'substructure waterproof'],
    preds: [{ t: 'tiebeam', type: 'FS', lag: 2, lvl: 'sub' }] },
  { key: 'backfill', name: 'الردم والدك', phase: 'أعمال الأساسات', scope: 'site', cat: 'backfill',
    prod: { m3: 200 }, crews: 1, color: '#c8a27a',
    kw: ['ردم', 'الدك', 'backfill', 'compact', 'رش مبيد', 'مكافحة النمل', 'anti termite', 'termite'],
    preds: [{ t: 'wp_sub', type: 'FS', lag: 0, lvl: 'sub' }] },
  { key: 'sog', name: 'البلاطة الأرضية', phase: 'أعمال الأساسات', scope: 'sub', cat: 'sog',
    prod: { m3: 40, m2: 250 }, crews: 1, color: '#9e9e9e',
    kw: ['بلاطة أرضية', 'البلاطة الأرضية', 'بلاطة على الأرض', 'أرضية خرسانية', 'slab on grade', 'ground slab', 'sog', 'slab-on-grade'],
    preds: [{ t: 'backfill', type: 'FS', lag: 0, lvl: 'any' }] },
  { key: 'columns', name: 'الأعمدة والجدران الخرسانية', phase: 'الهيكل الخرساني', scope: 'floor', cat: 'column',
    prod: { m3: 8, m2: 40, t: 1.2, kg: 1200 }, crews: 1, color: '#90a4ae',
    kw: ['أعمدة', 'الأعمدة', 'عمود', 'جدران خرسانية', 'حوائط خرسانية', 'حوائط القص', 'column', 'shear wall', 'core wall', 'concrete wall'],
    preds: [{ t: 'backfill', type: 'FS', lag: 0, lvl: 'any', onlyLevel: 0 },
            { t: 'slab', type: 'FS', lag: 7, lvl: 'prev' }] },
  { key: 'slab', name: 'الأسقف والجسور', phase: 'الهيكل الخرساني', scope: 'floor', cat: 'slab',
    prod: { m3: 30, m2: 120, t: 3, kg: 3000 }, crews: 1, color: '#b0bec5',
    kw: ['سقف', 'أسقف', 'الأسقف', 'بلاطة', 'بلاطات', 'كمرات', 'جسور', 'الدرج', 'سلالم', 'slab', 'beam', 'stair', 'roof slab', 'hordi', 'هوردي'],
    preds: [{ t: 'columns', type: 'FS', lag: 1, lvl: 'same' }] },
  { key: 'rebar', name: 'حديد التسليح (يوزع على الخرسانة)', phase: 'الهيكل الخرساني', scope: 'distribute', cat: null,
    distribute: ['footing', 'neck', 'tiebeam', 'sog', 'columns', 'slab'],
    kw: ['حديد تسليح', 'حديد التسليح', 'reinforcement', 'rebar', 'steel bar'], preds: [] },
  { key: 'formwork', name: 'الشدات الخشبية (توزع على الخرسانة)', phase: 'الهيكل الخرساني', scope: 'distribute', cat: null,
    distribute: ['footing', 'neck', 'tiebeam', 'columns', 'slab'],
    kw: ['شدات', 'شدة خشبية', 'طوبار', 'formwork', 'shuttering'], preds: [] },
  { key: 'blockwork', name: 'أعمال المباني (البلوك)', phase: 'أعمال المباني', scope: 'floor', cat: 'wall',
    prod: { m2: 40, m3: 8, no: 400 }, crews: 2, color: '#d7ccc8',
    kw: ['بلوك', 'طوب', 'مباني', 'مباني البلوك', 'جدران البلوك', 'block', 'masonry', 'brick'],
    preds: [{ t: 'slab', type: 'FS', lag: 14, lvl: 'same' }, { t: 'sog', type: 'FS', lag: 0, lvl: 'sub', onlyLevel: 0 }] },
  { key: 'mep_rough', name: 'تمديدات الكهرباء والسباكة والتكييف', phase: 'الأعمال الكهروميكانيكية', scope: 'floor', cat: 'mep',
    prod: { m: 120, no: 25, m2: 150, ls: null }, fixedDays: 15, crews: 2, color: '#4fc3f7',
    kw: ['تمديد', 'تمديدات', 'مواسير', 'أنابيب', 'كابلات', 'مجاري الهواء', 'دكت', 'تأسيس', 'كهرباء', 'سباكة', 'صرف صحي', 'تغذية مياه', 'تكييف', 'حريق', 'إنذار', 'conduit', 'pipe', 'piping', 'cable', 'duct', 'plumbing', 'electrical', 'drainage', 'hvac', 'fire fighting', 'mep'],
    preds: [{ t: 'blockwork', type: 'SS', lagPct: 0.5, lvl: 'same' }] },
  { key: 'plaster', name: 'اللياسة', phase: 'التشطيبات', scope: 'floor', cat: 'plaster', paint: { cat: 'wall', color: '#eeeeee' },
    prod: { m2: 60 }, crews: 2, color: '#e0e0e0',
    kw: ['لياسة', 'بياض', 'محارة', 'plaster', 'render'],
    preds: [{ t: 'mep_rough', type: 'FS', lag: 0, lvl: 'same' }, { t: 'blockwork', type: 'FS', lag: 0, lvl: 'same' }] },
  { key: 'ceiling', name: 'الأسقف المستعارة والجبس', phase: 'التشطيبات', scope: 'floor', cat: 'ceiling',
    prod: { m2: 40, m: 60 }, crews: 1, color: '#fafafa',
    kw: ['أسقف مستعارة', 'سقف مستعار', 'جبس', 'جبسوم', 'false ceiling', 'suspended ceiling', 'gypsum', 'ceiling'],
    preds: [{ t: 'plaster', type: 'SS', lagPct: 0.5, lvl: 'same' }] },
  { key: 'tiles', name: 'البلاط والرخام', phase: 'التشطيبات', scope: 'floor', cat: 'floorfinish',
    prod: { m2: 30, m: 60 }, crews: 2, color: '#bcaaa4',
    kw: ['بلاط', 'سيراميك', 'بورسلان', 'رخام', 'جرانيت', 'نعلات', 'وزرات', 'tile', 'tiling', 'ceramic', 'porcelain', 'marble', 'granite', 'skirting', 'flooring', 'screed', 'ذمة'],
    preds: [{ t: 'plaster', type: 'FS', lag: 0, lvl: 'same' }] },
  { key: 'doors', name: 'الأبواب', phase: 'التشطيبات', scope: 'floor', cat: 'door',
    prod: { no: 6, m2: 15 }, crews: 1, color: '#8d6e63',
    kw: ['باب', 'أبواب', 'الأبواب', 'door'],
    preds: [{ t: 'tiles', type: 'SS', lagPct: 0.6, lvl: 'same' }] },
  { key: 'windows', name: 'النوافذ والألمنيوم', phase: 'التشطيبات', scope: 'floor', cat: 'window',
    prod: { m2: 20, no: 6 }, crews: 1, color: '#81d4fa',
    kw: ['نافذة', 'نوافذ', 'شبابيك', 'شباك', 'ألمنيوم', 'المنيوم', 'زجاج', 'window', 'aluminium', 'aluminum', 'glazing', 'curtain wall'],
    preds: [{ t: 'plaster', type: 'FS', lag: 0, lvl: 'same' }] },
  { key: 'painting', name: 'الدهانات', phase: 'التشطيبات', scope: 'floor', cat: 'paint', paint: { cat: 'wall', color: '#f5ead3' },
    prod: { m2: 150 }, crews: 2, color: '#ffe0b2',
    kw: ['دهان', 'دهانات', 'بوية', 'معجون', 'paint', 'painting', 'emulsion'],
    preds: [{ t: 'tiles', type: 'SS', lagPct: 0.5, lvl: 'same' }, { t: 'ceiling', type: 'FS', lag: 0, lvl: 'same' }] },
  { key: 'mep_final', name: 'التركيبات النهائية للكهروميكانيك', phase: 'الأعمال الكهروميكانيكية', scope: 'floor', cat: 'fixture',
    prod: { no: 30, m: 150, ls: null }, fixedDays: 10, crews: 2, color: '#0288d1',
    kw: ['أطقم صحية', 'أدوات صحية', 'مغاسل', 'كراسي', 'خلاطات', 'مفاتيح', 'أفياش', 'إنارة', 'وحدات إضاءة', 'لوحات توزيع', 'وحدات تكييف', 'سخانات', 'sanitary', 'fixture', 'light fitting', 'luminaire', 'switch', 'socket', 'distribution board', 'split unit', 'water heater'],
    preds: [{ t: 'painting', type: 'SS', lagPct: 0.5, lvl: 'same' }] },
  { key: 'roof_wp', name: 'عزل السطح', phase: 'أعمال السطح', scope: 'roof', cat: 'roofwp',
    prod: { m2: 120 }, crews: 1, color: '#455a64',
    kw: ['عزل السطح', 'عزل الأسطح', 'عزل حراري', 'عزل مائي', 'ميول السطح', 'roof insulation', 'roof waterproof', 'thermal insulation', 'waterproofing', 'membrane', 'عزل'],
    preds: [{ t: 'slab', type: 'FS', lag: 14, lvl: 'top' }] },
  { key: 'facade', name: 'الواجهات', phase: 'الواجهات والأعمال الخارجية', scope: 'site', cat: 'facade',
    prod: { m2: 25 }, crews: 2, color: '#d8c3a5',
    kw: ['واجهة', 'واجهات', 'حجر', 'كلادينج', 'جي آر سي', 'facade', 'cladding', 'stone', 'grc', 'external finish'],
    preds: [{ t: 'blockwork', type: 'FS', lag: 0, lvl: 'all' }, { t: 'plaster', type: 'SS', lag: 10, lvl: 'all' }] },
  { key: 'elevator', name: 'المصاعد', phase: 'الأعمال الكهروميكانيكية', scope: 'site', cat: 'elevator',
    fixedDays: 45, crews: 1, color: '#7e57c2',
    kw: ['مصعد', 'مصاعد', 'elevator', 'lift', 'escalator'],
    preds: [{ t: 'slab', type: 'FS', lag: 14, lvl: 'top' }] },
  { key: 'external', name: 'الأعمال الخارجية واللاندسكيب', phase: 'الواجهات والأعمال الخارجية', scope: 'site', cat: 'external',
    prod: { m2: 100, m: 60, m3: 60 }, crews: 1, color: '#81c784',
    kw: ['الأعمال الخارجية', 'أعمال خارجية', 'لاندسكيب', 'زراعة', 'أرصفة', 'انترلوك', 'أسفلت', 'سور الموقع', 'سور خارجي', 'مظلات', 'landscape', 'paving', 'interlock', 'asphalt', 'boundary wall', 'external work', 'site work'],
    preds: [{ t: 'facade', type: 'SS', lagPct: 0.5, lvl: 'any' }] },
  { key: 'other', name: 'أعمال أخرى غير مصنفة', phase: 'أعمال أخرى', scope: 'site', cat: null,
    fixedDays: 20, crews: 1, color: '#9575cd', kw: [],
    preds: [{ t: 'slab', type: 'FS', lag: 0, lvl: 'top' }] },
  { key: 'testing', name: 'الاختبارات والتشغيل', phase: 'التسليم', scope: 'site', cat: null,
    fixedDays: 14, crews: 1, color: '#26a69a',
    kw: ['اختبار', 'تشغيل', 'testing', 'commissioning'],
    preds: [{ t: 'mep_final', type: 'FS', lag: 0, lvl: 'all' }, { t: 'painting', type: 'FS', lag: 0, lvl: 'all' }, { t: 'elevator', type: 'FS', lag: 0, lvl: 'any' }] },
  { key: 'handover', name: 'التسليم الابتدائي', phase: 'التسليم', scope: 'site', cat: null, milestone: true,
    fixedDays: 0, crews: 1, color: '#000000', kw: ['تسليم', 'handover'],
    preds: [{ t: 'testing', type: 'FS', lag: 0, lvl: 'any' }, { t: 'external', type: 'FS', lag: 0, lvl: 'any' },
            { t: 'roof_wp', type: 'FS', lag: 0, lvl: 'any' }, { t: 'doors', type: 'FS', lag: 0, lvl: 'all' },
            { t: 'windows', type: 'FS', lag: 0, lvl: 'all' }, { t: 'other', type: 'FS', lag: 0, lvl: 'any' }] },
];

export const TRADE = Object.fromEntries(TRADES.map(t => [t.key, t]));

// الأنشطة التي تظهر دائمًا في البرنامج حتى لو لم يرد لها بند في الجدول
export const ALWAYS = ['prelim', 'handover'];

export function normUnit(u) {
  const s = String(u || '').trim().toLowerCase().replace(/[\s.²³]/g, m => (m === '²' ? '2' : m === '³' ? '3' : ''));
  if (/^(م3|m3|cum|cu\.?m|مكعب|مترمكعب)/.test(s)) return 'm3';
  if (/^(م2|m2|sqm|sq\.?m|مربع|مترمربع)/.test(s)) return 'm2';
  if (/^(مط|م\.?ط|lm|ml|rm|m|م|مترطولي|طولي|متر)$/.test(s)) return 'm';
  if (/^(طن|ton|tons|t|tonne)$/.test(s)) return 't';
  if (/^(كجم|كغ|kg|kgs)$/.test(s)) return 'kg';
  if (/^(عدد|nr|no|nos|each|ea|pcs|pc|unit|set|طقم|وحدة)$/.test(s)) return 'no';
  if (/^(مقطوعية|مقطوع|ls|l\.s|lump|lumpsum|item|بالمقطوعية)/.test(s)) return 'ls';
  return s || 'ls';
}

const AR_NORM = s => String(s || '').toLowerCase()
  .replace(/[إأآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/[ًٌٍَُِّْـ]/g, '');

const KW_INDEX = TRADES.flatMap(t => t.kw.map(k => ({ t: t.key, k: AR_NORM(k), len: k.length })));

export function classify(desc) {
  const d = ' ' + AR_NORM(desc) + ' ';
  let best = null, bestElem = null;
  for (const e of KW_INDEX) {
    if (!d.includes(e.k)) continue;
    if (!best || e.len > best.len) best = e;
    if (TRADE[e.t].scope !== 'distribute' && (!bestElem || e.len > bestElem.len)) bestElem = e;
  }
  if (!best) return 'other';
  // «حديد تسليح للأعمدة» يُنسب إلى الأعمدة لا إلى الحديد العام
  if (TRADE[best.t].scope === 'distribute' && bestElem && TRADE[bestElem.t].distribute === undefined
      && TRADE[best.t].distribute.includes(bestElem.t)) return bestElem.t;
  return best.t;
}

// يستخرج رقم الدور من الوصف: 0 أرضي، 1 أول ... 'roof' للسطح، 'top' للملحق، null غير محدد
const LEVEL_WORDS = [
  [/(ملحق|penthouse|roof annex|upper annex)/, 'top'],
  [/((^|\s)(ال|لل|بال)?سطح($|\s|[،,.-])|روف|\broof\b)/, 'roof'],
  [/(بدروم|قبو|basement|سرداب)/, 0],
  [/(الدور الارضي|الطابق الارضي|ground floor|\bgf\b|(^|\s)(ال)?ارضي($|\s|[،,.-]))/, 0],
  [/(الدور الاول|الطابق الاول|first floor|1st floor)/, 1],
  [/(الدور الثاني|الطابق الثاني|second floor|2nd floor)/, 2],
  [/(الدور الثالث|الطابق الثالث|third floor|3rd floor)/, 3],
  [/(الدور الرابع|الطابق الرابع|fourth floor|4th floor)/, 4],
  [/(الدور الخامس|الطابق الخامس|fifth floor|5th floor)/, 5],
  [/(الدور السادس|الطابق السادس|sixth floor|6th floor)/, 6],
];

export function detectLevel(desc) {
  const d = AR_NORM(desc);
  for (const [re, lv] of LEVEL_WORDS) if (re.test(d)) return lv;
  const m = d.match(/(?:الدور|الطابق|floor|level)\s*(\d{1,2})/);
  if (m) return +m[1];
  return null;
}

export function levelName(l, floors) {
  if (l === -1) return 'الأساسات';
  if (l === floors) return 'السطح';
  if (l === null || l === undefined) return 'المشروع';
  const names = ['الدور الأرضي', 'الدور الأول', 'الدور الثاني', 'الدور الثالث', 'الدور الرابع', 'الدور الخامس', 'الدور السادس', 'الدور السابع', 'الدور الثامن', 'الدور التاسع', 'الدور العاشر'];
  return names[l] || `الدور ${l}`;
}
