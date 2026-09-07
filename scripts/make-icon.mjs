import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Generates build/icon.png (512x512) for electron-builder: a flat, high-contrast
 * emblem with a transparent background. Written as a dependency-free PNG encoder
 * so the repo stays free of image assets and build-time image tooling.
 */

const SIZE = 512;
const root = process.cwd();
const outDir = join(root, 'build');
const outPath = join(outDir, 'icon.png');
mkdirSync(outDir, { recursive: true });

const inCircle = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

const inRing = (x, y, cx, cy, rOuter, rInner) =>
  inCircle(x, y, cx, cy, rOuter) && !inCircle(x, y, cx, cy, rInner);

/** Triangle test using edge cross products. */
const inTriangle = (x, y, [ax, ay], [bx, by], [cx, cy]) => {
  const sign = (px, py, [x1, y1], [x2, y2]) =>
    (px - x2) * (y1 - y2) - (x1 - x2) * (py - y2);
  const d1 = sign(x, y, [ax, ay], [bx, by]);
  const d2 = sign(x, y, [bx, by], [cx, cy]);
  const d3 = sign(x, y, [cx, cy], [ax, ay]);
  const negative = d1 < 0 || d2 < 0 || d3 < 0;
  const positive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(negative && positive);
};

const SKY = [16, 26, 44];
const RUST = [196, 92, 44];
const SAND = [233, 178, 96];
const BAR = [236, 238, 244];

function pixel(x, y) {
  const cx = SIZE / 2;

  // Transparent outside the badge.
  if (!inCircle(x, y, cx, cx, 246)) return [0, 0, 0, 0];
  const base = [...SKY, 255];

  // Outer ring, then the sun, then the horizon bar and dune triangles.
  if (inRing(x, y, cx, cx, 246, 214)) return [...RUST, 255];
  if (inCircle(x, y, cx, 214, 104)) return [...SAND, 255];

  // Notch in the ring: three short rust spokes on the left half.
  if (y > 150 && y < 190 && x > 96 && x < 176) return [...RUST, 255];

  if (y > 348 && y < 372) return [...BAR, 255];
  if (y >= 240 && y <= 348) {
    if (inTriangle(x, y, [128, 348], [252, 224], [352, 348])) return [...RUST, 255];
    if (inTriangle(x, y, [252, 348], [344, 258], [430, 348])) return [124, 62, 40, 255];
  }
  return base;
}

// ---------------------------------------------------------------- PNG encoding

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

const crc32 = (buffer) => {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

// Filter 0 (None) for every scanline: simple and always valid.
const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
for (let y = 0; y < SIZE; y++) {
  const rowStart = y * (1 + SIZE * 4);
  raw[rowStart] = 0;
  for (let x = 0; x < SIZE; x++) {
    const [r, g, b, a] = pixel(x, y);
    const offset = rowStart + 1 + x * 4;
    raw[offset] = r;
    raw[offset + 1] = g;
    raw[offset + 2] = b;
    raw[offset + 3] = a;
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
ihdr[10] = 0; // deflate
ihdr[11] = 0; // adaptive filtering
ihdr[12] = 0; // interlace off

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

writeFileSync(outPath, png);
console.log(`[icon] ${outPath} (${png.length} bytes)`);
