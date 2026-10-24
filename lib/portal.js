// Thao tác trên trang Tra cứu hóa đơn của cổng thuế (Ant Design v3): chọn dòng, bấm Xuất xml, sang trang...
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { readFolder, readFile } = require('./reader');
const status = require('./status');

const SITE = 'https://hoadondientu.gdt.gov.vn/';
const DEFAULT_PROFILE = path.join(__dirname, '..', '.browser-profile');
// Nghỉ NGẪU NHIÊN giữa các thao tác (mặc định 1,5-4 giây) để nhịp thao tác không đều như máy -> tránh bị cổng thuế coi là bot,
// và để cổng thuế kịp phản hồi (thao tác dồn dập làm trang treo).
// Đổi khoảng nghỉ: đặt biến môi trường PAUSE_MIN_MS / PAUSE_MAX_MS.
const PAUSE_MIN_MS = Number(process.env.PAUSE_MIN_MS) || 1500;
const PAUSE_MAX_MS = Math.max(PAUSE_MIN_MS, Number(process.env.PAUSE_MAX_MS) || 4000);
const rand = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const humanPause = (min = PAUSE_MIN_MS, max = PAUSE_MAX_MS) => new Promise((r) => setTimeout(r, rand(min, max)));
// Chờ file tối đa 20 giây; nếu trang vẫn đang 'Đang xử lý' thì chờ thêm, tổng không quá 30 giây.
// Quá thì bỏ qua, tải hóa đơn tiếp (file về muộn vẫn được lưu).
const DOWNLOAD_WAIT_MS = Number(process.env.DL_WAIT_MS) || 20000;
const DOWNLOAD_MAX_MS = Math.max(DOWNLOAD_WAIT_MS, Number(process.env.DL_MAX_MS) || 30000);
// thông báo nhỏ (message / notification) và hộp thông báo dạng popup (Modal.error / warning)
const NOTICE = '.ant-message-notice, .ant-notification-notice, .ant-message-error, .ant-notification-notice-error, .ant-modal-confirm';
const FRESH = NOTICE.split(',').map((x) => `${x.trim()}:not([data-tool-seen])`).join(', ');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safe = (s) => s.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/_+/g, '_').slice(0, 90);

// Ưu tiên Google Chrome; máy không có Chrome thì mới dùng Microsoft Edge.
// Chrome dùng thư mục dữ liệu riêng (<profile>/chrome) — không mở chung dữ liệu Edge cũ (dễ lỗi khác phiên bản).
async function launch(profileDir = DEFAULT_PROFILE) {
  for (const [channel, dir] of [['chrome', path.join(profileDir, 'chrome')], ['msedge', profileDir]]) {
    try {
      return await chromium.launchPersistentContext(dir, {
        channel,
        headless: false,
        acceptDownloads: true,
        viewport: null,
        // không khôi phục các tab của lần chạy trước
        args: ['--start-maximized', '--no-first-run', '--disable-session-crashed-bubble', '--hide-crash-restore-bubble'],
      }).then((ctx) => {
        ctx.setDefaultTimeout(15000); // thao tác nào kẹt quá 15 giây thì báo lỗi, không đứng im
        ctx.setDefaultNavigationTimeout(60000); // cổng thuế tải trang chậm
        return ctx;
      });
    } catch (e) {
      console.log(`Không mở được ${channel}: ${e.message.split('\n')[0]}`);
    }
  }
  throw new Error('Không tìm thấy Google Chrome hoặc Microsoft Edge');
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
  // chờ bảng đổi dữ liệu: tối đa 20 giây, trang còn 'Đang xử lý' thì chờ thêm (tổng tối đa 60 giây)
  const start = Date.now();
  for (;;) {
    await sleep(500);
    const rows = await visibleRows(page);
    if (rows.length && (await rows[0].innerText().catch(() => firstRowText)) !== firstRowText) {
      await settle(page); // bảng đã đổi -> chờ trang tải xong hẳn rồi mới thao tác
      return true;
    }
    const ms = Date.now() - start;
    if (ms > 60000 || (ms > 20000 && !(await isBusy(page)))) return false;
  }
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
    const m = /^(\d?)([A-Z0-9]{6})$/.exec(cells[j]);
    if (!m || !/^\d+$/.test(cells[j + 1])) continue;
    const key = numKey(m[2], cells[j + 1]);
    const list = (index.get(key) || []).filter((e) => fs.existsSync(e.file));
    index.set(key, list);
    const msts = mstsIn(cells);
    const hit = list.find((e) => kind === 'ban-ra' || msts.includes(e.mst));
    if (hit) return hit.file;
  }
  return null;
}

