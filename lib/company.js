// Danh sách công ty và thư mục riêng của từng công ty (để dữ liệu các công ty không lẫn nhau)
//   input/<MST>/mua-vao, input/<MST>/ban-ra, ket_qua/<MST>, logs/<MST>, .browser-profiles/<MST>
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'cong_ty.json');

const validMst = (s) => /^\d{10}(-\d{3})?$/.test(String(s || '').trim());

function list() {
  try {
    const arr = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function save(arr) {
  fs.writeFileSync(FILE, JSON.stringify(arr, null, 2), 'utf8');
}

function find(mst) {
  return list().find((c) => c.mst === String(mst).trim()) || null;
}

function add(mst, ten) {
  mst = String(mst).trim();
  if (!validMst(mst)) throw new Error(`MST không hợp lệ: ${mst} (10 số, hoặc 10 số-3 số cho chi nhánh)`);
  const arr = list();
  if (arr.some((c) => c.mst === mst)) throw new Error(`Công ty ${mst} đã có trong danh sách`);
  const c = { mst, ten: String(ten || '').trim(), taoLuc: new Date().toISOString() };
  arr.push(c);
  save(arr);
  return c;
}

// Cập nhật tên công ty (vd lấy từ hóa đơn nếu lúc khai báo để trống)
function setName(mst, ten) {
  const arr = list();
  const c = arr.find((x) => x.mst === mst);
  if (c && ten && !c.ten) {
    c.ten = ten;
    save(arr);
  }
}

function paths(mst) {
  return {
    inDir: path.join(ROOT, 'input', mst),
    outDir: path.join(ROOT, 'ket_qua', mst),
    logDir: path.join(ROOT, 'logs', mst),
    profileDir: path.join(ROOT, '.browser-profiles', mst),
  };
}

// Đọc --mst=... từ dòng lệnh; trả về công ty đã khai báo
function fromArgs(argv = process.argv) {
  const a = argv.find((x) => x.startsWith('--mst='));
  if (!a) return null;
  const mst = a.slice(6).trim();
  const c = find(mst);
  if (!c) throw new Error(`Công ty ${mst} chưa được khai báo. Hãy thêm công ty trong menu.`);
  return c;
}

const label = (c) => `${c.mst}${c.ten ? ` - ${c.ten}` : ''}`;

module.exports = { ROOT, validMst, list, find, add, setName, paths, fromArgs, label };
