// Tự tìm kiếm trên trang Tra cứu hóa đơn: chọn tab bán ra/mua vào, nhập khoảng ngày,
// chọn "Kết quả kiểm tra" (mua vào có 3 nhóm), bấm Tìm kiếm, chuyển tab con
// (Hóa đơn điện tử / Máy tính tiền), chọn 50 dòng/trang rồi tải hết.
const fs = require('fs');
const path = require('path');
const P = require('./portal');

const { sleep, markActive } = P;
const LOOKUP_URL = 'https://hoadondientu.gdt.gov.vn/tra-cuu/tra-cuu-hoa-don';
const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
const DAY = 86400000;

function parseVN(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s || '').trim());
  if (!m) return null;
  const d = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  return d.getUTCDate() === +m[1] ? d : null;
}

// Chia khoảng ngày: không vượt quá 1 tháng và tối đa 30 ngày/lần (giới hạn của cổng thuế)
function chunks(from, to) {
  const out = [];
  for (let s = from; s <= to; ) {
    const monthEnd = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, 0));
    const e = new Date(Math.min(to, monthEnd, s.getTime() + 29 * DAY));
    out.push({ from: s, to: e });
    s = new Date(e.getTime() + DAY);
  }
  return out;
}

// Bấm phần tử đang hiển thị (selector + chữ khớp regex)
async function clickVisible(page, selector, re, attr = 'data-tool-click') {
  const n = await markActive(page, selector, attr);
  for (let i = 0; i < n; i++) {
    const el = page.locator(`[${attr}="${i}"]`);
    const text = ((await el.innerText().catch(() => '')) || '').normalize('NFC').trim();
    if (!re || re.test(text)) {
      await el.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      await el.click({ timeout: 5000 }).catch(() => el.dispatchEvent('click'));
      return text;
    }
  }
  return null;
}

// Mở trang Tra cứu hóa đơn (nếu đang ở trang khác của cổng thuế)
// Tình trạng trang: đã đăng nhập (có nút người dùng / Đăng xuất), còn nút "Đăng nhập", hay đang ở trang 403
function loginState(page) {
  return page
    .evaluate(() => {
      const shown = (el) => el && el.getClientRects().length > 0;
      const text = (document.body && document.body.innerText) || '';
      const forbidden = /\b403\b/.test(text) && /không có quyền truy cập/i.test(text);
      const loginBtn = [...document.querySelectorAll('.home-header-menu-item span, button, a')].some((el) => shown(el) && el.innerText.normalize('NFC').trim() === 'Đăng nhập');
      const userBox = shown(document.querySelector('.home-header-buttons'));
      // trang bên trong (đã đăng nhập) có thanh menu quản lý
      const appMenu = [...document.querySelectorAll('.ant-menu-submenu-title, .ant-menu-item')].some((el) => shown(el) && /Quản lý hóa đơn|Tra cứu/i.test(el.innerText.normalize('NFC')));
      return { loggedIn: !forbidden && !loginBtn && (userBox || appMenu), loginBtn, forbidden };
    })
    .catch(() => ({ loggedIn: false, loginBtn: false, forbidden: false }));
}

const hasLookupTabs = (p) =>
  p.evaluate(() => [...document.querySelectorAll('.ant-tabs-tab')].some((t) => /Tra cứu hóa đơn điện tử/i.test(t.innerText.normalize('NFC')))).catch(() => false);

// Mở trang Tra cứu hóa đơn ngay trên tab đang đăng nhập.
// Chuyển trang kiểu bấm menu (router của trang), không tải lại cả trang — tải lại trang này dễ bị báo 403.
async function openLookup(ctx, log) {
  const page = await P.currentPage(ctx); // chính tab bạn đăng nhập
  await page.bringToFront().catch(() => {});
  if (await hasLookupTabs(page)) return page;
  const pushed = await page
    .evaluate((url) => {
      const r = window.next && window.next.router;
      if (!r || typeof r.push !== 'function') return false;
      r.push(url);
      return true;
    }, new URL(LOOKUP_URL).pathname)
    .catch(() => false);
  if (!pushed) await page.goto(LOOKUP_URL, { timeout: 60000 }).catch(() => {});
  // cổng thuế có lúc tải chậm -> chờ tối đa 40 giây
  for (let t = 0; t < 40; t++) {
    if (await hasLookupTabs(page)) return page;
    const st = await loginState(page);
    if (st.forbidden) {
      // trang 403: quay về trang chủ để đăng nhập lại
      await page.goto(P.SITE).catch(() => {});
      return null;
    }
    await sleep(1000);
  }
  return null;
}

