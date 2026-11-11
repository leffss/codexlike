// 生成 CodexLike 应用图标（工单 14）：纯 Node 自绘，不依赖第三方素材与图形库。
// 图形语言：深色圆角方块（与应用窗口 backgroundColor #0f172a 同源）+ 终端提示符「>_」
// （青色箭头 + 绿色下划线，呼应「本地 coding agent 终端工作台」）。
// 输出：build/icon.ico（16/24/32/48/64/128/256 多尺寸 PNG-in-ICO）与 build/icon.png（256 原图）。
// 运行：node scripts/make-icon.mjs（在 desktop 包内）
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// new URL('.', import.meta.url) 已指向 scripts/ 目录（尾随分隔符），直接 resolve 即可
const PKG_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const OUT_DIR = join(PKG_DIR, 'build');

const SIZE = 256;
const RADIUS = 56;
const BG = [0x0f, 0x17, 0x2a]; // slate-900（与窗口背景一致）
const ARROW = [0x22, 0xd3, 0xee]; // cyan-400
const UNDERLINE = [0x34, 0xd3, 0x99]; // emerald-400

/** 点到线段的最短距离 */
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** 圆角矩形 signed distance（<0 在内部；d=0 在边缘） */
function roundedRectSDF(x, y) {
  const half = SIZE / 2;
  const qx = Math.abs(x - half) - (half - RADIUS);
  const qy = Math.abs(y - half) - (half - RADIUS);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - RADIUS;
}

/** 覆盖率（0..1，edge 半像素过渡做抗锯齿） */
function coverage(sdfValue) {
  return Math.max(0, Math.min(1, 0.5 - sdfValue));
}

/** 线条覆盖（lineWidth 为全宽，soft 为 AA 边沿） */
function stroke(dist, lineWidth) {
  const half = lineWidth / 2;
  return Math.max(0, Math.min(1, half + 0.5 - dist));
}

/** 在 (x+0.5, y+0.5) 像素中心采样：返回 [r,g,b,a]（0..255，预乘意义下的 straight alpha） */
function sample(x, y) {
  const px = x + 0.5;
  const py = y + 0.5;
  // 背景：圆角方块，白底透明
  const bgAlpha = coverage(roundedRectSDF(px, py));
  // 「>」箭头：两条粗线在中心处折角
  const cx = 118;
  const cy = SIZE / 2;
  const d1 = distToSegment(px, py, 88, 90, cx, cy);
  const d2 = distToSegment(px, py, cx, cy, 88, 182);
  const arrowAlpha = Math.max(stroke(d1, 17), stroke(d2, 17));
  // 下划线「_」：圆头粗线
  const du = distToSegment(px, py, 140, 172, 176, 172);
  const underlineAlpha = stroke(du, 17);

  // 合成：背景 → 箭头 → 下划线（straight alpha over）
  let r = BG[0];
  let g = BG[1];
  let b = BG[2];
  let a = bgAlpha;
  for (const [color, alpha] of [
    [ARROW, arrowAlpha],
    [UNDERLINE, underlineAlpha],
  ]) {
    const outA = alpha + a * (1 - alpha);
    if (outA > 0) {
      r = (color[0] * alpha + r * a * (1 - alpha)) / outA;
      g = (color[1] * alpha + g * a * (1 - alpha)) / outA;
      b = (color[2] * alpha + b * a * (1 - alpha)) / outA;
      a = outA;
    }
  }
  return [Math.round(r), Math.round(g), Math.round(b), Math.round(a * 255)];
}

/** 渲染 256 原图 */
function renderFull() {
  const pixels = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const [r, g, b, a] = sample(x, y);
      const i = (y * SIZE + x) * 4;
      pixels[i] = r;
      pixels[i + 1] = g;
      pixels[i + 2] = b;
      pixels[i + 3] = a;
    }
  }
  return { size: SIZE, pixels };
}

/** 双线性缩放（straight alpha 直接插值，本图形状简单无明显伪影） */
function resize(full, target) {
  const pixels = new Uint8Array(target * target * 4);
  const scale = full.size / target;
  for (let y = 0; y < target; y += 1) {
    const fy = (y + 0.5) * scale - 0.5;
    const y0 = Math.max(0, Math.min(full.size - 1, Math.floor(fy)));
    const y1 = Math.min(full.size - 1, y0 + 1);
    const wy = Math.max(0, Math.min(1, fy - y0));
    for (let x = 0; x < target; x += 1) {
      const fx = (x + 0.5) * scale - 0.5;
      const x0 = Math.max(0, Math.min(full.size - 1, Math.floor(fx)));
      const x1 = Math.min(full.size - 1, x0 + 1);
      const wx = Math.max(0, Math.min(1, fx - x0));
      const i = (y * target + x) * 4;
      for (let c = 0; c < 4; c += 1) {
        const p00 = full.pixels[(y0 * full.size + x0) * 4 + c];
        const p10 = full.pixels[(y0 * full.size + x1) * 4 + c];
        const p01 = full.pixels[(y1 * full.size + x0) * 4 + c];
        const p11 = full.pixels[(y1 * full.size + x1) * 4 + c];
        const top = p00 + (p10 - p00) * wx;
        const bottom = p01 + (p11 - p01) * wx;
        pixels[i + c] = Math.round(top + (bottom - top) * wy);
      }
    }
  }
  return { size: target, pixels };
}

function crc32(bytes) {
  let c = ~0;
  for (const byte of bytes) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return ~c >>> 0;
}

/** RGBA 像素 → PNG 文件字节（filter 0 逐行，zlib 压缩） */
function encodePng(image) {
  // 每行布局：1 字节 filter（恒 0/None）+ size×4 字节 RGBA
  const stride = image.size * 4 + 1;
  const raw = Buffer.alloc(stride * image.size);
  for (let y = 0; y < image.size; y += 1) {
    raw[y * stride] = 0; // filter: None
    Buffer.from(image.pixels.buffer, y * image.size * 4, image.size * 4).copy(
      raw,
      y * stride + 1,
    );
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(image.size, 0);
  ihdr.writeUInt32BE(image.size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const chunk = (type, data) => {
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 多张 PNG 打包为 PNG-in-ICO（Vista+ 全尺寸支持；256 在目录项里记为 0） */
function encodeIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);
  const entries = Buffer.alloc(pngs.length * 16);
  let offset = 6 + entries.length;
  const buffers = [header, entries];
  pngs.forEach((png, index) => {
    const size = png.size >= 256 ? 0 : png.size;
    const entry = Buffer.alloc(16);
    entry[0] = size;
    entry[1] = size;
    entry[2] = 0; // 调色板
    entry[3] = 0;
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bpp
    entry.writeUInt32LE(png.data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entry.copy(entries, index * 16);
    offset += png.data.length;
    buffers.push(png.data);
  });
  return Buffer.concat(buffers);
}

mkdirSync(OUT_DIR, { recursive: true });
const full = renderFull();
const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = sizes.map((size) => ({ size, data: encodePng(size === SIZE ? full : resize(full, size)) }));
writeFileSync(join(OUT_DIR, 'icon.ico'), encodeIco(pngs));
writeFileSync(join(OUT_DIR, 'icon.png'), encodePng(full));
console.log(`[icon] 已生成 ${join(OUT_DIR, 'icon.ico')}（${sizes.join('/')}）与 icon.png`);
