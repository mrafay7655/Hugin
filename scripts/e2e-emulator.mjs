// End-to-end test against the Firebase Emulator Suite (auth + functions + firestore).
// Run:  firebase emulators:exec --only auth,functions,firestore --project demo-hugin "node scripts/e2e-emulator.mjs"
import { createHmac } from "node:crypto";
import http from "node:http";
import { createRequire } from "node:module";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= "127.0.0.1:9099";
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const { seedDemoData } = require("./lib/seed/demo.js");

const PROJECT = "demo-hugin";
const ORG = "ravenwood";
const FN = `http://127.0.0.1:5001/${PROJECT}/us-central1`;
const AUTH = "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1";
const APP_SECRET = "test-app-secret";

initializeApp({ projectId: PROJECT });
const db = getFirestore();
const auth = getAuth();

// ── tiny harness ───────────────────────────────────────────────────────────
let passed = 0;
const failures = [];
async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${e.message}`);
  }
}
const assert = (c, m) => { if (!c) throw new Error(m || "assertion failed"); };
const eq = (a, b, m) => assert(JSON.stringify(a) === JSON.stringify(b), `${m ?? "not equal"}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
async function until(fn, what, ms = 25000) {
  const t = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

// ── fake Meta Graph API ────────────────────────────────────────────────────
const graphCalls = [];
let wamidCounter = 0;
const graph = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const json = body ? JSON.parse(body) : {};
    graphCalls.push({ url: req.url, auth: req.headers.authorization, body: json });
    res.setHeader("content-type", "application/json");
    if (req.url.endsWith("/messages") && req.method === "POST") res.end(JSON.stringify({ messages: [{ id: `wamid.FAKE${++wamidCounter}` }] }));
    else res.end("{}");
  });
});
await new Promise((r) => graph.listen(9988, "127.0.0.1", r));

// ── helpers ────────────────────────────────────────────────────────────────
const sign = (raw) => "sha256=" + createHmac("sha256", APP_SECRET).update(raw).digest("hex");
const waPayload = (id, from, name, text) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "W", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: "PNID_TEST" }, contacts: [{ profile: { name }, wa_id: from }], messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }] } }] }],
});
async function postWebhook(payload, signature) {
  const raw = JSON.stringify(payload);
  return fetch(`${FN}/whatsappWebhook`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": signature ?? sign(raw) }, body: raw });
}
async function callable(name, data, idToken) {
  const res = await fetch(`${FN}/${name}`, { method: "POST", headers: { "content-type": "application/json", ...(idToken ? { authorization: `Bearer ${idToken}` } : {}) }, body: JSON.stringify({ data }) });
  return { status: res.status, body: await res.json() };
}
const jwt = (t) => JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString());
const conv = (id) => db.doc(`orgs/${ORG}/conversations/${id}`);
const msgsOf = async (id) => (await conv(id).collection("messages").orderBy("at").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const lastSend = () => graphCalls.filter((c) => c.url.endsWith("/messages")).at(-1);

// ── setup ──────────────────────────────────────────────────────────────────
console.log("setup");
await seedDemoData({ db, orgId: ORG, now: () => Date.now(), adk: null, log: () => {} });
await db.doc(`orgs/${ORG}`).update({ allowedDomains: ["demo.com", "ravenwoodbank.com"] });
await auth.createUser({ email: "muhammad.rafay@demo.com", password: "demo-password-1", emailVerified: true, displayName: "Muhammad Rafay" });
await auth.createUser({ email: "outsider@gmail.com", password: "demo-password-2", emailVerified: true });

// ── 1. sign-in lockdown ────────────────────────────────────────────────────
console.log("\nsign-in lockdown");
let managerToken = "";
await step("approved domain user can sign in, token carries manager claims", async () => {
  const r = await fetch(`${AUTH}/accounts:signInWithPassword?key=x`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "muhammad.rafay@demo.com", password: "demo-password-1", returnSecureToken: true }) });
  const j = await r.json();
  assert(r.ok, `sign-in failed: ${JSON.stringify(j)}`);
  managerToken = j.idToken;
  const claims = jwt(managerToken);
  eq([claims.orgId, claims.role], [ORG, "manager"], "claims");
});
await step("a verified user on a non-approved domain is refused at sign-in", async () => {
  const r = await fetch(`${AUTH}/accounts:signInWithPassword?key=x`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "outsider@gmail.com", password: "demo-password-2", returnSecureToken: true }) });
  assert(!r.ok, "outsider was allowed in");
});
await step("public sign-up is refused (unverified, even on an approved domain)", async () => {
  for (const email of ["attacker@gmail.com", "newhire@demo.com", "x@demo.com.evil.net"]) {
    const r = await fetch(`${AUTH}/accounts:signUp?key=x`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "password-123", returnSecureToken: true }) });
    assert(!r.ok, `sign-up succeeded for ${email}`);
  }
  const users = await auth.listUsers();
  assert(users.users.every((u) => ["muhammad.rafay@demo.com", "outsider@gmail.com"].includes(u.email)), "an unexpected account exists");
});