async function chooseTopTab(page, kind) {
  const re = kind === 'ban-ra' ? /điện tử bán ra/i : /điện tử mua vào/i;
  const ok = await page.evaluate((src) => {
    const re = new RegExp(src, 'i');
    const tab = [...document.querySelectorAll('.ant-tabs-tab')].find((t) => !t.closest('.ant-tabs-tabpane') && re.test(t.innerText.normalize('NFC')));
    if (!tab) return false;
    tab.click();
    return true;
  }, re.source);
  if (!ok) throw new Error(`Không thấy tab "${kind === 'ban-ra' ? 'Tra cứu hóa đơn điện tử bán ra' : 'Tra cứu hóa đơn điện tử mua vào'}"`);
  await sleep(1000);
  await P.waitIdle(page);
}

// Ô ngày (DatePicker của Ant Design v3): bấm vào ô, gõ ngày vào ô nhập của lịch rồi Enter
async function setDate(page, index, value) {
  const n = await markActive(page, '.ant-calendar-picker input', 'data-tool-date');
  if (n < 2) throw new Error('Không thấy ô "Từ ngày" / "Đến ngày" trên trang');
  const input = page.locator(`[data-tool-date="${index}"]`);
  await input.click({ timeout: 5000 });
  const cal = page.locator('.ant-calendar-picker-container:not(.slide-up-leave) .ant-calendar-input').last();
  await cal.waitFor({ state: 'visible', timeout: 5000 });
  await cal.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type(value, { delay: 30 });
  await page.keyboard.press('Enter');
  await sleep(300);
  if (await cal.isVisible().catch(() => false)) await page.keyboard.press('Escape');
  await sleep(300);
  return input.inputValue();
}

async function setDates(page, from, to) {
  const a = fmt(from);
  const b = fmt(to);
  // Đặt "Đến ngày" trước rồi "Từ ngày" (trang tự chỉnh ô kia nếu cách nhau quá 30 ngày), rồi kiểm tra lại
  for (let t = 0; t < 3; t++) {
    await setDate(page, 1, b);
    await setDate(page, 0, a);
    const n = await markActive(page, '.ant-calendar-picker input', 'data-tool-date');
    const v0 = await page.locator('[data-tool-date="0"]').inputValue();
    const v1 = n > 1 ? await page.locator('[data-tool-date="1"]').inputValue() : '';
    if (v0 === a && v1 === b) return;
  }
  throw new Error(`Không đặt được khoảng ngày ${a} - ${b}`);
}

// Ô chọn "Kết quả kiểm tra": trả về danh sách lựa chọn, hoặc chọn lựa chọn thứ `index`
async function ttxlySelect(page, index, retried = false) {
  const found = await page.evaluate(() => {
    document.querySelectorAll('[data-tool-ttxly]').forEach((el) => el.removeAttribute('data-tool-ttxly'));
    const labels = [...document.querySelectorAll('label, span')].filter(
      (el) => /^Kết quả kiểm tra/i.test(el.innerText.normalize('NFC').trim()) && !el.closest('.ant-tabs-tabpane-inactive, [aria-hidden="true"], table') && el.getClientRects().length,
    );
    for (const l of labels) {
      const item = l.closest('.ant-form-item, .ant-row');
      const sel = item && item.querySelector('.ant-select-selection, .ant-select-selector');
      if (sel) {
        sel.setAttribute('data-tool-ttxly', '1');
        return true;
      }
    }
    return false;
  });
  if (!found) return null;
  await page.locator('[data-tool-ttxly="1"]').click({ timeout: 5000 });
  const items = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) li.ant-select-dropdown-menu-item');
  await items.first().waitFor({ state: 'visible', timeout: 5000 });
  const texts = (await items.allInnerTexts()).map((s) => s.trim());
  if (index === undefined) {
    await page.keyboard.press('Escape');
    return texts;
  }
  await items.nth(index).click();
  await sleep(400);
  // kiểm tra ô đã hiện đúng lựa chọn
  const now = ((await page.locator('[data-tool-ttxly="1"]').innerText().catch(() => '')) || '').trim();
  if (now && texts[index] && now !== texts[index]) {
    if (!retried) return ttxlySelect(page, index, true);
    throw new Error(`Không chọn được "Kết quả kiểm tra" = ${texts[index]} (đang là: ${now})`);
  }
  return texts[index];
}

