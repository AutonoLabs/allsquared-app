/**
 * Best-effort in-memory rate limiting for serverless (Vercel) deployments.
 *
 * Each warm function instance keeps its own counter map, so limits are per-instance
 * rather than global. That still blocks casual abuse and burst spam on a single
 * instance, but determined attackers can spread load across cold starts.
 *
 * For strict cross-instance limits, wire Vercel KV / Upstash Redis and replace
 * this store with a shared counter (see internal/checker-rate-limit-followup.md).
 */

type WindowState = {
  count: number;
  windowStartMs: number;
};

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_REQUESTS = 10;

const store = new Map<string, WindowState>();

export type RateLimitConfig = {
  windowMs?: number;
  maxRequests?: number;
};

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

function getConfig(config?: RateLimitConfig): { windowMs: number; maxRequests: number } {
  return {
    windowMs: config?.windowMs ?? DEFAULT_WINDOW_MS,
    maxRequests: config?.maxRequests ?? DEFAULT_MAX_REQUESTS,
  };
}

/** Extract client IP from common proxy headers (Vercel sets x-forwarded-for). */
export function getClientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }

  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;

  return "unknown";
}

export function checkRateLimit(key: string, config?: RateLimitConfig): RateLimitResult {
  const { windowMs, maxRequests } = getConfig(config);
  const now = Date.now();
  const existing = store.get(key);

  if (!existing || now - existing.windowStartMs >= windowMs) {
    store.set(key, { count: 1, windowStartMs: now });
    return { allowed: true };
  }

  if (existing.count >= maxRequests) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((windowMs - (now - existing.windowStartMs)) / 1000)
    );
    return { allowed: false, retryAfterSeconds };
  }

  existing.count += 1;
  return { allowed: true };
}

/** Test helper — clears the in-memory store between Vitest cases. */
export function resetRateLimitStore(): void {
  store.clear();
}
