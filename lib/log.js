// Ghi nhật ký ra màn hình và file logs/<ngày>_<giờ>_<tên>.log
const fs = require('fs');
const path = require('path');

const pad = (n) => String(n).padStart(2, '0');

function createLog(name, dir = path.join(__dirname, '..', 'logs')) {
  fs.mkdirSync(dir, { recursive: true });
  const d = new Date();
  const file = path.join(dir, `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}h${pad(d.getMinutes())}_${name}.log`);
  const log = (msg = '') => {
    console.log(msg);
    const t = new Date();
    try {
      fs.appendFileSync(file, `[${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}] ${msg}\n`, 'utf8');
    } catch {}
  };
  log.file = file;
  return log;
}

module.exports = { createLog };
