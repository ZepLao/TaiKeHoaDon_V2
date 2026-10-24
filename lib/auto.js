// Tự tìm kiếm trên trang Tra cứu hóa đơn: chọn tab bán ra/mua vào, nhập khoảng ngày,
// chọn "Kết quả kiểm tra" (mua vào có 3 nhóm), bấm Tìm kiếm, chuyển tab con
// (Hóa đơn điện tử / Máy tính tiền), chọn 50 dòng/trang rồi tải hết.
const fs = require('fs');
const path = require('path');
const P = require('./portal');
const status = require('./status');

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

// Chia khoảng ngày thành từng đợt CHUNK_DAYS ngày (không vượt qua cuối tháng) để mỗi lần tìm ít kết quả,
// cổng thuế trả nhanh, ít bị lỗi. Tải lần lượt tới khi hết khoảng ngày.
const CHUNK_DAYS = 5;
function chunks(from, to) {
  const out = [];
  for (let s = from; s <= to; ) {
    const monthEnd = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, 0));
    const e = new Date(Math.min(to, monthEnd, s.getTime() + (CHUNK_DAYS - 1) * DAY));
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
// Ô ngày của tab vừa chuyển có thể chưa hiện ngay -> chờ tối đa 15 giây rồi mới coi là lỗi
async function dateInputs(page) {
  for (let t = 0; t < 30; t++) {
    const n = await markActive(page, '.ant-calendar-picker input', 'data-tool-date');
    if (n >= 2) return n;
    await sleep(500);
  }
  throw new Error('Không thấy ô "Từ ngày" / "Đến ngày" trên trang');
}

async function setDate(page, index, value) {
  await dateInputs(page);
  const input = page.locator(`[data-tool-date="${index}"]`);
  await input.click({ timeout: 5000 });
  const cal = page.locator('.ant-calendar-picker-container:not(.slide-up-leave) .ant-calendar-input').last();
  await cal.waitFor({ state: 'visible', timeout: 5000 });
  await cal.click();
  await page.keyboard.press('Control+A');
  for (const ch of value) await page.keyboard.type(ch, { delay: P.rand(15, 60) }); // gõ nhanh chậm không đều như người
  await page.keyboard.press('Enter');
  await sleep(200);
  if (await cal.isVisible().catch(() => false)) await page.keyboard.press('Escape');
  await sleep(200);
  return input.inputValue();
}