// Trang đang xử lý? (lớp "Đang xử lý..." của cổng thuế hoặc bảng đang tải)
// Chỉ tính vòng quay đang HIỆN trên màn hình — bỏ qua vòng quay của tab con không mở (bị đẩy ra ngoài màn hình)
function isBusy(page) {
  return page
    .evaluate(() =>
      [...document.querySelectorAll('.ant-spin-spinning')].some((el) => {
        if (el.closest('.ant-tabs-tabpane-inactive, [aria-hidden="true"]')) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.right > 0 && r.left < window.innerWidth;
      }),
    )
    .catch(() => false);
}

// Chờ trang hết "Đang xử lý" (tối đa maxMs). Có log -> cứ 15 giây báo một lần để biết tool không bị treo.
async function waitIdle(page, maxMs = 60000, log, what = 'xử lý') {
  const start = Date.now();
  let told = 0;
  while (Date.now() - start < maxMs && (await isBusy(page))) {
    const sec = Math.floor((Date.now() - start) / 1000);
    if (log && sec >= told + 15) {
      told = sec;
      log(`    ... cổng thuế đang ${what} (${sec}s)`);
    }
    await sleep(500);
  }
  return !(await isBusy(page));
}

// Các yêu cầu dữ liệu (xhr/fetch) trang đã gửi lên cổng thuế mà chưa nhận trả lời -> Map(request -> lúc gửi)
function netPending(page) {
  if (!page._toolNet) {
    const pending = (page._toolNet = new Map());
    page.on('request', (r) => ['xhr', 'fetch'].includes(r.resourceType()) && pending.set(r, Date.now()));
    page.on('requestfinished', (r) => pending.delete(r));
    page.on('requestfailed', (r) => pending.delete(r));
  }
  return page._toolNet;
}

// Chờ cổng thuế trả lời HẾT các yêu cầu đang dở (liền 0,8 giây không còn yêu cầu nào), tối đa maxMs.
// Yêu cầu treo quá 90 giây coi như đã chết, không chờ nữa.
async function waitNetIdle(page, maxMs = 30000) {
  const pending = netPending(page);
  const start = Date.now();
  let quietSince = 0;
  while (Date.now() - start < maxMs) {
    const now = Date.now();
    for (const [r, t] of pending) if (now - t > 90000) pending.delete(r);
    if (pending.size) quietSince = 0;
    else if (!quietSince) quietSince = now;
    else if (now - quietSince >= 800) return true;
    await sleep(200);
  }
  return false;
}

// Nhịp thao tác tự điều chỉnh: cổng thuế chậm / lỗi / không trả file -> tăng mức chậm (nghỉ lâu hơn giữa các hóa đơn),
// chạy trơn tru liền vài hóa đơn -> giảm dần về nhịp thường.
const SLOW_MAX = 4;
function slower(page, log) {
  const before = page._toolSlow || 0;
  page._toolSlow = Math.min(SLOW_MAX, before + 1);
  page._toolOk = 0;
  if (log && page._toolSlow > before) log(`    (cổng thuế phản hồi chậm -> tool đi chậm lại, nghỉ ${paceText(page)} giữa các hóa đơn)`);
}
function faster(page) {
  if (!page._toolSlow || ++page._toolOk < 5) return;
  page._toolSlow--;
  page._toolOk = 0;
}
const paceRange = (page) => [PAUSE_MIN_MS * (1 + (page._toolSlow || 0)), PAUSE_MAX_MS * (1 + (page._toolSlow || 0))];
const paceText = (page) => paceRange(page).map((ms) => Math.round(ms / 1000)).join('-') + 's';
// Nghỉ trước thao tác tiếp: đợi trang hết "Đang xử lý", cổng thuế trả lời hết yêu cầu đang dở, rồi nghỉ ngẫu nhiên theo nhịp hiện tại
async function settle(page) {
  await waitIdle(page, 60000);
  await waitNetIdle(page, 30000);
  await humanPause(...paceRange(page));
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
    const m = /^(\d?)([A-Z0-9]{6})$/.exec(cells[j]);
    if (m && /^\d+$/.test(cells[j + 1])) return { kh: m[2], so: Number(cells[j + 1]) };
  }
  return null;
}
const sameInvoice = (inv, exp) => !exp || (inv && inv.khhdon === exp.kh && Number(inv.shdon) === exp.so);

