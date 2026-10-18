// Xuất bảng kê mua vào / bán ra theo mẫu hoadon/bang_ke_mua_ban.xlsx
//   input/mua-vao  -> sheet tháng (T01, T02...) + Total
//   input/ban-ra   -> sheet Bán ra
// Kết quả: ket_qua/bang_ke_mua_ban_<ngày>_<giờ>.xlsx (mỗi lần chạy 1 file mới, chỉ thêm hóa đơn chưa có)
const path = require('path');
const fs = require('fs');
const { readFolder } = require('./lib/reader');
const { buildBangKe } = require('./lib/bangke');

const ROOT = __dirname;
const IN_DIR = process.env.BANGKE_IN || path.join(ROOT, 'input');
// File mẫu của bạn (nếu có) được ưu tiên; không có thì dùng bản mẫu định dạng của tool
const TEMPLATE = [path.join(ROOT, 'hoadon', 'bang_ke_mua_ban.xlsx'), path.join(ROOT, 'mau', 'bang_ke_mau.xlsx')].find((f) => fs.existsSync(f));
const OUT_DIR = process.env.BANGKE_OUT || path.join(ROOT, 'ket_qua');

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
  if (!TEMPLATE) throw new Error('Không thấy file mẫu (hoadon/bang_ke_mua_ban.xlsx hoặc mau/bang_ke_mau.xlsx)');
  return buildBangKe({ purchase, sold, templateFile: TEMPLATE, outDir: OUT_DIR, log });
}

if (require.main === module) {
  run().catch((e) => {
    console.error('LỖI:', e.message);
    process.exit(1);
  });
}

module.exports = { run };
