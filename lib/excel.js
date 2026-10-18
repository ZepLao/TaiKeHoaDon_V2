const ExcelJS = require('exceljs');

const TCHAT = {
  1: 'Hàng hóa, dịch vụ',
  2: 'Khuyến mại',
  3: 'Chiết khấu thương mại',
  4: 'Ghi chú, diễn giải',
};

// [tiêu đề, hàm lấy giá trị, độ rộng, kiểu]
const INVOICE_COLS = [
  ['Ký hiệu mẫu số', (i) => i.khmshdon, 10],
  ['Ký hiệu hóa đơn', (i) => i.khhdon, 12],
  ['Số hóa đơn', (i) => i.shdon, 11],
  ['Ngày lập', (i) => i.nlap, 12, 'date'],
  ['Ngày ký', (i) => i.nky, 17, 'datetime'],
  ['Mã của CQT', (i) => i.mccqt, 36],
  ['Tên hóa đơn', (i) => i.thdon, 25],
  ['MST người bán', (i) => i.nban.mst, 15],
  ['Tên người bán', (i) => i.nban.ten, 40],
  ['Địa chỉ người bán', (i) => i.nban.dchi, 40],
  ['SĐT người bán', (i) => i.nban.sdt, 14],
  ['Email người bán', (i) => i.nban.email, 22],
  ['STK người bán', (i) => i.nban.stk, 18],
  ['Ngân hàng người bán', (i) => i.nban.nhang, 25],
  ['MST người mua', (i) => i.nmua.mst, 15],
  ['Tên người mua', (i) => i.nmua.ten, 40],
  ['Địa chỉ người mua', (i) => i.nmua.dchi, 40],
  ['Họ tên người mua hàng', (i) => i.nmua.hvtnmhang, 22],
  ['Mã khách hàng', (i) => i.nmua.mkhang, 12],
  ['CCCD người mua', (i) => i.nmua.cccd, 14],
  ['SĐT người mua', (i) => i.nmua.sdt, 14],
  ['Email người mua', (i) => i.nmua.email, 22],
  ['STK người mua', (i) => i.nmua.stk, 18],
  ['Ngân hàng người mua', (i) => i.nmua.nhang, 25],
  ['Hình thức thanh toán', (i) => i.httt, 16],
  ['Đơn vị tiền tệ', (i) => i.dvtte, 8],
  ['Tỷ giá', (i) => i.tgia, 10, 'num'],
  ['Tổng tiền chưa thuế', (i) => i.tgtcthue, 16, 'money'],
  ['Tổng tiền thuế', (i) => i.tgtthue, 15, 'money'],
  ['Tổng tiền chiết khấu TM', (i) => i.ttcktmai, 15, 'money'],
  ['Tổng tiền phí', (i) => i.tgtphi, 13, 'money'],
  ['Tổng tiền thanh toán', (i) => i.tgtttbso, 17, 'money'],
  ['Số tiền bằng chữ', (i) => i.tgtttbchu, 45],
  ['Số dòng hàng', (i) => i.items.length, 8, 'num'],
  ['MST tổ chức cung cấp giải pháp', (i) => i.mstTCGP, 15],
  ['Thông tin khác', (i) => [i.ttkhac, i.nban.ttkhac, i.nmua.ttkhac, i.ttoanKhac].filter(Boolean).join('; ') || null, 40],
  ['File', (i) => i.file, 40],
];

const KEY_COLS = INVOICE_COLS.filter((c) =>
  ['Ký hiệu mẫu số', 'Ký hiệu hóa đơn', 'Số hóa đơn', 'Ngày lập', 'MST người bán', 'Tên người bán', 'MST người mua', 'Tên người mua'].includes(c[0]),
);

