# HUGIN dashboard

The Next.js (App Router, TypeScript) dashboard for HUGIN. See the [project README](../README.md) for what HUGIN is and [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) for how it fits together.

It is **phone first**: the base styles are for a 390px phone (bottom tab bar, one pane at a time, slide-up sheets for details), and wider screens add the sidebar and side-by-side panes (breakpoints at 700, 900 and 1000px). The stylesheet is `src/app/globals.css`.

```bash
npm install
npm run dev:emu      # against the local Firebase emulators, on http://localhost:3001 (see the project README)
npm run dev          # against the real Firebase project configured in .env.local
npm run build
npm run lint
npm run test:e2e     # Playwright, on a laptop-sized window and a phone-sized one (needs the emulators running)
```

`.env.local` holds the public Firebase web config (see `.env.example`). Production values are in `apphosting.yaml`. These are client values, not secrets: access is controlled by Firebase Auth and the Firestore and Storage rules.

`NEXT_PUBLIC_GOOGLE_SIGNIN=true` shows a "Continue with Google" button on the login page. Turn it on only after Google sign-in is enabled for the Firebase project.

## Layout

```
src/app/login            sign-in
src/app/(app)/*          the signed-in screens: inbox, approvals, comments (moderation), insights, customers,
                         knowledge, agent, channels, policies, audit, access, demo
src/components/shell.tsx sidebar on a laptop, bottom tab bar and "More" sheet on a phone
src/lib/auth.tsx         session and role (manager or judge)
src/lib/data.ts          live Firestore hooks and the callable-function helper
src/lib/url-state.ts     screen state in the URL, so refresh, links and the phone back gesture work
e2e/                     Playwright tests (app.spec.ts for a laptop, mobile.spec.ts for a phone)
```

Next.js 16 ships its own docs in `node_modules/next/dist/docs`. Middleware is now called Proxy, and Cache Components are on, so Firebase code lives in client components.
