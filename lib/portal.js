// Thao tác trên trang Tra cứu hóa đơn của cổng thuế (Ant Design v3): chọn dòng, bấm Xuất xml, sang trang...
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { readFolder, readFile } = require('./reader');
const status = require('./status');

const SITE = 'https://hoadondientu.gdt.gov.vn/';
const DEFAULT_PROFILE = path.join(__dirname, '..', '.browser-profile');
const DELAY_MS = 1200; // nghỉ giữa 2 lần tải, giống tốc độ thao tác tay
// Chờ file tối đa 25 giây; nếu trang vẫn đang 'Đang xử lý' thì chờ thêm, tổng không quá 60 giây. Quá thì bỏ qua.
const DOWNLOAD_WAIT_MS = Number(process.env.DL_WAIT_MS) || 25000;
const DOWNLOAD_MAX_MS = Math.max(DOWNLOAD_WAIT_MS, Number(process.env.DL_MAX_MS) || 60000);
// thông báo nhỏ (message / notification) và hộp thông báo dạng popup (Modal.error / warning)
const NOTICE = '.ant-message-notice, .ant-notification-notice, .ant-message-error, .ant-notification-notice-error, .ant-modal-confirm';
const FRESH = NOTICE.split(',').map((x) => `${x.trim()}:not([data-tool-seen])`).join(', ');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safe = (s) => s.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/_+/g, '_').slice(0, 90);

async function launch(profileDir = DEFAULT_PROFILE) {
  for (const channel of ['msedge', 'chrome']) {
    try {
      return await chromium.launchPersistentContext(profileDir, {
        channel,
        headless: false,
        acceptDownloads: true,
        viewport: null,
        // không khôi phục các tab của lần chạy trước
        args: ['--start-maximized', '--no-first-run', '--disable-session-crashed-bubble', '--hide-crash-restore-bubble'],
      });
    } catch (e) {
      console.log(`Không mở được ${channel}: ${e.message.split('\n')[0]}`);
    }
  }
  throw new Error('Không tìm thấy Microsoft Edge hoặc Google Chrome');
}

// Trang tra cứu đang mở (tab trình duyệt cuối cùng của cổng thuế)
// Tab chính: tab tool mở cổng thuế để bạn đăng nhập (mainPage). Luôn dùng tab này, không mở tab mới.
async function currentPage(ctx) {
  if (ctx._toolMain && !ctx._toolMain.isClosed()) return ctx._toolMain;
  const pages = ctx.pages().filter((p) => !p.isClosed() && p.url().includes('hoadondientu.gdt.gov.vn'));
  if (pages.length) return pages[pages.length - 1];
  const p = await ctx.newPage();
  await p.goto(SITE).catch(() => {});
  ctx._toolMain = p;
  return p;
}

