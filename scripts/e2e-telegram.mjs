// End-to-end test of the Telegram channel against the Firebase Emulator Suite, with a FAKE Telegram.
// Nothing here touches the real Telegram service or the live project.
// Run from hugin/ (after `npm --prefix functions run build`):
//   node scripts/free-emulator-ports.mjs
//   firebase emulators:exec --only auth,functions,firestore --project demo-hugin "node scripts/e2e-telegram.mjs"
import http from "node:http";
import { createRequire } from "node:module";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= "127.0.0.1:9099";
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const { seedDemoData } = require("../functions/lib/seed/demo.js");

const PROJECT = "demo-hugin";
const ORG = "ravenwood";
const FN = `http://127.0.0.1:5001/${PROJECT}/us-central1`;
const AUTH = "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1";
const BOT_TOKEN = "local-test-token";
const SECRET = "local-tg-secret";

initializeApp({ projectId: PROJECT });
const db = getFirestore();
const auth = getAuth();

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
async function until(fn, what, ms = 30000) {
  const t = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

// ── fake Telegram ──────────────────────────────────────────────────────────
const calls = [];
let msgId = 100;
const telegram = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const json = body ? JSON.parse(body) : {};
    calls.push({ url: req.url, method: req.url.split("/").pop(), body: json });
    if (req.url.startsWith(`/file/bot${BOT_TOKEN}/`)) {
      res.setHeader("content-type", "application/octet-stream");
      return res.end(Buffer.from([1, 2, 3, 4]));
    }
    res.setHeader("content-type", "application/json");
    if (!req.url.startsWith(`/bot${BOT_TOKEN}/`)) return res.end(JSON.stringify({ ok: false, description: "Unauthorized" }));
    if (req.url.endsWith("/sendMessage")) return res.end(JSON.stringify({ ok: true, result: { message_id: ++msgId } }));
    if (req.url.endsWith("/getFile")) return res.end(JSON.stringify({ ok: true, result: { file_path: "voice/file_1.oga" } }));
    return res.end(JSON.stringify({ ok: true, result: true }));
  });
});
await new Promise((r) => telegram.listen(9977, "127.0.0.1", r));
const sends = (chat) => calls.filter((c) => c.method === "sendMessage" && String(c.body.chat_id) === String(chat));

// ── helpers ────────────────────────────────────────────────────────────────
let updateCounter = 7000;
const user = (id, first, username) => ({ id, first_name: first, username });
const textUpdate = (chat, from, text, id = ++updateCounter) => ({ update_id: id, message: { message_id: id, from, chat: { id: chat, type: "private" }, date: Math.floor(Date.now() / 1000), text } });
async function post(update, secret = SECRET) {
  return fetch(`${FN}/telegramWebhook`, { method: "POST", headers: { "content-type": "application/json", ...(secret === null ? {} : { "x-telegram-bot-api-secret-token": secret }) }, body: JSON.stringify(update) });
}
const conv = (id) => db.doc(`orgs/${ORG}/conversations/${id}`);
const msgsOf = async (id) => (await conv(id).collection("messages").orderBy("at").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const outsOf = async (id) => (await msgsOf(id)).filter((m) => m.dir === "out");
const lastTrace = async (id) => (await conv(id).collection("traces").orderBy("at").get()).docs.map((d) => d.data()).at(-1);
async function callable(name, data, idToken) {
  const res = await fetch(`${FN}/${name}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${idToken}` }, body: JSON.stringify({ data }) });
  return { status: res.status, body: await res.json() };
}

// ── setup ──────────────────────────────────────────────────────────────────
console.log("setup");
await seedDemoData({ db, orgId: ORG, now: () => Date.now(), adk: null, log: () => {} });
await auth.createUser({ email: "muhammad.rafay@demo.com", password: "demo-password-1", emailVerified: true, displayName: "Muhammad Rafay" });
const signIn = await (await fetch(`${AUTH}/accounts:signInWithPassword?key=x`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "muhammad.rafay@demo.com", password: "demo-password-1", returnSecureToken: true }) })).json();
const managerToken = signIn.idToken;
assert(managerToken, "could not sign in the manager");

