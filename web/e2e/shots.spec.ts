import { expect, test, devices, type Browser, type Page } from "@playwright/test";
import { JUDGE, MANAGER, signInAndWait, resetDemoData } from "./helpers";

// Takes the screenshots used on the landing page (design/landing/img). Not part of the normal test run.
//   PW_SHOTS=1 PW_SERVE=build firebase emulators:exec ... "node scripts/dev-seed.mjs && node scripts/seed-comments-local.mjs && cd web && npx playwright test --project shots"
// Run with real Gemini switched on for the functions, so traces and comment cards say Gemini.
const OUT = process.env.SHOTS_DIR ?? "../../design/landing/img";
const JPEG = { type: "jpeg" as const, quality: 86 };

async function desk(browser: Browser) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 });
  return { ctx, page: await ctx.newPage() };
}
async function phone(browser: Browser) {
  const { defaultBrowserType: _ignored, ...iphone } = devices["iPhone 14"]; // the Chromium that is installed, with the phone profile
  void _ignored;
  const ctx = await browser.newContext({ ...iphone, deviceScaleFactor: 2 });
  return { ctx, page: await ctx.newPage() };
}
const shot = (page: Page, name: string) => page.screenshot({ path: `${OUT}/${name}.jpg`, ...JPEG });

test("capture the landing page screenshots", async ({ browser }) => {
  await resetDemoData();

  // 1. A judge sends real messages, so every dashboard has real numbers and Gemini traces.
  const j = await desk(browser);
  await signInAndWait(j.page, JUDGE);
  const thread = j.page.locator(".try-thread");
  const say = async (label: string, replies: number) => {
    await j.page.getByRole("button", { name: label, exact: true }).click();
    await expect(thread.locator(".bub.ai")).toHaveCount(replies, { timeout: 120_000 });
  };
  await say("Phishing link", 1);
  await say("Fee question", 2);
  await say("Not fraud", 3);
  await say("Scam call", 4);
  await j.page.waitForTimeout(800);
  await thread.locator(".trace-h").last().scrollIntoViewIfNeeded();
  await shot(j.page, "try-desk");

  // two public comments through the live comment test
  for (const text of ["You've won a $500 giveaway! Claim now at ravenw00d-prizes.com", "Love waiting to see my paycheck. Thanks Ravenwood 🙃"]) {
    await j.page.getByLabel("Comment to test").fill(text);
    await j.page.getByRole("button", { name: "Classify" }).click();
    await expect(j.page.locator(".sunk", { hasText: text.slice(0, 20) })).toContainText(/Gemini|Rules/, { timeout: 120_000 });
  }
  await j.ctx.close();

  // 2. A manager's view on a laptop.
  const m = await desk(browser);
  await signInAndWait(m.page, MANAGER);
  const p = m.page;

  await p.goto("/inbox");
  await p.locator(".list-head .tab", { hasText: "Fraud" }).click();
  await p.locator(".li", { hasText: "(web chat)" }).first().click();
  await expect(p.locator(".thread-who")).toContainText("(web chat)");
  await p.locator(".trace-h").last().click();
  await p.waitForTimeout(600);
  await shot(p, "inbox-desk");

  await p.goto("/comments");
  await p.locator("button.li", { hasText: "rewards.com" }).first().click();
  await expect(p.locator(".sheet-in .card").first()).toContainText("scam or spam");
  await p.waitForTimeout(500);
  await shot(p, "moderation-scam-desk");

  await p.getByLabel("Search", { exact: true }).fill("international wire");
  await p.locator("button.li", { hasText: "international wire" }).first().click();
  await expect(p.locator(".sheet-in .card").first()).toContainText("Source");
  await p.waitForTimeout(500);
  await shot(p, "moderation-reply-desk");

  await p.goto("/insights");
  await expect(p.getByText("How people feel about each campaign")).toBeVisible();
  await p.waitForTimeout(900);
  await shot(p, "insights-desk");
  await p.locator("button.card").first().click();
  await p.waitForTimeout(900);
  await shot(p, "insights-campaign-desk");

  await p.goto("/agents");
  await expect(p.locator('[data-agent="customer-agent"]')).toContainText("Healthy", { timeout: 30_000 });
  await p.waitForTimeout(900);
  await shot(p, "agents-desk");
  await m.ctx.close();

  // 3. The same product on a phone.
  const ph = await phone(browser);
  await signInAndWait(ph.page, MANAGER);
  await ph.page.goto("/comments");
  await expect(ph.page.locator("button.li").first()).toBeVisible({ timeout: 30_000 });
  await ph.page.waitForTimeout(800);
  await shot(ph.page, "moderation-phone");
  await ph.page.locator("button.li", { hasText: "rewards.com" }).first().click();
  await ph.page.waitForTimeout(900);
  await shot(ph.page, "moderation-detail-phone");
  await ph.page.goto("/agents");
  await expect(ph.page.locator('[data-agent="customer-agent"]')).toBeVisible({ timeout: 30_000 });
  await ph.page.waitForTimeout(800);
  await shot(ph.page, "agents-phone");
  await ph.page.goto("/insights");
  await expect(ph.page.getByText("How people feel about each campaign")).toBeVisible({ timeout: 30_000 });
  await ph.page.waitForTimeout(800);
  await shot(ph.page, "insights-phone");
  await ph.ctx.close();

  const jp = await phone(browser);
  await signInAndWait(jp.page, JUDGE);
  await jp.page.waitForTimeout(1500);
  await shot(jp.page, "try-phone");
  await jp.ctx.close();
});
