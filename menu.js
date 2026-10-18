// Menu chính của TaiKeHoaDon: chọn / khai báo công ty, rồi chọn việc cần làm cho công ty đó.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync, spawn } = require('child_process');
const company = require('./lib/company');
const { readFolder, guessOwnMst } = require('./lib/reader');

const ROOT = __dirname;

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) =>
    rl.question(q, (a) => {
      rl.close();
      r(String(a || '').trim());
    }),
  );
}
const pause = () => ask('\nNhấn Enter để quay lại menu...');
const openFolder = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  spawn('explorer', [dir], { detached: true, stdio: 'ignore' }).unref();
};
const runScript = (script, args) => spawnSync(process.execPath, [path.join(ROOT, script), ...args], { stdio: 'inherit', cwd: ROOT });

// ---------- chuyển dữ liệu kiểu cũ (input/mua-vao, input/ban-ra) vào thư mục của công ty ----------
function moveInto(src, dest) {
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(dest, { recursive: true });
  let n = 0;
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name);
    let to = path.join(dest, name);
    if (fs.existsSync(to)) {
      if (fs.statSync(from).isDirectory()) {
        n += moveInto(from, to);
        continue;
      }
      const ext = path.extname(name);
      to = path.join(dest, `${path.basename(name, ext)}_cu${ext}`);
    }
    fs.renameSync(from, to);
    n++;
  }
  if (!fs.readdirSync(src).length) fs.rmdirSync(src);
  return n;
}

async function migrateLegacy() {
  const old = ['mua-vao', 'ban-ra'].map((k) => path.join(ROOT, 'input', k)).filter((d) => fs.existsSync(d));
  if (!old.length) return;
  const invs = old.flatMap((d) => readFolder(d).invoices);
  const mst = guessOwnMst(invs);
  console.log('\nPhát hiện dữ liệu kiểu cũ (chưa chia theo công ty):');
  old.forEach((d) => console.log(`  ${d}`));
  if (!mst) {
    console.log('Không xác định được MST từ các hóa đơn này — để nguyên.');
    return;
  }
  const ten = (invs.find((i) => i.nmua.mst === mst) || {}).nmua?.ten || (invs.find((i) => i.nban.mst === mst) || {}).nban?.ten || '';
  console.log(`=> ${invs.length} hóa đơn, thuộc công ty ${mst}${ten ? ` - ${ten}` : ''}`);
  const a = (await ask('Chuyển dữ liệu này vào thư mục riêng của công ty đó? (c = có / k = không) [c]: ')).toLowerCase();
  if (a === 'k') return;
  if (!company.find(mst)) company.add(mst, ten);
  const p = company.paths(mst);
  let n = 0;
  for (const k of ['mua-vao', 'ban-ra', '_trung']) n += moveInto(path.join(ROOT, 'input', k), path.join(p.inDir, k));
  // bảng kê cũ
  const kq = path.join(ROOT, 'ket_qua');
  if (fs.existsSync(kq)) {
    fs.mkdirSync(p.outDir, { recursive: true });
    for (const f of fs.readdirSync(kq)) {
      const full = path.join(kq, f);
      if (f === '_cu' && fs.statSync(full).isDirectory()) n += moveInto(full, path.join(p.outDir, '_cu'));
      else if (/^bang_ke_mua_ban_.*\.xlsx$/i.test(f)) {
        fs.renameSync(full, path.join(p.outDir, f));
        n++;
      }
    }
  }
  // phiên đăng nhập cũ của trình duyệt
  const oldProfile = path.join(ROOT, '.browser-profile');
  if (fs.existsSync(oldProfile) && !fs.existsSync(p.profileDir)) {
    fs.mkdirSync(path.dirname(p.profileDir), { recursive: true });
    try {
      fs.renameSync(oldProfile, p.profileDir);
    } catch {}
  }
  console.log(`Đã chuyển ${n} mục vào thư mục của công ty ${mst}.`);
  await pause();
}

