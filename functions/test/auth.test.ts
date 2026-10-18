import { describe, expect, it } from "vitest";
import { domainOf, evaluateAccess, validateAllowedDomain } from "../src/auth/authorize";

const access = { allowedDomains: ["demo.com", "ravenwoodbank.com"], invites: ["Contractor@Partner.io"] };

describe("evaluateAccess(): public sign-up is off", () => {
  it("lets an approved domain in", () => {
    expect(evaluateAccess("muhammad.rafay@demo.com", true, access).allowed).toBe(true);
    expect(evaluateAccess("Dana.Brooks@RavenwoodBank.com", true, access).allowed).toBe(true);
  });
  it("lets an invited address in, case-insensitively", () => {
    expect(evaluateAccess("contractor@partner.io", true, access)).toEqual({ allowed: true, reason: "Invited", role: "manager" });
  });
  it("refuses an unverified email even on an approved domain", () => {
    expect(evaluateAccess("muhammad.rafay@demo.com", false, access).allowed).toBe(false);
    expect(evaluateAccess("muhammad.rafay@demo.com", undefined, access).allowed).toBe(false);
  });
  it.each([
    "someone@gmail.com", "x@demo.com.evil.net", "x@evildemo.com", "x@sub.demo.com", "x@demo.co", "x@notdemo.com",
    "a@b@demo.com", "demo.com", "@demo.com", "x@demo", " ", "", "x y@demo.com",
  ])("refuses %s", (email) => expect(evaluateAccess(email, true, access).allowed).toBe(false));
  it("refuses when there is no email", () => {
    expect(evaluateAccess(undefined, true, access).allowed).toBe(false);
    expect(evaluateAccess(null, true, access).allowed).toBe(false);
  });
  it("refuses everyone when nothing is approved", () => {
    expect(evaluateAccess("a@demo.com", true, { allowedDomains: [], invites: [] }).allowed).toBe(false);
  });
});

describe("evaluateAccess(): roles", () => {
  const withJudge = { ...access, invites: ["Judge@Example.org", "boss@example.org"], judges: ["judge@example.org"] };
  it("an invited judge gets the judge role, an invited person the manager role, an approved domain the manager role", () => {
    expect(evaluateAccess("judge@example.org", true, withJudge)).toMatchObject({ allowed: true, role: "judge" });
    expect(evaluateAccess("boss@example.org", true, withJudge)).toMatchObject({ allowed: true, role: "manager" });
    expect(evaluateAccess("x@demo.com", true, withJudge)).toMatchObject({ allowed: true, role: "manager" });
  });
  it("a judge invite wins over an approved domain, so a judge on an approved domain stays a judge", () => {
    expect(evaluateAccess("judge@demo.com", true, { ...access, invites: ["judge@demo.com"], judges: ["judge@demo.com"] })).toMatchObject({ role: "judge" });
  });
  it("a refused person has no role", () => {
    expect(evaluateAccess("x@evil.net", true, withJudge).role).toBeUndefined();
  });
});

describe("domainOf()", () => {
  it("extracts and lowercases", () => expect(domainOf(" A@Demo.COM ")).toBe("demo.com"));
  it("rejects malformed input", () => {
    for (const bad of ["", "nope", "a@", "@b.com", "a@b@c.com", "a b@c.com"]) expect(domainOf(bad)).toBeNull();
  });
});

describe("validateAllowedDomain()", () => {
  it("accepts a company domain and normalizes it", () => expect(validateAllowedDomain("@RavenwoodBank.com")).toEqual({ ok: true, domain: "ravenwoodbank.com" }));
  it("refuses public mail providers, which anyone can register", () => {
    for (const d of ["gmail.com", "Outlook.com", "yahoo.com", "icloud.com"]) expect(validateAllowedDomain(d).ok).toBe(false);
  });
  it("refuses junk", () => {
    for (const d of ["", "localhost", "a..b", "-.com", "demo", "demo.c"]) expect(validateAllowedDomain(d).ok).toBe(false);
  });
});
