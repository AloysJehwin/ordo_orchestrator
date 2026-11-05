/** Mono 16-bit PCM WAV from samples in [-1, 1]. */
export function encodeWav(samples: Float32Array, rate: number): Uint8Array {
  const data = samples.length * 2;
  const b = Buffer.alloc(44 + data);
  b.write("RIFF", 0, "latin1");
  b.writeUInt32LE(36 + data, 4);
  b.write("WAVE", 8, "latin1");
  b.write("fmt ", 12, "latin1");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "latin1");
  b.writeUInt32LE(data, 40);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 32767), 44 + i * 2);
  return new Uint8Array(b);
}

/** Magnitudes of a real signal's spectrum (radix-2 FFT; n is a power of two), bins 0 … n/2. */
export function spectrum(x: Float32Array, n: number): Float32Array {
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = (x[i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len)
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const ar = re[i + k + len / 2]! * wr - im[i + k + len / 2]! * wi;
        const ai = re[i + k + len / 2]! * wi + im[i + k + len / 2]! * wr;
        re[i + k + len / 2] = re[i + k]! - ar;
        im[i + k + len / 2] = im[i + k]! - ai;
        re[i + k] = re[i + k]! + ar;
        im[i + k] = im[i + k]! + ai;
      }
  }
  const out = new Float32Array(n / 2 + 1);
  for (let i = 0; i <= n / 2; i++) out[i] = Math.hypot(re[i]!, im[i]!) / n;
  return out;
}
