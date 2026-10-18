// Re-seeds the demo comments and posts on the LIVE project, classifying every comment with Gemini.
// The first seed (scripts/prod-seed.mjs) had no model attached, so those comments were read by the rule-based fallback.
// This DELETES and recreates all comments and posts, including any added from Demo control.
//
// Needs Google application-default credentials with Vertex AI access:  gcloud auth application-default login
// Run from hugin/ after `npm --prefix functions run build`:   node scripts/seed-comments-gemini.mjs
import { createRequire } from "node:module";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const { initializeApp, applicationDefault } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { seedComments } = require("../functions/lib/seed/comments.js");
const { createAdkCommentClassifier } = require("../functions/lib/agent/adk/factory.js");

if (process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Emulator variables are set. This script is for the live project.");

const PROJECT = process.env.GCLOUD_PROJECT ?? "hugin-b1ff5";
const ORG = process.env.ORG_ID ?? "ravenwood";
const cfg = { project: PROJECT, location: "us-central1", model: "gemini-2.5-flash" };

initializeApp({ credential: applicationDefault(), projectId: PROJECT });
const ctx = { db: getFirestore(), orgId: ORG, now: () => Date.now(), adk: cfg, commentClassifier: createAdkCommentClassifier(cfg), understanderOverride: null, log: () => {} };

const t = Date.now();
const out = await seedComments(ctx);
const snap = await ctx.db.collection(`orgs/${ORG}/comments`).get();
const by = { gemini: 0, heuristic: 0 };
for (const d of snap.docs) by[d.data().source] = (by[d.data().source] ?? 0) + 1;
console.log(`seeded ${JSON.stringify(out)} in ${((Date.now() - t) / 1000).toFixed(0)}s; classified by Gemini: ${by.gemini}, by rules: ${by.heuristic}`);
