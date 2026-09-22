import { Resend } from "resend";
import { checkRateLimit, getClientIp } from "@/lib/rateLimit";

type LeadPayload = {
  email: string;
  notifiedSum: number;
  likelyValid: "smash_and_grab_likely" | "notices_served_on_time" | "needs_human_review";
};

// Basic but practical email check — rejects whitespace, missing @/. and absurd lengths.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LEN = 254; // RFC 5321 practical limit
const MAX_NOTIFIED_SUM_PENCE = 100_000_000_00; // £1,000,000 — anything above is implausible for a subbie
const MAX_BODY_BYTES = 4_096;

function isValidPayload(body: unknown): body is LeadPayload {
  if (typeof body !== "object" || body === null) return false;
  const candidate = body as Record<string, unknown>;
  return (
    typeof candidate.email === "string" &&
    candidate.email.length <= MAX_EMAIL_LEN &&
    EMAIL_RE.test(candidate.email) &&
    typeof candidate.notifiedSum === "number" &&
    Number.isFinite(candidate.notifiedSum) &&
    candidate.notifiedSum >= 0 &&
    candidate.notifiedSum <= MAX_NOTIFIED_SUM_PENCE &&
    typeof candidate.likelyValid === "string" &&
    ["smash_and_grab_likely", "notices_served_on_time", "needs_human_review"].includes(
      candidate.likelyValid
    )
  );
}

function hasJsonContentType(request: Request): boolean {
  const contentType = request.headers.get("content-type");
  if (!contentType) return false;
  const normalized = contentType.split(";")[0]?.trim().toLowerCase();
  return normalized === "application/json";
}

function contentLengthTooLarge(request: Request): boolean {
  const contentLengthHeader = request.headers.get("content-length");
  if (!contentLengthHeader) return false;
  const contentLength = Number.parseInt(contentLengthHeader, 10);
  return Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES;
}

type ReadJsonBodyResult =
  | { ok: true; body: unknown }
  | { ok: false; reason: "too_large" | "invalid_json" };

async function readJsonBody(request: Request): Promise<ReadJsonBodyResult> {
  if (contentLengthTooLarge(request)) {
    return { ok: false, reason: "too_large" };
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return { ok: false, reason: "too_large" };
  }

  try {
    return { ok: true, body: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
}

/**
 * Persist the lead as a structured JSON line to stdout BEFORE attempting email.
 * Vercel captures function logs, so the lead is recoverable even if email send
 * fails (unverified domain, rate limit, transient error). This is the source
 * of truth until a durable store is wired in Phase 01.
 */
function persistLeadToLog(payload: LeadPayload): void {
  console.log(
    JSON.stringify({
      event: "checker_lead",
      ts: new Date().toISOString(),
      email: payload.email,
      notifiedSumPence: payload.notifiedSum,
      likelyValid: payload.likelyValid,
    })
  );
}

export async function POST(request: Request): Promise<Response> {
  const rateLimit = checkRateLimit(getClientIp(request));
  if (!rateLimit.allowed) {
    return Response.json(
      { ok: false, error: "rate limit exceeded" },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
      }
    );
  }

  if (!hasJsonContentType(request)) {
    return Response.json({ ok: false, error: "invalid payload" }, { status: 415 });
  }

  const parsed = await readJsonBody(request);
  if (!parsed.ok) {
    const tooLarge = parsed.reason === "too_large";
    return Response.json(
      { ok: false, error: tooLarge ? "payload too large" : "invalid payload" },
      { status: tooLarge ? 413 : 400 }
    );
  }

  if (!isValidPayload(parsed.body)) {
    return Response.json({ ok: false, error: "invalid payload" }, { status: 400 });
  }

  const body = parsed.body;

  // Always persist first — never lose a lead to an email failure.
  persistLeadToLog(body);

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("[lead] RESEND_API_KEY not set — lead persisted to logs only:", body.email);
    return Response.json({ ok: true });
  }

  const resend = new Resend(apiKey);
  const fromAddress = process.env.RESEND_FROM_EMAIL ?? "checker@allsquared.dev";
  const toAddress = process.env.LEAD_NOTIFICATION_EMAIL ?? "eli@autonolabs.ai";

  try {
    await resend.emails.send({
      from: fromAddress,
      to: toAddress,
      subject: `New checker lead — ${body.likelyValid}`,
      text: `Email: ${body.email}\nNotified sum: £${(body.notifiedSum / 100).toFixed(2)}\nResult: ${body.likelyValid}`,
    });
  } catch (err) {
    // Email failed (unverified domain, rate limit, transient) — but the lead is
    // already in the logs. Do NOT surface the failure to the user: we don't want
    // to discourage real leads or tip off spammers that the endpoint degrades.
    console.error("[lead] email send failed (lead already persisted to logs):", (err as Error).message);
  }

  return Response.json({ ok: true });
}
