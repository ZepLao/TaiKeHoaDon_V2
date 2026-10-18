// Thao tác trên trang Tra cứu hóa đơn của cổng thuế (Ant Design v3): chọn dòng, bấm Xuất xml, sang trang...
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { readFolder, readFile } = require('./reader');
const status = require('./status');

const SITE = 'https://hoadondientu.gdt.gov.vn/';
const PROFILE_DIR = path.join(__dirname, '..', '.browser-profile');
const DELAY_MS = 1200; // nghỉ giữa 2 lần tải, giống tốc độ thao tác tay
const DOWNLOAD_WAIT_MS = Number(process.env.DL_WAIT_MS) || 90000; // cổng thuế có lúc trả file rất chậm

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safe = (s) => s.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/_+/g, '_').slice(0, 90);

async function launch() {
  for (const channel of ['msedge', 'chrome']) {
    try {
      return await chromium.launchPersistentContext(PROFILE_DIR, {
        channel,
        headless: false,
        acceptDownloads: true,
        viewport: null,
        args: ['--start-maximized'],
      });
    } catch (e) {
      console.log(`Không mở được ${channel}: ${e.message.split('\n')[0]}`);
    }
  }
  throw new Error('Không tìm thấy Microsoft Edge hoặc Google Chrome');
}

// Trang tra cứu đang mở (tab trình duyệt cuối cùng của cổng thuế)
async function currentPage(ctx) {
  const pages = ctx.pages().filter((p) => !p.isClosed() && p.url().includes('hoadondientu.gdt.gov.vn'));
  if (pages.length) return pages[pages.length - 1];
  const p = await ctx.newPage();
  await p.goto(SITE).catch(() => {});
  return p;
}

// Đánh dấu các phần tử khớp selector mà đang thực sự hiển thị ở tab đang mở.
// Trang thuế (Ant Design v3) giữ lại bảng của tab không mở (chỉ đẩy ra ngoài màn hình),
// và bảng có cột cố định được vẽ thêm các lớp .ant-table-fixed-left/right -> phải loại ra.
function markActive(page, selector, attr) {
  return page.evaluate(
    ({ selector, attr }) => {
      document.querySelectorAll(`[${attr}]`).forEach((el) => el.removeAttribute(attr));
      let n = 0;
      for (const el of document.querySelectorAll(selector)) {
        if (el.closest('.ant-tabs-tabpane-inactive, [aria-hidden="true"], .ant-table-fixed-left, .ant-table-fixed-right')) continue;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height || r.right <= 0 || r.left >= window.innerWidth) continue;
        const st = getComputedStyle(el);
        if (st.visibility === 'hidden' || st.display === 'none') continue;
        el.setAttribute(attr, String(n++));
      }
      return n;
    },
    { selector, attr },
  );
}

async function visibleRows(page) {
  const n = await markActive(page, 'tr.ant-table-row', 'data-tool-row');
  return Array.from({ length: n }, (_, i) => page.locator(`[data-tool-row="${i}"]`));
}

// Chọn dòng: bấm vào ô ở giữa (ô đầu có thể bị lớp cột cố định che)
async function selectRow(row) {
  const cells = row.locator('td');
  const n = await cells.count();
  const cell = cells.nth(Math.min(Math.floor(n / 2), Math.max(n - 1, 0)));
  await row.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  try {
    await cell.click({ timeout: 5000 });
  } catch {
    await cell.dispatchEvent('click');
  }
}

// Nút "Xuất xml" chỉ là icon có tooltip -> rê chuột lên từng nút để tìm đúng nút
async function findXmlButton(page) {
  const marked = page.locator('[data-tool-xml="1"]');
  if ((await marked.count()) && (await marked.first().isVisible())) return marked.first();
  const n = await markActive(page, 'button', 'data-tool-btn');
  for (let i = 0; i < n; i++) {
    const b = page.locator(`[data-tool-btn="${i}"]`);
    if ((await b.innerText()).trim().length > 2) continue; // chỉ xét nút icon
    await b.hover({ force: true, timeout: 3000 }).catch(() => {});
    await sleep(350);
    const tip = page.locator('.ant-tooltip:not(.ant-tooltip-hidden) .ant-tooltip-inner', { hasText: /xuất xml/i });
    if ((await tip.count()) && (await tip.first().isVisible())) {
      await b.evaluate((el) => el.setAttribute('data-tool-xml', '1'));
      await page.mouse.move(0, 0);
      return b;
    }
  }
  return null;
}