// Mở trình duyệt xong: giữ 1 tab làm tab chính, đóng các tab thừa (tab trống / tab cũ tự khôi phục)
async function openMainPage(ctx) {
  await sleep(1500); // chờ trình duyệt mở xong các tab khôi phục (nếu có)
  const pages = ctx.pages().filter((p) => !p.isClosed());
  const main = pages[0] || (await ctx.newPage());
  for (const p of pages.slice(1)) await p.close().catch(() => {});
  ctx._toolMain = main;
  await main.goto(SITE).catch(() => {});
  await main.bringToFront().catch(() => {});
  return main;
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
// Đóng hộp thoại đang mở (thông báo lỗi dạng popup, "Danh sách hóa đơn liên quan"...) — để lại sẽ che các nút
async function dismissModals(page) {
  for (let i = 0; i < 4; i++) {
    const open = await page
      .evaluate(() => [...document.querySelectorAll('.ant-modal-wrap')].filter((w) => getComputedStyle(w).display !== 'none' && w.getClientRects().length).length)
      .catch(() => 0);
    if (!open) return;
    const btn = page.locator('.ant-modal-wrap:visible .ant-modal-confirm-btns .ant-btn, .ant-modal-wrap:visible .ant-modal-close, .ant-modal-wrap:visible .ant-modal-footer .ant-btn').first();
    if (await btn.count().catch(() => 0)) await btn.click({ timeout: 2000 }).catch(() => page.keyboard.press('Escape'));
    else await page.keyboard.press('Escape').catch(() => {});
    await sleep(400);
  }
}

// Chọn dòng: bấm vào ô KHÔNG có nút/link (bấm nhầm nút "Hóa đơn liên quan"... sẽ mở hộp thoại)
// và không bị lớp cột cố định che (kiểm tra phần tử thật sự nằm trên cùng tại điểm bấm)
async function selectRow(row) {
  await row.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  const pt = await row
    .evaluate((tr) => {
      const tds = [...tr.children];
      const order = [...tds.keys()].slice(1).concat([0]);
      for (const i of order) {
        const td = tds[i];
        if (td.querySelector('a, button, input, .ant-btn, [role="button"], .anticon')) continue;
        const r = td.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) continue;
        const x = r.left + Math.min(r.width / 2, 25);
        const y = r.top + r.height / 2;
        if (x < 0 || x > innerWidth || y < 0 || y > innerHeight) continue;
        const top = document.elementFromPoint(x, y);
        if (top && (top === td || td.contains(top))) return { x, y };
      }
      return null;
    })
    .catch(() => null);
  if (pt) await row.page().mouse.click(pt.x, pt.y);
  else await row.locator('td').nth(1).dispatchEvent('click').catch(() => row.dispatchEvent('click'));
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
// Chỉ mục các file hóa đơn ĐANG CÓ trong thư mục: "ký hiệu|số" -> [{ mst người bán, đường dẫn file }]
function buildIndex(dir) {
  const index = new Map();
  for (const inv of readFolder(dir).invoices) {
    const k = numKey(inv.khhdon, inv.shdon);
    const file = path.join(dir, String(inv.file).split(' > ')[0]);
    index.set(k, [...(index.get(k) || []), { mst: inv.nban.mst, file }]);
  }
  return index;
}

// Dòng trên bảng đã có trong thư mục chưa? Bán ra: khớp ký hiệu + số.
// Mua vào: phải khớp thêm MST người bán (nhiều người bán có thể trùng ký hiệu + số).
// Mọi MST xuất hiện trong dòng (kể cả dạng "MST người bán: 0100230800")
const mstsIn = (cells) => [...new Set(cells.join(' ').match(/\b\d{10}(?:-\d{3})?\b/g) || [])];

// Trả về file đã có của dòng này (null nếu chưa có). Luôn kiểm tra file CÒN TỒN TẠI trên đĩa:
// bạn xóa file trong input thì tool tải lại, không dựa vào ghi nhớ cũ.
function alreadyHave(index, cells, kind) {
  for (let j = 0; j + 1 < cells.length; j++) {
    if (!/^[A-Z0-9]{6}$/.test(cells[j]) || !/^\d+$/.test(cells[j + 1])) continue;
    const key = numKey(cells[j], cells[j + 1]);
    const list = (index.get(key) || []).filter((e) => fs.existsSync(e.file));
    index.set(key, list);
    const msts = mstsIn(cells);
    const hit = list.find((e) => kind === 'ban-ra' || msts.includes(e.mst));
    if (hit) return hit.file;
  }
  return null;
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
// File không thuộc công ty đang chọn (đăng nhập nhầm tài khoản) -> không lưu vào công ty này, dừng tải
class WrongCompanyError extends Error {}
function checkOwner(inv, guard) {
  if (!guard || !guard.ownMst || !inv) return;
  const owner = guard.kind === 'ban-ra' ? inv.nban.mst : inv.nmua.mst;
  if (owner !== guard.ownMst) {
    throw new WrongCompanyError(`Hóa đơn ${inv.khhdon}-${inv.shdon} thuộc MST ${owner || '?'} (${guard.kind === 'ban-ra' ? 'người bán' : 'người mua'}), không phải công ty đang chọn ${guard.ownMst}. Có thể đang đăng nhập nhầm tài khoản — tool dừng để không lưu lẫn dữ liệu.`);
  }
}

async function saveDownload(dl, dir, index, guard) {
  const tmp = path.join(dir, `_dang_tai_${process.pid}_${++tmpNo}.zip`);
  await dl.saveAs(tmp);
  const inv = readFile(tmp).invoices[0];
  try {
    checkOwner(inv, guard);
  } catch (e) {
    // không để file nằm lại thư mục công ty này; chuyển sang input/_khac_cong_ty (khác ổ đĩa thì chép rồi xóa)
    const bad = path.join(__dirname, '..', 'input', '_khac_cong_ty');
    const dest = path.join(bad, invoiceFileName(inv));
    try {
      fs.mkdirSync(bad, { recursive: true });
      fs.renameSync(tmp, dest);
    } catch {
      try {
        fs.copyFileSync(tmp, dest);
      } catch {}
      try {
        fs.unlinkSync(tmp);
      } catch {}
    }
    throw e;
  }
  const name = inv ? invoiceFileName(inv) : `khong_doc_duoc_${Date.now()}.zip`;
  const dest = path.join(dir, name);
  if (inv && fs.existsSync(dest)) {
    fs.unlinkSync(tmp);
    return { inv, name, isNew: false };
  }
  fs.renameSync(tmp, dest);
  if (inv) {
    const k = numKey(inv.khhdon, inv.shdon);
    index.set(k, [...(index.get(k) || []), { mst: inv.nban.mst, file: dest }]);
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
async function fetchRow(page, dir, index, cells, log, count, guard) {
  const exp = rowKey(cells);
  const queue = downloadQueue(page);
  const fresh = page.locator(FRESH);
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRY + 1; attempt++) {
    if (attempt > 1) {
      const wait = 5 * (attempt - 1);
      log(`  [${count}] Cổng thuế đang bận (${lastErr.message.split('\n')[0].slice(0, 60)}) -> thử lại lần ${attempt - 1}/${MAX_RETRY} sau ${wait}s`);
      await closeNotices(page);
      await sleep(wait * 1000);
    }
    await waitIdle(page, 30000);
    const btn = await findXmlButton(page);
    if (!btn) throw new Error('Không tìm thấy nút "Xuất xml" trên trang');
    // đánh dấu các thông báo đang có; thông báo mới hiện sau khi bấm (lỗi / cảnh báo) -> bỏ qua hóa đơn ngay
    await page.evaluate((sel) => document.querySelectorAll(sel).forEach((el) => el.setAttribute('data-tool-seen', '1')), NOTICE).catch(() => {});
    try {
      await btn.click({ timeout: 5000 });
    } catch {
      await btn.dispatchEvent('click');
    }
    const start = Date.now();
    const deadline = start + DOWNLOAD_WAIT_MS;
    lastErr = null;
    while (!lastErr) {
      while (queue.length) {
        const r = await saveDownload(queue.shift(), dir, index, guard);
        if (!r.inv || sameInvoice(r.inv, exp)) return r; // không đọc được file -> coi là của dòng này, không bấm lại
        log(`  [${count}] (nhận file về muộn của hóa đơn khác: ${r.name}${r.isNew ? ' - đã lưu' : ' - đã có'})`);
      }
      if ((await fresh.count()) > 0) {
        const el = fresh.first();
        const msg = (await el.innerText().catch(() => '')).trim() || 'không rõ';
        await el.evaluate((n) => n.setAttribute('data-tool-seen', '1')).catch(() => {});
        await dismissModals(page); // popup lỗi -> đóng để không che các nút
        if (/thành công|success/i.test(msg)) continue; // thông báo thành công -> chờ file tiếp
        lastErr = new Error(`Trang báo lỗi: ${msg}`);
        if (!TRANSIENT.test(msg)) throw lastErr;
        break;
      }
      const now = Date.now();
      if (now > deadline && !(now < start + DOWNLOAD_MAX_MS && (await isBusy(page)))) {
        lastErr = new Error(`Chưa nhận được file sau ${Math.round((now - start) / 1000)}s — bỏ qua, tải hóa đơn tiếp theo`);
        break;
      }
      await sleep(400);
    }
  }
  throw lastErr;
}

// Cuối lượt: chờ và lưu nốt các file về muộn
async function drainLate(page, dir, index, log, guard) {
  await waitIdle(page, 60000);
  await sleep(2000);
  const queue = downloadQueue(page);
  while (queue.length) {
    const r = await saveDownload(queue.shift(), dir, index, guard);
    log(`  (file về muộn: ${r.name}${r.isNew ? ' - đã lưu' : ' - đã có'})`);
  }
}

async function downloadAll(page, dir, log, kind, opts = {}) {
  const guard = { ownMst: opts.ownMst, kind };
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
    for (const c of texts) status.record(statusMap, c, { uyNhiem: !!opts.uyNhiem }); // trạng thái hóa đơn (hủy, thay thế...) kể cả hóa đơn đã có
    status.save(dir, statusMap);
    for (let i = 0; i < rows.length; i++) {
      if (page.isClosed()) throw new Error('Cửa sổ trình duyệt đã bị đóng');
      const row = rows[i];
      const cells = texts[i];
      ++count;
      const label = cells.slice(1, 6).join(' | ');
      const have = alreadyHave(index, cells, kind);
      if (have) {
        skipped++;
        log(`  [${count}] Đã có file, bỏ qua  ${label}  (${path.basename(have)})`);
        continue;
      }
      try {
        await waitIdle(page, 30000);
        await dismissModals(page);
        await selectRow(row);
        await sleep(300);
        const r = await fetchRow(page, dir, index, cells, log, count, guard);
        if (r.isNew) log(`  [${count}] OK  ${r.name}`);
        else {
          skipped++;
          log(`  [${count}] Đã có, bỏ qua  ${r.name}`);
        }
      } catch (e) {
        failed++;
        failedList.push(cells);
        log(`  [${count}] LỖI ${label}: ${e.message.split('\n')[0]}`);
        if (e instanceof WrongCompanyError || /Không tìm thấy nút|closed|đã bị đóng/i.test(e.message)) throw e;
      }
      await sleep(DELAY_MS);
    }
    if (!(await nextPage(page, firstText))) break;
    pageNo++;
  }
  await drainLate(page, dir, index, log, guard);
  const notYet = failedList.filter((c) => !alreadyHave(index, c, kind)); // bỏ các hóa đơn đã về muộn
  failed = notYet.length;
  if (notYet.length) {
    log(`Có ${notYet.length} hóa đơn chưa tải được (chạy lại lần sau tool sẽ chỉ tải các hóa đơn này):`);
    for (const c of notYet) log(`  - ${c.slice(1, 6).join(" | ")}`);
  }
  return { count, failed, skipped };
}

module.exports = {
  SITE, sleep, launch, currentPage, openMainPage, markActive, visibleRows, pageState, kindOf, findWorkPage,
  resultCount, isBusy, waitIdle, dismissModals, downloadAll, buildIndex, alreadyHave, mstsIn, WrongCompanyError,
};