// "Chữ ký" của bảng đang hiện (số kết quả, trang, dòng đầu) để biết bảng đã được làm mới chưa
function tableSignature(page) {
  return page
    .evaluate(() => {
      const shown = (el) => !el.closest('.ant-tabs-tabpane-inactive, [aria-hidden="true"], .ant-table-fixed-left, .ant-table-fixed-right') && el.getClientRects().length;
      const count = [...document.querySelectorAll('span')].find((el) => shown(el) && /^Có [\d,.]+ kết quả$/.test(el.innerText.trim()));
      const pageNo = [...document.querySelectorAll('span, div')].find((el) => shown(el) && el.children.length === 0 && /^\d+ \/ \d+$/.test(el.innerText.trim()));
      const row = [...document.querySelectorAll('tr.ant-table-row')].find(shown);
      return [count ? count.innerText : '', pageNo ? pageNo.innerText : '', row ? row.innerText.slice(0, 200) : 'trống'].join('#');
    })
    .catch(() => '');
}

async function clickSearch(page) {
  await P.dismissModals(page);
  const before = await tableSignature(page);
  const clicked = await clickVisible(page, 'button', /^Tìm kiếm$/i);
  if (!clicked) throw new Error('Không thấy nút "Tìm kiếm"');
  // chờ bảng thật sự được làm mới: thấy "Đang xử lý" hoặc nội dung bảng thay đổi (tối đa ~12 giây);
  // kết quả mới giống hệt kết quả cũ thì sau thời gian này coi như đã xong
  let busySeen = false;
  for (let t = 0; t < 24; t++) {
    await sleep(500);
    if (await P.isBusy(page)) busySeen = true;
    else if (busySeen || (await tableSignature(page)) !== before) break;
  }
  await P.waitIdle(page);
  // chờ bảng có kết quả hoặc báo không có dữ liệu
  for (let t = 0; t < 60; t++) {
    const st = await page.evaluate(() => {
      const shown = (el) => !el.closest('.ant-tabs-tabpane-inactive, [aria-hidden="true"]') && el.getClientRects().length;
      const count = [...document.querySelectorAll('span')].some((el) => shown(el) && /^Có [\d,.]+ kết quả$/.test(el.innerText.trim()));
      const empty = [...document.querySelectorAll('.ant-table-placeholder')].some(shown);
      return count || empty;
    });
    if (st) return;
    await sleep(500);
  }
}

// Chọn 50 dòng/trang (ô chọn 15/30/50 cạnh nút chuyển trang)
async function setPageSize50(page) {
  const mark = await page.evaluate(() => {
    document.querySelectorAll('[data-tool-size]').forEach((el) => el.removeAttribute('data-tool-size'));
    for (const sel of document.querySelectorAll('.ant-select-selection, .ant-select-selector')) {
      if (sel.closest('.ant-tabs-tabpane-inactive, [aria-hidden="true"]') || !sel.getClientRects().length) continue;
      const v = sel.innerText.trim();
      if (['15', '30', '50'].includes(v)) {
        if (v === '50') return 'da50';
        sel.setAttribute('data-tool-size', '1');
        return 'ok';
      }
    }
    return 'none';
  });
  if (mark !== 'ok') return mark === 'da50';
  await page.locator('[data-tool-size="1"]').click({ timeout: 5000 });
  const item = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) li.ant-select-dropdown-menu-item', { hasText: /^50$/ });
  await item.first().click({ timeout: 5000 });
  await sleep(800);
  await P.waitIdle(page);
  return true;
}