// Tab đang mở là mua vào hay bán ra (dựa vào tiêu đề tab đang chọn)
// Dựa vào: tên tab đang chọn ("Tra cứu hóa đơn điện tử mua vào") và tiêu đề "Danh sách hóa đơn điện tử mua vào"
async function pageState(page) {
  return page.evaluate(() => {
    const hidden = (el) => el.closest('.ant-tabs-tabpane-inactive, [aria-hidden="true"]');
    const shown = (el) => !hidden(el) && el.getClientRects().length > 0;
    const tabs = [...document.querySelectorAll('.ant-tabs-tab-active')].filter(shown).map((el) => el.innerText.trim());
    const titles = [...document.querySelectorAll('.ld-header-title, span')]
      .filter((el) => shown(el) && /^Danh sách hóa đơn/i.test(el.innerText.normalize('NFC').trim()))
      .map((el) => el.innerText.trim());
    const rows = [...document.querySelectorAll('tr.ant-table-row')];
    return { tabs, titles, allRows: rows.length, shownRows: rows.filter((el) => shown(el) && !el.closest('.ant-table-fixed-left, .ant-table-fixed-right')).length, url: location.href };
  });
}

function kindOf(state) {
  const text = [...state.tabs, ...state.titles].join(' | ').normalize('NFC').toLowerCase();
  const mua = text.includes('mua vào');
  const ban = text.includes('bán ra');
  if (mua && !ban) return 'mua-vao';
  if (ban && !mua) return 'ban-ra';
  // cả hai (vd: tab bán ra đang mở nhưng tiêu đề tab kia còn hiện) -> ưu tiên tiêu đề danh sách
  const title = state.titles.join(' ').normalize('NFC').toLowerCase();
  if (title.includes('mua vào')) return 'mua-vao';
  if (title.includes('bán ra')) return 'ban-ra';
  return null;
}

// Chọn tab trình duyệt đang có bảng hóa đơn; chờ bảng tải xong tối đa ~15 giây
async function findWorkPage(ctx, log) {
  let best = null;
  for (let t = 0; t < 15; t++) {
    const pages = ctx.pages().filter((p) => !p.isClosed());
    if (!pages.length) await currentPage(ctx);
    for (const p of ctx.pages().filter((x) => !x.isClosed())) {
      const st = await pageState(p).catch(() => null);
      if (st && (!best || st.shownRows > best.st.shownRows)) best = { page: p, st };
    }
    if (best && best.st.shownRows > 0) break;
    if (t === 0) log('Đang chờ bảng hóa đơn hiện ra...');
    best = t < 14 ? null : best;
    await sleep(1000);
  }
  return best;
}

// Dòng "Có N kết quả" của tab đang mở
async function resultCount(page) {
  return page.evaluate(() => {
    for (const el of document.querySelectorAll('span')) {
      if (el.closest('.ant-tabs-tabpane-inactive, [aria-hidden="true"]') || !el.getClientRects().length) continue;
      const m = /^Có ([\d,.]+) kết quả$/.exec(el.innerText.trim());
      if (m) return Number(m[1].replace(/[,.]/g, ''));
    }
    return null;
  });
}

async function nextPage(page, firstRowText) {
  // Cổng thuế dùng nút icon mũi tên phải (cạnh chữ "1 / N"), không dùng phân trang của Ant Design
  let n = await markActive(page, 'button:has(.anticon-right):not([disabled])', 'data-tool-next');
  if (!n) n = await markActive(page, '.ant-pagination-next:not(.ant-pagination-disabled)', 'data-tool-next');
  if (!n) return false;
  const target = page.locator('[data-tool-next="0"]');
  await target.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  await target.click({ timeout: 5000 }).catch(() => target.dispatchEvent('click'));
  // chờ bảng đổi dữ liệu
  for (let t = 0; t < 30; t++) {
    await sleep(500);
    const rows = await visibleRows(page);
    if (rows.length && (await rows[0].innerText()) !== firstRowText) return true;
  }
  return false;
}

// Tên file chuẩn theo nội dung XML: MSTngườibán_KýhiệuMẫusốKýhiệu_Số.zip
const invoiceFileName = (inv) => safe(`${inv.nban.mst}_${inv.khmshdon}${inv.khhdon}_${inv.shdon}`) + '.zip';
const numKey = (khhdon, shdon) => `${khhdon}|${Number(shdon)}`;

// Chỉ mục các hóa đơn đã có trong thư mục: "ký hiệu|số" -> [MST người bán]
function buildIndex(dir) {
  const index = new Map();
  for (const inv of readFolder(dir).invoices) {
    const k = numKey(inv.khhdon, inv.shdon);
    index.set(k, [...(index.get(k) || []), inv.nban.mst]);
  }
  return index;
}

