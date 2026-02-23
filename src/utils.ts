import type { QueueMessage } from "./types";

export function parseMaxBodyLength(raw?: string): number {
  return parsePositiveInt(raw, 10000);
}

export function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function truncateText(
  text: string,
  maxLength: number
): { value: string; truncated: boolean } {
  if (text.length <= maxLength) {
    return { value: text, truncated: false };
  }
  return { value: text.slice(0, maxLength), truncated: true };
}

export function buildDatedKey(prefix: string, id: string, ext: string): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${prefix}/${y}/${m}/${d}/${id}.${ext}`;
}

export function extractDomain(email: string): string {
  const idx = email.lastIndexOf("@");
  return idx > -1 ? email.slice(idx + 1).toLowerCase() : "";
}

export function inferPriority(subject: string, from: string): QueueMessage["priority"] {
  const s = `${subject} ${from}`.toLowerCase();
  if (/(urgent|immediately|security|legal|outage|down)/.test(s)) return "high";
  if (/(invoice|payment|billing|contract)/.test(s)) return "normal";
  return "low";
}

export function estimateJsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function applyQueuePayloadBudget(
  payload: QueueMessage,
  maxBytes: number
): QueueMessage {
  if (estimateJsonBytes(payload) <= maxBytes) return payload;

  let next = { ...payload };
  if (next.textBody.length > 4000) {
    next = {
      ...next,
      textBody: next.textBody.slice(0, 4000),
      bodyTruncated: true
    };
  }
  if (estimateJsonBytes(next) <= maxBytes) return next;

  if (next.attachments.length > 8) {
    next = {
      ...next,
      attachments: next.attachments.slice(0, 8)
    };
  }
  if (estimateJsonBytes(next) <= maxBytes) return next;

  return {
    ...next,
    textBody: next.textBody.slice(0, 1500),
    bodyTruncated: true
  };
}