// Đặt khoảng ngày. Trả về false nếu ô đã đúng ngày sẵn (các nhóm cùng đợt không phải gõ lại).
async function setDates(page, from, to) {
  const a = fmt(from);
  const b = fmt(to);
  const current = async () => {
    const n = await dateInputs(page);
    const v0 = await page.locator('[data-tool-date="0"]').inputValue();
    const v1 = n > 1 ? await page.locator('[data-tool-date="1"]').inputValue() : '';
    return v0 === a && v1 === b;
  };
  if (await current()) return false;
  // Đặt "Đến ngày" trước rồi "Từ ngày" (trang tự chỉnh ô kia nếu cách nhau quá 30 ngày), rồi kiểm tra lại
  for (let t = 0; t < 3; t++) {
    await setDate(page, 1, b);
    await setDate(page, 0, a);
    if (await current()) return true;
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

// Bấm Tìm kiếm và chờ bảng có kết quả. Cổng thuế báo lỗi (vd "Cassandra timeout") hoặc chờ lâu không thấy
// kết quả -> bấm Tìm kiếm lại (tối đa 2 lần). Vẫn không được thì báo lỗi để bỏ qua mục này.
const SEARCH_TRIES = 2; // tìm 2 lần không được -> tải lại trang (xem reloadPortal)

// Theo dõi các yêu cầu dữ liệu (xhr/fetch) trang gửi lên cổng thuế -> biết lúc nào tìm kiếm đã trả kết quả
function trackRequests(page) {
  const st = { started: 0, pending: new Set() };
  const isApi = (r) => ['xhr', 'fetch'].includes(r.resourceType());
  const onReq = (r) => {
    if (!isApi(r)) return;
    st.started++;
    st.pending.add(r);
  };
  const onDone = (r) => st.pending.delete(r);
  page.on('request', onReq);
  page.on('requestfinished', onDone);
  page.on('requestfailed', onDone);
  st.stop = () => {
    page.off('request', onReq);
    page.off('requestfinished', onDone);
    page.off('requestfailed', onDone);
  };
  return st;
}

async function clickSearch(page, log = () => {}) {
  const fresh = page.locator(P.NOTICE.split(',').map((x) => `${x.trim()}:not([data-tool-seen])`).join(', '));
  let why = '';
  for (let attempt = 1; attempt <= SEARCH_TRIES; attempt++) {
    if (attempt > 1) {
      log(`    ${why} -> bấm Tìm kiếm lại (lần ${attempt}/${SEARCH_TRIES})`);
      await P.humanPause(5000, 12000); // cổng thuế đang chậm/lỗi -> nghỉ lâu hơn rồi mới tìm lại
    }
    await P.dismissModals(page);
    await page.evaluate((sel) => document.querySelectorAll(sel).forEach((el) => el.setAttribute('data-tool-seen', '1')), P.NOTICE).catch(() => {});
    await P.humanPause(); // nghỉ ngẫu nhiên trước khi bấm Tìm kiếm
    const before = await tableSignature(page);
    const net = trackRequests(page);
    try {
      const clicked = await clickVisible(page, 'button', /^Tìm kiếm$/i);
      if (!clicked) throw new Error('Không thấy nút "Tìm kiếm"');
      // chờ bảng thật sự được làm mới (tối đa ~12 giây): thấy "Đang xử lý", nội dung bảng thay đổi,
      // hoặc yêu cầu tìm kiếm gửi lên cổng thuế đã trả về (kết quả giống hệt lần trước, vd cùng 0 hóa đơn)
      let busySeen = false;
      const start = Date.now();
      while (Date.now() - start < 12000) {
        await sleep(200);
        if (await P.isBusy(page)) busySeen = true;
        else if (busySeen || (net.started && !net.pending.size && Date.now() - start > 600) || (await tableSignature(page)) !== before) break;
      }
    } finally {
      net.stop();
    }
    if (!(await P.waitIdle(page, 60000, log, 'tìm kiếm'))) {
      why = 'Cổng thuế tìm kiếm quá 60 giây chưa xong';
      continue;
    }
    // chờ bảng có kết quả hoặc báo không có dữ liệu (tối đa 30 giây); thông báo lỗi -> tìm lại
    why = 'Chưa thấy kết quả tìm kiếm sau 30 giây';
    for (let t = 0; t < 60; t++) {
      if ((await fresh.count().catch(() => 0)) > 0) {
        const msg = ((await fresh.first().innerText().catch(() => '')) || '').trim().split('\n')[0];
        await fresh.first().evaluate((n) => n.setAttribute('data-tool-seen', '1')).catch(() => {});
        if (msg && !/thành công|success/i.test(msg)) {
          why = `Cổng thuế báo lỗi khi tìm kiếm: ${msg.slice(0, 150)}`;
          break;
        }
      }
      const st = await page.evaluate(() => {
        const shown = (el) => !el.closest('.ant-tabs-tabpane-inactive, [aria-hidden="true"]') && el.getClientRects().length;
        const count = [...document.querySelectorAll('span')].some((el) => shown(el) && /^Có [\d,.]+ kết quả$/.test(el.innerText.trim()));
        const empty = [...document.querySelectorAll('.ant-table-placeholder')].some(shown);
        return count || empty;
      });
      if (st && !(await P.isBusy(page))) {
        await P.waitNetIdle(page, 30000); // chờ cổng thuế trả hết dữ liệu của lần tìm rồi mới thao tác trên bảng
        return;
      }
      await sleep(300);
    }
  }
  throw new Error(`${why} (đã thử ${SEARCH_TRIES} lần)`);
}

// ---------- trang bị treo -> tải lại trang rồi làm tiếp ----------
const MAX_RELOADS = 3; // mỗi mục tải lại trang tối đa 3 lần, vẫn lỗi thì bỏ qua mục đó (ghi vào danh sách tải tay)

// Lỗi phải dừng hẳn: trình duyệt bị đóng, đăng nhập nhầm công ty
const isFatal = (e) => e instanceof P.WrongCompanyError || /closed|đã bị đóng|Không tải lại được trang/i.test(e.message);

// ---------- mất đăng nhập -> nhắc đăng nhập lại rồi tải tiếp ----------
const BANNER_ID = 'tool-relogin-banner';
// Thanh thông báo đỏ trên đầu trang (không chặn chuột, không che hộp đăng nhập)
function showBanner(page, on) {
  return page
    .evaluate(
      ({ id, on }) => {
        const old = document.getElementById(id);
        if (!on) return old && old.remove();
        if (old || !document.body) return;
        const d = document.createElement('div');
        d.id = id;
        d.textContent = '⚠ TOOL TẢI HÓA ĐƠN: phiên đăng nhập đã hết — hãy ĐĂNG NHẬP LẠI (gõ captcha). Đăng nhập xong tool tự tải tiếp, không cần làm gì thêm.';
        d.style.cssText =
          'position:fixed;top:0;left:0;right:0;z-index:2147483647;pointer-events:none;background:#c62828;color:#fff;font:bold 16px/1.4 Arial,sans-serif;padding:10px 16px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.4)';
        document.body.appendChild(d);
      },
      { id: BANNER_ID, on },
    )
    .catch(() => {});
}

// Đưa cửa sổ trình duyệt lên trên cùng (thu nhỏ rồi phóng to lại để Windows cho cửa sổ nổi lên)
async function raiseWindow(page) {
  await page.bringToFront().catch(() => {});
  try {
    const s = await page.context().newCDPSession(page);
    const { windowId } = await s.send('Browser.getWindowForTarget');
    await s.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    await s.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } });
    await s.detach().catch(() => {});
  } catch {}
}

const beep = () => process.stdout.write('\x07');