// Các tab con trong tab đang mở: "Hóa đơn điện tử", "Hóa đơn có mã khởi tạo từ máy tính tiền"
async function subTabNames(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.ant-tabs-tabpane-active .ant-tabs-tab')]
      .filter((t) => !t.closest('.ant-tabs-tabpane-inactive') && t.getClientRects().length)
      .map((t) => t.innerText.normalize('NFC').trim()),
  );
}
async function openSubTab(page, name) {
  await page.evaluate((name) => {
    const t = [...document.querySelectorAll('.ant-tabs-tabpane-active .ant-tabs-tab')].find(
      (t) => !t.closest('.ant-tabs-tabpane-inactive') && t.innerText.normalize('NFC').trim() === name,
    );
    if (t) t.click();
  }, name);
  await sleep(1000);
  await P.waitIdle(page);
}

// Ghi số kết quả cổng thuế báo cho từng lần tìm (để đối chiếu trong sheet Kiểm tra)
function saveCount(dir, entry) {
  const file = path.join(dir, '_so_luong.json');
  let all = {};
  try {
    all = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  all[`${entry.tu}|${entry.den}|${entry.nhom}|${entry.tab}`] = entry;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(all, null, 1), 'utf8');
}

// Ô "Hóa đơn ủy nhiệm" (checkbox) trong form mua vào: tick / bỏ tick. Trả về false nếu không có ô này.
async function setUyNhiem(page, on) {
  const res = await page.evaluate((on) => {
    const labels = [...document.querySelectorAll('label, span, div')].filter(
      (el) =>
        el.children.length === 0 &&
        /^Hóa đơn ủy nhiệm/i.test(el.innerText.normalize('NFC').trim()) &&
        !el.closest('.ant-tabs-tabpane-inactive, [aria-hidden="true"], table') &&
        el.getClientRects().length,
    );
    for (const l of labels) {
      const item = l.closest('.ant-form-item, .ant-row');
      const box = item && item.querySelector('.ant-checkbox');
      if (!box) continue;
      if (box.classList.contains('ant-checkbox-checked') !== on) (box.querySelector('input') || box).click();
      return true;
    }
    return false;
  }, on);
  if (!res) return false;
  await sleep(300);
  const ok = await page.evaluate(() => {
    const box = [...document.querySelectorAll('.ant-checkbox')].find((b) => !b.closest('.ant-tabs-tabpane-inactive, [aria-hidden="true"], table') && b.getClientRects().length);
    return box ? box.classList.contains('ant-checkbox-checked') : null;
  });
  if (ok !== on) throw new Error(`Không ${on ? 'tick' : 'bỏ tick'} được ô "Hóa đơn ủy nhiệm"`);
  return true;
}

