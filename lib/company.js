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

function remove(mst) {
  const arr = list();
  const next = arr.filter((c) => c.mst !== mst);
  if (next.length === arr.length) throw new Error(`Không có công ty ${mst} trong danh sách`);
  save(next);
}

// Đếm dữ liệu của công ty (để hiện trước khi xóa)
function stats(mst) {
  const p = paths(mst);
  const count = (dir, re) => {
    if (!fs.existsSync(dir)) return 0;
    let n = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) n += count(full, re);
      else if (re.test(e.name)) n++;
    }
    return n;
  };
  return {
    muaVao: count(path.join(p.inDir, 'mua-vao'), /\.(zip|xml)$/i),
    banRa: count(path.join(p.inDir, 'ban-ra'), /\.(zip|xml)$/i),
    bangKe: count(p.outDir, /\.xlsx$/i),
  };
}

// Cất toàn bộ dữ liệu của công ty vào da_xoa/<MST>_<ngày giờ>/ (không xóa hẳn, khôi phục được)
function archive(mst) {
  const p = paths(mst);
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const dest = path.join(ROOT, 'da_xoa', `${mst}_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}h${pad(d.getMinutes())}`);
  const moved = [];
  const failed = [];
  for (const [name, dir] of [['input', p.inDir], ['ket_qua', p.outDir], ['logs', p.logDir], ['trinh_duyet', p.profileDir]]) {
    if (!fs.existsSync(dir)) continue;
    const to = path.join(dest, name);
    fs.mkdirSync(dest, { recursive: true });
    try {
      fs.renameSync(dir, to);
      moved.push(name);
    } catch (e) {
      try {
        fs.cpSync(dir, to, { recursive: true });
        fs.rmSync(dir, { recursive: true, force: true });
        moved.push(name);
      } catch (e2) {
        failed.push(`${dir} (${e2.code || e2.message})`);
      }
    }
  }
  return { dest, moved, failed };
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

module.exports = { ROOT, validMst, list, find, add, setName, remove, stats, archive, paths, fromArgs, label };