// Lỗi tạm thời phía cổng thuế (vd "Cassandra timeout during read query...") -> chờ rồi thử lại
const TRANSIENT = /cassandra|timeout|timed out|time out|quá thời gian|đang bận|thử lại sau|503|502|504|chưa nhận được file/i;
const MAX_RETRY = 0; // không thử lại: lỗi thì bỏ qua, tải hóa đơn tiếp theo
// Bao nhiêu hóa đơn LIÊN TIẾP bị treo / hết giờ / lỗi tạm thời thì coi như trang bị treo -> tải lại trang
const STUCK_LIMIT = 3;
class PortalStuckError extends Error {}
class LoginLostError extends Error {}

// Mất phiên đăng nhập? (hết cookie đăng nhập "jwt", trang hiện lại nút "Đăng nhập", hoặc trang 403)
async function loginLost(page) {
  if (page.isClosed()) return false;
  const cs = await page.context().cookies(SITE).catch(() => null);
  if (!cs) return false;
  if (!cs.some((c) => c.name === 'jwt' && c.value)) return true;
  return page
    .evaluate(() => {
      const shown = (el) => el && el.getClientRects().length > 0;
      const text = (document.body && document.body.innerText) || '';
      const forbidden = /\b403\b/.test(text) && /không có quyền truy cập/i.test(text);
      const loginBtn = [...document.querySelectorAll('.home-header-menu-item span, button, a')].some((el) => shown(el) && el.innerText.normalize('NFC').trim() === 'Đăng nhập');
      return forbidden || loginBtn;
    })
    .catch(() => false);
}

// Cổng thuế báo KHÔNG CÓ file gốc của hóa đơn -> thử lại bao nhiêu lần cũng không có, không cần tải lại.
// Ghi nhớ vào <thư mục>/_khong_co_xml.json để các lần chạy sau bỏ qua luôn (xóa file này nếu muốn thử lại).
const NO_XML = /không tồn tại hồ sơ gốc|không tồn tại hóa đơn/i;
const NO_XML_FILE = '_khong_co_xml.json';
function loadNoXml(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, NO_XML_FILE), 'utf8'));
  } catch {
    return {};
  }
}
function saveNoXml(dir, map) {
  try {
    fs.writeFileSync(path.join(dir, NO_XML_FILE), JSON.stringify(map, null, 1), 'utf8');
  } catch {}
}
// Dòng này đã được ghi nhớ là "không có file gốc"? Mua vào: khớp thêm MST người bán
// (bỏ MST công ty mình ra vì dòng nào cũng có — nếu không sẽ nhận nhầm hóa đơn trùng ký hiệu + số của người bán khác)
function knownNoXml(map, cells, kind, ownMst) {
  const k = rowKey(cells);
  const e = k && map[numKey(k.kh, k.so)];
  if (!e) return null;
  return kind === 'ban-ra' || mstsIn(cells).some((m) => m !== ownMst && (e.msts || []).includes(m)) ? e : null;
}

async function closeNotices(page) {
  const close = page.locator('.ant-notification-notice-close');
  const n = await close.count().catch(() => 0);
  for (let i = 0; i < n; i++) await close.nth(i).click({ timeout: 1000 }).catch(() => {});
}

// Dòng đang được chọn trên bảng (cổng thuế gắn class "ant-selected-row") -> ký hiệu + số, hoặc null
function selectedKey(page) {
  return page
    .evaluate(() => {
      const tr = [...document.querySelectorAll('tr.ant-selected-row')].find(
        (el) => !el.closest('.ant-tabs-tabpane-inactive, [aria-hidden="true"], .ant-table-fixed-left, .ant-table-fixed-right') && el.getClientRects().length,
      );
      if (!tr) return null;
      const cells = [...tr.querySelectorAll('td')].map((td) => td.innerText.trim());
      for (let j = 0; j + 1 < cells.length; j++) {
        const m = /^(\d?)([A-Z0-9]{6})$/.exec(cells[j]);
        if (m && /^\d+$/.test(cells[j + 1])) return { kh: m[2], so: Number(cells[j + 1]) };
      }
      return { kh: null, so: null };
    })
    .catch(() => null);
}

