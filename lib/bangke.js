// Ghi hóa đơn vào bảng kê theo mẫu hoadon/bang_ke_mua_ban.xlsx:
//  - Mỗi tháng 1 file riêng, gồm sheet tháng (vd T09) và "Total": hóa đơn MUA VÀO của tháng đó
//  - Sheet "Bán ra": hóa đơn BÁN RA
// Mỗi lần chạy mở file gần nhất của tháng đó (chưa có: dùng định dạng file mẫu, không lấy dữ liệu cũ),
// chỉ thêm hóa đơn chưa có, rồi lưu thành file mới có ngày giờ.
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const PURCHASE = {
  cols: 15, // A..O
  mergeTo: 9, // "TỔNG CỘNG" gộp A..I
  sumCols: [12, 14, 15], // L, N, O
  dateCol: 4,
  extraCols: 0,
};
const SOLD = {
  cols: 16, // A..P
  mergeTo: 6, // A..F
  sumCols: [13, 15, 16], // M, O, P
  dateCol: 5,
  extraCols: 2, // Q, R: công thức phụ của mẫu
};

const MONTH_RE = /^T(\d{2})(?:-(\d{4}))?$/;
const pad = (n) => String(n).padStart(2, '0');
const nfc = (s) => String(s || '').normalize('NFC').trim().toLowerCase();

// ---------- chuẩn hóa để so trùng ----------
const normKH = (v) => {
  const s = String(v ?? '').trim().toUpperCase();
  return /^\d[A-Z0-9]{6}$/.test(s) ? s.slice(1) : s; // "1C26TMW" -> "C26TMW"
};
const normSo = (v) => Number(String(v ?? '').replace(/\D/g, '')) || 0;
const normMST = (v) => String(v ?? '').trim().replace(/^0+/, '').toUpperCase();
const purchaseKey = (kh, so, mst) => `${normKH(kh)}|${normSo(so)}|${normMST(mst)}`;
const soldKey = (kh, so) => `${normKH(kh)}|${normSo(so)}`;

// ---------- đọc giá trị ô ----------
function plain(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if ('result' in v) return v.result ?? null;
    if (v.formula || v.sharedFormula) return null;
    if (v.text) return v.text;
  }
  return v;
}
function toDate(v) {
  v = plain(v);
  if (v instanceof Date) return v;
  if (typeof v === 'number') return new Date(Math.round((v - 25569) * 86400000)); // số serial Excel
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(v || ''));
  if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || ''));
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return null;
}
const isTotalCell = (v) => {
  const p = plain(v);
  if (typeof p === 'string' && nfc(p) === nfc('TỔNG CỘNG')) return true;
  return !!(v && typeof v === 'object' && /^SUM\(/i.test(v.formula || ''));
};
const cloneStyle = (s) => JSON.parse(JSON.stringify(s || {}));

// ---------- đọc sheet hiện có ----------
function readSheet(ws, layout) {
  const ncols = layout.cols + layout.extraCols;
  let totalRow = null;
  for (let r = 2; r <= ws.rowCount && !totalRow; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= layout.cols; c++) if (isTotalCell(row.getCell(c).value)) totalRow = r;
  }
  const end = totalRow ? totalRow - 1 : ws.rowCount;
  const rows = [];
  let firstDataRow = null;
  for (let r = 2; r <= end; r++) {
    const row = ws.getRow(r);
    const cells = [];
    let has = false;
    for (let c = 1; c <= ncols; c++) {
      const cell = row.getCell(c);
      let v = cell.value;
      if (cell.type === ExcelJS.ValueType.Formula) v = { formula: cell.formula, result: plain(v), fromRow: r };
      cells.push(v);
      if (c <= layout.cols && plain(v) !== null && plain(v) !== '') has = true;
    }
    if (has) {
      rows.push({ cells, date: toDate(cells[layout.dateCol - 1]), height: row.height });
      firstDataRow = firstDataRow || r;
    }
  }
  // Định dạng lấy từ dòng dữ liệu đầu tiên (hoặc dòng 2 đã kẻ sẵn khung)
  const styleRow = firstDataRow || (ws.rowCount >= 2 && (!totalRow || totalRow > 2) ? 2 : null);
  const style = (r) => (r ? Array.from({ length: ncols }, (_, i) => cloneStyle(ws.getRow(r).getCell(i + 1).style)) : null);
  const hasBorder = (st) => st && st.some((s) => s.border && Object.keys(s.border).length);
  const ds = style(styleRow);
  return {
    rows,
    totalRow,
    lastRow: ws.rowCount,
    dataStyle: hasBorder(ds) ? ds : null,
    totalStyle: style(totalRow),
  };
}