// Dòng trên bảng đã có trong thư mục chưa? Bán ra: khớp ký hiệu + số.
// Mua vào: phải khớp thêm MST người bán (nhiều người bán có thể trùng ký hiệu + số).
function alreadyHave(index, cells, kind) {
  for (let j = 0; j + 1 < cells.length; j++) {
    if (!/^[A-Z0-9]{6}$/.test(cells[j]) || !/^\d+$/.test(cells[j + 1])) continue;
    const sellers = index.get(numKey(cells[j], cells[j + 1]));
    if (sellers && (kind === 'ban-ra' || sellers.some((m) => cells.includes(m)))) return true;
  }
  return false;
}

// Trang đang xử lý? (lớp "Đang xử lý..." của cổng thuế hoặc bảng đang tải)
function isBusy(page) {
  return page
    .evaluate(() => [...document.querySelectorAll('.ant-spin-spinning')].some((el) => el.getClientRects().length > 0))
    .catch(() => false);
}

async function waitIdle(page, maxMs = 120000) {
  const end = Date.now() + maxMs;
  while (Date.now() < end && (await isBusy(page))) await sleep(500);
}

// Hàng đợi mọi file trang tải về (kể cả file về muộn của lần bấm trước)
function downloadQueue(page) {
  if (!page._toolQueue) {
    page._toolQueue = [];
    page.on('download', (d) => page._toolQueue.push(d));
  }
  return page._toolQueue;
}

let tmpNo = 0;
// Lưu 1 file vừa tải theo nội dung XML -> { inv, name, isNew }
async function saveDownload(dl, dir, index) {
  const tmp = path.join(dir, `_dang_tai_${process.pid}_${++tmpNo}.zip`);
  await dl.saveAs(tmp);
  const inv = readFile(tmp).invoices[0];
  const name = inv ? invoiceFileName(inv) : `khong_doc_duoc_${Date.now()}.zip`;
  const dest = path.join(dir, name);
  if (inv && fs.existsSync(dest)) {
    fs.unlinkSync(tmp);
    return { inv, name, isNew: false };
  }
  fs.renameSync(tmp, dest);
  if (inv) {
    const k = numKey(inv.khhdon, inv.shdon);
    index.set(k, [...(index.get(k) || []), inv.nban.mst]);
  }
  return { inv, name, isNew: true };
}

// Ký hiệu + số hóa đơn của dòng đang chọn (để kiểm tra file tải về đúng hóa đơn)
function rowKey(cells) {
  for (let j = 0; j + 1 < cells.length; j++) {
    if (/^[A-Z0-9]{6}$/.test(cells[j]) && /^\d+$/.test(cells[j + 1])) return { kh: cells[j], so: Number(cells[j + 1]) };
  }
  return null;
}
const sameInvoice = (inv, exp) => !exp || (inv && inv.khhdon === exp.kh && Number(inv.shdon) === exp.so);

// Lỗi tạm thời phía cổng thuế (vd "Cassandra timeout during read query...") -> chờ rồi thử lại
const TRANSIENT = /cassandra|timeout|timed out|time out|quá thời gian|đang bận|thử lại sau|503|502|504|chưa nhận được file/i;
const MAX_RETRY = 0; // không thử lại: lỗi thì bỏ qua, tải hóa đơn tiếp theo

async function closeNotices(page) {
  const close = page.locator('.ant-notification-notice-close');
  const n = await close.count().catch(() => 0);
  for (let i = 0; i < n; i++) await close.nth(i).click({ timeout: 1000 }).catch(() => {});
}

// Bấm "Xuất xml" cho dòng đang chọn và chờ đúng file của hóa đơn đó.
// Không bấm lại khi trang còn đang xử lý (tránh gửi yêu cầu dồn lên cổng thuế).
async function fetchRow(page, dir, index, cells, log, count) {
  const exp = rowKey(cells);
  const queue = downloadQueue(page);
  const errBox = page.locator('.ant-message-error, .ant-notification-notice-error');
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRY + 1; attempt++) {
    if (attempt > 1) {
      const wait = 5 * (attempt - 1);
      log(`  [${count}] Cổng thuế đang bận (${lastErr.message.split('\n')[0].slice(0, 60)}) -> thử lại lần ${attempt - 1}/${MAX_RETRY} sau ${wait}s`);
      await closeNotices(page);
      await sleep(wait * 1000);
    }
    await waitIdle(page);
    const btn = await findXmlButton(page);
    if (!btn) throw new Error('Không tìm thấy nút "Xuất xml" trên trang');
    const before = await errBox.count();
    try {
      await btn.click({ timeout: 5000 });
    } catch {
      await btn.dispatchEvent('click');
    }
    const deadline = Date.now() + DOWNLOAD_WAIT_MS;
    lastErr = null;
    while (!lastErr) {
      while (queue.length) {
        const r = await saveDownload(queue.shift(), dir, index);
        if (!r.inv || sameInvoice(r.inv, exp)) return r; // không đọc được file -> coi là của dòng này, không bấm lại
        log(`  [${count}] (nhận file về muộn của hóa đơn khác: ${r.name}${r.isNew ? ' - đã lưu' : ' - đã có'})`);
      }
      if ((await errBox.count()) > before) {
        const msg = (await errBox.last().innerText().catch(() => '')).trim() || 'không rõ';
        lastErr = new Error(`Trang báo lỗi: ${msg}`);
        if (!TRANSIENT.test(msg)) throw lastErr;
        break;
      }
      if (Date.now() > deadline) {
        lastErr = new Error(`Chưa nhận được file sau ${DOWNLOAD_WAIT_MS / 1000}s`);
        break;
      }
      await sleep(400);
    }
  }
  throw lastErr;
}