// Chờ bạn đăng nhập lại (không giới hạn thời gian), rồi mở lại trang Tra cứu hóa đơn.
// Sau khi hàm này xong, nơi gọi đặt lại form tìm kiếm và tải tiếp mục đang dở (hóa đơn đã có file được bỏ qua).
async function waitRelogin(page, log, why = '') {
  log(`\n   !!! MẤT ĐĂNG NHẬP cổng thuế${why}.`);
  log('   !!! Hãy ĐĂNG NHẬP LẠI trên cửa sổ trình duyệt (gõ captcha). Đăng nhập xong tool TỰ TẢI TIẾP từ chỗ đang dừng.');
  beep();
  await raiseWindow(page);
  if (!(await loginState(page)).loginBtn) await page.goto(P.SITE).catch(() => {});
  const start = Date.now();
  let nhac = 1;
  for (;;) {
    let ok = 0;
    while (ok < 2) {
      if (page.isClosed()) throw new Error('Cửa sổ trình duyệt đã bị đóng');
      await showBanner(page, true);
      await sleep(1500);
      const st = await loginState(page);
      ok = st.loggedIn && !(await P.loginLost(page)) ? ok + 1 : 0;
      if (st.forbidden) await page.goto(P.SITE).catch(() => {});
      const phut = Math.floor((Date.now() - start) / 60000);
      if (phut >= nhac * 2) {
        nhac++;
        log(`   ... vẫn đang chờ bạn đăng nhập lại (${phut} phút)`);
        beep();
      }
    }
    await showBanner(page, false);
    log('   Đã đăng nhập lại -> mở lại trang Tra cứu hóa đơn...');
    if (await openLookup(page.context(), log)) {
      await P.waitIdle(page, 30000);
      log('   Đặt lại tìm kiếm và TẢI TIẾP.');
      return;
    }
    log('   Chưa vào được trang Tra cứu hóa đơn (phiên chưa hợp lệ) — hãy đăng nhập lại.');
  }
}

// Lỗi này do mất đăng nhập? -> chờ đăng nhập lại rồi trả về true (nơi gọi làm lại bước đang dở)
async function reloginIfLost(page, e, log) {
  if (!(e instanceof P.LoginLostError) && !(await P.loginLost(page))) return false;
  await waitRelogin(page, log);
  return true;
}