// ---------- chọn / khai báo công ty ----------
async function addCompany() {
  console.log('\n--- KHAI BÁO CÔNG TY MỚI ---');
  for (;;) {
    const mst = await ask('MST công ty (10 số, chi nhánh: 10 số-3 số; Enter để hủy): ');
    if (!mst) return null;
    if (!company.validMst(mst)) {
      console.log('MST không hợp lệ.');
      continue;
    }
    if (company.find(mst)) {
      console.log('Công ty này đã có trong danh sách.');
      return company.find(mst);
    }
    const ten = await ask('Tên công ty (có thể để trống, tool tự lấy từ hóa đơn): ');
    const c = company.add(mst, ten);
    const p = company.paths(mst);
    for (const d of [path.join(p.inDir, 'mua-vao'), path.join(p.inDir, 'ban-ra'), p.outDir]) fs.mkdirSync(d, { recursive: true });
    console.log(`Đã thêm: ${company.label(c)}`);
    return c;
  }
}

async function chooseCompany() {
  for (;;) {
    console.clear();
    const list = company.list();
    console.log('================================================');
    console.log('                 TaiKeHoaDon');
    console.log('    Tải hóa đơn điện tử và xuất bảng kê Excel');
    console.log('================================================\n');
    console.log('CHỌN CÔNG TY:');
    if (!list.length) console.log('  (chưa có công ty nào — nhấn T để khai báo)');
    list.forEach((c, i) => console.log(`  ${i + 1}. ${company.label(c)}`));
    console.log('\n  T. Thêm công ty mới');
    console.log('  0. Thoát\n');
    const a = (await ask('Chọn: ')).toUpperCase();
    if (a === '0') return null;
    if (a === 'T') {
      const c = await addCompany();
      if (c) return c;
      continue;
    }
    const c = list[Number(a) - 1];
    if (c) return c;
  }
}

// ---------- menu công ty ----------
async function companyMenu(c) {
  const p = company.paths(c.mst);
  const arg = `--mst=${c.mst}`;
  for (;;) {
    c = company.find(c.mst) || c;
    console.clear();
    console.log('================================================');
    console.log(`CÔNG TY: ${company.label(c)}`);
    console.log('================================================\n');
    console.log('  1. Tải hóa đơn TỰ ĐỘNG  (nhập khoảng ngày, tool tự tìm kiếm)');
    console.log('  2. Tải hóa đơn THỦ CÔNG (tự tìm kiếm trên trang, nhấn Enter)');
    console.log('  3. Xuất bảng kê Excel');
    console.log(`  4. Sắp xếp file tải tay (bỏ file vào ${p.inDir})`);
    console.log('  5. Mở thư mục bảng kê');
    console.log('  6. Mở thư mục hóa đơn đã tải');
    console.log('  7. Mở thư mục nhật ký');
    console.log('  9. Đổi công ty');
    console.log('  0. Thoát\n');
    const a = await ask('Chọn: ');
    if (a === '1') runScript('download.js', [arg]);
    else if (a === '2') runScript('download.js', [arg, 'manual']);
    else if (a === '3') {
      runScript('bang-ke.js', [arg]);
      openFolder(p.outDir);
    } else if (a === '4') runScript('sap-xep.js', [arg]);
    else if (a === '5') openFolder(p.outDir);
    else if (a === '6') openFolder(p.inDir);
    else if (a === '7') openFolder(p.logDir);
    else if (a === '9') return true;
    else if (a === '0') return false;
    else continue;
    if (['1', '2', '3', '4'].includes(a)) await pause();
  }
}

(async () => {
  await migrateLegacy();
  for (;;) {
    const c = await chooseCompany();
    if (!c) break;
    if (!(await companyMenu(c))) break;
  }
  process.exit(0);
})().catch(async (e) => {
  console.error('LỖI:', e.message);
  await pause();
  process.exit(1);
});
