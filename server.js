const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { readFolder, guessOwnMst } = require('./lib/reader');
const { writeWorkbook } = require('./lib/excel');

const PORT = Number(process.env.PORT) || 3456;
const IN_DIR = path.join(__dirname, 'input');
const OUT_DIR = path.join(__dirname, 'output');
let lastFile = null;

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => {
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

async function build({ folder, mst }) {
  const dir = folder && folder.trim() ? folder.trim() : IN_DIR;
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`Không tìm thấy thư mục: ${dir}`);

  const { invoices, errors, fileCount, dup } = readFolder(dir);
  if (!invoices.length) {
    throw new Error(`Không đọc được hóa đơn nào trong ${dir} (${fileCount} file .xml/.zip). Hãy tải file XML hóa đơn từ cổng thuế.`);
  }

  const own = (mst && mst.trim()) || guessOwnMst(invoices);
  const sold = invoices.filter((i) => i.nban.mst === own);
  const purchase = invoices.filter((i) => i.nban.mst !== own && i.nmua.mst === own);
  const other = invoices.filter((i) => i.nban.mst !== own && i.nmua.mst !== own);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
  const file = path.join(OUT_DIR, `HoaDon_${own || 'chiTiet'}_${stamp}.xlsx`);
  await writeWorkbook(file, { sold, purchase, other, errors });
  lastFile = file;

  return {
    folder: dir,
    mst: own,
    fileCount,
    total: invoices.length,
    dup,
    sold: sold.length,
    purchase: purchase.length,
    other: other.length,
    items: invoices.reduce((s, i) => s + i.items.length, 0),
    errors,
    file: path.basename(file),
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return fs.createReadStream(path.join(__dirname, 'public', 'index.html')).pipe(res);
    }
    if (req.method === 'GET' && url.pathname === '/api/info') {
      return send(res, 200, { inputDir: IN_DIR });
    }
    if (req.method === 'POST' && url.pathname === '/api/build') {
      return send(res, 200, await build(await readBody(req)));
    }
    if (req.method === 'GET' && url.pathname === '/api/download') {
      if (!lastFile) return send(res, 404, { message: 'Chưa có file' });
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${path.basename(lastFile)}"`,
      });
      return fs.createReadStream(lastFile).pipe(res);
    }
    if (req.method === 'POST' && url.pathname === '/api/open-folder') {
      const which = (await readBody(req)).which === 'input' ? IN_DIR : OUT_DIR;
      fs.mkdirSync(which, { recursive: true });
      exec(`explorer "${which}"`);
      return send(res, 200, { ok: true });
    }
    send(res, 404, { message: 'Not found' });
  } catch (e) {
    send(res, 400, { message: e.message });
  }
});

fs.mkdirSync(IN_DIR, { recursive: true });
server.listen(PORT, '127.0.0.1', () => {
  const link = `http://localhost:${PORT}`;
  console.log(`Tool đang chạy tại ${link} (nhấn Ctrl+C để dừng)`);
  if (process.platform === 'win32' && !process.env.NO_OPEN) exec(`start "" ${link}`);
});
