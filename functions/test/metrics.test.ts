import { describe, expect, it } from "vitest";
import { AGENTS, dayKey } from "../src/agent/metrics";

describe("metrics helpers", () => {
  it("keys a day in UTC", () => {
    expect(dayKey(Date.UTC(2026, 9, 15, 23, 59))).toBe("2026-10-15");
    expect(dayKey(Date.UTC(2026, 9, 16, 0, 0))).toBe("2026-10-16");
  });
  it("lists every agent the dashboard shows, once", () => {
    expect(new Set(AGENTS).size).toBe(AGENTS.length);
    expect(AGENTS).toEqual(expect.arrayContaining(["customer-agent", "comment-agent", "policy-engine", "output-guard", "telegram", "whatsapp", "meta-comments", "sweeper"]));
  });
});