// ── 2. webhook security ────────────────────────────────────────────────────
console.log("\nwebhook security");
await step("GET handshake echoes the challenge only for the right verify token", async () => {
  const ok = await fetch(`${FN}/whatsappWebhook?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=CH123`);
  eq([ok.status, await ok.text()], [200, "CH123"]);
  const bad = await fetch(`${FN}/whatsappWebhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=CH123`);
  eq(bad.status, 403);
});
await step("POST with a bad or missing signature is rejected and stores nothing", async () => {
  const p = waPayload("wamid.EVIL", "15559990000", "Mallory", "hello");
  eq((await postWebhook(p, "sha256=" + "0".repeat(64))).status, 401);
  eq((await fetch(`${FN}/whatsappWebhook`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(p) })).status, 401);
  assert(!(await db.doc("wa_events/wamid.EVIL").get()).exists, "event was stored");
});

// ── 3. WhatsApp in, agent, WhatsApp out ────────────────────────────────────
console.log("\nreal WhatsApp path (webhook -> trigger -> agent -> Graph API)");
const MARCUS = "wa_14155550142_whatsapp";
await step("scam report: agent replies through the Graph API, locks the card, opens a case", async () => {
  const p = waPayload("wamid.SCAM1", "14155550142", "Marcus Reed", "Someone just called saying they're from the bank and asked for my one-time code. I didn't give it. Is my account safe?");
  eq((await postWebhook(p)).status, 200);
  await until(async () => (await msgsOf(MARCUS)).some((m) => m.dir === "out"), "agent reply");
  const sent = lastSend();
  assert(sent, "nothing was sent to the Graph API");
  eq(sent.auth, "Bearer test-wa-token", "auth header");
  eq(sent.body.to, "14155550142", "recipient");
  assert(sent.body.text.body.includes("locked your card"), `unexpected reply: ${sent.body.text.body}`);
  const c = (await conv(MARCUS).get()).data();
  eq([c.decision, c.status, c.transport], ["fraud_risk", "fraud", "whatsapp"]);
  assert(/^FR-\d+$/.test(c.caseId), "no case id");
  eq((await db.doc(`orgs/${ORG}/cards/wa_14155550142`).get()).data().locked, true, "card locked");
  const out = (await msgsOf(MARCUS)).find((m) => m.dir === "out");
  assert(out.wamid?.startsWith("wamid.FAKE"), "outbound wamid not recorded");
});
await step("Meta retrying the same delivery does not duplicate anything", async () => {
  const before = (await msgsOf(MARCUS)).length;
  const p = waPayload("wamid.SCAM1", "14155550142", "Marcus Reed", "Someone just called...");
  eq((await postWebhook(p)).status, 200);
  await new Promise((r) => setTimeout(r, 1500));
  eq((await msgsOf(MARCUS)).length, before, "message count changed");
});
await step("a delivery status from Meta updates the message", async () => {
  const out = (await msgsOf(MARCUS)).find((m) => m.dir === "out");
  const payload = { object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "PNID_TEST" }, statuses: [{ id: out.wamid, status: "read", timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: "14155550142" }] } }] }] };
  eq((await postWebhook(payload)).status, 200);
  await until(async () => (await msgsOf(MARCUS)).find((m) => m.dir === "out")?.status === "read", "read status");
});