// Chọn dòng: bấm vào ô KHÔNG có nút/link (bấm nhầm nút "Hóa đơn liên quan"... sẽ mở hộp thoại),
// rồi KIỂM TRA trang đã chọn đúng dòng (đúng ký hiệu + số) — tránh bấm "Xuất xml" cho nhầm hóa đơn.
async function selectRow(row, exp) {
  const page = row.page();
  const isRight = async () => {
    const s = await selectedKey(page);
    return !!s && (!exp || (s.kh === exp.kh && s.so === exp.so));
  };
  const safeCells = await row
    .evaluate((tr) =>
      [...tr.children]
        .map((td, i) => ({ i, ok: !td.querySelector('a, button, input, .ant-btn, [role="button"], .anticon') && td.getBoundingClientRect().width > 8 }))
        .filter((x) => x.ok && x.i > 0)
        .map((x) => x.i),
    )
    .catch(() => []);
  for (const i of [...safeCells.slice(0, 4), 'row']) {
    try {
      if (i === 'row') await row.dispatchEvent('click');
      else await row.locator('td').nth(i).click({ position: { x: 6, y: 6 }, timeout: 4000 });
    } catch {
      continue; // ô bị lớp khác che -> thử ô khác
    }
    for (let t = 0; t < 20; t++) {
      // cổng thuế chậm thì dòng được chọn sau vài giây -> chờ tối đa 3 giây rồi mới thử ô khác
      if (await isRight()) return true;
      await sleep(150);
    }
  }
  return false;
}

// Thời gian chờ file tự điều chỉnh theo tốc độ thực tế của cổng thuế (đo từ các file về muộn)
const waitFor = (page) => Math.min(Math.max(DOWNLOAD_WAIT_MS, page._toolWait || 0), DOWNLOAD_MAX_MS);
function noteLatency(page, ms) {
  page._toolWait = Math.max(page._toolWait || 0, Math.round(ms * 1.3) + 3000);
}
// hóa đơn đã bấm "Xuất xml" nhưng chưa nhận file (file có thể về muộn) -> { kh, so, count, start }
const pendingOf = (page) => page._toolPending || (page._toolPending = []);

// Ghi nhận file vừa về: nếu là file về muộn của hóa đơn trước thì báo đúng hóa đơn đó
function claimLate(page, r, log) {
  const p = pendingOf(page);
  const i = r.inv ? p.findIndex((x) => sameInvoice(r.inv, x)) : -1;
  if (i >= 0) {
    const x = p.splice(i, 1)[0];
    const sec = (Date.now() - x.start) / 1000;
    noteLatency(page, Date.now() - x.start);
    log(`  [${x.count}] OK (về muộn sau ${Math.round(sec)}s)  ${r.name}${r.isNew ? '' : ' - đã có'}`);
    if (waitFor(page) > DOWNLOAD_WAIT_MS) log(`    (cổng thuế đang chậm -> tăng thời gian chờ mỗi hóa đơn lên ${Math.round(waitFor(page) / 1000)}s)`);
  } else {
    log(`  (nhận file: ${r.name}${r.isNew ? ' - đã lưu' : ' - đã có'})`);
  }
}

// Bấm "Xuất xml" cho dòng đang chọn và chờ đúng file của hóa đơn đó.
async function fetchRow(page, dir, index, cells, log, count, guard) {
  const exp = rowKey(cells);
  const queue = downloadQueue(page);
  const fresh = page.locator(FRESH);
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
  const wait = waitFor(page);
  let told = 0;
  for (;;) {
    while (queue.length) {
      const r = await saveDownload(queue.shift(), dir, index, guard);
      if (!r.inv || sameInvoice(r.inv, exp)) {
        if (Date.now() - start > DOWNLOAD_WAIT_MS) noteLatency(page, Date.now() - start);
        return r;
      }
      claimLate(page, r, log);
    }
    if ((await fresh.count()) > 0) {
      const el = fresh.first();
      const msg = (await el.innerText().catch(() => '')).trim() || 'không rõ';
      await el.evaluate((n) => n.setAttribute('data-tool-seen', '1')).catch(() => {});
      await dismissModals(page); // popup lỗi -> đóng để không che các nút
      if (/thành công|success/i.test(msg)) continue; // thông báo thành công -> chờ file tiếp
      throw new Error(`Trang báo lỗi: ${msg}`);
    }
    const now = Date.now();
    if (now - start > wait && !(now - start < Math.max(wait, DOWNLOAD_MAX_MS) && (await isBusy(page)))) {
      if (exp) pendingOf(page).push({ ...exp, count, start });
      const err = new Error(`sau ${Math.round((now - start) / 1000)}s — chuyển sang hóa đơn tiếp, file về muộn vẫn được lưu`);
      err.timeout = true;
      throw err;
    }
    const sec = Math.floor((now - start) / 1000);
    if (sec >= told + 20) {
      told = sec;
      log(`    ... [${count}] đang chờ cổng thuế trả file (${sec}s)`);
    }
    await sleep(400);
  }
}

