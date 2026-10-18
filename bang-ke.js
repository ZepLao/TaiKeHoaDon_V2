// Xuất bảng kê mua vào / bán ra theo mẫu, mỗi tháng 1 file:
//   input/mua-vao  -> sheet tháng (vd T09) + Total
//   input/ban-ra   -> sheet Bán ra
//   + sheet Kiểm tra (số lượng, tổng hợp thuế suất, cảnh báo)
// Kết quả: ket_qua/bang_ke_mua_ban_T09-2026_<ngày>_<giờ>.xlsx (chạy lại chỉ thêm hóa đơn chưa có)
const path = require('path');
const fs = require('fs');
const { readFolder } = require('./lib/reader');
const { buildBangKe } = require('./lib/bangke');
const status = require('./lib/status');
const { createLog } = require('./lib/log');

const ROOT = __dirname;
const IN_DIR = process.env.BANGKE_IN || path.join(ROOT, 'input');
// File mẫu của bạn (nếu có) được ưu tiên; không có thì dùng bản mẫu định dạng của tool
const TEMPLATE = [path.join(ROOT, 'hoadon', 'bang_ke_mua_ban.xlsx'), path.join(ROOT, 'mau', 'bang_ke_mau.xlsx')].find((f) => fs.existsSync(f));
const OUT_DIR = process.env.BANGKE_OUT || path.join(ROOT, 'ket_qua');

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
};

async function run(log = console.log) {
  const read = (sub) => {
    const dir = path.join(IN_DIR, sub);
    if (!fs.existsSync(dir)) return [];
    const r = readFolder(dir);
    log(`Đọc ${sub}: ${r.invoices.length} hóa đơn từ ${r.fileCount} file${r.errors.length ? `, ${r.errors.length} file lỗi` : ''}`);
    for (const e of r.errors.slice(0, 5)) log(`  Lỗi: ${e.file}: ${e.error}`);
    return r.invoices;
  };
  const purchase = read('mua-vao');
  const sold = read('ban-ra');
  const kinds = ['mua-vao', 'ban-ra'];
  const statusMaps = Object.fromEntries(kinds.map((k) => [k, status.load(path.join(IN_DIR, k))]));
  const counts = Object.fromEntries(kinds.map((k) => [k, readJson(path.join(IN_DIR, k, '_so_luong.json'))]));
  if (!TEMPLATE) throw new Error('Không thấy file mẫu (hoadon/bang_ke_mua_ban.xlsx hoặc mau/bang_ke_mau.xlsx)');
  return buildBangKe({ purchase, sold, templateFile: TEMPLATE, outDir: OUT_DIR, log, statusMaps, counts });
}

if (require.main === module) {
  const log = createLog('bang-ke');
  run(log)
    .then(() => log(`\nNhật ký: ${log.file}`))
    .catch((e) => {
      log(`LỖI: ${e.message}`);
      process.exit(1);
    });
}

module.exports = { run };
