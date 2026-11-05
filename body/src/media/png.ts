import { deflateSync } from "node:zlib";

const CRC = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC[n] = c >>> 0;
}
export function crc32(buf: Uint8Array, start = 0, end = buf.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  out.set(data, 8);
  out.writeUInt32BE(crc32(out, 4, 8 + data.length), 8 + data.length);
  return out;
}

/**
 * An 8-bit RGB PNG. Each scanline uses the Sub or Up filter, whichever leaves the smaller sum of residuals, then the
 * whole image is deflated. The same pixels always give the same bytes (for replay).
 */
export function encodePng(w: number, h: number, rgb: Uint8Array): Uint8Array {
  const stride = w * 3;
  const raw = Buffer.alloc((stride + 1) * h);
  const sub = new Uint8Array(stride);
  const up = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const row = y * stride;
    let sSub = 0;
    let sUp = 0;
    for (let i = 0; i < stride; i++) {
      const v = rgb[row + i]!;
      const a = i >= 3 ? rgb[row + i - 3]! : 0;
      const b = y > 0 ? rgb[row - stride + i]! : 0;
      sub[i] = (v - a) & 0xff;
      up[i] = (v - b) & 0xff;
      sSub += sub[i]! < 128 ? sub[i]! : 256 - sub[i]!;
      sUp += up[i]! < 128 ? up[i]! : 256 - up[i]!;
    }
    const o = y * (stride + 1);
    if (sUp < sSub) {
      raw[o] = 2;
      raw.set(up, o + 1);
    } else {
      raw[o] = 1;
      raw.set(sub, o + 1);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", new Uint8Array(0))]));
}
