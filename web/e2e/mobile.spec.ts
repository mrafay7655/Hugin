import { expect, test, type Page } from "@playwright/test";
import { inboxTab, JUDGE, nav, overflowsHorizontally, resetDemoData, signIn, signInAndWait } from "./helpers";

// These run on a phone: 390 x 844, touch. They are the mobile-first checks.

const ROUTES = ["/try", "/agents", "/inbox", "/approvals", "/comments", "/insights", "/customers", "/knowledge", "/agent", "/channels", "/channels/telegram", "/policies", "/audit", "/access", "/demo"];

const waitForData = (page: Page) => page.waitForTimeout(1200);

test.describe("login on a phone", () => {
  test("the form comes first, the picture is hidden, nothing scrolls sideways", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByLabel("Work email")).toBeVisible();
    await expect(page.locator(".auth-art")).toBeHidden();
    expect((await overflowsHorizontally(page)).over).toBe(false);
  });

  test("fields are big enough to tap and do not zoom the page on iPhone", async ({ page }) => {
    await page.goto("/login");
    for (const sel of ["#email", "#pw"]) {
      const box = await page.locator(sel).boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(await page.locator(sel).evaluate((e) => parseFloat(getComputedStyle(e).fontSize))).toBeGreaterThanOrEqual(16);
    }
    expect((await page.getByRole("button", { name: "Sign in", exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  });

  test("a refused account is told why", async ({ page }) => {
    await signIn(page, { email: "outsider@gmail.com", password: "outsider-pass-1" });
    await expect(page.locator(".banner[role=alert]")).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe("the signed-in app on a phone", () => {
  test.beforeEach(async ({ page }) => {
    await resetDemoData();
    await signInAndWait(page);
  });

  test("navigation is a bottom tab bar, not a sidebar", async ({ page }) => {
    await expect(page.locator(".side")).toBeHidden();
    const bar = page.locator(".tabbar");
    await expect(bar).toBeVisible();
    for (const label of ["Inbox", "Approvals", "Comments", "Agents", "More"]) await expect(bar.locator(".tb", { hasText: label })).toBeVisible();
    // finger-sized tabs
    for (const el of await bar.locator(".tb").all()) expect((await el.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    // and the bar sits at the bottom of the screen
    const box = (await bar.boundingBox())!;
    expect(box.y + box.height).toBeGreaterThan(page.viewportSize()!.height - 2);
  });

  test("More lists everything else, navigates, and closes by itself", async ({ page }) => {
    await page.getByRole("button", { name: "More" }).click();
    const more = page.locator(".more");
    await expect(more).toBeVisible();
    for (const label of ["Try it live", "Social insights", "Customers", "Knowledge", "Run replay", "Channels", "Agent policies", "Audit log", "Access", "Demo control"]) await expect(more.getByRole("link", { name: label })).toBeVisible();
    await more.getByRole("link", { name: "Knowledge" }).click();
    await expect(page).toHaveURL(/\/knowledge/);
    await expect(more).toBeHidden();
    await expect(page.locator(".tabbar .tb", { hasText: "More" })).toHaveClass(/active/);
    // coming back to the page More was opened from must not reopen it
    await page.locator('.tabbar a[href="/inbox"]').click();
    await expect(page).toHaveURL(/\/inbox/);
    await expect(more).toBeHidden();
  });

  test("inbox: the list, then the conversation, then back; the chosen conversation is in the URL", async ({ page }) => {
    const inbox = page.locator(".inbox");
    await expect(inbox).toHaveAttribute("data-view", "list");
    await expect(page.locator(".thread")).toBeHidden();
    await inboxTab(page, "Resolved").click();
    await page.locator(".li", { hasText: "Priya Shah" }).click();

    await expect(inbox).toHaveAttribute("data-view", "thread");
    await expect(page).toHaveURL(/\/inbox\?c=/);
    await expect(page.locator(".list")).toBeHidden();
    await expect(page.locator(".tabbar")).toBeHidden(); // the composer gets the room
    await expect(page.getByText("Source · Fee Schedule §4.2").first()).toBeVisible();
    expect((await overflowsHorizontally(page)).over).toBe(false);

    // the thread's own back button
    await page.getByRole("button", { name: "Back to the inbox" }).click();
    await expect(inbox).toHaveAttribute("data-view", "list");
    await expect(page.locator(".tabbar")).toBeVisible();

    // the phone's back gesture: open, then go back through history
    await inboxTab(page, "Resolved").click();
    await page.locator(".li", { hasText: "Priya Shah" }).click();
    await expect(inbox).toHaveAttribute("data-view", "thread");
    await page.goBack();
    await expect(inbox).toHaveAttribute("data-view", "list");
  });

  test("a refresh keeps you in the same conversation", async ({ page }) => {
    await inboxTab(page, "Resolved").click();
    await page.locator(".li", { hasText: "Priya Shah" }).click();
    await expect(page).toHaveURL(/\?c=/);
    await page.reload();
    await expect(page.locator(".inbox")).toHaveAttribute("data-view", "thread");
    await expect(page.locator(".thread-who")).toContainText("Priya Shah");
  });

  test("conversation controls are finger-sized and the customer panel is a sheet you can open and close", async ({ page }) => {
    await inboxTab(page, "Resolved").click();
    await page.locator(".li", { hasText: "Priya Shah" }).click();
    for (const name of ["Send to Fraud", "Resolve", "Take over", "Customer details"]) {
      const b = (await page.getByRole("button", { name }).boundingBox())!;
      expect(b.width, name).toBeGreaterThanOrEqual(36);
      expect(b.height, name).toBeGreaterThanOrEqual(36);
    }
    await page.getByRole("button", { name: "Customer details" }).click();
    await expect(page.locator(".ctx.open")).toBeVisible();
    await expect(page.locator(".ctx.open")).toContainText("Priya Shah");
    await page.locator(".ctx-bg").click({ position: { x: 20, y: 20 } });
    await expect(page.locator(".ctx.open")).toHaveCount(0);
  });

  test("a locked card can be unlocked from the customer sheet", async ({ page }) => {
    await nav(page, "/demo");
    await page.getByRole("button", { name: "OTP scam report" }).click();
    await page.getByRole("button", { name: "Send as customer" }).click();
    await expect(page.getByText("Sent · watch the Inbox")).toBeVisible();
    await nav(page, "/inbox");
    await inboxTab(page, "Fraud").click();
    await page.locator(".li", { hasText: "Marcus Reed" }).click();
    await expect(page.locator(".bub.ai").last()).toContainText("locked your card");
    await page.getByRole("button", { name: "Customer details" }).click();
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Unlock card" }).click();
    await expect(page.getByText("Card unlocked").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Unlock card" })).toHaveCount(0);
  });

  test("approvals open the exact conversation", async ({ page }) => {
    await nav(page, "/approvals");
    await expect(page.getByText("Drafts the agent is not allowed to send")).toBeVisible();
    await expect(page.locator(".page-narrow .card:visible", { hasText: "James Walker" })).toBeVisible();
    await page.locator(".page-narrow .card:visible", { hasText: "James Walker" }).getByRole("link", { name: "Open thread" }).click();
    await expect(page).toHaveURL(/\/inbox\?c=c8_x/);
    await expect(page.locator(".thread-who")).toContainText("James Walker");
  });

  test("comments: tapping one opens it as its own screen, and back returns to the list", async ({ page }) => {
    await nav(page, "/comments");
    await waitForData(page);
    const sheet = page.locator(".sheet").first();
    await expect(sheet).not.toHaveClass(/open/);
    await page.locator(".li").first().click();
    await expect(sheet).toHaveClass(/open/);
    await expect(sheet.getByText("Public reply").or(sheet.getByText("No reply is drafted"))).toBeVisible();
    await sheet.getByRole("button", { name: "Back to the list" }).click();
    await expect(sheet).not.toHaveClass(/open/);
  });

  test("customers: a list, and the profile as its own screen", async ({ page }) => {
    await nav(page, "/customers");
    await page.locator(".g-customers .li", { hasText: "Marcus Reed" }).click();
    const sheet = page.locator(".sheet.open");
    await expect(sheet).toContainText("Communication style");
    await sheet.getByRole("button", { name: "Back to customers" }).click();
    await expect(page.locator(".sheet.open")).toHaveCount(0);
  });

  test("audit log is a list of cards, not a table to scroll sideways", async ({ page }) => {
    await nav(page, "/audit");
    await waitForData(page);
    await expect(page.locator(".audit-cards")).toBeVisible();
    await expect(page.locator(".audit-table")).toBeHidden();
  });

  test("the policy sliders are usable and the saved policy is explained", async ({ page }) => {
    await nav(page, "/policies");
    await expect(page.getByLabel("Auto-send at or above")).toBeVisible();
    await expect(page.getByText("P-05")).toBeVisible();
    const box = (await page.getByLabel("Auto-send at or above").boundingBox())!;
    expect(box.width).toBeGreaterThan(200);
  });

  test("no screen scrolls sideways, and every field is at least 16px so iPhone does not zoom", async ({ page }) => {
    for (const href of ROUTES) {
      await page.goto(href);
      await waitForData(page);
      const o = await overflowsHorizontally(page);
      expect(o.over, `${href} is wider than the screen (${o.scrollWidth} > ${o.innerWidth})`).toBe(false);
      const small = await page.evaluate(() =>
        [...document.querySelectorAll("input:not([type=range]):not([type=checkbox]), textarea, select")]
          .filter((e) => (e as HTMLElement).offsetParent !== null)
          .map((e) => parseFloat(getComputedStyle(e).fontSize))
          .filter((n) => n < 16).length,
      );
      expect(small, `${href} has fields under 16px`).toBe(0);
    }
  });

  test("toasts appear above the tab bar", async ({ page }) => {
    await nav(page, "/demo");
    await page.getByRole("button", { name: "Praise" }).click();
    await page.getByRole("button", { name: "Post comment" }).click();
    const toast = page.locator(".toast").first();
    await expect(toast).toBeVisible();
    const t = (await toast.boundingBox())!;
    const bar = (await page.locator(".tabbar").boundingBox())!;
    expect(t.y + t.height).toBeLessThanOrEqual(bar.y + 1);
  });
});

test.describe("a judge on a phone", () => {
  test("can look and try, but settings, knowledge and access are read-only", async ({ page }) => {
    await resetDemoData();
    await signInAndWait(page, JUDGE);
    await expect(page.locator(".tabbar")).toBeVisible();
    await page.getByRole("button", { name: "More" }).click();
    await expect(page.locator(".more")).toContainText("Judge · view and try");
    await page.keyboard.press("Escape");
    await page.locator(".more-bg").click({ position: { x: 20, y: 20 } });

    await nav(page, "/access");
    await expect(page.getByText("You are signed in as a judge")).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve domain" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Invite" })).toHaveCount(0);

    await nav(page, "/policies");
    await expect(page.getByRole("button", { name: "Save changes" })).toHaveCount(0);
    await expect(page.getByLabel("Auto-send at or above")).toBeDisabled();

    await nav(page, "/knowledge");
    await expect(page.getByRole("button", { name: "Add document" })).toHaveCount(0);

    await nav(page, "/demo");
    await expect(page.getByRole("button", { name: /Reset sample data/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Fee question", exact: true }).click();
    await page.getByRole("button", { name: "Send as customer" }).click();
    await expect(page.getByText("Sent · watch the Inbox")).toBeVisible();
  });
});

test.describe("a judge on a phone, trying it live", () => {
  test.beforeEach(async ({ page }) => {
    await resetDemoData();
    await signInAndWait(page, JUDGE);
  });

  test("lands on Try it live, which is the first tab", async ({ page }) => {
    await expect(page).toHaveURL(/\/try/);
    await expect(page.locator(".tabbar .tb").first()).toContainText("Try it");
    await expect(page.getByText("Chat with HUGIN as a customer")).toBeVisible();
    await expect(page.getByRole("link", { name: "Open the bot" })).toHaveAttribute("href", /t\.me\/ravenwood_hugin_bot/);
    expect((await overflowsHorizontally(page)).over).toBe(false);
  });

  test("the web chat is a private conversation that the agent answers", async ({ page }) => {
    // start from a clean chat, so an earlier test's conversation does not get in the way
    if (await page.getByRole("button", { name: "Start over" }).isVisible()) {
      await page.getByRole("button", { name: "Start over" }).click();
      await expect(page.locator(".try-thread .bub")).toHaveCount(0);
    }
    await page.getByRole("button", { name: "Fee question", exact: true }).click();
    await expect(page.locator(".try-thread .bub.ai").last()).toContainText("$45", { timeout: 30_000 });
    await expect(page.locator(".try-thread .trace").last()).toContainText(/Rules only|Gemini/);
  });
});
