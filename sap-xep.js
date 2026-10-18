// Sắp xếp file hóa đơn tải tay của 1 công ty: bỏ file .xml/.zip vào input/<MST>/ (để lẫn cũng được),
// tool đọc XML rồi chuyển vào input/<MST>/ban-ra hoặc input/<MST>/mua-vao.
// File trùng chuyển vào input/<MST>/_trung; file không thuộc công ty / không đọc được thì để nguyên.
//   node sap-xep.js --mst=<MST>
const fs = require('fs');
const path = require('path');
const { readFile } = require('./lib/reader');
const company = require('./lib/company');

const KIND_DIRS = ['ban-ra', 'mua-vao'];
let comp;
try {
  comp = company.fromArgs();
} catch (e) {
  console.log(`LỖI: ${e.message}`);
  process.exit(1);
}
if (!comp) {
  console.log('Chưa chọn công ty. Hãy chạy qua menu TaiKeHoaDon.bat.');
  process.exit(1);
}
const mst = comp.mst;
const IN_DIR = company.paths(mst).inDir;
fs.mkdirSync(IN_DIR, { recursive: true });
console.log(`Công ty: ${company.label(comp)}`);
console.log(`Thư mục: ${IN_DIR}`);

function listFiles(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (!ent.name.startsWith('_')) listFiles(full, out);
    } else if (/\.(zip|xml)$/i.test(ent.name)) out.push(full);
  }
  return out;
}

const keyOf = (inv) => [inv.nban.mst, inv.khmshdon, inv.khhdon, inv.shdon].join('|');
const fileName = (inv, ext) => `${inv.nban.mst}_${inv.khmshdon}${inv.khhdon}_${inv.shdon}${ext}`;

const seen = new Map(); // key -> đường dẫn đã giữ
const stats = { 'ban-ra': 0, 'mua-vao': 0, trung: 0, khac: 0, loi: 0 };
const files = listFiles(IN_DIR);
// Xử lý file đã nằm đúng thư mục trước để chúng được giữ lại
files.sort((a, b) => Number(!KIND_DIRS.includes(path.basename(path.dirname(b))) ) - Number(!KIND_DIRS.includes(path.basename(path.dirname(a)))));

for (const full of files) {
  let invoices;
  try {
    invoices = readFile(full).invoices;
  } catch (e) {
    invoices = [];
  }
  if (invoices.length !== 1) {
    // 0 hóa đơn (lỗi) hoặc file chứa nhiều hóa đơn -> để nguyên
    stats[invoices.length ? 'khac' : 'loi']++;
    continue;
  }
  const inv = invoices[0];
  const kind = inv.nban.mst === mst ? 'ban-ra' : inv.nmua.mst === mst ? 'mua-vao' : null;
  if (!kind) {
    stats.khac++;
    continue;
  }
  const key = keyOf(inv);
  let dest;
  if (seen.has(key)) {
    dest = path.join(IN_DIR, '_trung', path.relative(IN_DIR, full).replace(/[\\/]/g, '__'));
    stats.trung++;
  } else {
    const inPlace = path.basename(path.dirname(full)) === kind && path.dirname(path.dirname(full)) === IN_DIR;
    dest = inPlace ? full : path.join(IN_DIR, kind, fileName(inv, path.extname(full)));
    seen.set(key, dest);
    stats[kind]++;
  }
  if (dest !== full) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(full, dest);
  }
}

// Xóa các thư mục con đã trống
function removeEmpty(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.name.startsWith('_') || (dir === IN_DIR && KIND_DIRS.includes(ent.name))) continue;
    const full = path.join(dir, ent.name);
    removeEmpty(full);
    if (!fs.readdirSync(full).length) fs.rmdirSync(full);
  }
}
removeEmpty(IN_DIR);

console.log(`Bán ra: ${stats['ban-ra']} | Mua vào: ${stats['mua-vao']} | Trùng (chuyển vào _trung): ${stats.trung}`);
if (stats.khac || stats.loi) console.log(`Để nguyên: ${stats.khac} file không thuộc MST trên, ${stats.loi} file không đọc được`);