// Tải lại trang: về trang chủ rồi mở lại Tra cứu hóa đơn (kiểu bấm menu — tải lại thẳng trang tra cứu dễ bị 403).
// Nếu mất phiên đăng nhập thì nhắc bạn đăng nhập lại rồi tự chạy tiếp.
async function reloadPortal(page, log, lan) {
  log(`   ↻ Trang cổng thuế bị treo -> TẢI LẠI TRANG (lần ${lan}/${MAX_RELOADS}) rồi tải tiếp...`);
  await P.humanPause(2000, 4000);
  await page.goto(P.SITE).catch(() => {});
  let lost = 0;
  for (let t = 0; t < 900; t++) {
    if (page.isClosed()) throw new Error('Cửa sổ trình duyệt đã bị đóng');
    await sleep(1000);
    const st = await loginState(page);
    if (st.loggedIn) {
      if (await openLookup(page.context(), log)) {
        await P.waitIdle(page, 30000);
        log('   Đã tải lại trang Tra cứu hóa đơn, đặt lại tìm kiếm và tải tiếp.');
        return;
      }
      continue;
    }
    // trang chủ hiện nút "Đăng nhập" / 403 vài lần liền -> mất phiên thật
    lost = st.loginBtn || st.forbidden ? lost + 1 : 0;
    if (lost >= 3) return waitRelogin(page, log, ' sau khi tải lại trang');
    if (t > 0 && t % 90 === 0) {
      // trang chủ cứ quay 'Đang xử lý' -> tải lại trang chủ lần nữa
      log(`   ... trang cổng thuế chưa tải xong sau ${t}s -> tải lại trang chủ`);
      await page.goto(P.SITE).catch(() => {});
    } else if (t > 0 && t % 30 === 0) log(`   ... đang chờ trang cổng thuế tải lại (${t}s)`);
  }
  throw new Error('Không tải lại được trang Tra cứu hóa đơn sau 15 phút');
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
async function openSubTab(page, name, log) {
  await page.evaluate((name) => {
    const t = [...document.querySelectorAll('.ant-tabs-tabpane-active .ant-tabs-tab')].find(
      (t) => !t.closest('.ant-tabs-tabpane-inactive') && t.innerText.normalize('NFC').trim() === name,
    );
    if (t) t.click();
  }, name);
  await sleep(1000);
  await P.waitIdle(page, 60000, log, 'mở tab');
  await P.waitNetIdle(page, 30000);
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

// Tải 1 nhóm: đợt ngày c + "Kết quả kiểm tra" g + ủy nhiệm, ở mọi tab con cần tải (hoặc chỉ tab opt.onlyTab).
// Kết quả từng tab đẩy vào mảng out (mỗi phần tử có grp để cuối lượt thử lại được).
// opt: { dir, ownMst, onlyTab, retry (lượt thử lại cuối), nhom (tên nhóm đã biết) }
async function runGroup(page, grp, opt, log, out) {
  const { kind, c, g, uyNhiem, mtt } = grp;
  const { dir, ownMst, onlyTab, retry } = opt;
  const title = kind === 'ban-ra' ? 'BÁN RA' : 'MUA VÀO';
  // Đặt form cho nhóm này: (lượt thử lại / sau khi tải lại trang thì chọn lại cả tab Mua vào/Bán ra) -> nhóm, ngày, ủy nhiệm
  const prepare = async (full) => {
    if (full) await chooseTopTab(page, kind);
    const t = g === null ? 'Tất cả' : await ttxlySelect(page, g);
    const doiNgay = await setDates(page, c.from, c.to);
    if (g !== null && doiNgay) await ttxlySelect(page, g); // chọn lại sau khi đổi ngày cho chắc
    if (kind === 'mua-vao') await setUyNhiem(page, uyNhiem);
    return t;
  };
  const entry = (x) => out.push({ kind, tu: fmt(c.from), den: fmt(c.to), grp, ...x });
  let nhom = opt.nhom || '';
  let header = false;
  let tabs = null;
  let searchedTab = null; // tab con đã được làm mới bởi lần tìm đầu tiên
  let reset = false; // trang vừa được mở lại (sau khi đăng nhập lại) -> đặt lại cả form
  for (let reloads = 0; ; reloads++) {
    try {
      const ten = await prepare(retry || reloads > 0 || reset);
      if (!nhom) nhom = `${ten}${uyNhiem ? ' (ủy nhiệm)' : ''}`;
      if (!header) {
        log(`\n=== ${retry ? 'THỬ LẠI: ' : ''}${title} | ${fmt(c.from)} - ${fmt(c.to)} | ${nhom} ===`);
        header = true;
      }
      tabs = (await subTabNames(page)) || [];
      searchedTab = null;
      if (!tabs.length) {
        // tab con chỉ hiện sau lần tìm đầu tiên (lúc đó đang mở tab đầu tiên)
        await clickSearch(page, log);
        tabs = (await subTabNames(page)) || [];
        searchedTab = tabs[0] || null;
      }
      break;
    } catch (e) {
      if (isFatal(e)) throw e;
      if (await reloginIfLost(page, e, log)) {
        reset = true;
        reloads--; // mất đăng nhập không tính vào số lần tải lại trang
        continue;
      }
      if (reloads >= MAX_RELOADS) {
        log(`   BỎ QUA nhóm này (đã tải lại trang ${reloads} lần): ${e.message.split('\n')[0]}`);
        entry({ nhom: nhom || `Nhóm ${g === null ? 'Tất cả' : g + 1}`, tab: onlyTab || '', portal: 'LỖI', count: 0, failed: 0, noXml: 0, skipped: 0 });
        return;
      }
      log(`   ${e.message.split('\n')[0]}`);
      await reloadPortal(page, log, reloads + 1);
    }
  }
  // Bỏ qua tab "máy tính tiền" trong chế độ tự động (tránh bị treo cổng thuế, bạn tải tay bằng chế độ thủ công nếu cần)
  if (tabs.length) {
    const nonMtt = tabs.filter((t) => !/máy tính tiền/i.test(t));
    if (nonMtt.length) tabs = nonMtt;
  }
  if (onlyTab) tabs = tabs.includes(onlyTab) || !tabs.length ? [onlyTab] : tabs;
  for (const tab of tabs.length ? tabs : ['']) {
    const muc = `${title} | ${fmt(c.from)} - ${fmt(c.to)} | ${nhom} | Tab: ${tab || 'mặc định'}`;
    log(`\n>> ${retry ? 'THỬ LẠI' : 'ĐANG TẢI'}: ${muc}`);
    // Trang bị treo (tìm kiếm không xong, nhiều hóa đơn liền bị treo...) -> tải lại trang, đặt lại form,
    // tìm lại rồi tải tiếp. Hóa đơn đã tải được bỏ qua (đã có file) nên không tải trùng.
    let moi = 0; // số file tải mới ở các lần trước khi phải tải lại trang
    reset = false;
    for (let reloads = 0; ; reloads++) {
      try {
        if (reloads > 0 || reset) {
          reset = false;
          await prepare(true);
          // trang mới tải lại chưa có tab con -> tìm 1 lần cho tab con hiện ra rồi mới mở đúng tab
          if (tab && !((await subTabNames(page)) || []).includes(tab)) await clickSearch(page, log);
        }
        if (tab) await openSubTab(page, tab, log);
        // Cổng thuế chỉ làm mới TAB CON ĐANG MỞ khi bấm Tìm kiếm -> mở tab rồi mới tìm
        if (!(searchedTab && tab === searchedTab)) {
          log('   Đang tìm kiếm trên cổng thuế...');
          await clickSearch(page, log);
        }
        searchedTab = null;
        const n = await P.resultCount(page);
        const rows = await P.visibleRows(page);
        const total = n ?? rows.length;
        log(`   Cổng thuế báo: ${total} hóa đơn${total ? '' : ' (không có gì để tải)'}`);
        saveCount(dir, { tu: fmt(c.from), den: fmt(c.to), nhom, tab, soKetQua: total, luc: new Date().toISOString() });
        const base = { nhom, tab, portal: total };
        if (!rows.length) {
          entry({ ...base, count: 0, failed: 0, noXml: 0, skipped: 0 });
          break;
        }
        if ((n || 0) > 15 && (await setPageSize50(page))) log('    (đã chọn 50 dòng/trang)');
        const r = await P.downloadAll(page, dir, log, kind, { ownMst, uyNhiem, quiet: retry });
        // cộng dồn file tải mới của các lần trước (lần sau các file đó hiện là "đã có")
        const tong = moi + r.newCount;
        const daCo = Math.max(0, r.count - r.failed - r.noXml - tong);
        const coFile = tong + daCo;
        const kFile = r.noXml || 0;
        const loi = r.failed || 0;
        let dgMuc = '';
        if (loi > 0 && kFile > 0) {
          dgMuc = `THIẾU: ${loi} LỖI, ${kFile} K.FILE GỐC (tải ${coFile}/${total})`;
        } else if (loi > 0) {
          dgMuc = `THIẾU ${loi} HĐ CHƯA TẢI`;
        } else if (kFile > 0) {
          dgMuc = `THIẾU ${kFile} FILE GỐC (tải ${coFile}/${total})`;
        } else if (total === coFile) {
          dgMuc = `KHỚP ĐỦ (${coFile}/${total})`;
        } else {
          dgMuc = `ĐÃ XỬ LÝ (${coFile}/${total})`;
        }
        log(`   ==> KẾT QUẢ [${nhom} | Tab: ${tab || 'mặc định'}]: Cổng thuế báo ${total} HĐ -> Tải mới: ${tong} | Đã có: ${daCo} | Không có XML gốc: ${kFile} | Chưa tải: ${loi}  [${dgMuc}]`);
        entry({ ...base, ...r, skipped: daCo, count: Math.max(r.count, tong + daCo + r.failed + r.noXml) });
        break;
      } catch (e) {
        if (isFatal(e)) throw e;
        moi += e.newCount || 0;
        searchedTab = null;
        if (await reloginIfLost(page, e, log)) {
          reset = true;
          reloads--; // mất đăng nhập không tính vào số lần tải lại trang
          continue;
        }
        if (reloads >= MAX_RELOADS) {
          log(`   BỎ QUA mục này (đã tải lại trang ${reloads} lần): ${e.message.split('\n')[0]}`);
          entry({ nhom, tab, portal: 'LỖI', count: moi, failed: 0, noXml: 0, skipped: 0 });
          break;
        }
        log(`   ${e.message.split('\n')[0]}`);
        await reloadPortal(page, log, reloads + 1);
      }
    }
  }
}

// Cuối lượt: tải lại MỘT vòng các mục còn lỗi (hóa đơn lỗi tạm thời / tìm kiếm lỗi).
// Hóa đơn đã có file và hóa đơn cổng thuế báo không có file gốc được bỏ qua -> chỉ tải đúng hóa đơn còn thiếu.
async function retryFailed(page, summary, { inDir, ownMst }, log) {
  const targets = summary.filter((r) => r.grp && (r.portal === 'LỖI' || r.failed > 0));
  if (!targets.length) return;
  const soHd = targets.reduce((a, r) => a + (r.failed || 0), 0);
  log(`\n${'='.repeat(20)} THỬ LẠI ${targets.length} MỤC CÒN LỖI (${soHd} hóa đơn${targets.some((r) => r.portal === 'LỖI') ? ' + mục tìm kiếm lỗi' : ''}) ${'='.repeat(20)}`);
  log('(chỉ tải hóa đơn chưa có file; hóa đơn cổng thuế báo "không có file gốc" thì bỏ qua)');
  await P.humanPause(10000, 20000); // nghỉ một chút cho cổng thuế đỡ tải rồi mới thử lại
  for (const old of targets) {
    const lai = [];
    await runGroup(page, old.grp, { dir: path.join(inDir, old.kind), ownMst, onlyTab: old.tab || null, retry: true, nhom: old.nhom }, log, lai);
    if (!lai.length) continue;
    // cộng file đã tải mới ở lượt chính vào kết quả lượt thử lại (lượt thử lại thấy chúng là "đã có")
    const oldNew = Math.max(0, old.count - old.failed - (old.noXml || 0) - old.skipped);
    const e = lai[0];
    if (e.portal === 'LỖI') e.count += oldNew;
    else e.skipped = Math.max(0, e.skipped - oldNew);
    summary.splice(summary.indexOf(old), 1, ...lai);
  }
}

// summary: truyền mảng từ ngoài vào để lượt bị dừng giữa chừng vẫn còn kết quả các mục đã tải
async function runAuto(page, { from, to, kinds, inDir, ownMst, summary = [] }, log) {
  for (const kind of kinds) {
    const dir = path.join(inDir, kind);
    const title = kind === 'ban-ra' ? 'BÁN RA' : 'MUA VÀO';
    // mất đăng nhập ngay lúc chuyển tab -> chờ đăng nhập lại rồi làm lại bước này
    for (;;) {
      try {
        await chooseTopTab(page, kind);
        if (kind === 'mua-vao') await ttxlySelect(page);
        break;
      } catch (e) {
        if (isFatal(e) || !(await reloginIfLost(page, e, log))) throw e;
      }
    }
    // Mua vào: 2 nhóm "Kết quả kiểm tra" (Đã cấp mã, Không mã) x (không / có tick "Hóa đơn ủy nhiệm"); bán ra: mặc định
    // Bỏ qua nhóm máy tính tiền khi tự động tải (tải tay riêng để tránh bị treo cổng thuế)
    let groups = [{ g: null, uyNhiem: false, mtt: false }];
    if (kind === 'mua-vao') {
      const opts = (await ttxlySelect(page)) || [];
      const isMtt = (i) => /máy tính tiền/i.test(opts[i] || '');
      const idx = opts.length ? opts.map((_, i) => i) : [null];
      // Chỉ lấy các nhóm không phải máy tính tiền
      const nonMttIdx = idx.filter((g) => g === null || !isMtt(g));
      const coUyNhiem = await setUyNhiem(page, false);
      if (!coUyNhiem) log('(Không thấy ô "Hóa đơn ủy nhiệm" trên trang — bỏ qua phần ủy nhiệm)');
      groups = [
        ...nonMttIdx.map((g) => ({ g, uyNhiem: false, mtt: false })),
        ...(coUyNhiem ? nonMttIdx.filter((g) => g !== null).map((g) => ({ g, uyNhiem: true, mtt: false })) : []),
      ];
    }
    const parts = chunks(from, to);
    if (parts.length > 1) log(`\n${title}: chia ${fmt(from)} - ${fmt(to)} thành ${parts.length} đợt, mỗi đợt tối đa ${CHUNK_DAYS} ngày`);
    // Chạy theo thứ tự: từng mục tra cứu (từng nhóm) -> chạy lần lượt từng đợt ngày đến hết rồi mới sang mục khác
    for (const { g, uyNhiem, mtt } of groups) {
      for (const [ci, c] of parts.entries()) {
        if (parts.length > 1) log(`\n######## ${title} — ĐỢT ${ci + 1}/${parts.length}: ${fmt(c.from)} - ${fmt(c.to)} ########`);
        await runGroup(page, { kind, c, g, uyNhiem, mtt }, { dir, ownMst }, log, summary);
      }
    }
    if (kind === 'mua-vao') await setUyNhiem(page, false).catch(() => {}); // trả trang về như cũ
  }
  await retryFailed(page, summary, { inDir, ownMst }, log);
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

// Thứ tự ưu tiên hiển thị các nhóm tra cứu
const nhomRank = (nhom) => {
  const s = String(nhom || '').toLowerCase();
  const un = s.includes('ủy nhiệm') || s.includes('uy nhiem');
  if (s.includes('đã cấp mã') || s.includes('da cap ma')) return un ? 3 : 1;
  if (s.includes('không mã') || s.includes('khong ma')) return un ? 4 : 2;
  return un ? 5 : 0;
};

function printSummary(sum, log) {
  if (!sum || !sum.length) return;

  log(`\n${'='.repeat(40)} BẢNG ĐỐI CHIẾU SỐ LƯỢNG HÓA ĐƠN VỚI CỔNG THUẾ ${'='.repeat(40)}`);
  log('(Sắp xếp theo thứ tự từng mục tra cứu, từ ngày đầu đến ngày cuối để đối chiếu trực tiếp trên web)\n');

  for (const kind of ['mua-vao', 'ban-ra']) {
    let kList = sum.filter((r) => r.kind === kind);
    if (!kList.length) continue;
    const titleKind = kind === 'ban-ra' ? 'BÁN RA' : 'MUA VÀO';

    // Sắp xếp: Từng mục tra cứu -> từng ngày từ đầu đến hết
    kList.sort((a, b) => {
      const rA = nhomRank(a.nhom);
      const rB = nhomRank(b.nhom);
      if (rA !== rB) return rA - rB;
      const tA = parseVN(a.tu) ? parseVN(a.tu).getTime() : 0;
      const tB = parseVN(b.tu) ? parseVN(b.tu).getTime() : 0;
      return tA - tB;
    });

    log(`>>> [${titleKind}] CHI TIẾT TỪNG MỤC TRA CỨU:`);
    const head = ['Mục tra cứu (Kết quả kiểm tra)', 'Khoảng ngày', 'Tab', 'Cổng thuế', 'Tải mới', 'Đã có', 'K.file gốc', 'Chưa tải', 'Kết quả đối chiếu'];

    // Chuẩn bị dữ liệu từng dòng
    const items = kList.map((r) => {
      const portalVal = typeof r.portal === 'number' ? r.portal : r.portal || 0;
      const moi = Math.max(0, r.count - r.failed - (r.noXml || 0) - r.skipped);
      const daCo = r.skipped || 0;
      const kFile = r.noXml || 0;
      const loi = r.failed || 0;
      const coFile = moi + daCo;

      let doiChieu = '';
      if (r.portal === 'LỖI') {
        doiChieu = 'LỖI TÌM KIẾM';
      } else if (portalVal === 0) {
        doiChieu = 'Không có HĐ (0/0)';
      } else if (loi > 0 && kFile > 0) {
        doiChieu = `Thiếu: ${loi} lỗi, ${kFile} K.file gốc (tải ${coFile}/${portalVal})`;
      } else if (loi > 0) {
        doiChieu = `Thiếu ${loi} HĐ (lỗi tải)`;
      } else if (kFile > 0) {
        doiChieu = `Thiếu ${kFile} file gốc (tải ${coFile}/${portalVal})`;
      } else if (portalVal === coFile) {
        doiChieu = `Khớp đủ (${portalVal}/${portalVal})`;
      } else if (portalVal > coFile) {
        doiChieu = `Lệch: thiếu ${portalVal - coFile} HĐ (tải ${coFile}/${portalVal})`;
      } else {
        doiChieu = `Khớp (${coFile}/${portalVal})`;
      }

      return {
        r,
        cells: [
          r.nhom || 'Tất cả',
          `${r.tu} - ${r.den}`,
          shortTab(r.tab),
          portalVal,
          moi,
          daCo,
          kFile,
          loi,
          doiChieu,
        ],
      };
    });

    const allCellRows = items.map((it) => it.cells);
    const w = head.map((h, i) => Math.max(width(h), ...allCellRows.map((row) => width(row[i]))));
    const line = (cells) => cells.map((c, i) => (i >= 3 && i <= 7 ? padL(c, w[i]) : padR(c, w[i]))).join(' | ');
    const sep = w.map((n) => '-'.repeat(n)).join('-+-');

    log(line(head));
    log(sep);

    // In theo từng mục: từng ngày đến hết rồi mới đến mục khác
    let currentNhom = null;
    let groupItems = [];

    const flushGroup = () => {
      if (!groupItems.length) return;
      if (groupItems.length > 1) {
        const gPortal = groupItems.reduce((s, it) => s + (typeof it.r.portal === 'number' ? it.r.portal : 0), 0);
        const gMoi = groupItems.reduce((s, it) => s + Math.max(0, it.r.count - it.r.failed - (it.r.noXml || 0) - it.r.skipped), 0);
        const gCo = groupItems.reduce((s, it) => s + (it.r.skipped || 0), 0);
        const gKFile = groupItems.reduce((s, it) => s + (it.r.noXml || 0), 0);
        const gLoi = groupItems.reduce((s, it) => s + (it.r.failed || 0), 0);
        const gCoFile = gMoi + gCo;
        let gDoiChieu = '';
        if (gPortal === 0) {
          gDoiChieu = 'Không có HĐ (0/0)';
        } else if (gLoi > 0 && gKFile > 0) {
          gDoiChieu = `Thiếu: ${gLoi} lỗi, ${gKFile} K.file gốc (tải ${gCoFile}/${gPortal})`;
        } else if (gLoi > 0) {
          gDoiChieu = `Thiếu ${gLoi} HĐ`;
        } else if (gKFile > 0) {
          gDoiChieu = `Thiếu ${gKFile} file gốc (tải ${gCoFile}/${gPortal})`;
        } else if (gPortal === gCoFile) {
          gDoiChieu = `Khớp đủ (${gPortal}/${gPortal})`;
        } else if (gPortal > gCoFile) {
          gDoiChieu = `Lệch: thiếu ${gPortal - gCoFile} HĐ (tải ${gCoFile}/${gPortal})`;
        } else {
          gDoiChieu = `Khớp (${gCoFile}/${gPortal})`;
        }
        const sumCells = [
          `  -> TỔNG MỤC: ${currentNhom}`,
          'Cả khoảng ngày',
          shortTab(groupItems[0].r.tab),
          gPortal,
          gMoi,
          gCo,
          gKFile,
          gLoi,
          gDoiChieu,
        ];
        log(line(sumCells));
      }
      groupItems = [];
    };

    items.forEach((it) => {
      if (currentNhom !== null && currentNhom !== it.r.nhom) {
        flushGroup();
        log(sep);
      }
      currentNhom = it.r.nhom;
      groupItems.push(it);
      log(line(it.cells));
    });
    flushGroup();

    log(w.map((n) => '='.repeat(n)).join('==='));

    // Tổng kết loại này
    const t = kList.reduce(
      (a, r) => ({
        portal: a.portal + (typeof r.portal === 'number' ? r.portal : 0),
        moi: a.moi + Math.max(0, r.count - r.failed - (r.noXml || 0) - r.skipped),
        co: a.co + (r.skipped || 0),
        noXml: a.noXml + (r.noXml || 0),
        loi: a.loi + (r.failed || 0),
      }),
      { portal: 0, moi: 0, co: 0, noXml: 0, loi: 0 },
    );
    const tongCoFile = t.moi + t.co;
    let tinhTrang = '';
    if (t.portal === 0) {
      tinhTrang = 'Không có hóa đơn nào trên cổng thuế';
    } else if (t.loi > 0 || t.noXml > 0) {
      const parts = [];
      if (t.loi > 0) parts.push(`${t.loi} HĐ lỗi chưa tải được`);
      if (t.noXml > 0) parts.push(`${t.noXml} HĐ không có file XML gốc`);
      tinhTrang = `CHƯA ĐỦ (Đã tải được ${tongCoFile}/${t.portal} HĐ — Còn thiếu: ${parts.join(', ')} — xem danh sách chi tiết bên dưới để tải tay/xin file)`;
    } else if (tongCoFile === t.portal) {
      tinhTrang = `KHỚP ĐỦ 100% VỚI CỔNG THUẾ (${tongCoFile}/${t.portal} hóa đơn)`;
    } else if (tongCoFile < t.portal) {
      tinhTrang = `CHƯA KHỚP (cổng thuế báo ${t.portal}, có file ${tongCoFile} — lệch ${t.portal - tongCoFile} HĐ)`;
    } else {
      tinhTrang = `Khớp (${tongCoFile}/${t.portal} hóa đơn)`;
    }

    log(`=> TỔNG KẾT ${titleKind}: Cổng thuế báo: ${t.portal} HĐ | Đã tải mới: ${t.moi} | Đã có sẵn: ${t.co} | Không có XML gốc: ${t.noXml} | Chưa tải được: ${t.loi}`);
    log(`   ĐÁNH GIÁ: ${tinhTrang}\n`);
  }
}

// ---------- danh sách hóa đơn chưa tải được (để tải tay) ----------
const csvCell = (v) => {
  const t = String(v ?? '');
  return /[",;\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

// Gom các hóa đơn chưa tải được từ bảng tổng hợp: mỗi dòng kèm vị trí (loại, đợt ngày, nhóm, tab, trang, dòng, STT)
function failedEntries(sum, ownMst) {
  const out = [];
  for (const r of sum || []) {
    const loai = r.kind === 'ban-ra' ? 'Bán ra' : 'Mua vào';
    const where = { loai, dot: r.tu ? `${r.tu} - ${r.den}` : '', nhom: r.nhom || '', tab: r.tab || '' };
    if (r.portal === 'LỖI') {
      out.push({ ...where, trang: '', dong: '', stt: '', kh: '', so: '', ngay: '', mst: '', lyDo: 'Tìm kiếm bị lỗi — tải tay CẢ MỤC này' });
      continue;
    }
    // hóa đơn lỗi (cần tải tay) và hóa đơn cổng thuế không có file gốc (khongFile: không cần tải lại)
    for (const [list, khongFile] of [[r.failedList, false], [r.noXmlList, true]]) {
      for (const f of list || []) {
        const st = status.fromCells(f.cells) || {};
        const mst = (st.msts || []).filter((m) => m !== ownMst).join(', ');
        out.push({ ...where, trang: f.trang, dong: f.dong, stt: f.stt, kh: st.kh || '', so: st.so ?? '', ngay: st.ngay || '', mst, lyDo: f.lyDo, khongFile });
      }
    }
  }
  return out;
}

// In danh sách và lưu file CSV (mở bằng Excel) cạnh file nhật ký
function printFailed(all, log) {
  const list = all.filter((x) => !x.khongFile); // lỗi tải -> cần tải tay
  const khong = all.filter((x) => x.khongFile); // không có file XML gốc
  const total = list.length + khong.length;

  log(`\n${'='.repeat(25)} DANH SÁCH HÓA ĐƠN CHƯA TẢI ĐƯỢC / CẦN TẢI TAY (${total}) ${'='.repeat(25)}`);
  if (!total) {
    log('Đã tải thành công 100% — không có hóa đơn nào bị lỗi hoặc thiếu file gốc.');
    return null;
  }

  const where = (x) => `${x.loai} | Đợt: ${x.dot} | ${shortNhom(x.nhom)} | Tab: ${shortTab(x.tab)}`;
  const itemInfo = (x) => `Ký hiệu: ${x.kh || '?'} | Số HĐ: ${x.so ?? '?'} | Ngày: ${x.ngay || '?'} | MST bên kia: ${x.mst || '?'}\n     Vị trí: ${where(x)} (Trang ${x.trang}, dòng ${x.dong}, STT ${x.stt})`;

  if (list.length) {
    log(`\n>>> 1. HÓA ĐƠN BỊ LỖI KHI TẢI (${list.length} hóa đơn) — CẦN TẢI TAY TRÊN CỔNG THUẾ:`);
    log('(Vào Tra cứu hóa đơn, chọn đúng Đợt ngày, Nhóm và Tab, tới đúng Trang/Dòng để bấm tải file XML):');
    list.forEach((x, i) => {
      log(`  ${String(i + 1).padStart(2)}. ${itemInfo(x)}`);
      log(`     Lý do lỗi: ${x.lyDo}`);
    });
  }

  if (khong.length) {
    log(`\n>>> 2. HÓA ĐƠN CỔNG THUẾ KHÔNG CÓ FILE XML GỐC (${khong.length} hóa đơn) — CẦN TẢI BẢN PDF HOẶC XIN BÊN BÁN:`);
    log('(Cổng thuế báo "Không tồn tại hồ sơ gốc của hóa đơn" nên không thể tải file XML):');
    khong.forEach((x, i) => {
      log(`  ${String(i + 1).padStart(2)}. ${itemInfo(x)}`);
      log(`     Tình trạng: ${x.lyDo} -> Hãy xem/tải bản PDF trên trang thuế hoặc liên hệ người bán`);
    });
  }

  if (!log.file || !all.length) return null;
  const head = ['#', 'Phân loại', 'Cần tải tay', 'Loại', 'Đợt ngày', 'Nhóm (Kết quả kiểm tra)', 'Tab', 'Trang', 'Dòng', 'STT', 'Ký hiệu', 'Số HĐ', 'Ngày HĐ', 'MST bên kia', 'Lý do / Hướng dẫn'];
  const lines = [
    head,
    ...list.map((x, i) => [i + 1, 'Lỗi tải cổng thuế', 'Có (tải file XML)', x.loai, x.dot, x.nhom, x.tab, x.trang, x.dong, x.stt, x.kh, x.so, x.ngay, x.mst, x.lyDo]),
    ...khong.map((x, i) => [list.length + i + 1, 'Không có XML gốc', 'Có (tải file PDF/xin bên bán)', x.loai, x.dot, x.nhom, x.tab, x.trang, x.dong, x.stt, x.kh, x.so, x.ngay, x.mst, `${x.lyDo} (Tải PDF trên thuế hoặc xin bên bán)`]),
  ];
  const file = log.file.replace(/\.log$/, '_chua_tai_duoc.csv');
  try {
    fs.writeFileSync(file, '\ufeff' + lines.map((l) => l.map(csvCell).join(',')).join('\r\n'), 'utf8');
    log(`\n=> Đã lưu danh sách chi tiết các file chưa tải được ra file Excel: ${file}`);
    return file;
  } catch (e) {
    log(`(Không lưu được file danh sách: ${e.message})`);
    return null;
  }
}

module.exports = { runAuto, printSummary, failedEntries, printFailed, openLookup, loginState, parseVN, chunks, fmt, isUyNhiemChecked };
