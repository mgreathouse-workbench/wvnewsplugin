const { createCanvas } = require('@napi-rs/canvas');
const fs = require('fs');
const path = require('path');

function makeIcon(size, dark) {
  const c = createCanvas(size, size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = dark ? '#1f1f1f' : '#ffffff';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = dark ? '#e0e0e0' : '#2c2c2c';
  const pad = Math.round(size * 0.18);
  ctx.fillRect(pad, pad, size - 2 * pad, size - 2 * pad);
  ctx.fillStyle = dark ? '#1f1f1f' : '#ffffff';
  const lineH = Math.max(1, Math.round(size * 0.05));
  const x0 = pad + Math.round(size * 0.06);
  const w = size - 2 * pad - Math.round(size * 0.12);
  for (let i = 0; i < 4; i++) {
    const y = pad + Math.round(size * (0.18 + i * 0.16));
    const lw = i === 0 ? w : Math.round(w * (i % 2 === 0 ? 0.75 : 0.9));
    ctx.fillRect(x0, y, lw, lineH);
  }
  return c.toBuffer('image/png');
}

const out = process.argv[2] || path.join(__dirname, '..', 'plugin', 'wvnews-print', 'icons');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'icon-light.png'),   makeIcon(48, false));
fs.writeFileSync(path.join(out, 'icon-light@2x.png'), makeIcon(96, false));
fs.writeFileSync(path.join(out, 'icon-dark.png'),    makeIcon(48, true));
fs.writeFileSync(path.join(out, 'icon-dark@2x.png'),  makeIcon(96, true));
console.log('Wrote 4 icons to', out);
