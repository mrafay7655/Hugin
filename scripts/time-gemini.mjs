// Times the real Gemini understanding pipeline (Vertex AI, through ADK) on a few messages. Writes nothing.
// Needs application-default credentials with Vertex AI access. Run from hugin/ after building functions:
//   node scripts/time-gemini.mjs                       thinking off (the default)
//   GEMINI_THINKING_BUDGET=-1 node scripts/time-gemini.mjs   let the model think, to compare
import { createRequire } from "node:module";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const { createAdkUnderstander } = require("../functions/lib/agent/adk/factory.js");
const { retrieveFromDocs } = require("../functions/lib/agent/retrieve.js");

process.env.GEMINI_TIMEOUT_MS ??= "120000"; // measure, do not cut off
const cfg = { project: process.env.GCLOUD_PROJECT ?? "hugin-b1ff5", location: "us-central1", model: process.env.GEMINI_MODEL ?? "gemini-2.5-flash" };
const KB = [{ id: "fee", title: "Fee Schedule", status: "active", sections: [{ id: "§4.2", title: "International wires", text: "Outgoing international wires are $45 each." }] }];
const deps = { officialDomains: ["ravenwoodbank.com"], searchPolicy: async (q) => retrieveFromDocs(q, KB), customerContext: async () => ({ tier: "Everyday", customerSinceYear: 2021, recentIntents: [], cardLocked: false }) };
const run = createAdkUnderstander(cfg, deps);

const MESSAGES = [
  "Someone called saying they're from Ravenwood and asked for my one-time code. I didn't give it. Is my account safe?",
  "Got a text saying my account is LOCKED, verify at ravenw00d-verify.com. Is this you?",
  "What's the fee for an international wire?",
];
console.log(`model ${cfg.model} · thinking budget ${process.env.GEMINI_THINKING_BUDGET ?? "0 (off)"}`);
for (const text of MESSAGES) {
  const t = Date.now();
  try {
    const r = await run({ text, kind: "text" });
    console.log(`${String(Date.now() - t).padStart(6)} ms  ${r.understanding.intent.padEnd(16)} tools: ${r.toolCalls.map((c) => c.name).join(", ") || "none"}`);
  } catch (e) {
    console.log(`${String(Date.now() - t).padStart(6)} ms  FAILED: ${e.message}`);
  }
}