// Bản thiết kế của 1 sheet (độ rộng cột, tiêu đề, định dạng) để tạo sheet mới cùng kiểu
function captureSpec(ws, layout, info) {
  const ncols = layout.cols + layout.extraCols;
  const head = ws.getRow(1);
  return {
    widths: Array.from({ length: ncols }, (_, i) => ws.getColumn(i + 1).width),
    header: Array.from({ length: ncols }, (_, i) => ({ value: head.getCell(i + 1).value, style: cloneStyle(head.getCell(i + 1).style) })),
    headerHeight: head.height,
    views: (ws.views || []).map((v) => ({ state: v.state, xSplit: v.xSplit, ySplit: v.ySplit, topLeftCell: 'A2', activeCell: 'A2' })),
    dataStyle: info.dataStyle,
    totalStyle: info.totalStyle,
  };
}

function createSheet(wb, name, spec) {
  const ws = wb.addWorksheet(name, { views: spec.views });
  spec.widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));
  const head = ws.getRow(1);
  spec.header.forEach((h, i) => {
    head.getCell(i + 1).value = h.value;
    head.getCell(i + 1).style = cloneStyle(h.style);
  });
  if (spec.headerHeight) head.height = spec.headerHeight;
  return ws;
}

// ---------- hóa đơn XML -> dòng ----------
const rateNum = (s) => {
  const m = /^(\d+(?:[.,]\d+)?)\s*%$/.exec(String(s || '').trim());
  return m ? Number(m[1].replace(',', '.')) / 100 : null;
};
const round = (n) => Math.round(n);

// Các dòng hàng của 1 hóa đơn: { ten, dvt, sl, dgia, thtien, tsuat, tthue, tong }
function invoiceLines(inv) {
  let lines = inv.items.map((h) => {
    const sign = h.tchat === 3 ? -1 : 1; // chiết khấu thương mại -> số âm
    const thtien = typeof h.thtien === 'number' ? h.thtien * sign : 0;
    const rate = rateNum(h.tsuat);
    const tthue = typeof h.tthue === 'number' ? h.tthue * sign : rate !== null ? round(thtien * rate) : 0;
    return { ten: h.ten, dvt: h.dvt, sl: h.sluong, dgia: h.dgia, thtien, tsuat: h.tsuat, tthue };
  });
  if (!lines.length) {
    // Hóa đơn không có dòng hàng: ghi theo từng mức thuế suất
    lines = (inv.rates.length ? inv.rates : [{ tsuat: null, thtien: inv.tgtcthue, tthue: inv.tgtthue }]).map((r) => ({
      ten: null, dvt: null, sl: null, dgia: null, thtien: r.thtien || 0, tsuat: r.tsuat, tthue: r.tthue || 0,
    }));
  } else {
    // Cân lại tiền thuế cho khớp tổng thuế từng mức thuế suất trên hóa đơn (lệch do làm tròn)
    for (const r of inv.rates) {
      if (typeof r.tthue !== 'number') continue;
      const group = lines.filter((l) => l.tsuat === r.tsuat);
      if (!group.length) continue;
      const diff = r.tthue - group.reduce((s, l) => s + l.tthue, 0);
      if (diff && Math.abs(diff) <= Math.max(5, group.length)) {
        group.reduce((a, b) => (Math.abs(b.thtien) > Math.abs(a.thtien) ? b : a)).tthue += diff;
      }
    }
  }
  for (const l of lines) l.tong = l.thtien + l.tthue;
  return lines;
}

const nlapDate = (inv) => toDate(inv.nlap);
const fmtVN = (d) => (d ? `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}` : null);
const rateCell = (s) => (rateNum(s) !== null ? rateNum(s) : s || null); // "8%" -> 0.08 (định dạng 0%)

function purchaseRows(inv) {
  const date = nlapDate(inv);
  return invoiceLines(inv).map((l) => ({
    date,
    cells: [
      Number(inv.khmshdon) || inv.khmshdon, inv.khhdon, normSo(inv.shdon) || inv.shdon, date,
      inv.nban.ten, inv.nban.mst, inv.nban.dchi,
      l.ten, l.dvt, l.sl, l.dgia, l.thtien, rateCell(l.tsuat), l.tthue, l.tong,
    ],
  }));
}