async function runAuto(page, { from, to, kinds, inDir, ownMst }, log) {
  const summary = [];
  for (const kind of kinds) {
    const dir = path.join(inDir, kind);
    const title = kind === 'ban-ra' ? 'BÁN RA' : 'MUA VÀO';
    await chooseTopTab(page, kind);
    // Mua vào: 3 nhóm "Kết quả kiểm tra" x (không / có tick "Hóa đơn ủy nhiệm"); bán ra: tất cả
    // Quy trình (theo hướng dẫn của người dùng):
    //  - Bán ra: để mặc định, chỉ nhập ngày -> Tìm kiếm -> tải (tab Hóa đơn điện tử và tab Máy tính tiền nếu có)
    //  - Mua vào, "Kết quả kiểm tra":
    //      Đã cấp mã hóa đơn            -> tab "Hóa đơn điện tử"
    //      Cục Thuế đã nhận không mã    -> tab "Hóa đơn điện tử"
    //      Cục Thuế đã nhận HĐ có mã khởi tạo từ máy tính tiền -> tab "Hóa đơn có mã khởi tạo từ máy tính tiền"
    //    + tick "Hóa đơn ủy nhiệm" cho 2 nhóm đầu (tab Hóa đơn điện tử)
    let groups = [{ g: null, uyNhiem: false, mtt: false }];
    if (kind === 'mua-vao') {
      const opts = (await ttxlySelect(page)) || [];
      const isMtt = (i) => /máy tính tiền/i.test(opts[i] || '');
      const idx = opts.length ? opts.map((_, i) => i) : [null];
      const coUyNhiem = await setUyNhiem(page, false);
      if (!coUyNhiem) log('(Không thấy ô "Hóa đơn ủy nhiệm" trên trang — bỏ qua phần ủy nhiệm)');
      groups = [
        ...idx.map((g) => ({ g, uyNhiem: false, mtt: g !== null && isMtt(g) })),
        ...(coUyNhiem ? idx.filter((g) => g !== null && !isMtt(g)).map((g) => ({ g, uyNhiem: true, mtt: false })) : []),
      ];
    }
    for (const c of chunks(from, to)) {
      for (const { g, uyNhiem, mtt } of groups) {
        const ten = g === null ? 'Tất cả' : await ttxlySelect(page, g);
        await setDates(page, c.from, c.to);
        if (g !== null) await ttxlySelect(page, g); // chọn lại sau khi đổi ngày cho chắc
        if (kind === 'mua-vao') await setUyNhiem(page, uyNhiem);
        const nhom = `${ten}${uyNhiem ? ' (ủy nhiệm)' : ''}`;
        log(`\n=== ${title} | ${fmt(c.from)} - ${fmt(c.to)} | ${nhom} ===`);
        let tabs = (await subTabNames(page)) || [];
        let searchedTab = null; // tab con đã được làm mới bởi lần tìm đầu tiên
        if (!tabs.length) {
          // tab con chỉ hiện sau lần tìm đầu tiên (lúc đó đang mở tab đầu tiên)
          await clickSearch(page);
          tabs = (await subTabNames(page)) || [];
          searchedTab = tabs[0] || null;
        }
        // Mua vào: nhóm "máy tính tiền" chỉ tải tab "Hóa đơn có mã khởi tạo từ máy tính tiền",
        // các nhóm khác (kể cả ủy nhiệm) chỉ tải tab "Hóa đơn điện tử"
        if (kind === 'mua-vao' && tabs.length) {
          const pick = tabs.filter((t) => (mtt ? /máy tính tiền/i.test(t) : !/máy tính tiền/i.test(t)));
          if (pick.length) tabs = pick;
        }
        for (const tab of tabs.length ? tabs : ['']) {
          if (tab) await openSubTab(page, tab);
          // Cổng thuế chỉ làm mới TAB CON ĐANG MỞ khi bấm Tìm kiếm -> mở tab rồi mới tìm
          if (!(searchedTab && tab === searchedTab)) await clickSearch(page);
          searchedTab = null;
          const n = await P.resultCount(page);
          const rows = await P.visibleRows(page);
          const total = n ?? rows.length;
          const muc = `${title} | ${fmt(c.from)} - ${fmt(c.to)} | ${nhom} | Tab: ${tab || 'mặc định'}`;
          log(`\n>> ĐANG TẢI: ${muc}`);
          log(`   Cổng thuế báo: ${total} hóa đơn${total ? '' : ' (không có gì để tải)'}`);
          saveCount(dir, { tu: fmt(c.from), den: fmt(c.to), nhom, tab, soKetQua: total, luc: new Date().toISOString() });
          const base = { kind, tu: fmt(c.from), den: fmt(c.to), nhom, tab, portal: total };
          if (!rows.length) {
            summary.push({ ...base, count: 0, failed: 0, skipped: 0 });
            continue;
          }
          if ((n || 0) > 15 && (await setPageSize50(page))) log('    (đã chọn 50 dòng/trang)');
          const r = await P.downloadAll(page, dir, log, kind, { ownMst, uyNhiem });
          log(`   KẾT QUẢ [${muc}]: ${r.count} hóa đơn -> tải mới ${r.count - r.failed - r.skipped}, đã có ${r.skipped}, chưa tải được ${r.failed}`);
          summary.push({ ...base, ...r });
        }
      }
    }
    if (kind === 'mua-vao') await setUyNhiem(page, false).catch(() => {}); // trả trang về như cũ
  }
  return summary;
}

