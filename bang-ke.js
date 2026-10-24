// Xuất bảng kê mua vào / bán ra của 1 công ty theo mẫu, mỗi tháng 1 file:
//   input/<MST>/mua-vao  -> sheet tháng (vd T09) + Total
//   input/<MST>/ban-ra   -> sheet Bán ra
//   + sheet Kiểm tra (số lượng, tổng hợp thuế suất, cảnh báo)
// Kết quả: ket_qua/<MST>/bang_ke_mua_ban_T09-2026_<ngày>_<giờ>.xlsx (chạy lại chỉ thêm hóa đơn chưa có)
//   node bang-ke.js --mst=<MST>
const path = require('path');
const fs = require('fs');
const { readFolder } = require('./lib/reader');
const { buildBangKe } = require('./lib/bangke');
const status = require('./lib/status');
const company = require('./lib/company');
const { createLog } = require('./lib/log');

const ROOT = __dirname;
// File mẫu của bạn (nếu có) được ưu tiên; không có thì dùng bản mẫu định dạng của tool
const TEMPLATE = [path.join(ROOT, 'hoadon', 'bang_ke_mua_ban.xlsx'), path.join(ROOT, 'mau', 'bang_ke_mau.xlsx')].find((f) => fs.existsSync(f));

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
};

async function run(log = console.log, comp = company.fromArgs()) {
  if (!comp) throw new Error('Chưa chọn công ty. Hãy chạy qua menu TaiKeHoaDon.bat.');
  const p = company.paths(comp.mst);
  const IN_DIR = process.env.BANGKE_IN || p.inDir;
  const OUT_DIR = process.env.BANGKE_OUT || p.outDir;
  log(`Bảng kê công ty ${company.label(comp)}`);

  // Chỉ lấy hóa đơn của đúng công ty: mua vào -> bên mua là công ty; bán ra -> bên bán là công ty
  const read = (sub) => {
    const dir = path.join(IN_DIR, sub);
    if (!fs.existsSync(dir)) return [];
    const r = readFolder(dir);
    const own = (inv) => (sub === 'ban-ra' ? inv.nban.mst : inv.nmua.mst) === comp.mst;
    const mine = r.invoices.filter(own);
    const other = r.invoices.filter((i) => !own(i));
    log(`Đọc ${sub}: ${mine.length} hóa đơn từ ${r.fileCount} file${r.errors.length ? `, ${r.errors.length} file lỗi` : ''}`);
    for (const e of r.errors.slice(0, 5)) log(`  Lỗi: ${e.file}: ${e.error}`);
    if (other.length) {
      log(`  CẢNH BÁO: bỏ qua ${other.length} hóa đơn không thuộc công ty ${comp.mst} trong ${dir}:`);
      for (const i of other.slice(0, 5)) log(`    - ${i.file} (người bán ${i.nban.mst}, người mua ${i.nmua.mst})`);
    }
    return mine;
  };
  const purchase = read('mua-vao');
  const sold = read('ban-ra');
  const ten = (purchase[0] && purchase[0].nmua.ten) || (sold[0] && sold[0].nban.ten);
  if (ten) company.setName(comp.mst, ten);

  const kinds = ['mua-vao', 'ban-ra'];
  const statusMaps = Object.fromEntries(kinds.map((k) => [k, status.load(path.join(IN_DIR, k))]));
  const noXmlMaps = Object.fromEntries(kinds.map((k) => [k, readJson(path.join(IN_DIR, k, '_khong_co_xml.json'))]));
  const counts = Object.fromEntries(kinds.map((k) => [k, readJson(path.join(IN_DIR, k, '_so_luong.json'))]));
  if (!TEMPLATE) throw new Error('Không thấy file mẫu (hoadon/bang_ke_mua_ban.xlsx hoặc mau/bang_ke_mau.xlsx)');
  return buildBangKe({ purchase, sold, templateFile: TEMPLATE, outDir: OUT_DIR, log, statusMaps, noXmlMaps, counts });
}

if (require.main === module) {
  let comp;
  try {
    comp = company.fromArgs();
  } catch (e) {
    console.error(`LỖI: ${e.message}`);
    process.exit(1);
  }
  const log = createLog('bang-ke', comp ? company.paths(comp.mst).logDir : undefined);
  run(log, comp)
    .then(() => log(`\nNhật ký: ${log.file}`))
    .catch((e) => {
      log(`LỖI: ${e.message}`);
      process.exit(1);
    });
}

module.exports = { run };
