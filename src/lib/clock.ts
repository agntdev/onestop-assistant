/**
 * Injectable wall-clock seam. Every schedule, cutoff, "today", expiry, and
 * late/on-time decision MUST go through `now()` so tests can pin time.
 */
let _now: () => number = () => Date.now();

/** Current epoch milliseconds (overridable in tests). */
export function now(): number {
  return _now();
}

/** Override the clock. Returns a restore function. */
export function setNow(fn: () => number): () => void {
  const prev = _now;
  _now = fn;
  return () => {
    _now = prev;
  };
}

/** Restore the real wall clock. */
export function resetNow(): void {
  _now = () => Date.now();
}

/** UTC calendar day key `YYYY-MM-DD` for rate-limit / usage buckets. */
export function dayKey(ms: number = now()): string {
  return new Date(ms).toISOString().slice(0, 10);
}