// ── 1. webhook security ────────────────────────────────────────────────────
console.log("\nwebhook security");
await step("a wrong secret is rejected and stores nothing", async () => {
  eq((await post(textUpdate(9, user(9, "Mallory"), "hello", 1), "wrong-secret")).status, 401);
  assert(!(await db.doc("tg_events/u1").get()).exists, "event was stored");
  assert(!(await conv("tg_9_telegram").get()).exists, "conversation was created");
});
await step("a missing secret is rejected", async () => {
  eq((await post(textUpdate(9, user(9, "Mallory"), "hello", 2), null)).status, 401);
});
await step("GET is not allowed", async () => {
  eq((await fetch(`${FN}/telegramWebhook`)).status, 405);
});
await step("messages from a group chat are ignored", async () => {
  const u = { update_id: 3, message: { message_id: 3, from: user(5, "Eve"), chat: { id: -100123, type: "supergroup" }, date: Math.floor(Date.now() / 1000), text: "hi all" } };
  eq((await post(u)).status, 200);
  assert(!(await conv("tg_-100123_telegram").get()).exists, "group conversation was created");
});

// ── 2. fee question ────────────────────────────────────────────────────────
console.log("\nfee question (chat 1001)");
const AYESHA = user(1001, "Ayesha", "ayesha_k");
const C1 = "tg_1001_telegram";
await step("a text message creates a Telegram customer and the agent answers through the Telegram API", async () => {
  eq((await post(textUpdate(1001, AYESHA, "What's the fee for an international wire?"))).status, 200);
  await until(async () => (await outsOf(C1)).length > 0, "agent reply");
  const cust = (await db.doc(`orgs/${ORG}/customers/tg_1001`).get()).data();
  eq([cust.name, cust.tgId, cust.phoneMasked], ["Ayesha", "1001", "@ayesha_k"]);
  const c = (await conv(C1).get()).data();
  eq([c.channel, c.transport], ["telegram", "telegram"]);
  const out = (await outsOf(C1))[0];
  assert(/\$45/.test(out.text), `reply does not state the wire fee: ${out.text}`);
  eq(out.cite, { doc: "Fee Schedule", section: "§4.2" });
  eq(out.status, "sent");
  const sent = sends(1001).at(-1);
  assert(sent, "nothing sent to the fake Telegram");
  eq(sent.body.text, out.text);
});
await step("the same update delivered twice is processed once", async () => {
  const before = (await outsOf(C1)).length;
  const dup = textUpdate(1001, AYESHA, "What's the fee for an international wire?", 8888);
  eq((await post(dup)).status, 200);
  await until(async () => (await outsOf(C1)).length > before, "first delivery");
  const after = (await outsOf(C1)).length;
  eq((await post(dup)).status, 200);
  await new Promise((r) => setTimeout(r, 2500));
  eq((await outsOf(C1)).length, after, "a retry produced another reply");
});

// ── 3. OTP scam ────────────────────────────────────────────────────────────
console.log("\nOTP scam report (chat 1001)");
await step("the agent locks the card, opens a P2 case and reassures the customer", async () => {
  const n = (await outsOf(C1)).length;
  await post(textUpdate(1001, AYESHA, "Someone just called saying they're from the bank and asked for my one-time code. I didn't give it. Is my account safe?"));
  await until(async () => (await outsOf(C1)).length > n, "scam reply");
  const t = await lastTrace(C1);
  eq(t.policyId, "P-07");
  const c = (await conv(C1).get()).data();
  eq(c.status, "fraud");
  assert(/^FR-\d+$/.test(c.caseId), `no fraud case: ${c.caseId}`);
  assert((await db.doc(`orgs/${ORG}/cards/tg_1001`).get()).data()?.locked === true, "card not locked");
  assert(/never ask for one-time codes/i.test((await outsOf(C1)).at(-1).text), "reassurance missing");
});

