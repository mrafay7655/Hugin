import { readFileSync } from "node:fs";
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { afterAll, beforeAll, describe, it } from "vitest";

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-hugin-rules",
    firestore: { rules: readFileSync("../firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
  });
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await db.doc("orgs/ravenwood").set({ name: "Ravenwood", allowedDomains: ["demo.com"] });
    await db.doc("orgs/other").set({ name: "Other bank" });
    await db.doc("orgs/ravenwood/conversations/c1_whatsapp").set({ customerId: "c1", unread: true, status: "open", mode: "agent", approval: null });
    await db.doc("orgs/ravenwood/conversations/c1_whatsapp/messages/m1").set({ text: "hi", dir: "in" });
    await db.doc("orgs/ravenwood/conversations/c1_whatsapp/traces/t1").set({ summary: "x" });
    await db.doc("orgs/ravenwood/customers/c1").set({ name: "Marcus Reed" });
    await db.doc("orgs/ravenwood/audit/a1").set({ action: "approved" });
    await db.doc("orgs/ravenwood/settings/policy").set({ autoSend: 0.85 });
    await db.doc("orgs/ravenwood/cards/c1").set({ locked: true });
    await db.doc("orgs/ravenwood/comments/k1").set({ text: "great", sentiment: "positive" });
    await db.doc("orgs/other/customers/x").set({ name: "Secret" });
    await db.doc("wa_events/wamid.1").set({ at: 1 });
    await db.doc("orgs/ravenwood/members/u1").set({ email: "muhammad.rafay@demo.com", revoked: false });
    await db.doc("orgs/ravenwood/members/u5").set({ email: "removed@demo.com", revoked: true });
  });
});
afterAll(async () => env?.cleanup());

const manager = () => env.authenticatedContext("u1", { orgId: "ravenwood", role: "manager" }).firestore();
const otherOrgManager = () => env.authenticatedContext("u2", { orgId: "other", role: "manager" }).firestore();
const noClaims = () => env.authenticatedContext("u3", { email: "x@demo.com" }).firestore();
const wrongRole = () => env.authenticatedContext("u4", { orgId: "ravenwood", role: "viewer" }).firestore();
const anon = () => env.unauthenticatedContext().firestore();
const judge = () => env.authenticatedContext("u6", { orgId: "ravenwood", role: "judge" }).firestore();
const removed = () => env.authenticatedContext("u5", { orgId: "ravenwood", role: "manager" }).firestore();

const READABLE = [
  "orgs/ravenwood",
  "orgs/ravenwood/conversations/c1_whatsapp",
  "orgs/ravenwood/conversations/c1_whatsapp/messages/m1",
  "orgs/ravenwood/conversations/c1_whatsapp/traces/t1",
  "orgs/ravenwood/customers/c1",
  "orgs/ravenwood/audit/a1",
  "orgs/ravenwood/settings/policy",
  "orgs/ravenwood/cards/c1",
  "orgs/ravenwood/comments/k1",
];

describe("reads", () => {
  it.each(READABLE)("a manager of the org can read %s", async (p) => {
    await assertSucceeds(manager().doc(p).get());
  });
  it.each(READABLE)("anonymous users cannot read %s", async (p) => {
    await assertFails(anon().doc(p).get());
  });
  it.each(READABLE)("a signed-in user WITHOUT manager claims cannot read %s", async (p) => {
    await assertFails(noClaims().doc(p).get());
  });
  it("a wrong role cannot read", async () => {
    await assertFails(wrongRole().doc("orgs/ravenwood/customers/c1").get());
  });
  it("a manager of ANOTHER org cannot read this org's data", async () => {
    await assertFails(otherOrgManager().doc("orgs/ravenwood/customers/c1").get());
    await assertFails(otherOrgManager().collection("orgs/ravenwood/conversations").get());
  });
  it("a manager can list their own conversations", async () => {
    await assertSucceeds(manager().collection("orgs/ravenwood/conversations").get());
  });
  it("webhook ledgers are never readable by clients", async () => {
    await assertFails(manager().doc("wa_events/wamid.1").get());
  });
});

