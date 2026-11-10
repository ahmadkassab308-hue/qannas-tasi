// قراءة جدول الكميات من ملف Excel أو CSV وتصنيف البنود
import { classify, detectLevel, normUnit } from './library.js';

const HEAD = {
  code: ['رقم البند', 'البند', 'رقم', 'م', 'item no', 'item', 'code', 'no', 'ref', 'الرمز', 'كود'],
  desc: ['وصف البند', 'الوصف', 'البيان', 'بيان الأعمال', 'وصف الأعمال', 'description', 'desc', 'work description', 'الأعمال'],
  unit: ['الوحدة', 'وحدة', 'unit', 'uom'],
  qty: ['الكمية', 'كمية', 'qty', 'quantity', 'quantities'],
  rate: ['سعر الوحدة', 'الفئة', 'السعر', 'فئة', 'rate', 'unit price', 'unit rate', 'price'],
  amount: ['الإجمالي', 'الاجمالي', 'المبلغ', 'القيمة', 'الإجمالى', 'total', 'amount', 'value'],
};

const norm = s => String(s ?? '').trim().toLowerCase().replace(/[إأآ]/g, 'ا').replace(/ة/g, 'ه').replace(/\s+/g, ' ');
const num = v => {
  if (typeof v === 'number') return v;
  const s = String(v ?? '').replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/٫/g, '.').replace(/[,٬\s]/g, '');
  const n = parseFloat(s);
  return isFinite(n) ? n : 0;
};

function findHeader(rows) {
  let best = null;
  for (let r = 0; r < Math.min(rows.length, 25); r++) {
    const cols = {};
    let score = 0;
    rows[r].forEach((cell, c) => {
      const v = norm(cell);
      if (!v) return;
      for (const [k, names] of Object.entries(HEAD)) {
        if (cols[k] !== undefined) continue;
        if (names.some(n => v === norm(n) || (n.length > 3 && v.includes(norm(n))))) { cols[k] = c; score++; break; }
      }
    });
    if (cols.desc !== undefined && cols.qty !== undefined && (!best || score > best.score)) best = { row: r, cols, score };
  }
  return best;
}

export function parseRows(rows) {
  const h = findHeader(rows);
  if (!h) throw new Error('لم أجد عمودي «الوصف» و«الكمية» في الملف. تأكد أن الصف الأول يحتوي عناوين الأعمدة.');
  const { cols } = h;
  const items = [];
  for (let r = h.row + 1; r < rows.length; r++) {
    const row = rows[r];
    const desc = String(row[cols.desc] ?? '').trim();
    const qty = num(row[cols.qty]);
    if (!desc || !(qty > 0)) continue;
    let rate = cols.rate !== undefined ? num(row[cols.rate]) : 0;
    let amount = cols.amount !== undefined ? num(row[cols.amount]) : 0;
    if (!rate && amount) rate = amount / qty;
    if (!amount) amount = rate * qty;
    const unit = normUnit(cols.unit !== undefined ? row[cols.unit] : '');
    items.push({
      id: items.length + 1,
      code: cols.code !== undefined ? String(row[cols.code] ?? '').trim() : String(items.length + 1),
      desc, unitRaw: cols.unit !== undefined ? String(row[cols.unit] ?? '') : '', unit, qty, rate, amount,
      trade: classify(desc), level: detectLevel(desc),
    });
  }
  if (!items.length) throw new Error('لم أجد بنودًا لها كميات في الملف.');
  return items;
}

export async function readBoqFile(file) {
  const buf = await file.arrayBuffer();
  const XLSX = window.XLSX;
  let wb;
  if (/\.csv$/i.test(file.name)) {
    const text = new TextDecoder('utf-8').decode(buf);
    wb = XLSX.read(text, { type: 'string' });
  } else {
    wb = XLSX.read(buf, { type: 'array' });
  }
  // نجرب كل الأوراق ونأخذ أول ورقة فيها بنود
  let lastErr;
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '', raw: true });
    try { return parseRows(rows); } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

