import { describe, expect, it, beforeEach } from "vitest";
import { checkRateLimit, getClientIp, resetRateLimitStore } from "../rateLimit";

describe("rateLimit", () => {
  beforeEach(() => {
    resetRateLimitStore();
  });

  it("allows requests under the limit", () => {
    const config = { windowMs: 60_000, maxRequests: 3 };

    expect(checkRateLimit("1.2.3.4", config)).toEqual({ allowed: true });
    expect(checkRateLimit("1.2.3.4", config)).toEqual({ allowed: true });
    expect(checkRateLimit("1.2.3.4", config)).toEqual({ allowed: true });
  });

  it("blocks requests over the limit and returns retryAfterSeconds", () => {
    const config = { windowMs: 60_000, maxRequests: 2 };

    expect(checkRateLimit("1.2.3.4", config)).toEqual({ allowed: true });
    expect(checkRateLimit("1.2.3.4", config)).toEqual({ allowed: true });

    const blocked = checkRateLimit("1.2.3.4", config);
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) {
      expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
      expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60);
    }
  });

  it("tracks limits independently per key", () => {
    const config = { windowMs: 60_000, maxRequests: 1 };

    expect(checkRateLimit("1.2.3.4", config)).toEqual({ allowed: true });
    expect(checkRateLimit("5.6.7.8", config)).toEqual({ allowed: true });
    expect(checkRateLimit("1.2.3.4", config).allowed).toBe(false);
  });

  it("extracts the first IP from x-forwarded-for", () => {
    const request = new Request("http://localhost/api/lead", {
      headers: { "x-forwarded-for": "203.0.113.1, 70.41.3.18" },
    });

    expect(getClientIp(request)).toBe("203.0.113.1");
  });
});
