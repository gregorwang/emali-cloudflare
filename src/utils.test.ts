import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyQueuePayloadBudget,
  buildDatedKey,
  estimateJsonBytes,
  extractDomain,
  inferPriority,
  parseMaxBodyLength,
  parsePositiveInt,
  truncateText
} from "./utils";

describe("utils", () => {
  it("truncateText trims by max length", () => {
    const { value, truncated } = truncateText("abcdefgh", 4);
    assert.equal(value, "abcd");
    assert.equal(truncated, true);
  });

  it("parseMaxBodyLength falls back to default", () => {
    assert.equal(parseMaxBodyLength("not-a-number"), 10000);
    assert.equal(parseMaxBodyLength("512"), 512);
  });

  it("parsePositiveInt returns fallback for invalid input", () => {
    assert.equal(parsePositiveInt(undefined, 7), 7);
    assert.equal(parsePositiveInt("0", 7), 7);
    assert.equal(parsePositiveInt("15", 7), 15);
  });

  it("extractDomain returns lowercased domain", () => {
    assert.equal(extractDomain("User@Example.COM"), "example.com");
  });

  it("inferPriority detects urgent patterns", () => {
    assert.equal(inferPriority("URGENT: account down", "noreply@example.com"), "high");
    assert.equal(inferPriority("Monthly invoice", "billing@example.com"), "normal");
    assert.equal(inferPriority("Hello", "friend@example.com"), "low");
  });

  it("buildDatedKey includes prefix and extension", () => {
    const key = buildDatedKey("emails", "id123", "eml");
    assert.equal(key.startsWith("emails/"), true);
    assert.equal(key.endsWith("/id123.eml"), true);
  });

  it("applyQueuePayloadBudget truncates oversized payload", () => {
    const payload = {
      messageId: "1",
      emailId: "1",
      receivedAt: new Date().toISOString(),
      to: "to@example.com",
      from: "from@example.com",
      fromName: "From",
      subject: "subject",
      textBody: "x".repeat(10000),
      hasHtml: false,
      attachments: [],
      rawR2Key: "emails/raw.eml",
      priority: "normal" as const
    };
    const resized = applyQueuePayloadBudget(payload, 3500);
    assert.equal(resized.bodyTruncated, true);
    assert.equal(estimateJsonBytes(resized) <= 3500, true);
  });
});
