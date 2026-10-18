# HUGIN

**A governed Gemini agent that catches scams before the money moves.**
Built for the Google Cloud AI Builder Cup 2026 (BFSI track) by a team of two. The bank in the demo, Ravenwood Bank, is fictional.

Scams move in minutes. Bank queues move in hours. HUGIN reads every customer message, voice note and scam screenshot, answers only from approved policy, locks a card and opens a fraud case when someone reports a scam, and hands anything risky to a person with its reasoning attached. It also reads the public comments on the bank's posts, scores their sentiment, and flags scams for hiding.

The idea that makes it safe to put in front of a bank: **the model proposes, code decides.** Gemini understands the message. A deterministic policy engine decides what happens. Output guards in code stop anything unsafe from ever being sent, whoever wrote it.

## Try it

| | |
|---|---|
| Live dashboard | https://hugin-web--hugin-b1ff5.us-central1.hosted.app (sign-in details are in the submission notes; there is no public sign-up) |
| Live bot | Telegram, [@ravenwood_hugin_bot](https://t.me/ravenwood_hugin_bot). Send it a scam call, a suspicious link, a voice note or a screenshot, then watch the dashboard. |
| Demo tools | Demo control, in the dashboard: simulated customers and comments run through the exact same pipeline, clearly labelled SIMULATED. |

The dashboard is built phone first: a bottom tab bar on a phone, a sidebar on a laptop.

## What it does

- **Customer messages** (Telegram live; WhatsApp Cloud API implemented, see limits): text, voice notes and screenshots are read by Gemini. Replies come from reviewed templates and approved knowledge text, never from free model generation, and cite the source they used.
- **Fraud:** a clear report ("someone called and asked for my one-time code") locks the card, opens a case, alerts the team and reassures the customer, at once. A vague keyword does not lock anything: it goes to a person (policy P-05).
- **Phishing:** every link is checked against the bank's real domain. A lookalike such as `ravenw00d-verify.com` is flagged, and the customer is asked whether they entered any details.
- **Comments:** Instagram and Facebook comments are received through Meta webhooks (implemented and tested against a fake of Meta's API; the demo's comments are sample data). Each is classified for sentiment, sarcasm, topic and risk, rolled up per post and campaign, and a manager can reply (with a drafted, sourced answer), hide scams, or mark them handled.
- **Every decision is explained.** The Inbox shows the reasoning trace per message, and the Agent console replays the Gemini and ADK run, including what the rules said and whether they overrode the model.

## The rules the agent follows

| Rule | When | What happens |
|---|---|---|
| P-07 | A clear fraud or one-time-code report | Lock the card, open a case, notify Fraud, reassure. At once. |
| P-05 | A fraud keyword the rules cannot be sure of | A person reviews it. Nothing is locked on a hunch. |
| P-08 | A suspicious link or screenshot | Check the domain against the official one. Lookalikes are phishing. |
| P-04 | Account changes, refunds, complaints | Draft only. A person approves before anything is sent. |
| P-01 | Confident and backed by an approved source | Answer, with the source cited. |
| P-06 | Unsure | Draft for a person. |
| P-02 | No approved source | Honest fallback and hand to a person. Never guess. |
| P-99 | Anything fails | Fail safe: hand to a person. |

**Output guards** run in code on every outgoing message, from the agent or from a person: no request for a PIN, one-time code, password, card or account number or SSN (in any phrasing, including spaced-out or look-alike letters); no promise of a refund by the agent; no link to anything but the bank's own site (people may link to public authorities but never to a lookalike); WhatsApp's 24-hour window respected. A manager's message is checked by the same code.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the diagrams.

**Google Cloud and Firebase, as actually used:**

| Piece | Used for |
|---|---|
| **Gemini on Vertex AI**, through the **Google Agent Development Kit (ADK) for TypeScript** | Understanding every message. A `SequentialAgent` runs an *investigator* (Gemini chooses read-only tools: policy search, domain check, customer context) and then a *classifier* (structured output validated by a schema). A second ADK agent classifies comments. Voice notes and screenshots go to Gemini directly. |
| **Firebase App Hosting** (Cloud Run) | The Next.js dashboard. |
| **Cloud Functions, 2nd gen** (Cloud Run) | Telegram, WhatsApp and Meta webhooks; the agent (a Firestore trigger on each new customer message); every manager action; a sweeper that picks up messages whose run was lost. |
| **Firestore** | All data, live to the dashboard. Security rules allow reads only; every write goes through a function. |
| **Firebase Authentication with Identity Platform** | Sign-in. Public sign-up is off. Blocking functions allow only approved domains and invited people, and set the role. |
| **Cloud Storage** | Archive of voice notes and screenshots. |
| **Secret Manager** | Bot and API tokens. Nothing sensitive is in the repository. |

**Not used, on purpose:** Vertex AI Search (policy retrieval is keyword search over approved documents in Firestore, behind a small interface it could replace), Pub/Sub (the agent runs from the Firestore trigger), BigQuery, Document AI. These are the natural next steps; we did not want to claim what we did not build.

## Security and governance

- **No public sign-up.** An account needs an approved bank domain or an explicit invite, and a verified email. Removing a domain or an invite ends those people's sessions at once.
- **Two roles.** A *manager* can change anything. A *judge* can read everything and use the demo tools, but only on simulated data and the Telegram demo bot: a judge cannot change policy, knowledge or access, reset the demo, or touch a WhatsApp conversation or a real public comment. A judge can act on simulated conversations and on the Telegram demo bot's chats, so they can try the full loop.
- **Webhooks are authenticated** (Meta's HMAC signature, Telegram's secret header), deduplicated, rate-limited (30 messages an hour per chat, and a daily cap across the bot), and WhatsApp messages for another phone number are ignored.
- **The audit log is append-only.** Security rules deny every update and delete.
- **Customer text is data, never instructions.** A message cannot close the data tag in a prompt, and a customer's display name is never echoed back unless it looks like a plain first name.
- **Personal data:** real customers' messages expire after 30 days (Firestore TTL); names are shortened on the public Telegram screen; phone numbers are masked.
- **Fail safe:** if anything in the pipeline throws, the customer gets a holding reply and the case goes to a person. The model can never lock, unlock or send on its own: the tools it can call are read-only.

## Run it locally

Needs Node 22 and the Firebase CLI. Everything runs on the Firebase Emulator Suite, with no cloud account and no model.

```bash
npm --prefix functions install --legacy-peer-deps && npm --prefix functions run build
npm --prefix web install

firebase emulators:start --only auth,functions,firestore --project demo-hugin   # terminal 1
node scripts/dev-seed.mjs                                                       # terminal 2: demo data and accounts
npm --prefix web run dev:emu                                                    # terminal 3, then open http://localhost:3001
```

Sign in as `muhammad.rafay@demo.com` / `demo-password-1` (manager) or `judge@demo.com` / `judge-password-1` (judge). These local accounts exist only in the emulator.

## Tests

```bash
npm --prefix functions test            # unit tests: policy, guards, agent, ADK (with a fake Gemini), comments, auth, Telegram, WhatsApp
npm --prefix functions run test:int    # Firestore-emulator tests: the agent, comments, security rules, access, safety, Telegram
node scripts/free-emulator-ports.mjs
firebase emulators:exec --only auth,functions,firestore --project demo-hugin "node scripts/e2e-emulator.mjs"     # WhatsApp and Meta, end to end
firebase emulators:exec --only auth,functions,firestore --project demo-hugin "node scripts/e2e-telegram.mjs"     # Telegram, end to end
firebase emulators:exec --only auth,functions,firestore --project demo-hugin "node scripts/dev-seed.mjs && cd web && npx playwright test"   # the dashboard in a browser, on a laptop and on a phone
```

The model is faked in these tests, and so are Meta and Telegram, so they prove the plumbing and the safety rules, not Gemini's accuracy. `scripts/benchmark.mjs` measures Gemini itself on a labelled set (it needs Vertex AI credentials and writes nothing to the database).

## Deploy

```bash
npm --prefix functions run build
firebase deploy --only functions,firestore,apphosting --project hugin-b1ff5
node scripts/lock-auth.mjs            # checks the sign-in lockdown; add --apply to switch off self-service sign-up
```

`scripts/prod-seed.mjs` creates the demo data and the manager and judge accounts in the live project. Secrets (`WHATSAPP_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `META_PAGE_TOKEN`) are set in Secret Manager with `firebase functions:secrets:set`.

## Honest limits

- **WhatsApp** is implemented end to end and tested against a fake of Meta's API, but the WhatsApp test number can only message five verified recipients, so **Telegram is the open channel** for trying it. Instagram and Facebook comments use the same Meta webhooks; YouTube, X and TikTok are simulated.
- **Speed.** Gemini takes a few seconds per message; a typical message is answered in about 4 to 11 seconds.
- **Retrieval** is keyword search, not semantic search. It is conservative on purpose: below a relevance score it says it has no source instead of guessing.
- Ravenwood Bank, its customers and its numbers are made up. Sample data is labelled SAMPLE throughout.

## Layout

```
web/         Next.js dashboard (App Router, TypeScript), phone first
functions/   Cloud Functions: webhooks, the ADK agent, policy engine, guards, manager actions, comments
  src/policy      the policy engine and the output guards (pure, heavily tested)
  src/agent       understanding, retrieval, replies, the agent run, ADK pipeline
  src/comments    sentiment and risk classification, ingestion, Meta moderation
  test/           unit tests; test/integration runs on the Firestore emulator
scripts/     seeding, end-to-end runs, benchmark, auth lockdown check, deploy helpers
firestore.rules, storage.rules, firestore.indexes.json, firebase.json
```
