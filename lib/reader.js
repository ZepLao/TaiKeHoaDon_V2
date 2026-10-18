// Đọc hóa đơn điện tử dạng XML (chuẩn TT78/2021, Quyết định 1450) từ file .xml hoặc .zip tải trên cổng thuế.
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false, // giữ nguyên chuỗi (MST có số 0 đầu, số hóa đơn...)
  trimValues: true,
  isArray: (name) => ['HHDVu', 'LTSuat', 'TTin', 'LPhi', 'HDon'].includes(name),
});

const text = (v) => {
  if (v === undefined || v === null) return null;
  if (typeof v === 'object') return v['#text'] !== undefined ? String(v['#text']) : null;
  const s = String(v).trim();
  return s === '' ? null : s;
};
const num = (v) => {
  const s = text(v);
  if (s === null) return null;
  const n = Number(s.replace(/,/g, ''));
  return isNaN(n) ? s : n;
};
const arr = (v) => (v === undefined || v === null || v === '' ? [] : Array.isArray(v) ? v : [v]);

// Tìm đệ quy tất cả object có chứa key (vd: tìm các node có DLHDon)
function findAll(obj, key, out = []) {
  if (!obj || typeof obj !== 'object') return out;
  if (Array.isArray(obj)) {
    for (const x of obj) findAll(x, key, out);
    return out;
  }
  if (key in obj) out.push(obj);
  for (const v of Object.values(obj)) if (v && typeof v === 'object') findAll(v, key, out);
  return out;
}
const findFirst = (obj, key) => {
  const r = findAll(obj, key)[0];
  return r ? r[key] : undefined;
};

// "Thông tin khác": danh sách <TTin><TTruong/><KDLieu/><DLieu/></TTin> -> chuỗi
function otherInfo(node) {
  const items = arr(node && node.TTin)
    .map((t) => [text(t.TTruong), text(t.DLieu)])
    .filter(([, v]) => v !== null);
  return items.length ? items.map(([k, v]) => `${k}: ${v}`).join('; ') : null;
}

function party(p) {
  p = p || {};
  return {
    ten: text(p.Ten),
    mst: text(p.MST),
    dchi: text(p.DChi),
    mkhang: text(p.MKHang),
    hvtnmhang: text(p.HVTNMHang),
    cccd: text(p.CCCDan),
    sdt: text(p.SDThoai),
    email: text(p.DCTDTu),
    stk: text(p.STKNHang),
    nhang: text(p.TNHang),
    ttkhac: otherInfo(p.TTKhac),
  };
}

function normalize(hdon, file) {
  const dl = hdon.DLHDon || {};
  const tc = dl.TTChung || {};
  const nd = dl.NDHDon || {};
  const tt = nd.TToan || {};

  const items = arr(nd.DSHHDVu && nd.DSHHDVu.HHDVu).map((h) => ({
    tchat: num(h.TChat),
    stt: num(h.STT),
    ma: text(h.MHHDVu),
    ten: text(h.THHDVu),
    dvt: text(h.DVTinh),
    sluong: num(h.SLuong),
    dgia: num(h.DGia),
    tlckhau: num(h.TLCKhau),
    stckhau: num(h.STCKhau),
    thtien: num(h.ThTien),
    tsuat: text(h.TSuat),
    tthue: num(h.TThue),
    ttkhac: otherInfo(h.TTKhac),
  }));

  const rates = arr(tt.THTTLTSuat && tt.THTTLTSuat.LTSuat).map((r) => ({
    tsuat: text(r.TSuat),
    thtien: num(r.ThTien),
    tthue: num(r.TThue),
  }));

  const fees = arr(tt.DSLPhi && tt.DSLPhi.LPhi);
  const tongPhi = fees.reduce((s, f) => s + (Number(text(f.TPhi)) || 0), 0);

  const dscks = hdon.DSCKS || {};
  return {
    file,
    thdon: text(tc.THDon),
    khmshdon: text(tc.KHMSHDon),
    khhdon: text(tc.KHHDon),
    shdon: text(tc.SHDon),
    nlap: text(tc.NLap),
    dvtte: text(tc.DVTTe),
    tgia: num(tc.TGia),
    httt: text(tc.HTTToan),
    mstTCGP: text(tc.MSTTCGP),
    ttkhac: otherInfo(tc.TTKhac),
    mccqt: text(hdon.MCCQT),
    nky: text(findFirst(dscks.NBan, 'SigningTime')),
    nban: party(nd.NBan),
    nmua: party(nd.NMua),
    items,
    rates,
    tgtcthue: num(tt.TgTCThue),
    tgtthue: num(tt.TgTThue),
    ttcktmai: num(tt.TTCKTMai),
    tgtphi: fees.length ? tongPhi : null,
    tgtttbso: num(tt.TgTTTBSo),
    tgtttbchu: text(tt.TgTTTBChu),
    ttoanKhac: otherInfo(tt.TTKhac),
  };
}