describe("writes: everything goes through Cloud Functions", () => {
  it("a manager cannot create or edit messages (no forging a customer or agent message)", async () => {
    await assertFails(manager().doc("orgs/ravenwood/conversations/c1_whatsapp/messages/forged").set({ text: "x", dir: "out", author: "ai" }));
    await assertFails(manager().doc("orgs/ravenwood/conversations/c1_whatsapp/messages/m1").update({ text: "tampered" }));
    await assertFails(manager().doc("orgs/ravenwood/conversations/c1_whatsapp/messages/m1").delete());
  });
  it("the audit log is append-only to nobody on the client: no create, update or delete", async () => {
    await assertFails(manager().collection("orgs/ravenwood/audit").add({ action: "fake" }));
    await assertFails(manager().doc("orgs/ravenwood/audit/a1").update({ action: "edited" }));
    await assertFails(manager().doc("orgs/ravenwood/audit/a1").delete());
  });
  it("a manager cannot change policy, cards, customers, the org, or traces directly", async () => {
    await assertFails(manager().doc("orgs/ravenwood/settings/policy").set({ autoSend: 0.1 }));
    await assertFails(manager().doc("orgs/ravenwood/cards/c1").update({ locked: false }));
    await assertFails(manager().doc("orgs/ravenwood/customers/c1").update({ name: "x" }));
    await assertFails(manager().doc("orgs/ravenwood").update({ allowedDomains: ["gmail.com"] }));
    await assertFails(manager().doc("orgs/ravenwood/conversations/c1_whatsapp/traces/t1").delete());
  });
  it("a manager cannot approve a draft or switch mode by writing the conversation", async () => {
    await assertFails(manager().doc("orgs/ravenwood/conversations/c1_whatsapp").update({ mode: "human" }));
    await assertFails(manager().doc("orgs/ravenwood/conversations/c1_whatsapp").update({ approval: null }));
    await assertFails(manager().doc("orgs/ravenwood/conversations/c1_whatsapp").update({ status: "resolved" }));
  });
  it("marking a conversation read is allowed, but only that field and only to false", async () => {
    await assertSucceeds(manager().doc("orgs/ravenwood/conversations/c1_whatsapp").update({ unread: false }));
    await assertFails(manager().doc("orgs/ravenwood/conversations/c1_whatsapp").update({ unread: true }));
    await assertFails(manager().doc("orgs/ravenwood/conversations/c1_whatsapp").update({ unread: false, status: "resolved" }));
  });
  it("nobody can create or delete conversations from the client", async () => {
    await assertFails(manager().doc("orgs/ravenwood/conversations/new").set({ customerId: "c1" }));
    await assertFails(manager().doc("orgs/ravenwood/conversations/c1_whatsapp").delete());
  });
  it("anonymous and claim-less users cannot write at all", async () => {
    await assertFails(anon().doc("orgs/ravenwood/customers/c9").set({ name: "x" }));
    await assertFails(noClaims().doc("orgs/ravenwood/conversations/c1_whatsapp").update({ unread: false }));
  });
  it("a manager of another org cannot mark this org's conversations read", async () => {
    await assertFails(otherOrgManager().doc("orgs/ravenwood/conversations/c1_whatsapp").update({ unread: false }));
  });
  it("unknown top-level collections are closed", async () => {
    await assertFails(manager().doc("secrets/x").get());
    await assertFails(manager().doc("secrets/x").set({ a: 1 }));
  });
});

describe("judges and removed people", () => {
  it.each(READABLE)("a judge can read %s", async (p) => {
    await assertSucceeds(judge().doc(p).get());
  });
  it("a judge cannot write anything directly, including the policy and the org", async () => {
    await assertFails(judge().doc("orgs/ravenwood/settings/policy").set({ autoSend: 0.1 }));
    await assertFails(judge().doc("orgs/ravenwood").update({ allowedDomains: ["gmail.com"] }));
    await assertFails(judge().doc("orgs/ravenwood/cards/c1").update({ locked: false }));
    await assertFails(judge().doc("orgs/ravenwood/conversations/c1_whatsapp/messages/forged").set({ text: "x" }));
    await assertFails(judge().doc("orgs/ravenwood/members/u6").set({ revoked: false, role: "manager" }));
  });
  it("a judge of another org cannot read", async () => {
    const other = env.authenticatedContext("u7", { orgId: "other", role: "judge" }).firestore();
    await assertFails(other.doc("orgs/ravenwood/customers/c1").get());
  });
  it.each(READABLE)("a person whose access was removed cannot read %s, even with a valid manager token", async (p) => {
    await assertFails(removed().doc(p).get());
  });
  it("a person whose access was removed cannot mark conversations read either", async () => {
    await assertFails(removed().doc("orgs/ravenwood/conversations/c1_whatsapp").update({ unread: false }));
  });
  it("a member record marked not revoked still works", async () => {
    await assertSucceeds(manager().doc("orgs/ravenwood/customers/c1").get());
  });
});
