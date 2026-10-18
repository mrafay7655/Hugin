import { expect, test } from "@playwright/test";
import { inboxTab, JUDGE, nav, overflowsHorizontally, resetDemoData, signIn, signInAndWait } from "./helpers";

// These run in a desktop window (1440 x 900). The phone has its own file, mobile.spec.ts.

test.describe("sign-in lockdown", () => {
  test("signed-out visitors are sent to login", async ({ page }) => {
    await page.goto("/inbox");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("wrong password shows a plain error", async ({ page }) => {
    await signIn(page, { email: "muhammad.rafay@demo.com", password: "nope-nope" });
    await expect(page.locator(".banner[role=alert]")).toContainText("Email or password is incorrect");
  });

  test("an account outside the approved domains is refused, with a reason", async ({ page }) => {
    // outsider@gmail.com is created by scripts/dev-seed.mjs with a verified email
    await signIn(page, { email: "outsider@gmail.com", password: "outsider-pass-1" });
    await expect(page.locator(".banner[role=alert]")).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });

  test("login shows the picture beside the form on a wide screen", async ({ page }) => {
    await page.goto("/login");
    await expect(page.locator(".auth-art")).toBeVisible();
    await expect(page.locator(".tabbar")).toHaveCount(0);
  });
});

test.describe("manager workspace", () => {
  test.beforeEach(async ({ page }) => {
    await resetDemoData();
    await signInAndWait(page);
  });

  test("a wide screen has the sidebar, not the tab bar", async ({ page }) => {
    await expect(page.locator(".side")).toBeVisible();
    await expect(page.locator(".tabbar")).toBeHidden();
    await expect(page.locator(".side")).toContainText("Manager");
  });

  test("inbox shows seeded conversations with the agent's reasoning", async ({ page }) => {
    await expect(page.locator(".li").first()).toBeVisible();
    await inboxTab(page, "Resolved").click();
    await page.locator(".li", { hasText: "Priya Shah" }).click();
    await expect(page.getByText("Source · Fee Schedule §4.2").first()).toBeVisible();
    await page.locator(".trace-h").first().click();
    await expect(page.locator(".trace-b")).toContainText("Confidence");
    // list, conversation and customer column are all on screen at once
    await expect(page.locator(".list")).toBeVisible();
    await expect(page.locator(".thread")).toBeVisible();
    await expect(page.locator(".ctx")).toBeVisible();
  });

  test("simulated OTP scam: agent locks the card and opens a fraud case; a manager can unlock it", async ({ page }) => {
    await nav(page, "/demo");
    await page.getByRole("button", { name: "OTP scam report" }).click();
    await page.getByRole("button", { name: "Send as customer" }).click();
    await expect(page.getByText("Sent · watch the Inbox")).toBeVisible();
    await nav(page, "/inbox");
    await inboxTab(page, "Fraud").click();
    await page.locator(".li", { hasText: "Marcus Reed" }).click();
    await expect(page.locator(".bub.ai").last()).toContainText("locked your card");
    await expect(page.locator(".ctx")).toContainText("Card locked");
    await expect(page.locator(".thread-top .badge.mono")).toHaveText(/^FR-\d+$/);

    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Unlock card" }).click();
    await expect(page.getByText("Card unlocked").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Unlock card" })).toHaveCount(0);
  });

  test("an ordinary message that mentions a PIN does not lock anything", async ({ page }) => {
    await nav(page, "/demo");
    await page.getByRole("button", { name: "Not fraud: forgot PIN" }).click();
    await page.getByRole("button", { name: "Send as customer" }).click();
    await expect(page.getByText("Sent · watch the Inbox")).toBeVisible();
    await nav(page, "/inbox");
    await page.locator(".li", { hasText: "Daniel Okafor" }).first().click();
    await page.waitForTimeout(1500);
    await expect(page.locator(".ctx")).not.toContainText("Card locked");
    await expect(page.locator(".thread-top .badge.mono")).toHaveCount(0);
  });

  test("approvals: edit and approve a draft; it is sent and leaves the queue", async ({ page }) => {
    await nav(page, "/approvals");
    await expect(page.getByText("Drafts the agent is not allowed to send")).toBeVisible();
    const card = page.locator(".page-narrow .card:visible", { hasText: "James Walker" });
    await expect(card).toBeVisible();
    await card.locator("textarea").fill("Hi James, I'm sorry about the fees. I'll call you today to sort this out.");
    await card.getByRole("button", { name: "Approve and send" }).click();
    await expect(page.getByText("Approved and sent")).toBeVisible();
    await expect(page.locator(".card", { hasText: "James Walker" })).toHaveCount(0);
  });

  test("a manager message asking for a PIN, however it is worded, is blocked by the guard", async ({ page }) => {
    await inboxTab(page, "Resolved").click();
    await page.locator(".li", { hasText: "Tom Becker" }).click();
    await expect(page.locator(".thread-who")).toContainText("Tom Becker"); // the thread must have switched before acting on it
    await page.getByRole("button", { name: "Take over" }).click();
    await expect(page.getByText("You're in control")).toBeVisible();
    for (const text of ["Please reply with your PIN so I can verify you", "whats ur otp", "Kindly share the verification code"]) {
      await page.getByLabel("Reply", { exact: true }).fill(text);
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect(page.getByText("Not done").first()).toBeVisible();
    }
    await expect(page.locator(".bub.human", { hasText: /pin|otp|verification/i })).toHaveCount(0);
    await page.getByRole("button", { name: "Hand back to agent" }).click();
  });

  test("moderation: scams are flagged and hidden; a sourced reply is allowed, an unsafe one is blocked", async ({ page }) => {
    await nav(page, "/comments");
    await expect(page.getByText("Risky: review first")).toBeVisible();

    // the scam is flagged, has no drafted reply, and can be hidden
    await page.getByRole("button", { name: /ravenw00d-rewards\.com/ }).first().click();
    const detail = page.locator(".sheet-in .card").first();
    await expect(detail).toContainText("Risk: scam or spam");
    await expect(detail).toContainText("No reply is drafted for scams");
    await detail.getByRole("button", { name: "Hide" }).click();
    await expect(page.getByText("Comment hidden")).toBeVisible();

    // a fee question gets a cited, sourced draft; a reply asking for an account number is blocked
    await page.locator(".tabs").getByRole("button", { name: /^All/ }).click();
    await expect(page).toHaveURL(/view=everything/);
    await page.getByLabel("Search", { exact: true }).fill("international wire");
    await page.getByRole("button", { name: /fee for an international wire at Ravenwood/ }).first().click();
    await expect(page.getByText("Source · Fee Schedule §4.2").first()).toBeVisible();
    await page.getByLabel(/Public reply/).fill("Reply with your account number and we'll check");
    await page.getByRole("button", { name: "Reply publicly" }).click();
    await expect(page.getByText("Not done").first()).toBeVisible();
    await page.getByLabel(/Public reply/).fill("International wires are $45 each. Message us privately with any questions!");
    await page.getByRole("button", { name: "Reply publicly" }).click();
    await expect(page.getByText(/Reply recorded/)).toBeVisible();
    await expect(page.getByText(/Replied by Muhammad Rafay/)).toBeVisible();
  });

  test("a simulated comment is classified live", async ({ page }) => {
    await nav(page, "/demo");
    await page.getByRole("button", { name: "Legal threat" }).click();
    await page.getByRole("button", { name: "Post comment" }).click();
    await expect(page.getByText(/Comment classified/)).toBeVisible();
    await nav(page, "/comments");
    await page.getByRole("button", { name: /report you to the CFPB/ }).first().click();
    await expect(page.locator(".sheet-in .card").first()).toContainText("Negative");
  });

  test("social insights shows sentiment by campaign", async ({ page }) => {
    await nav(page, "/insights");
    await expect(page.getByText("How people feel about each campaign")).toBeVisible();
  });

  test("policies: draft threshold above auto-send cannot be saved; locked rule cannot be unticked", async ({ page }) => {
    await nav(page, "/policies");
    await expect(page.getByRole("checkbox").first()).toBeDisabled();
    await expect(page.getByText("P-05")).toBeVisible();
    await page.getByLabel("Draft at or above").evaluate((el: HTMLInputElement) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, "0.95");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await expect(page.getByText("must be lower than auto-send")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  test("access: public mail domains are refused, invites carry a role; the audit log records actions", async ({ page }) => {
    await nav(page, "/access");
    await page.getByPlaceholder("bankname.com").fill("gmail.com");
    await page.getByRole("button", { name: "Approve domain" }).click();
    await expect(page.getByText("Not done").first()).toBeVisible();
    await expect(page.getByLabel("Role")).toBeVisible();
    await nav(page, "/audit");
    await expect(page.locator(".audit-table")).toContainText("muhammad.rafay@demo.com");
  });

  test("no screen scrolls sideways at desktop width either", async ({ page }) => {
    for (const href of ["/inbox", "/comments", "/insights", "/agent", "/channels/telegram", "/policies", "/audit"]) {
      await page.goto(href);
      await page.waitForTimeout(800);
      expect((await overflowsHorizontally(page)).over, href).toBe(false);
    }
  });

  test("sign out returns to login", async ({ page }) => {
    await page.getByTitle("Sign out").click();
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe("a judge", () => {
  test.beforeEach(async ({ page }) => {
    await resetDemoData();
    await signInAndWait(page, JUDGE);
  });

  test("sees the judge role and can read everything", async ({ page }) => {
    await expect(page.locator(".side")).toContainText("Judge · view and try");
    await nav(page, "/policies");
    await expect(page.getByText("You are signed in as a judge")).toBeVisible();
    await expect(page.getByLabel("Auto-send at or above")).toBeDisabled();
    await expect(page.getByRole("button", { name: "Save changes" })).toHaveCount(0);
  });

  test("cannot add knowledge, change access, or reset the demo", async ({ page }) => {
    await nav(page, "/knowledge");
    await expect(page.getByRole("button", { name: "Add document" })).toHaveCount(0);
    await nav(page, "/access");
    await expect(page.getByRole("button", { name: "Approve domain" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Invite" })).toHaveCount(0);
    await nav(page, "/demo");
    await expect(page.getByRole("button", { name: /Reset sample data/ })).toHaveCount(0);
  });

  test("can try the demo: a simulated message is handled and a judge may act on it", async ({ page }) => {
    await nav(page, "/demo");
    await page.getByRole("button", { name: "Fee question", exact: true }).click();
    await page.getByRole("button", { name: "Send as customer" }).click();
    await expect(page.getByText("Sent · watch the Inbox")).toBeVisible();
    await nav(page, "/approvals");
    await expect(page.getByText("Drafts the agent is not allowed to send")).toBeVisible();
    const card = page.locator(".page-narrow .card:visible", { hasText: "James Walker" });
    await expect(card).toBeVisible();
    // James's conversation is a simulated sample, so a judge may act on it
    await expect(card.getByRole("button", { name: "Approve and send" })).toBeEnabled();
  });
});

test.describe("try it live and the agent dashboard", () => {
  test.beforeEach(async () => {
    await resetDemoData();
  });

  test("a judge lands on Try it live and sees all three ways to test", async ({ page }) => {
    await signInAndWait(page, JUDGE);
    await expect(page.locator(".side")).toContainText("Try it live");
    await expect(page.getByText("Chat with HUGIN as a customer")).toBeVisible();
    await expect(page.getByText("Or message the real bot on Telegram")).toBeVisible();
    await expect(page.getByText("Test a public comment")).toBeVisible();
  });

  test("web chat: a scam report locks the card in the judge's own conversation, with the reasoning shown", async ({ page }) => {
    await signInAndWait(page, JUDGE);
    await page.getByRole("button", { name: "Scam call", exact: true }).click();
    await expect(page.locator(".try-thread .bub.ai").first()).toContainText("locked your card", { timeout: 30_000 });
    await expect(page.locator(".try-thread .trace").first()).toContainText("P-07");
    await expect(page.getByText(/^FR-\d+$/).first()).toBeVisible();
    // the same conversation is in the Inbox, marked simulated, and only the judge's
    await page.getByRole("link", { name: "Open in Inbox" }).click();
    await expect(page.locator(".thread-who")).toContainText("(web chat)");
    await expect(page.locator(".thread-who")).toContainText("SIMULATED");
  });

  test("web chat: a keyword alone does not lock anything", async ({ page }) => {
    await signInAndWait(page, JUDGE);
    await page.getByRole("button", { name: "Not fraud", exact: true }).click();
    await expect(page.locator(".try-thread .bub.ai").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/^FR-\d+$/)).toHaveCount(0);
  });

  test("web chat: uploads say clearly when Cloud Storage is not on", async ({ page }) => {
    await signInAndWait(page, JUDGE);
    await page.locator('input[type="file"]').setInputFiles({ name: "scam.png", mimeType: "image/png", buffer: Buffer.from("89504e470d0a1a0a", "hex") });
    await expect(page.getByText("scam.png")).toBeVisible();
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText(/Cloud Storage/).first()).toBeVisible();
  });

  test("comment test: Gemini or the rules score it, and a scam is flagged with no reply", async ({ page }) => {
    await signInAndWait(page, JUDGE);
    await page.getByLabel("Comment to test").fill("You've won a $500 giveaway! Claim now at ravenw00d-prizes.com");
    await page.getByRole("button", { name: "Classify" }).click();
    const result = page.locator(".sunk", { hasText: "ravenw00d-prizes.com" });
    await expect(result).toContainText("scam or spam");
    await expect(result).toContainText("No reply drafted");
  });

  test("the Inbox hides sample data for a judge by default, and shows it on request", async ({ page }) => {
    await signInAndWait(page, JUDGE);
    await nav(page, "/inbox");
    await expect(page.getByLabel(/Hide sample data/)).toBeChecked();
    await expect(page.locator(".li", { hasText: "Priya Shah" })).toHaveCount(0);
    await page.getByLabel(/Hide sample data/).uncheck();
    await inboxTab(page, "Resolved").click();
    await expect(page.locator(".li", { hasText: "Priya Shah" })).toBeVisible();
    await expect(page.locator(".li", { hasText: "Priya Shah" })).toContainText("SAMPLE");
  });

  test("the agent dashboard lists every agent with its status, and counts a new message", async ({ page }) => {
    await signInAndWait(page, JUDGE);
    await page.getByRole("button", { name: "Fee question", exact: true }).click();
    await expect(page.locator(".try-thread .bub.ai").first()).toBeVisible({ timeout: 30_000 });
    await nav(page, "/agents");
    for (const name of ["Customer agent", "Comment agent", "Policy engine", "Output guard", "Telegram connector", "WhatsApp connector", "Meta comments connector", "Sweeper"]) {
      await expect(page.locator(".agents-grid .card", { hasText: name })).toBeVisible();
    }
    await expect(page.locator('[data-agent="customer-agent"]')).toContainText("Healthy");
    await expect(page.locator(".stat", { hasText: "Messages handled" })).not.toContainText(/^Messages handled0/);
    await expect(page.getByText("Messages per day")).toBeVisible();
    await page.getByRole("button", { name: "7 days" }).click();
    await expect(page.locator(".stat", { hasText: "Messages handled" })).toContainText("last 7 days");
  });
});