function parseXml(buf, file, out, errors) {
  let doc;
  try {
    doc = parser.parse(buf.toString('utf8').replace(/^﻿/, ''));
  } catch (e) {
    errors.push({ file, error: `XML lỗi: ${e.message}` });
    return;
  }
  const nodes = findAll(doc, 'DLHDon');
  if (!nodes.length) return; // không phải file hóa đơn (vd: file phụ trong zip) -> bỏ qua
  for (const n of nodes) {
    try {
      const inv = normalize(n, file);
      if (!inv.shdon && !inv.khhdon) errors.push({ file, error: 'Không đủ thông tin hóa đơn (thiếu ký hiệu và số hóa đơn)' });
      else out.push(inv);
    } catch (e) {
      errors.push({ file, error: e.message });
    }
  }
}

function readZip(buf, file, out, errors) {
  let zip;
  try {
    zip = new AdmZip(buf);
  } catch (e) {
    errors.push({ file, error: `Zip lỗi: ${e.message}` });
    return;
  }
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const name = `${file} > ${entry.entryName}`;
    const ext = path.extname(entry.entryName).toLowerCase();
    if (ext === '.xml') parseXml(entry.getData(), name, out, errors);
    else if (ext === '.zip') readZip(entry.getData(), name, out, errors);
  }
}

// Đọc toàn bộ thư mục (kể cả thư mục con)
function readFolder(dir) {
  const invoices = [];
  const errors = [];
  let fileCount = 0;
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) {
        if (!ent.name.startsWith('_')) walk(full); // bỏ qua thư mục bắt đầu bằng "_" (vd: _trung)
        continue;
      }
      const ext = path.extname(ent.name).toLowerCase();
      if (ext !== '.xml' && ext !== '.zip') continue;
      fileCount++;
      const rel = path.relative(dir, full);
      const buf = fs.readFileSync(full);
      if (ext === '.xml') parseXml(buf, rel, invoices, errors);
      else readZip(buf, rel, invoices, errors);
    }
  };
  walk(dir);

  // Bỏ trùng (cùng 1 hóa đơn tải nhiều lần)
  const seen = new Set();
  const unique = [];
  let dup = 0;
  for (const inv of invoices) {
    const key = [inv.nban.mst, inv.khmshdon, inv.khhdon, inv.shdon].join('|');
    if (seen.has(key)) {
      dup++;
      continue;
    }
    seen.add(key);
    unique.push(inv);
  }
  unique.sort((a, b) => (a.nlap || '').localeCompare(b.nlap || '') || (Number(a.shdon) || 0) - (Number(b.shdon) || 0));
  return { invoices: unique, errors, fileCount, dup };
}

// MST của mình = MST xuất hiện trong nhiều hóa đơn nhất (ở vai trò bán hoặc mua)
function guessOwnMst(invoices) {
  const count = new Map();
  for (const inv of invoices) {
    for (const m of new Set([inv.nban.mst, inv.nmua.mst])) {
      if (m) count.set(m, (count.get(m) || 0) + 1);
    }
  }
  let best = null;
  for (const [m, c] of count) if (!best || c > best[1]) best = [m, c];
  return best ? best[0] : null;
}

// Đọc 1 file .xml/.zip -> danh sách hóa đơn bên trong
function readFile(full, name = path.basename(full)) {
  const out = [];
  const errors = [];
  const buf = fs.readFileSync(full);
  if (path.extname(full).toLowerCase() === '.zip') readZip(buf, name, out, errors);
  else parseXml(buf, name, out, errors);
  return { invoices: out, errors };
}

module.exports = { readFolder, readFile, guessOwnMst };
