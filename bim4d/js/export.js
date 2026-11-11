// التصدير: MS Project XML (يُفتح في MS Project ويُستورد في Primavera P6) و Excel
import { toISO } from './scheduler.js';
import { TRADE } from './library.js';

const x = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

const note = msg => {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 4000);
};

// داخل رابط claude.ai يمر التنزيل عبر نافذة تأكيد؛ وخارجه تنزيل مباشر
export async function download(name, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const dl = window.claude?.use ? await window.claude.use('downloads').catch(() => null) : null;
  if (dl) {
    try { await dl.save({ filename: name, data: blob }); }
    catch (e) {
      if (e?.code === 'rejected_extension') note('هذه الصيغة لا تُنزَّل من صفحة الرابط. شغّل المنصة من المستودع لتنزيلها.');
      else if (e?.code !== 'declined') note('تعذر التنزيل: ' + (e?.message || e));
    }
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export function toMSPXML(sched, project, progress = {}) {
  const weekend = new Set(project.weekend.map(Number));
  const wdPerWeek = 7 - weekend.size;
  const dt = (d, end) => `${toISO(d)}T${end ? '17:00:00' : '08:00:00'}`;
  let uid = 1, id = 1;
  const taskUID = new Map();
  const rows = [];
  let phase = null, phaseRow = null;
  for (const t of sched.tasks) {
    if (t.phase !== phase) {
      phase = t.phase;
      phaseRow = { uid: uid++, id: id++, name: phase, summary: true, start: t.start, finish: t.finish, outline: 1 };
      rows.push(phaseRow);
    }
    if (t.start < phaseRow.start) phaseRow.start = t.start;
    if (t.finish > phaseRow.finish) phaseRow.finish = t.finish;
    const r = { uid: uid++, id: id++, t, outline: 2 };
    taskUID.set(t.key, r.uid);
    rows.push(r);
  }
  const preds = new Map();
  for (const l of sched.links) (preds.get(l.to) || preds.set(l.to, []).get(l.to)).push(l);

  let s = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Project xmlns="http://schemas.microsoft.com/project">
<SaveVersion>14</SaveVersion>
<Name>${x(project.name)}</Name>
<Title>${x(project.name)}</Title>
<ScheduleFromStart>1</ScheduleFromStart>
<StartDate>${dt(sched.start)}</StartDate>
<FinishDate>${dt(sched.finish, true)}</FinishDate>
<CalendarUID>1</CalendarUID>
<DefaultStartTime>08:00:00</DefaultStartTime>
<DefaultFinishTime>17:00:00</DefaultFinishTime>
<MinutesPerDay>480</MinutesPerDay>
<MinutesPerWeek>${480 * wdPerWeek}</MinutesPerWeek>
<DaysPerMonth>${Math.round(wdPerWeek * 4.33)}</DaysPerMonth>
<DurationFormat>7</DurationFormat>
<Calendars><Calendar><UID>1</UID><Name>تقويم المشروع</Name><IsBaseCalendar>1</IsBaseCalendar><WeekDays>`;
  for (let d = 0; d < 7; d++) {
    const work = !weekend.has(d);
    s += `<WeekDay><DayType>${d + 1}</DayType><DayWorking>${work ? 1 : 0}</DayWorking>${work ? '<WorkingTimes><WorkingTime><FromTime>08:00:00</FromTime><ToTime>12:00:00</ToTime></WorkingTime><WorkingTime><FromTime>13:00:00</FromTime><ToTime>17:00:00</ToTime></WorkingTime></WorkingTimes>' : ''}</WeekDay>`;
  }
  for (const h of sched.cal.holidays) s += `<WeekDay><DayType>0</DayType><DayWorking>0</DayWorking><TimePeriod><FromDate>${h}T00:00:00</FromDate><ToDate>${h}T23:59:00</ToDate></TimePeriod></WeekDay>`;
  s += `</WeekDays></Calendar></Calendars>\n<Tasks>\n`;
  for (const r of rows) {
    if (r.summary) {
      s += `<Task><UID>${r.uid}</UID><ID>${r.id}</ID><Name>${x(r.name)}</Name><OutlineLevel>1</OutlineLevel><Summary>1</Summary><Start>${dt(r.start)}</Start><Finish>${dt(r.finish, true)}</Finish></Task>\n`;
      continue;
    }
    const t = r.t;
    const pc = Math.round(progress[t.key]?.pct || 0);
    s += `<Task><UID>${r.uid}</UID><ID>${r.id}</ID><Name>${x(t.fullName)}</Name><Type>1</Type><OutlineLevel>2</OutlineLevel>` +
      `<Start>${dt(t.start)}</Start><Finish>${dt(t.finish, true)}</Finish><Duration>PT${t.dur * 8}H0M0S</Duration><DurationFormat>7</DurationFormat>` +
      `<Milestone>${t.milestone ? 1 : 0}</Milestone><Summary>0</Summary><Critical>${t.critical ? 1 : 0}</Critical><PercentComplete>${pc}</PercentComplete>` +
      `<Cost>${Math.round(t.cost * 100)}</Cost><FixedCost>${t.cost.toFixed(2)}</FixedCost><ConstraintType>0</ConstraintType><CalendarUID>-1</CalendarUID>` +
      `<Notes>${x(t.driver ? `الكمية ${t.driver.qty.toFixed(1)} ${t.driver.unit} · إنتاجية ${t.driver.prod}/يوم · طواقم ${t.driver.crews}` : '')}</Notes>`;
    for (const l of preds.get(t.key) || []) {
      s += `<PredecessorLink><PredecessorUID>${taskUID.get(l.from)}</PredecessorUID><Type>${l.type === 'SS' ? 3 : 1}</Type><CrossProject>0</CrossProject><LinkLag>${Math.round(l.lag * 4800)}</LinkLag><LagFormat>7</LagFormat></PredecessorLink>`;
    }
    s += `</Task>\n`;
  }
  s += `</Tasks>\n</Project>`;
  return s;
}

export function toExcel(sched, project, items, progress, evm) {
  const XLSX = window.XLSX;
  const wb = XLSX.utils.book_new();
  const map = new Map(sched.tasks.map(t => [t.key, t]));
  const preds = t => sched.links.filter(l => l.to === t.key).map(l => `${map.get(l.from).id}${l.type}${l.lag ? '+' + l.lag : ''}`).join(', ');
  const s1 = [['#', 'النشاط', 'المرحلة', 'المستوى', 'المدة (يوم عمل)', 'البداية', 'النهاية', 'السماح الكلي', 'حرج', 'الأنشطة السابقة', 'القيمة', 'الوزن %', 'الإنجاز الفعلي %']];
  for (const t of sched.tasks) {
    s1.push([t.id, t.name, t.phase, t.levelName, t.dur, toISO(t.start), toISO(t.finish), t.TF, t.critical ? 'نعم' : '', preds(t),
      Math.round(t.cost), +(100 * t.cost / (sched.bac || 1)).toFixed(2), progress[t.key]?.pct || 0]);
  }
  const ws1 = XLSX.utils.aoa_to_sheet(s1);
  ws1['!cols'] = [{ wch: 5 }, { wch: 38 }, { wch: 22 }, { wch: 14 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 9 }, { wch: 6 }, { wch: 26 }, { wch: 14 }, { wch: 8 }, { wch: 10 }];
  ws1['!views'] = [{ RTL: true }];
  XLSX.utils.book_append_sheet(wb, ws1, 'البرنامج الزمني');

  const s2 = [['رقم البند', 'الوصف', 'الوحدة', 'الكمية', 'سعر الوحدة', 'الإجمالي', 'النشاط المرتبط', 'المستوى']];
  for (const it of items) s2.push([it.code, it.desc, it.unitRaw || it.unit, it.qty, it.rate, Math.round(it.amount), TRADE[it.trade]?.name || '', it.levelOverride ?? it.level ?? 'تلقائي']);
  const ws2 = XLSX.utils.aoa_to_sheet(s2);
  ws2['!cols'] = [{ wch: 9 }, { wch: 50 }, { wch: 8 }, { wch: 10 }, { wch: 10 }, { wch: 14 }, { wch: 30 }, { wch: 10 }];
  ws2['!views'] = [{ RTL: true }];
  XLSX.utils.book_append_sheet(wb, ws2, 'ربط جدول الكميات');

  if (evm) {
    const s3 = [['المؤشر', 'القيمة'], ['تاريخ البيانات', evm.dataDate], ['قيمة العقد BAC', Math.round(evm.bac)], ['القيمة المخططة PV', Math.round(evm.pv)],
      ['القيمة المكتسبة EV', Math.round(evm.ev)], ['التكلفة الفعلية AC', evm.ac ? Math.round(evm.ac) : ''], ['نسبة الإنجاز المخططة %', +(evm.planPct * 100).toFixed(2)],
      ['نسبة الإنجاز الفعلية %', +(evm.actPct * 100).toFixed(2)], ['مؤشر أداء الجدول SPI', +evm.spi.toFixed(3)], ['مؤشر أداء التكلفة CPI', evm.cpi ? +evm.cpi.toFixed(3) : ''],
      ['التكلفة المتوقعة عند الإنجاز EAC', evm.eac ? Math.round(evm.eac) : ''], ['تاريخ الانتهاء المتوقع', evm.forecastFinish || '']];
    const ws3 = XLSX.utils.aoa_to_sheet(s3);
    ws3['!cols'] = [{ wch: 32 }, { wch: 18 }];
    ws3['!views'] = [{ RTL: true }];
    XLSX.utils.book_append_sheet(wb, ws3, 'مؤشرات الأداء');
  }
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
