// Tải hóa đơn XML từ cổng thuế bằng trình duyệt do tool mở. Bạn tự đăng nhập (gõ captcha);
// tool lặp lại thao tác chọn hóa đơn -> "Xuất xml", rồi xuất bảng kê.
//   node download.js --mst=<MST>          -> TỰ ĐỘNG: nhập khoảng ngày, tool tự tìm kiếm mọi nhóm
//   node download.js --mst=<MST> manual   -> THỦ CÔNG: bạn tự tìm kiếm trên trang, nhấn Enter để tải
// Mỗi công ty có thư mục và trình duyệt riêng (xem lib/company.js); chạy qua menu TaiKeHoaDon.bat.
const path = require('path');
const readline = require('readline');
const P = require('./lib/portal');
const { runAuto, openLookup, loginState, parseVN, fmt, isUyNhiemChecked } = require('./lib/auto');
const { createLog } = require('./lib/log');
const bangKe = require('./bang-ke');
const company = require('./lib/company');

let COMPANY;
let IN_DIR;
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, r));

async function askRange(log) {
  const now = new Date();
  const first = new Date(Date.UTC(now.getFullYear(), now.getMonth() - 1, 1));
  const last = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 0));
  for (;;) {
    const a = (await ask(`Từ ngày (dd/mm/yyyy) [${fmt(first)}]: `)).trim() || fmt(first);
    const b = (await ask(`Đến ngày (dd/mm/yyyy) [${fmt(last)}]: `)).trim() || fmt(last);
    const from = parseVN(a);
    const to = parseVN(b);
    if (from && to && from <= to) return { from, to };
    log('Ngày không hợp lệ, nhập lại (ví dụ 01/09/2026).');
  }
}

async function askKinds() {
  const k = (await ask('Tải loại nào? 1 = Mua vào, 2 = Bán ra, 3 = Cả hai [3]: ')).trim();
  return k === '1' ? ['mua-vao'] : k === '2' ? ['ban-ra'] : ['mua-vao', 'ban-ra'];
}

// Cổng thuế lưu phiên đăng nhập trong cookie "jwt"
async function jwtValue(ctx) {
  const cs = await ctx.cookies('https://hoadondientu.gdt.gov.vn').catch(() => []);
  const c = cs.find((x) => x.name === 'jwt' && x.value);
  return c ? c.value : null;
}

// Chờ tới khi bạn đăng nhập xong: có cookie đăng nhập VÀ trang không còn nút "Đăng nhập" / trang 403
// (cookie cũ hết hạn vẫn còn trong trình duyệt nên không dựa vào cookie một mình). Kiểm tra 2 lần liên tiếp.
async function waitForLogin(ctx, log) {
  let told = '';
  let okTimes = 0;
  for (;;) {
    const page = await P.currentPage(ctx);
    const v = await jwtValue(ctx);
    const st = await loginState(page);
    const loaded = await page.evaluate(() => ((document.body && document.body.innerText) || '').length > 100).catch(() => false);
    const ready = !!v && loaded && !st.loginBtn && !st.forbidden;
    okTimes = ready ? okTimes + 1 : 0;
    if (okTimes >= 2) return v;
    const msg = v && st.loginBtn ? 'old' : 'wait';
    if (!ready && told !== msg) {
      log(
        msg === 'old'
          ? 'Phiên đăng nhập cũ đã hết hạn — hãy ĐĂNG NHẬP trên trình duyệt (đăng nhập xong tool tự chạy tiếp).'
          : 'Đang chờ bạn ĐĂNG NHẬP trên trình duyệt... (đăng nhập xong tool tự chạy tiếp, không cần nhấn gì)',
      );
      told = msg;
    }
    await P.sleep(1500);
  }
}

// Đăng nhập xong -> tự mở trang Tra cứu hóa đơn ngay trên tab đó
async function loginAndOpenLookup(ctx, log) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    await waitForLogin(ctx, log);
    log('Đã đăng nhập. Đang mở trang Tra cứu hóa đơn...');
    const page = await openLookup(ctx, log);
    if (page) return page;
    log('Chưa vào được trang Tra cứu hóa đơn (cổng thuế báo không có quyền / phiên đã hết hạn).');
    log('=> Hãy ĐĂNG NHẬP LẠI trên trình duyệt, tool sẽ tự thử lại.');
    // chờ trang hiện lại nút "Đăng nhập" (đã về trang chủ) để không thử lại ngay với phiên cũ
    for (let t = 0; t < 10 && !(await loginState(await P.currentPage(ctx))).loginBtn; t++) await P.sleep(1000);
  }
  return null;
}