function soldRows(inv) {
  const date = nlapDate(inv);
  return invoiceLines(inv).map((l) => {
    const canMul = typeof l.sl === 'number' && typeof l.dgia === 'number' && Math.abs(l.sl * l.dgia - l.thtien) < 0.01;
    return {
      date,
      cells: [
        null, Number(inv.khmshdon) || inv.khmshdon, `${inv.khmshdon}${inv.khhdon}`, inv.shdon, fmtVN(date),
        inv.nmua.ten || inv.nmua.hvtnmhang, inv.nmua.mst, inv.nmua.dchi,
        l.ten, l.dvt, l.sl, l.dgia, canMul ? { formula: 'K{r}*L{r}', result: l.thtien } : l.thtien,
        l.tsuat, l.tthue, l.tong,
        { formula: 'ROUND((M{r}*10%),0)', result: round(l.thtien * 0.1) },
        { formula: 'Q{r}-O{r}', result: round(l.thtien * 0.1) - l.tthue },
      ],
    };
  });
}

// ---------- ghi lại vùng dữ liệu của sheet ----------
function colLetter(n) {
  let s = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// Công thức của dòng cũ -> đổi số dòng sang vị trí mới; công thức mẫu dùng {r}
function formulaAt(v, r) {
  if (v.fromRow) return v.formula.replace(/(\$?[A-Z]{1,3})(\$?)(\d+)\b/g, (m, col, d, num) => (Number(num) === v.fromRow ? `${col}${d}${r}` : m));
  return v.formula.replace(/\{r\}/g, r);
}

function writeSheet(ws, layout, rows, styles, oldInfo) {
  const ncols = layout.cols + layout.extraCols;
  // Bỏ gộp ô & xóa vùng cũ (giữ dòng tiêu đề)
  for (const m of Object.values(ws._merges || {})) {
    if (m.top >= 2) ws.unMergeCells(m.range);
  }
  const clearTo = Math.max(oldInfo.lastRow, oldInfo.totalRow || 0, rows.length + 2);
  for (let r = 2; r <= clearTo; r++) {
    const row = ws.getRow(r);
    row.height = undefined;
    for (let c = 1; c <= ncols; c++) {
      const cell = row.getCell(c);
      cell.value = null;
      cell.style = {};
    }
  }

  rows.forEach((item, i) => {
    const r = i + 2;
    const row = ws.getRow(r);
    if (item.height) row.height = item.height;
    item.cells.forEach((v, c) => {
      const cell = row.getCell(c + 1);
      if (styles.dataStyle && styles.dataStyle[c]) cell.style = cloneStyle(styles.dataStyle[c]);
      cell.value = v && typeof v === 'object' && v.formula ? { formula: formulaAt(v, r), result: v.result ?? undefined } : v ?? null;
    });
    if (layout === SOLD) row.getCell(1).value = i + 1; // STT
  });

  // Dòng TỔNG CỘNG
  const tr = rows.length + 2;
  const trow = ws.getRow(tr);
  for (let c = 1; c <= layout.cols; c++) {
    const cell = trow.getCell(c);
    cell.style = cloneStyle((styles.totalStyle && styles.totalStyle[c - 1]) || { font: { bold: true, name: 'Times New Roman', size: 12 } });
    if (c <= layout.mergeTo) cell.value = 'TỔNG CỘNG';
  }
  ws.mergeCells(2 + rows.length, 1, 2 + rows.length, layout.mergeTo);
  for (const c of layout.sumCols) {
    const L = colLetter(c);
    const sum = rows.reduce((s, it) => s + (Number(plain(it.cells[c - 1])) || 0), 0);
    trow.getCell(c).value = rows.length ? { formula: `SUM(${L}2:${L}${tr - 1})`, result: sum } : 0;
  }
  // Vùng lọc trải hết dữ liệu (như sheet Total của mẫu) thì nới theo số dòng mới
  const af = typeof ws.autoFilter === 'string' ? /^([A-Z]+)1:([A-Z]+)(\d+)$/.exec(ws.autoFilter) : null;
  if (af && Number(af[3]) > 1) ws.autoFilter = `${af[1]}1:${af[2]}${tr}`;
}

// ---------- chương trình chính ----------
// Mỗi tháng 1 file: bang_ke_mua_ban_T09-2026_<ngày>_<giờ>.xlsx gồm sheet T09, Total, Bán ra của riêng tháng đó
const monthTag = (y, m) => `T${pad(m)}-${y}`;

function findLatest(outDir, tag) {
  if (!fs.existsSync(outDir)) return null;
  const re = new RegExp(`^bang_ke_mua_ban_${tag}_.*\\.xlsx$`, 'i');
  const files = fs
    .readdirSync(outDir)
    .filter((f) => re.test(f) && !f.startsWith('~$'))
    .map((f) => path.join(outDir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0] || null;
}

async function buildMonth({ y, m, purchase, sold, templateFile, outDir, log }) {
  const tag = monthTag(y, m);
  const latest = findLatest(outDir, tag);
  const fromTemplate = !latest;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(latest || templateFile);

  // Phân loại sheet
  const monthSheets = [];
  let totalWs = null;
  let soldWs = null;
  for (const ws of wb.worksheets) {
    if (MONTH_RE.test(ws.name)) monthSheets.push(ws);
    else if (nfc(ws.name) === 'total') totalWs = ws;
    else if (nfc(ws.name) === nfc('Bán ra')) soldWs = ws;
  }
  if (!monthSheets.length && !totalWs) throw new Error('File không có sheet tháng (T01..T12) hoặc "Total" để làm mẫu');
  if (!soldWs) throw new Error('File không có sheet "Bán ra"');

  // Định dạng sheet tháng lấy từ sheet tháng có dữ liệu (vd T04 của file mẫu)
  const monthInfos = monthSheets.map((ws) => ({ ws, info: readSheet(ws, PURCHASE) }));
  const model = monthInfos.find((x) => x.info.dataStyle && x.info.totalStyle) || monthInfos[0] || { ws: totalWs, info: readSheet(totalWs, PURCHASE) };
  const monthSpec = captureSpec(model.ws, PURCHASE, model.info);

  const sheetName = `T${pad(m)}`;
  const sheets = new Map(); // 'month' | 'total' | 'sold' -> { ws, layout, info, rows, added }
  let monthEntry;
  const own = fromTemplate ? null : monthInfos.find((x) => x.ws.name === sheetName || x.ws.name === `${sheetName}-${y}`);
  if (!own) {
    // File mẫu: bỏ hết sheet tháng ví dụ, tạo sheet của tháng cần ghi theo đúng định dạng
    for (const x of monthInfos) wb.removeWorksheet(x.ws.id);
    const ws = createSheet(wb, sheetName, monthSpec);
    monthEntry = { ws, layout: PURCHASE, info: { rows: [], lastRow: 1, totalRow: null, dataStyle: monthSpec.dataStyle, totalStyle: monthSpec.totalStyle }, rows: [], added: 0 };
  } else {
    monthEntry = { ws: own.ws, layout: PURCHASE, info: own.info, rows: own.info.rows, added: 0 };
  }
  sheets.set('month', monthEntry);
  const load = (key, ws, layout) => {
    const info = readSheet(ws, layout);
    if (fromTemplate) info.rows = []; // file tháng mới: không lấy dữ liệu cũ
    sheets.set(key, { ws, layout, info, rows: info.rows, added: 0 });
  };
  if (totalWs) load('total', totalWs, PURCHASE);
  load('sold', soldWs, SOLD);

  // Chỉ mục hóa đơn đã có trong từng sheet
  const keysOf = (entry) => {
    const set = new Set();
    for (const r of entry.rows) {
      const c = r.cells;
      if (entry.layout === SOLD) set.add(soldKey(c[2], c[3]));
      else {
        set.add(purchaseKey(c[1], c[2], plain(c[5])));
        if (!plain(c[5])) set.add(purchaseKey(c[1], c[2], ''));
      }
    }
    return set;
  };
  const keyIndex = new Map([...sheets].map(([n, e]) => [n, keysOf(e)]));
  const has = (key, inv) => {
    const set = keyIndex.get(key);
    if (sheets.get(key).layout === SOLD) return set.has(soldKey(inv.khhdon, inv.shdon));
    return set.has(purchaseKey(inv.khhdon, inv.shdon, inv.nban.mst)) || set.has(purchaseKey(inv.khhdon, inv.shdon, ''));
  };
  let seq = 1e9; // thứ tự thêm vào (dòng cũ giữ thứ tự trước)
  const add = (key, rows) => {
    const e = sheets.get(key);
    for (const r of rows) e.rows.push({ ...r, seq: seq++ });
    e.added++;
    keyIndex.set(key, keysOf(e));
  };

  // MUA VÀO -> sheet tháng + Total
  const stat = { tag, muaMoi: 0, muaCo: 0, banMoi: 0, banCo: 0 };
  for (const inv of purchase) {
    let isNew = false;
    if (!has('month', inv)) {
      add('month', purchaseRows(inv));
      isNew = true;
    }
    if (sheets.has('total') && !has('total', inv)) {
      add('total', purchaseRows(inv));
      isNew = true;
    }
    stat[isNew ? 'muaMoi' : 'muaCo']++;
  }
  // Total chứa đủ các dòng của sheet tháng (vd: dòng nhập tay)
  if (sheets.has('total')) {
    const total = sheets.get('total');
    const totalKeys = keyIndex.get('total');
    const synced = new Set();
    for (const r of monthEntry.rows) {
      const k = purchaseKey(r.cells[1], r.cells[2], plain(r.cells[5]));
      if (totalKeys.has(k)) continue;
      total.rows.push({ ...r, cells: r.cells.map((v) => (v && v.fromRow ? { ...v } : v)), seq: seq++ });
      synced.add(k);
    }
    synced.forEach((k) => totalKeys.add(k));
  }

  // BÁN RA
  for (const inv of sold) {
    if (has('sold', inv)) {
      stat.banCo++;
      continue;
    }
    add('sold', soldRows(inv));
    stat.banMoi++;
  }

  if (!fromTemplate && !stat.muaMoi && !stat.banMoi) {
    log(`${tag}: không có hóa đơn mới (đã có ${stat.muaCo} mua vào, ${stat.banCo} bán ra) -> không tạo file`);
    return { ...stat, file: null };
  }

  // Sắp xếp: mua vào theo ngày tăng dần, bán ra theo ngày & số giảm dần (giống mẫu)
  const t = (r) => (r.date ? r.date.getTime() : 0);
  for (const [, e] of sheets) {
    e.rows.forEach((r, i) => (r.seq = r.seq ?? i));
    if (e.layout === SOLD) e.rows.sort((a, b) => t(b) - t(a) || normSo(b.cells[3]) - normSo(a.cells[3]) || a.seq - b.seq);
    else e.rows.sort((a, b) => t(a) - t(b) || a.seq - b.seq);
  }
  for (const [, e] of sheets) {
    const styles = { dataStyle: e.info.dataStyle || monthSpec.dataStyle, totalStyle: e.info.totalStyle || monthSpec.totalStyle };
    writeSheet(e.ws, e.layout, e.rows, styles, e.info);
  }

  // Thứ tự sheet: tháng, Total, Bán ra, rồi các sheet khác
  const first = [monthEntry.ws, totalWs, soldWs].filter(Boolean);
  [...first, ...wb.worksheets.filter((w) => !first.includes(w))].forEach((w, i) => (w.orderNo = i));

  wb.calcProperties = { ...(wb.calcProperties || {}), fullCalcOnLoad: true };
  fs.mkdirSync(outDir, { recursive: true });
  const now = new Date();
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}h${pad(now.getMinutes())}`;
  let file = path.join(outDir, `bang_ke_mua_ban_${tag}_${stamp}.xlsx`);
  for (let i = 2; fs.existsSync(file); i++) file = path.join(outDir, `bang_ke_mua_ban_${tag}_${stamp}_${i}.xlsx`);
  await wb.xlsx.writeFile(file);

  log(`${tag}: mua vào +${stat.muaMoi} mới (${stat.muaCo} đã có), bán ra +${stat.banMoi} mới (${stat.banCo} đã có)${latest ? '' : ' [file tháng mới]'}`);
  log(`   -> ${file}`);
  return { ...stat, file };
}

// Chia hóa đơn theo tháng của ngày lập, mỗi tháng xuất 1 file
async function buildBangKe({ purchase, sold, templateFile, outDir, log = console.log }) {
  const groups = new Map();
  const put = (inv, kind) => {
    const d = nlapDate(inv);
    if (!d) return log(`  Bỏ qua hóa đơn không có ngày lập: ${inv.file}`);
    const key = d.getUTCFullYear() * 100 + d.getUTCMonth() + 1;
    if (!groups.has(key)) groups.set(key, { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, purchase: [], sold: [] });
    groups.get(key)[kind].push(inv);
  };
  purchase.forEach((i) => put(i, 'purchase'));
  sold.forEach((i) => put(i, 'sold'));

  const results = [];
  for (const key of [...groups.keys()].sort((a, b) => a - b)) {
    results.push(await buildMonth({ ...groups.get(key), templateFile, outDir, log }));
  }
  if (!results.length) log('Không có hóa đơn nào để xuất.');
  return results;
}

module.exports = { buildBangKe };