// Cuối lượt: chờ và lưu nốt các file về muộn
async function drainLate(page, dir, index, log) {
  await waitIdle(page, 60000);
  await sleep(2000);
  const queue = downloadQueue(page);
  while (queue.length) {
    const r = await saveDownload(queue.shift(), dir, index);
    log(`  (file về muộn: ${r.name}${r.isNew ? ' - đã lưu' : ' - đã có'})`);
  }
}

async function downloadAll(page, dir, log, kind, onPage) {
  fs.mkdirSync(dir, { recursive: true });
  const index = buildIndex(dir);
  const statusMap = status.load(dir);
  downloadQueue(page); // bắt cả file về muộn
  let count = 0;
  let failed = 0;
  let pageNo = 1;
  const failedList = [];
  let skipped = 0;
  const total = await resultCount(page);
  if (total !== null) log(`Trang thuế báo: có ${total} kết quả`);
  await page.evaluate(() => document.querySelectorAll('[data-tool-xml]').forEach((el) => el.removeAttribute('data-tool-xml')));
  for (;;) {
    const rows = await visibleRows(page);
    if (!rows.length) {
      log('Không thấy dòng hóa đơn nào trên bảng.');
      break;
    }
    const firstText = await rows[0].innerText();
    log(`Trang ${pageNo}: ${rows.length} hóa đơn`);
    const texts = [];
    for (const row of rows) texts.push((await row.locator('td').allInnerTexts()).map((s) => s.trim()).filter(Boolean));
    for (const c of texts) status.record(statusMap, c); // trạng thái hóa đơn (hủy, thay thế...) kể cả hóa đơn đã có
    status.save(dir, statusMap);
    for (let i = 0; i < rows.length; i++) {
      if (page.isClosed()) throw new Error('Cửa sổ trình duyệt đã bị đóng');
      const row = rows[i];
      const cells = texts[i];
      ++count;
      const label = cells.slice(1, 6).join(' | ');
      if (alreadyHave(index, cells, kind)) {
        skipped++;
        log(`  [${count}] Đã có, bỏ qua  ${label}`);
        continue;
      }
      try {
        await waitIdle(page);
        await selectRow(row);
        await sleep(300);
        const r = await fetchRow(page, dir, index, cells, log, count);
        if (r.isNew) log(`  [${count}] OK  ${r.name}`);
        else {
          skipped++;
          log(`  [${count}] Đã có, bỏ qua  ${r.name}`);
        }
      } catch (e) {
        failed++;
        failedList.push(cells);
        log(`  [${count}] LỖI ${label}: ${e.message.split('\n')[0]}`);
        if (/Không tìm thấy nút|closed|đã bị đóng/i.test(e.message)) throw e;
      }
      await sleep(DELAY_MS);
    }
    if (onPage) await onPage(texts);
    if (!(await nextPage(page, firstText))) break;
    pageNo++;
  }
  await drainLate(page, dir, index, log);
  const notYet = failedList.filter((c) => !alreadyHave(index, c, kind)); // bỏ các hóa đơn đã về muộn
  failed = notYet.length;
  if (notYet.length) {
    log(`Có ${notYet.length} hóa đơn chưa tải được (chạy lại lần sau tool sẽ chỉ tải các hóa đơn này):`);
    for (const c of notYet) log(`  - ${c.slice(1, 6).join(" | ")}`);
  }
  return { count, failed, skipped };
}

module.exports = {
  SITE, sleep, launch, currentPage, markActive, visibleRows, pageState, kindOf, findWorkPage,
  resultCount, isBusy, waitIdle, downloadAll, buildIndex, alreadyHave,
};