async function autoMode(ctx, log) {
  log('\n=== CHẾ ĐỘ TỰ ĐỘNG ===');
  log('- Trên cửa sổ trình duyệt vừa mở: ĐĂNG NHẬP cổng thuế (tự gõ captcha).');
  log('- Ở cửa sổ này: nhập khoảng ngày và loại hóa đơn (làm trước hay sau khi đăng nhập đều được).');
  log('Đăng nhập xong tool tự mở Tra cứu hóa đơn, tự tìm kiếm từng nhóm và tải hết.\n');
  for (;;) {
    const { from, to } = await askRange(log);
    const kinds = await askKinds();
    const page = await loginAndOpenLookup(ctx, log);
    if (!page) {
      log('Không mở được trang Tra cứu hóa đơn sau nhiều lần thử. Hãy kiểm tra đăng nhập rồi chạy lại.');
    } else {
      await page.bringToFront().catch(() => {});
      try {
        const sum = await runAuto(page, { from, to, kinds, inDir: IN_DIR, ownMst: COMPANY.mst }, log);
        const t = sum.reduce((s, r) => ({ moi: s.moi + r.count - r.failed - r.skipped, co: s.co + r.skipped, loi: s.loi + r.failed }), { moi: 0, co: 0, loi: 0 });
        log(`\nXONG: ${t.moi} hóa đơn tải mới, ${t.co} đã có, ${t.loi} chưa tải được.`);
      } catch (e) {
        log(`Dừng: ${e.message.split('\n')[0]}`);
        log('(Bạn có thể dùng chế độ THỦ CÔNG nếu trang thuế thay đổi giao diện.)');
      }
    }
    const again = (await ask('\nTải thêm khoảng ngày khác? (c = có, Enter = kết thúc và xuất bảng kê): ')).trim().toLowerCase();
    if (again !== 'c') return;
  }
}

async function manualMode(ctx, log) {
  log('\n=== CHẾ ĐỘ THỦ CÔNG ===');
  log('1. Trong cửa sổ trình duyệt vừa mở: đăng nhập cổng thuế.');
  log('2. Vào Tra cứu > Tra cứu hóa đơn, chọn tab Mua vào hoặc Bán ra (và tab con nếu có),');
  log('   chọn khoảng ngày, bấm Tìm kiếm cho tới khi bảng hiện danh sách hóa đơn.');
  log('3. Quay lại cửa sổ này và nhấn Enter để tool tự tải từng hóa đơn.\n');
  for (let round = 1; ; round++) {
    const ans = (await ask(round === 1 ? 'Nhấn Enter để bắt đầu tải (q = thoát): ' : '\nTải tiếp tab/khoảng ngày khác: tìm kiếm trên trình duyệt rồi nhấn Enter (q = kết thúc và xuất bảng kê): ')).trim().toLowerCase();
    if (ans === 'q') return;
    let found;
    try {
      found = await P.findWorkPage(ctx, log);
    } catch {
      log('Trình duyệt đã bị đóng. Hãy chạy lại tool.');
      return;
    }
    if (!found || !found.st.shownRows) {
      log('Chưa thấy bảng danh sách hóa đơn trên trình duyệt.');
      log('=> Hãy vào Tra cứu > Tra cứu hóa đơn, chọn tab, chọn ngày, bấm Tìm kiếm, đợi bảng hiện danh sách rồi mới nhấn Enter.');
      if (found) log(`   (Chẩn đoán: trang ${found.st.url} | tab: ${found.st.tabs.join(' / ') || 'không có'} | dòng bảng: ${found.st.allRows})`);
      continue;
    }
    const p = found.page;
    await p.bringToFront().catch(() => {});
    let kind = P.kindOf(found.st);
    if (!kind) {
      log(`Không nhận ra tab (tab: ${found.st.tabs.join(' / ') || 'không có'}).`);
      const k = (await ask('Đây là hóa đơn (m) mua vào hay (b) bán ra? ')).trim().toLowerCase();
      kind = k.startsWith('b') ? 'ban-ra' : 'mua-vao';
    }
    const folder = path.join(IN_DIR, kind);
    log(`Đang tải hóa đơn ${kind === 'ban-ra' ? 'BÁN RA' : 'MUA VÀO'} -> ${folder}`);
    try {
      const uyNhiem = kind === 'mua-vao' && (await isUyNhiemChecked(p));
      if (uyNhiem) log('(Đang tick "Hóa đơn ủy nhiệm" — các hóa đơn sẽ được ghi chú ủy nhiệm)');
      const { count, failed, skipped } = await P.downloadAll(p, folder, log, kind, { ownMst: COMPANY.mst, uyNhiem });
      log(`Xong lượt này: ${count - failed - skipped} tải mới, ${skipped} đã có, ${failed} chưa tải được (tổng ${count} dòng)`);
    } catch (e) {
      log(`Dừng lượt này: ${e.message.split('\n')[0]}`);
    }
  }
}

async function main() {
  const manual = process.argv.includes('manual');
  COMPANY = company.fromArgs();
  if (!COMPANY) throw new Error('Chưa chọn công ty. Hãy chạy qua menu TaiKeHoaDon.bat.');
  const paths = company.paths(COMPANY.mst);
  IN_DIR = paths.inDir;
  const log = createLog(manual ? 'tai-thu-cong' : 'tai-tu-dong', paths.logDir);
  log(`CÔNG TY: ${company.label(COMPANY)}`);
  log(`Lưu hóa đơn vào: ${IN_DIR}`);
  log('LƯU Ý: đăng nhập đúng tài khoản của công ty này. Nếu tải ra hóa đơn của MST khác, tool sẽ dừng và không lưu.');
  const ctx = await P.launch(paths.profileDir);
  await P.openMainPage(ctx);

  if (manual) await manualMode(ctx, log);
  else await autoMode(ctx, log);

  log('\nĐang xuất bảng kê...');
  await bangKe.run(log, COMPANY).catch((e) => log(`LỖI xuất bảng kê: ${e.message}`));
  log(`\nNhật ký: ${log.file}`);
  rl.close();
  process.exit(0); // trình duyệt do tool mở sẽ tự đóng theo
}

if (require.main === module) {
  main().catch((e) => {
    console.error('LỖI:', e.message);
    process.exit(1);
  });
} else {
  rl.close();
  module.exports = { loginAndOpenLookup, waitForLogin, jwtValue };
}
