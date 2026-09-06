// Generates the toolbar icons without any image dependencies:
// a rounded dark square with two overlapping "side by side" circles.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
// Supersampled coverage for smooth edges.
function coverage(x, y, inside, s = 4) {
  let hit = 0;
  for (let i = 0; i < s; i++) for (let j = 0; j < s; j++) hit += inside(x - 0.5 + (i + 0.5) / s, y - 0.5 + (j + 0.5) / s) ? 1 : 0;
  return hit / (s * s);
}
function roundedSquare(x, y, size, r) {
  const cx = Math.max(r, Math.min(size - r, x)), cy = Math.max(r, Math.min(size - r, y));
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
function icon(size) {
  const r = size * 0.22;
  const c1 = [size * 0.38, size * 0.52], c2 = [size * 0.62, size * 0.52], cr = size * 0.19;
  return png(size, (x, y) => {
    const bg = coverage(x, y, (px, py) => roundedSquare(px, py, size, r));
    if (bg === 0) return [0, 0, 0, 0];
    const left = coverage(x, y, (px, py) => (px - c1[0]) ** 2 + (py - c1[1]) ** 2 <= cr * cr);
    const right = coverage(x, y, (px, py) => (px - c2[0]) ** 2 + (py - c2[1]) ** 2 <= cr * cr);
    // dark base, white left circle, blue right circle
    let [cr_, cg, cb] = [28, 28, 30];
    const blend = (a, col) => { cr_ = cr_ + (col[0] - cr_) * a; cg = cg + (col[1] - cg) * a; cb = cb + (col[2] - cb) * a; };
    blend(left, [245, 245, 247]);
    blend(right, [10, 132, 255]);
    return [Math.round(cr_), Math.round(cg), Math.round(cb), Math.round(bg * 255)];
  });
}
mkdirSync('icons', { recursive: true });
for (const s of [16, 32, 48, 128]) writeFileSync(`icons/${s}.png`, icon(s));
console.log('icons written');