// Cuối lượt: chờ và lưu nốt các file về muộn
async function drainLate(page, dir, index, log, guard) {
  await waitIdle(page, 60000);
  const queue = downloadQueue(page);
  // còn hóa đơn đang chờ file -> chờ thêm tối đa 30 giây
  for (let t = 0; t < 30 && pendingOf(page).length && !queue.length; t++) await sleep(1000);
  await sleep(300);
  while (queue.length) {
    const r = await saveDownload(queue.shift(), dir, index, guard);
    claimLate(page, r, log);
  }
  pendingOf(page).length = 0;
}

async function downloadAll(page, dir, log, kind, opts = {}) {
  const guard = { ownMst: opts.ownMst, kind };
  fs.mkdirSync(dir, { recursive: true });
  const index = buildIndex(dir);
  const statusMap = status.load(dir);
  downloadQueue(page); // bắt cả file về muộn
  let count = 0;
  let failed = 0;
  let newCount = 0; // số file tải mới trong lượt này (để cộng dồn khi phải tải lại trang giữa chừng)
  let stuck = 0; // số hóa đơn liên tiếp bị treo / hết giờ / lỗi 504 -> nhiều quá thì coi như trang bị treo
  let pageNo = 1;
  const failedList = [];
  const noXmlList = []; // hóa đơn cổng thuế báo không có file gốc (không cần tải lại)
  const noXmlMap = loadNoXml(dir);
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
        if (!opts.quiet) log(`  [${count}] Đã có file, bỏ qua  ${label}  (${path.basename(have)})`);
        continue;
      }
      const noXml = knownNoXml(noXmlMap, cells, kind, opts.ownMst);
      if (noXml) {
        noXmlList.push({ cells, trang: pageNo, dong: i + 1, stt: count, lyDo: noXml.lyDo });
        log(`  [${count}] Bỏ qua (cổng thuế không có file gốc, đã báo lần trước)  ${label}`);
        continue;
      }
      try {
        await waitIdle(page, 30000);
        await waitNetIdle(page, 30000); // cổng thuế còn đang xử lý yêu cầu trước -> chờ xong mới bấm tiếp
        await dismissModals(page);
        if (!(await selectRow(row, rowKey(cells)))) throw new Error('Không chọn được đúng dòng hóa đơn trên bảng');
        await sleep(rand(500, 1200));
        const t0 = Date.now();
        const r = await fetchRow(page, dir, index, cells, log, count, guard);
        stuck = 0;
        if (Date.now() - t0 > 10000) slower(page, log);
        else faster(page);
        if (r.isNew) {
          newCount++;
          log(`  [${count}] OK  ${r.name}`);
        } else {
          skipped++;
          log(`  [${count}] Đã có, bỏ qua  ${r.name}`);
        }
      } catch (e) {
        const lyDo = e.timeout ? 'Cổng thuế không trả file' : e.message.split('\n')[0].replace(/^Trang báo lỗi: /, '');
        if (!e.timeout && NO_XML.test(lyDo)) {
          // không có file gốc -> không tính là lỗi cần tải lại; ghi nhớ để lần sau bỏ qua luôn
          noXmlList.push({ cells, trang: pageNo, dong: i + 1, stt: count, lyDo });
          const k = rowKey(cells);
          if (k) {
            noXmlMap[numKey(k.kh, k.so)] = { kh: k.kh, so: k.so, msts: mstsIn(cells), lyDo, luc: new Date().toISOString() };
            saveNoXml(dir, noXmlMap);
          }
          log(`  [${count}] KHÔNG CÓ FILE GỐC ${label}: ${lyDo} (không cần tải lại)`);
          stuck = 0;
          await humanPause();
          continue;
        }
        failed++;
        failedList.push({ cells, trang: pageNo, dong: i + 1, stt: count, lyDo });
        slower(page, log);
        log(`  [${count}] ${e.timeout ? 'CHƯA CÓ FILE' : 'LỖI'} ${label}: ${e.message.split('\n')[0]}`);
        e.newCount = newCount;
        if (e instanceof WrongCompanyError || /closed|đã bị đóng/i.test(e.message)) throw e;
        // lỗi do mất đăng nhập -> báo ra ngoài để chờ đăng nhập lại rồi tải tiếp
        if (await loginLost(page)) {
          const err = new LoginLostError('Mất phiên đăng nhập cổng thuế');
          err.newCount = newCount;
          throw err;
        }
        if (/Không tìm thấy nút/i.test(e.message)) throw e;
        // treo / hết giờ / 504... liên tiếp nhiều hóa đơn -> trang bị treo, báo ra ngoài để tải lại trang rồi tải tiếp
        stuck = e.timeout || TRANSIENT.test(e.message) || /Không chọn được/.test(e.message) ? stuck + 1 : 0;
        if (stuck >= STUCK_LIMIT) {
          const err = new PortalStuckError(`${stuck} hóa đơn liên tiếp bị treo / lỗi cổng thuế`);
          err.newCount = newCount;
          throw err;
        }
      }
      await settle(page); // chờ cổng thuế xong việc + nghỉ ngẫu nhiên (1,5-4 giây, chậm thì lâu hơn) trước khi tải hóa đơn tiếp
    }
    if (!(await nextPage(page, firstText))) break;
    pageNo++;
  }
  // Cổng thuế báo N kết quả mà mới duyệt được ít hơn -> không sang được trang sau (trang bị treo).
  // Báo ra ngoài để tải lại trang rồi tải tiếp (hóa đơn đã có file sẽ được bỏ qua) — không âm thầm bỏ sót.
  if (total && count < total) {
    log(`  !! Mới duyệt ${count}/${total} hóa đơn — không sang được trang ${pageNo + 1}.`);
    const err = new PortalStuckError(`Không sang được trang ${pageNo + 1} của bảng kết quả`);
    err.newCount = newCount;
    throw err;
  }
  await drainLate(page, dir, index, log, guard);
  const notYet = failedList.filter((f) => !alreadyHave(index, f.cells, kind)); // bỏ các hóa đơn đã về muộn
  failed = notYet.length;
  if (notYet.length) {
    log(`\n  !! CÓ ${notYet.length} HÓA ĐƠN LỖI CHƯA TẢI ĐƯỢC (cần tải tay):`);
    for (const f of notYet) {
      const st = status.fromCells(f.cells) || {};
      const mst = (st.msts || []).filter((m) => m !== opts.ownMst).join(', ');
      log(`     + Trang ${f.trang}, dòng ${f.dong} (STT ${f.stt}) | Ký hiệu ${st.kh || '?'}, Số ${st.so ?? '?'}, Ngày ${st.ngay || '?'}, MST ${mst || '?'} -> Lý do: ${f.lyDo}`);
    }
  }
  if (noXmlList.length) {
    log(`\n  !! CÓ ${noXmlList.length} HÓA ĐƠN CỔNG THUẾ KHÔNG CÓ FILE XML GỐC:`);
    for (const f of noXmlList) {
      const st = status.fromCells(f.cells) || {};
      const mst = (st.msts || []).filter((m) => m !== opts.ownMst).join(', ');
      log(`     + Trang ${f.trang}, dòng ${f.dong} (STT ${f.stt}) | Ký hiệu ${st.kh || '?'}, Số ${st.so ?? '?'}, Ngày ${st.ngay || '?'}, MST ${mst || '?'} -> ${f.lyDo}`);
    }
  }
  return { count, failed, noXml: noXmlList.length, skipped, failedList: notYet, noXmlList, newCount };
}

module.exports = {
  SITE, sleep, rand, humanPause, launch, currentPage, openMainPage, markActive, visibleRows, pageState, kindOf, findWorkPage,
  NOTICE, resultCount, isBusy, waitIdle, waitNetIdle, settle, dismissModals, downloadAll, buildIndex, alreadyHave, mstsIn, WrongCompanyError, PortalStuckError,
  LoginLostError, loginLost,
};