// ── 4. manager callables ───────────────────────────────────────────────────
console.log("\nmanager actions (callable functions)");
const NORA = "wa_15551230001_whatsapp";
await step("callables reject anonymous and forged tokens", async () => {
  eq((await callable("approveDraft", { convId: NORA })).status, 401);
  eq((await callable("approveDraft", { convId: NORA }, "not.a.token")).status, 401);
  eq((await callable("updatePolicy", { autoSend: 0.5 })).status, 401);
});
await step("account change: agent queues a draft and sends only a holding reply", async () => {
  const p = waPayload("wamid.ACC1", "15551230001", "Nora Quinn", "I need to change the phone number on my account.");
  eq((await postWebhook(p)).status, 200);
  await until(async () => (await conv(NORA).get()).data()?.approval, "draft");
  const sends = graphCalls.filter((c) => c.url.endsWith("/messages") && c.body.to === "15551230001");
  eq(sends.length, 1, "exactly one message (the holding reply) should be sent");
  assert(sends[0].body.text.body.includes("verify your identity"));
});
await step("manager approves the draft: it is sent on WhatsApp and the draft clears", async () => {
  const r = await callable("approveDraft", { convId: NORA, text: "Hi Nora, this is Muhammad. I'm calling you now to verify your identity." }, managerToken);
  eq(r.status, 200, JSON.stringify(r.body));
  const sends = graphCalls.filter((c) => c.url.endsWith("/messages") && c.body.to === "15551230001");
  eq(sends.length, 2);
  assert(sends[1].body.text.body.startsWith("Hi Nora, this is Muhammad"));
  const c = (await conv(NORA).get()).data();
  eq([c.approval, c.decision], [null, "human"]);
  const audit = (await db.collection(`orgs/${ORG}/audit`).get()).docs.map((d) => d.data());
  assert(audit.some((a) => a.action === "approved" && a.actor === "muhammad.rafay@demo.com"), "approval not audited under the manager's email");
});
await step("a message that asks for an OTP cannot be sent, even by a manager", async () => {
  const r = await callable("sendHumanMessage", { convId: NORA, text: "Please share your OTP so I can verify you" }, managerToken);
  eq(r.status, 400, JSON.stringify(r.body));
  eq(r.body.error.status, "FAILED_PRECONDITION");
  const sends = graphCalls.filter((c) => c.url.endsWith("/messages") && c.body.to === "15551230001");
  eq(sends.length, 2, "blocked message reached Meta");
});
await step("take over silences the agent; hand back restores it", async () => {
  eq((await callable("setConversationMode", { convId: NORA, human: true }, managerToken)).status, 200);
  const before = graphCalls.length;
  await postWebhook(waPayload("wamid.ACC2", "15551230001", "Nora Quinn", "What's the fee for an international wire?"));
  await until(async () => (await msgsOf(NORA)).some((m) => m.wamid === "wamid.ACC2" && m.processed), "message processed");
  eq(graphCalls.length, before, "agent replied while a human was in control");
  eq((await callable("setConversationMode", { convId: NORA, human: false }, managerToken)).status, 200);
});
await step("policy edits are validated and audited; locked rules cannot be removed", async () => {
  eq((await callable("updatePolicy", { autoSend: 0.9, draft: 0.95 }, managerToken)).status, 400, "draft >= autoSend must fail");
  eq((await callable("updatePolicy", { alwaysHuman: ["refund"] }, managerToken)).status, 403, "removing account_change must be refused");
  eq((await callable("updatePolicy", { perIntent: { fee_inquiry: 0.93 } }, managerToken)).status, 200);
  const audit = (await db.collection(`orgs/${ORG}/audit`).get()).docs.map((d) => d.data());
  assert(audit.some((a) => a.action === "policy" && String(a.detail).includes("fee_inquiry")), "policy change not audited");
});
await step("public mail domains cannot be approved; real domains can", async () => {
  eq((await callable("addAllowedDomain", { domain: "gmail.com" }, managerToken)).status, 400);
  eq((await callable("addAllowedDomain", { domain: "partnerbank.com" }, managerToken)).status, 200);
  assert(((await db.doc(`orgs/${ORG}`).get()).data().allowedDomains).includes("partnerbank.com"));
});
await step("demo simulator drives the same pipeline (Instagram fee question)", async () => {
  const r = await callable("simulateInbound", { customerId: "c2", channel: "instagram", text: "What's the fee for an international wire?" }, managerToken);
  eq(r.status, 200, JSON.stringify(r.body));
  await until(async () => (await msgsOf("c2_instagram")).some((m) => m.dir === "out" && m.text.includes("$45")), "simulated reply");
  const before = graphCalls.filter((c) => c.body.to === undefined).length;
  eq(before, 0, "a simulated conversation must never call Meta");
});

