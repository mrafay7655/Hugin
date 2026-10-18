// Re-seeds the sample comments on the LOCAL EMULATOR, classifying each with the real Gemini model.
// For taking screenshots and demos where the comment cards should say "Gemini", not "Rules".
// Needs the Firestore emulator running and Google application-default credentials with Vertex AI access.
import { createRequire } from "node:module";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { seedComments } = require("../functions/lib/seed/comments.js");
const { createAdkCommentClassifier } = require("../functions/lib/agent/adk/factory.js");

const cfg = { project: process.env.GEMINI_PROJECT ?? "hugin-b1ff5", location: "us-central1", model: "gemini-2.5-flash" };
initializeApp({ projectId: "demo-hugin" });
const ctx = { db: getFirestore(), orgId: "ravenwood", now: () => Date.now(), adk: cfg, commentClassifier: createAdkCommentClassifier(cfg), understanderOverride: null, log: () => {} };
const t = Date.now();
const out = await seedComments(ctx);
const snap = await ctx.db.collection("orgs/ravenwood/comments").get();
const by = {};
for (const d of snap.docs) by[d.data().source] = (by[d.data().source] ?? 0) + 1;
console.log(`seeded ${JSON.stringify(out)} in ${((Date.now() - t) / 1000).toFixed(0)}s; by source ${JSON.stringify(by)}`);
