// Lưu trạng thái hóa đơn đọc từ bảng tra cứu của cổng thuế (file XML không có thông tin này).
// File: input/<mua-vao|ban-ra>/_trang_thai.json — mỗi lần tải (kể cả hóa đơn đã có) đều cập nhật lại,
// vì trạng thái có thể đổi về sau (vd hóa đơn bị hủy, bị thay thế).
const fs = require('fs');
const path = require('path');

const FILE = '_trang_thai.json';
const norm = (s) => String(s || '').normalize('NFC').trim();

function load(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'));
  } catch {
    return {};
  }
}

function save(dir, map) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, FILE);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(map, null, 1), 'utf8');
  fs.renameSync(`${file}.tmp`, file);
}

// Đọc thông tin từ các ô của 1 dòng trên bảng tra cứu
function fromCells(cells) {
  let kh = null;
  let so = null;
  for (let j = 0; j + 1 < cells.length; j++) {
    if (/^[A-Z0-9]{6}$/.test(cells[j]) && /^\d+$/.test(cells[j + 1])) {
      kh = cells[j];
      so = Number(cells[j + 1]);
      break;
    }
  }
  if (!kh) return null;
  const texts = cells.map(norm);
  const lower = texts.map((t) => t.toLowerCase());
  const ngay = texts.find((t) => /^\d{2}\/\d{2}\/\d{4}/.test(t)) || null;
  return {
    kh,
    so,
    // MST có thể nằm trong chữ, vd "MST người bán: 0100230800"
    msts: [...new Set(texts.join(' ').match(/\b\d{10}(?:-\d{3})?\b/g) || [])],
    ngay: ngay ? ngay.slice(0, 10) : null,
    tthai: texts.find((t, i) => /^hóa đơn/.test(lower[i]) && t.length < 40 && /(mới|thay thế|điều chỉnh|hủy)/.test(lower[i])) || null,
    kqxl: texts.find((t, i) => t.length < 90 && /(cấp mã|đã nhận|không mã|máy tính tiền|từ chối)/.test(lower[i]) && !/^hóa đơn/.test(lower[i])) || null,
    batHopPhap: lower.some((t) => t.includes('bất hợp pháp')),
    capNhat: new Date().toISOString(),
  };
}

// Ghi nhận 1 dòng; trả về entry (hoặc null nếu không đọc được ký hiệu/số)
function record(map, cells, extra = {}) {
  const e = fromCells(cells);
  if (!e) return null;
  const key = `${e.kh}|${e.so}`;
  const list = map[key] || (map[key] = []);
  // cùng ký hiệu + số: so khớp theo bộ MST (mua vào: mọi dòng đều có MST bên mua nên phải trùng hết)
  // dòng ghi bởi bản cũ có thể thiếu MST người bán -> coi là cùng hóa đơn nếu bộ MST này chứa bộ kia
  const same = list.find((x) => x.msts.every((m) => e.msts.includes(m)) || e.msts.every((m) => x.msts.includes(m)));
  if (same) Object.assign(same, e, { uyNhiem: same.uyNhiem || !!extra.uyNhiem });
  else list.push({ ...e, uyNhiem: !!extra.uyNhiem });
  return e;
}

// Tìm trạng thái của 1 hóa đơn (đã đọc từ XML). Mua vào phải khớp MST người bán.
function lookup(map, inv, kind) {
  const list = map[`${inv.khhdon}|${Number(inv.shdon)}`];
  if (!list || !list.length) return null;
  // Mua vào: MST bên mua (chính mình) có ở mọi dòng -> phải khớp MST người bán.
  // Dòng ghi bởi bản cũ chỉ có MST bên mua: dùng được nếu chỉ có đúng 1 dòng như vậy.
  if (kind === 'mua-vao') {
    const hit = list.find((x) => x.msts.includes(inv.nban.mst));
    if (hit) return hit;
    const old = list.filter((x) => x.msts.every((m) => m === inv.nmua.mst));
    return old.length === 1 ? old[0] : null;
  }
  return list.find((x) => x.msts.includes(inv.nmua.mst)) || (list.length === 1 ? list[0] : null);
}

// Hóa đơn không được cộng vào tổng
const isExcluded = (tthai) => /bị hủy|bị thay thế/i.test(norm(tthai));
const isAdjust = (tthai) => /điều chỉnh/i.test(norm(tthai));

module.exports = { load, save, record, lookup, fromCells, isExcluded, isAdjust, FILE };
