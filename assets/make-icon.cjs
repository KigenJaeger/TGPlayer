// Generates the app icon (assets/icon.svg + assets/icon.png) from one geometry
// definition, so the two can never drift apart.
//
// Why generate instead of shipping a binary: the window icon has to be a raster
// file (BrowserWindow ignores SVG) and electron-builder wants >=256px to make the
// .ico, but the shape itself is the brand mark from src/index.html. Keeping the
// vector source here means the icon can be edited as numbers rather than pixels.
//
// Run with:  node assets/make-icon.cjs
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 512;          // >=256 so electron-builder can derive the .ico
const VIEW = 48;           // the brand mark's own coordinate space
const RADIUS = 11;         // rounded-square corner, in VIEW units
const SAMPLES = 4;         // 4x4 supersampling per pixel for clean edges

// The paper plane from the .brand-mark svg, recentred and scaled to sit inside a
// rounded square instead of the original circle. Rounded joins in the source path
// are dropped: at icon sizes a 0.1-unit fillet is well under one pixel.
const PLANE = [
  [34.12, 10.98], [6.98, 21.10], [7.07, 24.78], [14.25, 27.45], [17.01, 36.37],
  [20.32, 37.02], [25.10, 30.85], [32.83, 36.47], [36.51, 35.09], [41.02, 13.10],
  [37.80, 10.98],
];
// The underside fold. Telegram's mark reads as a folded sheet only because this
// sits a shade darker than the body; without it the plane looks flat.
const FOLD = [
  [14.43, 27.45], [30.99, 16.23], [19.22, 29.57], [18.85, 33.80], [16.64, 26.90],
];

const BG_TOP = [111, 182, 232];      // #6fb6e8, the cool Material You blue
const BG_BOTTOM = [43, 134, 197];    // #2b86c5
const BODY = [255, 255, 255];
const FOLD_COLOR = [143, 213, 255];  // #8fd5ff

// Even-odd is enough here: neither polygon self-intersects.
function inPolygon(points, x, y) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Signed-distance test for a rounded rect: push the point into the corner circle's
// frame and measure from there, which is exact rather than an approximation.
function inRoundedRect(x, y) {
  const half = VIEW / 2;
  const dx = Math.max(Math.abs(x - half) - (half - RADIUS), 0);
  const dy = Math.max(Math.abs(y - half) - (half - RADIUS), 0);
  return Math.hypot(dx, dy) <= RADIUS;
}

const mix = (a, b, t) => a + (b - a) * t;

function renderPixels() {
  const pixels = Buffer.alloc(SIZE * SIZE * 4);
  const step = VIEW / SIZE / SAMPLES;
  const origin = VIEW / SIZE / SAMPLES / 2;
  for (let py = 0; py < SIZE; py += 1) {
    for (let px = 0; px < SIZE; px += 1) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const x = (px * VIEW) / SIZE + origin + sx * step;
          const y = (py * VIEW) / SIZE + origin + sy * step;
          if (!inRoundedRect(x, y)) continue;   // outside stays transparent
          let colour = [
            mix(BG_TOP[0], BG_BOTTOM[0], y / VIEW),
            mix(BG_TOP[1], BG_BOTTOM[1], y / VIEW),
            mix(BG_TOP[2], BG_BOTTOM[2], y / VIEW),
          ];
          if (inPolygon(PLANE, x, y)) colour = BODY;
          if (inPolygon(FOLD, x, y)) colour = FOLD_COLOR;
          r += colour[0]; g += colour[1]; b += colour[2]; a += 255;
        }
      }
      const total = SAMPLES * SAMPLES;
      const offset = (py * SIZE + px) * 4;
      // Averaging colour over covered samples only, then alpha over all of them,
      // keeps edge pixels the right hue instead of darkening them toward black.
      const covered = a / 255;
      if (covered > 0) {
        pixels[offset] = Math.round(r / covered);
        pixels[offset + 1] = Math.round(g / covered);
        pixels[offset + 2] = Math.round(b / covered);
      }
      pixels[offset + 3] = Math.round(a / total);
    }
  }
  return pixels;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header[8] = 8;    // bit depth
  header[9] = 6;    // colour type 6 = RGBA
  // Each scanline is prefixed with its filter byte; 0 means "store as-is", which
  // deflate handles well enough for flat artwork like this.
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
  for (let y = 0; y < SIZE; y += 1) {
    raw[y * (SIZE * 4 + 1)] = 0;
    pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const points = (list) => list.map(([x, y]) => `${x},${y}`).join(' ');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW} ${VIEW}" width="${SIZE}" height="${SIZE}">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="rgb(${BG_TOP.join(',')})"/>
      <stop offset="1" stop-color="rgb(${BG_BOTTOM.join(',')})"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="${VIEW}" height="${VIEW}" rx="${RADIUS}" fill="url(#sky)"/>
  <polygon points="${points(PLANE)}" fill="rgb(${BODY.join(',')})"/>
  <polygon points="${points(FOLD)}" fill="rgb(${FOLD_COLOR.join(',')})"/>
</svg>
`;

const dir = __dirname;
fs.writeFileSync(path.join(dir, 'icon.svg'), svg, 'utf8');
const png = encodePng(renderPixels());
fs.writeFileSync(path.join(dir, 'icon.png'), png);
process.stdout.write(`icon.png ${png.length} bytes at ${SIZE}x${SIZE}\n`);