// ── 5. comments and sentiment ──────────────────────────────────────────────
console.log("\ncomments and sentiment (Meta webhook -> classifier -> moderation)");
const cdoc = (id) => db.doc(`orgs/${ORG}/comments/${id}`);
const postComments = (payload, signature) => {
  const raw = JSON.stringify(payload);
  return fetch(`${FN}/metaCommentsWebhook`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": signature ?? sign(raw) }, body: raw });
};
const igComment = (id, text) => ({ object: "instagram", entry: [{ id: "IG1", changes: [{ field: "comments", value: { id, text, from: { id: "55", username: "e2e_user" }, media: { id: "ig_metal" } } }] }] });
await step("comment webhook rejects a bad signature and stores nothing", async () => {
  eq((await postComments(igComment("e2e-evil", "hi"), "sha256=" + "0".repeat(64))).status, 401);
  assert(!(await cdoc("instagram_e2e-evil").get()).exists, "comment stored");
});
await step("signed Instagram scam comment is classified, flagged and alerts the team", async () => {
  eq((await postComments(igComment("e2e-1", "You've won a giveaway! Claim now at ravenw00d-prizes.com"))).status, 200);
  const c = await until(async () => (await cdoc("instagram_e2e-1").get()).data(), "comment stored");
  eq([c.intent, c.riskFlag, c.draft], ["scam_or_spam", true, null]);
  const alerts = (await db.collection(`orgs/${ORG}/alerts`).get()).docs.map((d) => d.data());
  assert(alerts.some((a) => /Risky comment on instagram/.test(a.text)), "no alert");
});
await step("signed Facebook complaint gets negative sentiment and a private-message draft", async () => {
  const p = { object: "page", entry: [{ id: "P1", changes: [{ field: "feed", value: { item: "comment", verb: "add", comment_id: "e2e_fb1", message: "Worst bank ever, three overdraft fees this week. Ridiculous.", post_id: "fb_alerts", from: { id: "9", name: "Greg H." }, created_time: Math.floor(Date.now() / 1000) } }] }] };
  eq((await postComments(p)).status, 200);
  const c = await until(async () => (await cdoc("facebook_e2e_fb1").get()).data(), "fb comment");
  eq([c.sentiment, c.needsReply], ["negative", true]);
  assert(/message us|private/i.test(c.draft), `draft: ${c.draft}`);
});
await step("manager hides the scam and replies to the complaint through Meta", async () => {
  graphCalls.length = 0;
  eq((await callable("hideComment", { commentId: "instagram_e2e-1", hidden: true }, managerToken)).status, 200);
  eq((await cdoc("instagram_e2e-1").get()).data().status, "hidden");
  eq((await callable("replyToComment", { commentId: "facebook_e2e_fb1", text: "Sorry about this, Greg. Please message us privately and we'll review those fees." }, managerToken)).status, 200);
  assert(graphCalls.some((c) => c.url.endsWith("/e2e-1") && c.body.hide === true), "hide not sent to Meta");
  assert(graphCalls.some((c) => c.url.endsWith("/e2e_fb1/comments")), "reply not sent to Meta");
});
await step("a public reply asking for an account number is blocked", async () => {
  const r = await callable("replyToComment", { commentId: "facebook_e2e_fb1", text: "Reply with your account number and we'll check" }, managerToken);
  eq(r.status, 400, JSON.stringify(r.body));
});
await step("simulateComment classifies a demo comment end to end", async () => {
  const r = await callable("simulateComment", { platform: "youtube", text: "Love the new app, super fast!" }, managerToken);
  eq(r.status, 200, JSON.stringify(r.body));
  eq((await cdoc(r.body.result.id).get()).data().sentiment, "positive");
});

// ── 6. judges, removed access, and other people's phone numbers ───────────
console.log("\njudges, removed access, wrong phone number");
const signIn = async (email, password) => {
  const r = await fetch(`${AUTH}/accounts:signInWithPassword?key=x`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password, returnSecureToken: true }) });
  const j = await r.json();
  assert(r.ok, `sign-in failed for ${email}: ${JSON.stringify(j)}`);
  return j.idToken;
};
let judgeToken = "";
await step("an invited judge signs in with the judge role, not manager", async () => {
  await db.doc(`orgs/${ORG}/invites/judge@demo.com`).set({ by: "e2e", at: Date.now(), role: "judge" });
  await auth.createUser({ email: "judge@demo.com", password: "judge-password-1", emailVerified: true, displayName: "Hackathon Judge" });
  judgeToken = await signIn("judge@demo.com", "judge-password-1");
  eq([jwt(judgeToken).orgId, jwt(judgeToken).role], [ORG, "judge"], "claims");
});
await step("a judge cannot change policy, knowledge, access or reset the demo", async () => {
  for (const [name, data] of [["updatePolicy", { autoSend: 0.9 }], ["addKnowledgeDoc", { title: "Test doc", text: "Some policy text here" }], ["addAllowedDomain", { domain: "judge-bank.com" }], ["addInvite", { email: "friend@judge-bank.com" }], ["resetDemo", {}]]) {
    const r = await callable(name, data, judgeToken);
    eq(r.status, 403, `${name} should be refused for a judge: ${JSON.stringify(r.body)}`);
  }
});
await step("a judge can use the simulator, but cannot message a real WhatsApp customer", async () => {
  eq((await callable("simulateInbound", { customerId: "c2", channel: "instagram", text: "hello there" }, judgeToken)).status, 200);
  const r = await callable("sendHumanMessage", { convId: MARCUS, text: "Hello from a judge" }, judgeToken);
  eq(r.status, 403, JSON.stringify(r.body));
  const before = graphCalls.filter((c) => c.body.to === "14155550142").length;
  eq(graphCalls.filter((c) => c.body.to === "14155550142").length, before, "a judge's message reached Meta");
});
await step("removing a person's invite ends their session at once, even with a valid token", async () => {
  await callable("addInvite", { email: "temp@partner.io" }, managerToken);
  await auth.createUser({ email: "temp@partner.io", password: "temp-password-1", emailVerified: true });
  const tempToken = await signIn("temp@partner.io", "temp-password-1");
  eq((await callable("setConversationMode", { convId: NORA, human: false }, tempToken)).status, 200, "invited person should work first");
  eq((await callable("removeInvite", { email: "temp@partner.io" }, managerToken)).status, 200);
  const r = await callable("setConversationMode", { convId: NORA, human: false }, tempToken);
  eq(r.status, 403, `the removed person still has access: ${JSON.stringify(r.body)}`);
});
await step("a WhatsApp message for another phone number is ignored", async () => {
  const p = waPayload("wamid.OTHERNUM", "15557770000", "Stranger", "hello");
  p.entry[0].changes[0].value.metadata.phone_number_id = "SOME_OTHER_NUMBER";
  eq((await postWebhook(p)).status, 200);
  await new Promise((r) => setTimeout(r, 1000));
  assert(!(await db.doc("wa_events/wamid.OTHERNUM").get()).exists, "a message for another number was stored");
});
await step("a manager can unlock a card the agent locked; it is audited", async () => {
  eq((await db.doc(`orgs/${ORG}/cards/wa_14155550142`).get()).data().locked, true, "precondition: locked");
  eq((await callable("unlockCard", { convId: MARCUS }, managerToken)).status, 200);
  eq((await db.doc(`orgs/${ORG}/cards/wa_14155550142`).get()).data().locked, false);
  const audit = (await db.collection(`orgs/${ORG}/audit`).get()).docs.map((d) => d.data());
  assert(audit.some((a) => a.action === "unlock-card"), "unlock not audited");
});

// ── done ───────────────────────────────────────────────────────────────────
graph.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("failed:", failures.join(" | "));
  process.exit(1);
}
process.exit(0);
