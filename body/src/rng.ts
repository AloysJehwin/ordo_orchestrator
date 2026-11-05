import { createHash } from "node:crypto";

/**
 * A seeded stream of random numbers (sfc32, keyed by a SHA-256 of the seed and its labels). The same seed and labels
 * always give the same numbers, so every value and every pixel a body produces can be produced again by `body replay`.
 */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;
  constructor(...parts: (string | number)[]) {
    const h = createHash("sha256").update(parts.map(String).join("\u0000")).digest();
    this.a = h.readUInt32LE(0);
    this.b = h.readUInt32LE(4);
    this.c = h.readUInt32LE(8);
    this.d = h.readUInt32LE(12);
    for (let i = 0; i < 12; i++) this.next();
  }
  /** [0, 1) */
  next(): number {
    const t0 = (this.a + this.b) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.d = (this.d + 1) | 0;
    const t = (t0 + this.d) | 0;
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4294967296;
  }
  range(lo: number, hi: number) {
    return lo + (hi - lo) * this.next();
  }
  int(n: number) {
    return Math.floor(this.next() * n);
  }
  chance(p: number) {
    return this.next() < p;
  }
  normal(mean = 0, sd = 1) {
    const u = Math.max(1e-12, this.next());
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next());
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.int(xs.length)]!;
  }
}
