// ─── make-icon — build/icon.svg → build/icon.ico (16–256 px) + build/icon.png ───
// Renders with Electron's own Chromium, so no image library is needed.
// Usage: npx electron scripts/make-icon.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

// ICO with PNG payloads (valid since Windows Vista).
function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e);
    head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(data.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p.data)]);
}

// One hidden page draws the SVG onto a canvas at every size (vector → each size, no upscaling).
async function renderAll(svg) {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('about:blank');
  const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  const urls = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image(); img.src = ${JSON.stringify(src)}; await img.decode();
    return ${JSON.stringify(SIZES)}.map((s) => {
      const c = document.createElement('canvas'); c.width = s; c.height = s;
      const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, s, s);
      return c.toDataURL('image/png');
    });
  })()`);
  win.destroy();
  return urls.map((u, i) => ({ size: SIZES[i], data: Buffer.from(u.split(',')[1], 'base64') }));
}

app.whenReady().then(async () => {
  try {
    const svg = fs.readFileSync(path.join(ROOT, 'build', 'icon.svg'), 'utf8');
    const pngs = await renderAll(svg);
    fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), ico(pngs));
    fs.writeFileSync(path.join(ROOT, 'build', 'icon.png'), pngs[pngs.length - 1].data);
    console.log(`icon.ico: ${SIZES.join(', ')} px`);
    app.exit(0);
  } catch (err) {
    console.error('make-icon failed:', err);
    app.exit(1);
  }
});