// Ô 'Hóa đơn ủy nhiệm' đang được tick? (dùng cho chế độ thủ công)
function isUyNhiemChecked(page) {
  return page
    .evaluate(() => {
      const box = [...document.querySelectorAll('.ant-checkbox')].find((b) => !b.closest('.ant-tabs-tabpane-inactive, [aria-hidden="true"], table') && b.getClientRects().length);
      return !!(box && box.classList.contains('ant-checkbox-checked'));
    })
    .catch(() => false);
}

// ---------- bảng tổng hợp cuối lượt tải: mỗi mục (loại, khoảng ngày, nhóm, tab) bao nhiêu hóa đơn ----------
const shortNhom = (s) =>
  String(s || '')
    .replace('Đã cấp mã hóa đơn', 'Đã cấp mã')
    .replace(/Cục Thuế đã nhận hóa đơn có mã khởi tạo từ máy tính tiền/i, 'Có mã từ máy tính tiền')
    .replace(/Cục Thuế đã nhận không mã/i, 'Không mã');
const shortTab = (s) => (/máy tính tiền/i.test(s || '') ? 'Máy tính tiền' : /điện tử/i.test(s || '') ? 'HĐ điện tử' : s || '-');
const width = (s) => [...String(s)].length;
const padR = (s, n) => String(s) + ' '.repeat(Math.max(0, n - width(s)));
const padL = (s, n) => ' '.repeat(Math.max(0, n - width(s))) + String(s);

function printSummary(sum, log) {
  if (!sum || !sum.length) return;
  const head = ['Loại', 'Khoảng ngày', 'Nhóm', 'Tab', 'Cổng thuế', 'Tải mới', 'Đã có', 'Chưa tải'];
  const rows = sum.map((r) => [
    r.kind === 'ban-ra' ? 'Bán ra' : 'Mua vào',
    `${r.tu.slice(0, 5)}-${r.den.slice(0, 5)}`,
    shortNhom(r.nhom),
    shortTab(r.tab),
    r.portal ?? r.count,
    r.count - r.failed - r.skipped,
    r.skipped,
    r.failed,
  ]);
  const w = head.map((h, i) => Math.max(width(h), ...rows.map((r) => width(r[i]))));
  const line = (cells) => cells.map((c, i) => (i >= 4 ? padL(c, w[i]) : padR(c, w[i]))).join(' | ');
  log(`\n${'='.repeat(25)} TỔNG HỢP LƯỢT TẢI ${'='.repeat(25)}`);
  log(line(head));
  log(w.map((n) => '-'.repeat(n)).join('-+-'));
  rows.forEach((r) => log(line(r)));
  log('');
  for (const kind of ['mua-vao', 'ban-ra']) {
    const k = sum.filter((r) => r.kind === kind);
    if (!k.length) continue;
    const t = k.reduce(
      (a, r) => ({ portal: a.portal + (r.portal ?? r.count), moi: a.moi + r.count - r.failed - r.skipped, co: a.co + r.skipped, loi: a.loi + r.failed }),
      { portal: 0, moi: 0, co: 0, loi: 0 },
    );
    log(`=> ${kind === 'ban-ra' ? 'BÁN RA ' : 'MUA VÀO'}: cổng thuế báo ${t.portal} (một hóa đơn có thể hiện ở nhiều nhóm), tải mới ${t.moi}, đã có ${t.co}, chưa tải được ${t.loi}`);
  }
}

module.exports = { runAuto, printSummary, openLookup, loginState, parseVN, chunks, fmt, isUyNhiemChecked };