export const SAMPLE_BOQ = [
  ['رقم البند', 'وصف البند', 'الوحدة', 'الكمية', 'سعر الوحدة', 'الإجمالي'],
  ['1.1', 'تجهيز الموقع وتسويره ومكاتب الموقع', 'مقطوعية', 1, 45000],
  ['2.1', 'حفر الموقع لمنسوب التأسيس شامل نزح المياه', 'م3', 1800, 18],
  ['2.2', 'خرسانة عادية (نظافة) أسفل القواعد والميدات', 'م3', 45, 260],
  ['2.3', 'خرسانة مسلحة للقواعد شاملة الشدات', 'م3', 180, 780],
  ['2.4', 'خرسانة مسلحة لرقاب الأعمدة', 'م3', 22, 900],
  ['2.5', 'خرسانة مسلحة للميدات', 'م3', 60, 850],
  ['2.6', 'عزل الأساسات بالبيتومين على وجهين', 'م2', 900, 22],
  ['2.7', 'ردم ودك على طبقات مع رش مبيد النمل الأبيض', 'م3', 1100, 30],
  ['2.8', 'بلاطة أرضية خرسانية سماكة 10 سم', 'م2', 600, 65],
  ['2.9', 'حديد تسليح عالي المقاومة', 'طن', 140, 3600],
  ['3.1', 'خرسانة مسلحة للأعمدة والجدران الخرسانية', 'م3', 150, 1100],
  ['3.2', 'خرسانة مسلحة للأسقف والجسور والدرج', 'م3', 720, 950],
  ['4.1', 'مباني بلوك أسمنتي معزول للجدران الخارجية سماكة 20 سم', 'م2', 2400, 95],
  ['4.2', 'مباني بلوك أسمنتي للجدران الداخلية سماكة 15 سم', 'م2', 2100, 75],
  ['5.1', 'لياسة داخلية وخارجية بالأسمنت', 'م2', 9000, 32],
  ['5.2', 'بلاط بورسلان للأرضيات شامل النعلات', 'م2', 2100, 120],
  ['5.3', 'رخام للدرج والمداخل', 'م2', 260, 380],
  ['5.4', 'دهانات داخلية بلاستيك ثلاث طبقات', 'م2', 7200, 28],
  ['5.5', 'أسقف مستعارة جبس بورد', 'م2', 1400, 85],
  ['5.6', 'أبواب خشبية داخلية', 'عدد', 96, 1600],
  ['5.7', 'نوافذ ألمنيوم مع زجاج مزدوج', 'م2', 420, 650],
  ['6.1', 'تمديدات الكهرباء والمواسير والكابلات', 'مقطوعية', 1, 380000],
  ['6.2', 'تمديدات السباكة والصرف الصحي وتغذية المياه', 'مقطوعية', 1, 290000],
  ['6.3', 'مجاري الهواء وتمديدات التكييف', 'مقطوعية', 1, 260000],
  ['6.4', 'توريد وتركيب الأطقم الصحية والخلاطات', 'عدد', 120, 1800],
  ['6.5', 'توريد وتركيب وحدات الإنارة والمفاتيح والأفياش', 'عدد', 900, 140],
  ['6.6', 'توريد وتركيب مصعد ركاب 8 أشخاص', 'عدد', 1, 165000],
  ['7.1', 'عزل السطح المائي والحراري مع الميول', 'م2', 600, 140],
  ['7.2', 'تكسية الواجهات بالحجر الطبيعي', 'م2', 1200, 260],
  ['8.1', 'الأعمال الخارجية والانترلوك واللاندسكيب', 'م2', 800, 110],
  ['9.1', 'الاختبارات والتشغيل والتسليم', 'مقطوعية', 1, 35000],
].map((r, i) => (i && r.length === 5 ? [...r, r[3] * r[4]] : r));