const ITEM_COLS = [
  ['STT dòng', (h) => h.stt, 8, 'num'],
  ['Tính chất', (h) => TCHAT[h.tchat] || h.tchat, 18],
  ['Mã hàng hóa', (h) => h.ma, 14],
  ['Tên hàng hóa, dịch vụ', (h) => h.ten, 45],
  ['Đơn vị tính', (h) => h.dvt, 10],
  ['Số lượng', (h) => h.sluong, 11, 'num'],
  ['Đơn giá', (h) => h.dgia, 15, 'money'],
  ['Tỷ lệ CK (%)', (h) => h.tlckhau, 9, 'num'],
  ['Số tiền chiết khấu', (h) => h.stckhau, 14, 'money'],
  ['Thành tiền chưa thuế', (h) => h.thtien, 16, 'money'],
  ['Thuế suất', (h) => h.tsuat, 9],
  ['Tiền thuế', (h) => h.tthue, 14, 'money'],
  ['Thông tin khác (dòng)', (h) => h.ttkhac, 30],
];

const RATE_COLS = [
  ['Thuế suất', (r) => r.tsuat, 10],
  ['Thành tiền chưa thuế', (r) => r.thtien, 16, 'money'],
  ['Tiền thuế', (r) => r.tthue, 15, 'money'],
];

// NLap dạng yyyy-mm-dd; SigningTime dạng yyyy-mm-ddThh:mm:ss (giờ VN)
function toDate(v, withTime) {
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2}))?/.exec(v);
  if (!m) return v;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], withTime ? +(m[4] || 0) : 0, withTime ? +(m[5] || 0) : 0, withTime ? +(m[6] || 0) : 0));
}

function value(col, obj) {
  const v = col[1](obj);
  if (v === undefined || v === null || v === '') return null;
  if (col[3] === 'date') return toDate(v, false);
  if (col[3] === 'datetime') return toDate(v, true);
  return v;
}

const FMT = { date: 'dd/mm/yyyy', datetime: 'dd/mm/yyyy hh:mm:ss', money: '#,##0.##', num: '#,##0.####' };

function addSheet(wb, name, cols, rows) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = cols.map(([header, , width, type]) => ({ header, width: width || 15, style: FMT[type] ? { numFmt: FMT[type] } : {} }));
  for (const r of rows) ws.addRow(r);
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
  head.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  head.height = 32;
  if (rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
}

const STT = ['STT', () => null, 6];
const STT_HD = ['STT HĐ', () => null, 7];

function addGroup(wb, prefix, invoices) {
  addSheet(wb, `${prefix} - Danh sach`, [STT, ...INVOICE_COLS], invoices.map((inv, i) => [i + 1, ...INVOICE_COLS.map((c) => value(c, inv))]));

  const itemRows = [];
  const rateRows = [];
  invoices.forEach((inv, i) => {
    const key = KEY_COLS.map((c) => value(c, inv));
    for (const h of inv.items) itemRows.push([i + 1, ...key, ...ITEM_COLS.map((c) => value(c, h))]);
    for (const r of inv.rates) rateRows.push([i + 1, ...key, ...RATE_COLS.map((c) => value(c, r))]);
  });
  addSheet(wb, `${prefix} - Chi tiet hang hoa`, [STT_HD, ...KEY_COLS, ...ITEM_COLS], itemRows);
  addSheet(wb, `${prefix} - Theo thue suat`, [STT_HD, ...KEY_COLS, ...RATE_COLS], rateRows);
}

async function writeWorkbook(file, { sold, purchase, other, errors }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'tool_data_hoadon';
  wb.created = new Date();
  if (sold.length) addGroup(wb, 'Ban ra', sold);
  if (purchase.length) addGroup(wb, 'Mua vao', purchase);
  if (other.length) addGroup(wb, 'Khac', other);
  if (errors.length) {
    addSheet(wb, 'Loi doc file', [['File', null, 60], ['Lỗi', null, 60]], errors.map((e) => [e.file, e.error]));
  }
  await wb.xlsx.writeFile(file);
}

module.exports = { writeWorkbook };
