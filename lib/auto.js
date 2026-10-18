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
async function openLookup(ctx, log) {
  const hasTabs = (p) =>
    p.evaluate(() => [...document.querySelectorAll('.ant-tabs-tab')].some((t) => /Tra cứu hóa đơn điện tử/i.test(t.innerText.normalize('NFC')))).catch(() => false);
  for (const p of ctx.pages()) if (!p.isClosed() && (await hasTabs(p))) return p;
  const page = await P.currentPage(ctx);
  log('Đang mở trang Tra cứu hóa đơn...');
  await page.goto(LOOKUP_URL).catch(() => {});
  for (let t = 0; t < 20; t++) {
    if (await hasTabs(page)) return page;
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
async function ttxlySelect(page, index) {
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
  await sleep(300);
  return texts[index];
}

async function clickSearch(page) {
  const clicked = await clickVisible(page, 'button', /^Tìm kiếm$/i);
  if (!clicked) throw new Error('Không thấy nút "Tìm kiếm"');
  await sleep(800);
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

async function runAuto(page, { from, to, kinds, inDir }, log) {
  const summary = [];
  for (const kind of kinds) {
    const dir = path.join(inDir, kind);
    const title = kind === 'ban-ra' ? 'BÁN RA' : 'MUA VÀO';
    await chooseTopTab(page, kind);
    let groups = [null];
    if (kind === 'mua-vao') {
      const opts = await ttxlySelect(page);
      groups = opts && opts.length ? opts.map((_, i) => i) : [null];
    }
    for (const c of chunks(from, to)) {
      for (const g of groups) {
        const nhom = g === null ? 'Tất cả' : await ttxlySelect(page, g);
        await setDates(page, c.from, c.to);
        if (g !== null) await ttxlySelect(page, g); // chọn lại sau khi đổi ngày cho chắc
        log(`\n=== ${title} | ${fmt(c.from)} - ${fmt(c.to)} | ${nhom} ===`);
        await clickSearch(page);
        const tabs = (await subTabNames(page)) || [];
        for (const tab of tabs.length ? tabs : ['']) {
          if (tab) await openSubTab(page, tab);
          const n = await P.resultCount(page);
          const rows = await P.visibleRows(page);
          log(`--- Tab "${tab || 'mặc định'}": ${n ?? rows.length} kết quả`);
          saveCount(dir, { tu: fmt(c.from), den: fmt(c.to), nhom, tab, soKetQua: n ?? rows.length, luc: new Date().toISOString() });
          if (!rows.length) continue;
          if ((n || 0) > 15 && (await setPageSize50(page))) log('    (đã chọn 50 dòng/trang)');
          const r = await P.downloadAll(page, dir, log, kind);
          summary.push({ kind, tu: fmt(c.from), den: fmt(c.to), nhom, tab, ...r });
        }
      }
    }
  }
  return summary;
}

module.exports = { runAuto, openLookup, parseVN, chunks, fmt };