// ── 4. phishing link + tapped buttons ──────────────────────────────────────
console.log("\nphishing link and buttons (chat 2002)");
const BILAL = user(2002, "Bilal", "bilal_r");
const C2 = "tg_2002_telegram";
await step("a lookalike link gets a warning with Yes/No buttons as a Telegram inline keyboard", async () => {
  await post(textUpdate(2002, BILAL, "Got a text saying my account is LOCKED, verify at ravenw00d-verify.com. Is this you?"));
  await until(async () => sends(2002).length > 0, "phishing reply");
  const s = sends(2002).at(-1).body;
  assert(/isn't ours/.test(s.text), `no warning: ${s.text}`);
  const row = s.reply_markup?.inline_keyboard?.[0] ?? [];
  assert(row.map((b) => b.text).includes("Yes, I did"), `no Yes button: ${JSON.stringify(s.reply_markup)}`);
});
await step("tapping 'Yes, I did' escalates to a P1 case and locks the card, and the tap is acknowledged", async () => {
  const cb = { update_id: ++updateCounter, callback_query: { id: "cbq1", from: BILAL, data: "Yes, I did", message: { message_id: 5, chat: { id: 2002, type: "private" } } } };
  eq((await post(cb)).status, 200);
  await until(async () => (await lastTrace(C2))?.intent === "phishing_compromised", "escalation");
  assert((await db.doc(`orgs/${ORG}/cards/tg_2002`).get()).data()?.locked === true, "card not locked");
  const c = (await conv(C2).get()).data();
  eq(c.status, "fraud");
  await until(async () => calls.some((x) => x.method === "answerCallbackQuery" && x.body.callback_query_id === "cbq1"), "callback acknowledgement");
});

// ── 5. voice note ──────────────────────────────────────────────────────────
console.log("\nvoice note (chat 3003)");
await step("a voice note is stored and its file is fetched from Telegram", async () => {
  const u = { update_id: ++updateCounter, message: { message_id: 9, from: user(3003, "Sana"), chat: { id: 3003, type: "private" }, date: Math.floor(Date.now() / 1000), voice: { file_id: "VOICE_FILE_1", mime_type: "audio/ogg", duration: 6 } } };
  eq((await post(u)).status, 200);
  const m = await until(async () => (await msgsOf("tg_3003_telegram")).find((x) => x.dir === "in" && x.kind === "voice"), "voice message");
  eq([m.mediaId, m.mediaMime], ["VOICE_FILE_1", "audio/ogg"]);
  await until(async () => calls.some((x) => x.method === "getFile" && x.body.file_id === "VOICE_FILE_1"), "getFile call");
  await until(async () => (await msgsOf("tg_3003_telegram")).find((x) => x.dir === "in" && x.processed === true), "agent processed it");
});

// ── 6. dashboard replies go out through Telegram ───────────────────────────
console.log("\ndashboard");
await step("a manager's reply from the dashboard is delivered through Telegram", async () => {
  const before = sends(1001).length;
  const r = await callable("sendHumanMessage", { convId: C1, text: "Hi Ayesha, this is Dana from the fraud team. Your card is safe." }, managerToken);
  eq(r.status, 200, JSON.stringify(r.body));
  const sent = sends(1001).at(-1);
  assert(sends(1001).length > before, "nothing sent");
  eq(sent.body.text, "Hi Ayesha, this is Dana from the fraud team. Your card is safe.");
});
await step("a manager's message asking for a code is blocked and never reaches Telegram", async () => {
  const before = sends(1001).length;
  const r = await callable("sendHumanMessage", { convId: C1, text: "Please share your OTP so I can verify you" }, managerToken);
  assert(r.status >= 400, `was not refused: ${JSON.stringify(r.body)}`);
  eq(sends(1001).length, before, "blocked text reached Telegram");
});

// ── done ───────────────────────────────────────────────────────────────────
telegram.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("failed:", failures.join(" | "));
  process.exit(1);
}
process.exit(0);
