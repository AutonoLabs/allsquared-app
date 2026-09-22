import { describe, expect, it, vi, beforeEach } from "vitest";
import { resetRateLimitStore } from "@/lib/rateLimit";

const sendMock = vi.fn().mockResolvedValue({ data: { id: "test-id" }, error: null });

vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: { send: sendMock },
  })),
}));

const JSON_HEADERS = { "Content-Type": "application/json" };

function makeLeadRequest(
  body: unknown,
  extraHeaders: Record<string, string> = {}
): Request {
  return new Request("http://localhost/api/lead", {
    method: "POST",
    headers: { ...JSON_HEADERS, ...extraHeaders },
    body: JSON.stringify(body),
  });
}

describe("POST /api/lead", () => {
  beforeEach(() => {
    sendMock.mockClear();
    resetRateLimitStore();
    process.env.RESEND_API_KEY = "test-key";
  });

  it("returns ok:true and emails the lead when RESEND_API_KEY is set", async () => {
    const { POST } = await import("../route");
    const request = makeLeadRequest({
      email: "subbie@example.com",
      notifiedSum: 500000,
      likelyValid: "smash_and_grab_likely",
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("returns ok:true without emailing when RESEND_API_KEY is missing", async () => {
    delete process.env.RESEND_API_KEY;
    const { POST } = await import("../route");
    const request = makeLeadRequest({
      email: "subbie@example.com",
      notifiedSum: 500000,
      likelyValid: "smash_and_grab_likely",
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true });
  });

  it("returns 400 for an invalid payload", async () => {
    const { POST } = await import("../route");
    const request = makeLeadRequest({ email: "not-an-email" });

    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it("returns 400 for a non-JSON body instead of throwing", async () => {
    const { POST } = await import("../route");
    const request = new Request("http://localhost/api/lead", {
      method: "POST",
      headers: JSON_HEADERS,
      body: "not json at all",
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it("returns 415 when content-type is not application/json", async () => {
    const { POST } = await import("../route");
    const request = new Request("http://localhost/api/lead", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({
        email: "subbie@example.com",
        notifiedSum: 500000,
        likelyValid: "smash_and_grab_likely",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(415);
  });

  it("returns 413 when content-length exceeds the limit", async () => {
    const { POST } = await import("../route");
    const request = new Request("http://localhost/api/lead", {
      method: "POST",
      headers: {
        ...JSON_HEADERS,
        "Content-Length": "5000",
      },
      body: JSON.stringify({
        email: "subbie@example.com",
        notifiedSum: 500000,
        likelyValid: "smash_and_grab_likely",
      }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(413);
    expect(body).toEqual({ ok: false, error: "payload too large" });
  });

  it("returns 429 when the rate limit is exceeded", async () => {
    const { POST } = await import("../route");
    const payload = {
      email: "subbie@example.com",
      notifiedSum: 500000,
      likelyValid: "smash_and_grab_likely" as const,
    };

    for (let i = 0; i < 10; i += 1) {
      const okResponse = await POST(
        makeLeadRequest(payload, { "x-forwarded-for": "198.51.100.42" })
      );
      expect(okResponse.status).toBe(200);
    }

    const blocked = await POST(
      makeLeadRequest(payload, { "x-forwarded-for": "198.51.100.42" })
    );
    const blockedBody = await blocked.json();

    expect(blocked.status).toBe(429);
    expect(blockedBody).toEqual({ ok: false, error: "rate limit exceeded" });
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
  });

  it("still returns ok:true and persists the lead when Resend throws", async () => {
    sendMock.mockRejectedValueOnce(new Error("unverified domain"));
    const { POST } = await import("../route");
    const request = makeLeadRequest({
      email: "subbie@example.com",
      notifiedSum: 500000,
      likelyValid: "smash_and_grab_likely",
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an implausibly large notified sum", async () => {
    const { POST } = await import("../route");
    const request = makeLeadRequest({
      email: "subbie@example.com",
      notifiedSum: 1_000_000_000_00, // £1,000,000,000
      likelyValid: "smash_and_grab_likely",
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
  });
});
