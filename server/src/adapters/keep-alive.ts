/**
 * Work that may outlast the request that started it (a transaction waiting for its receipt). On Vercel the function
 * is kept alive until it settles (waitUntil, as @vercel/functions does it); a long-lived server outlives it anyway.
 */
export function keepAlive(work: Promise<unknown>): void {
  const ctx = (globalThis as { [k: symbol]: { get?: () => { waitUntil?: (p: Promise<unknown>) => void } } | undefined })[Symbol.for("@vercel/request-context")]?.get?.();
  ctx?.waitUntil?.(work.catch(() => undefined));
}

/** The work's result if it settles within `ms`, else null; the work keeps going (kept alive) either way. */
export async function within<T>(work: Promise<T>, ms: number): Promise<T | null> {
  if (!Number.isFinite(ms)) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((r) => (timer = setTimeout(() => r(null), ms)));
  const r = await Promise.race([work, late]);
  clearTimeout(timer);
  if (r === null) keepAlive(work);
  return r;
}
