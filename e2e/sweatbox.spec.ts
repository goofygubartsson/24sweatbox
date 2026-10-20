import { expect, test, type Page } from "@playwright/test";

async function devLogin(page: Page, as: "host" | "viewer") {
  await page.goto("/");
  await page.getByRole("button", { name: `Dev ${as}` }).click();
  await expect(page.getByText(as === "host" ? "Dev Host" : "Dev Viewer").first()).toBeVisible();
}

/** Type on the scope's command line (keys go to the window when nothing has focus). */
async function command(page: Page, line: string) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

async function createSweatbox(page: Page, apt: string, position: string, runway: string) {
  await page.getByLabel("Airport").selectOption(apt);
  await page.getByLabel("Position").selectOption(position);
  await page.getByLabel("Runway format").selectOption(runway);
  await page.getByRole("button", { name: "Create Sweatbox" }).click();
  await expect(page).toHaveURL(/\/s\/[A-Za-z]{6}$/);
  return page.url().split("/s/")[1]!;
}

test("the start page is just the name and a login button", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("ATC24Academy Sweatbox");
  await expect(page.getByRole("link", { name: "Log in with Discord" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Replay" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Maker" })).toHaveCount(0);
  await page.goto("/?login_error=not_in_guild");
  await expect(page.getByRole("alert")).toContainText("Join the ATC24Academy Discord first");
});

test("a trainer creates a generated sweatbox, controls an aircraft, loads another and ends it", async ({ page }) => {
  await devLogin(page, "host");
  await expect(page.getByRole("heading", { name: "Create Sweatbox" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Join Sweatbox" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Replay" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Maker" })).toBeVisible();

  const code = await createSweatbox(page, "IRFD", "APP", "25");
  await expect(page.locator(".bar__code")).toHaveText(code);
  await expect(page.locator(".bar")).toContainText("APP-IRFD-25");
  await expect(page.locator("canvas.scope-canvas")).toBeVisible();
  // the generated file's CMD lines ran on this client
  await expect(page.locator(".bar")).toContainText("IRFD_CTR");

  await page.locator(".barfield", { hasText: "Play" }).click();
  await expect(page.locator(".barfield", { hasText: "Pause" })).toBeVisible();

  // select the first aircraft and give it a level
  await page.locator(".barfield", { hasText: "ASEL" }).click();
  const first = page.locator(".listpop__item").first();
  await expect(first).toBeVisible();
  const cs = (await first.locator("span").first().innerText()).trim();
  await first.click();
  await page.locator(".barfield", { hasText: "CFL" }).click();
  await page.locator(".listpop__filter").fill("50");
  await page.locator(".listpop__filter").press("Enter");
  await expect(page.locator(".msgs")).toContainText(`HOST ALT ${cs} → 5000`);

  // an impossible approach gives the controller-facing reason
  await page.locator(".barfield", { hasText: "AHDG" }).click();
  await page.locator(".listpop__filter").fill("90");
  await page.locator(".listpop__filter").press("Enter");
  await page.locator(".barfield", { hasText: "APPR" }).click();
  await page.locator(".listpop__filter").fill("IRFD-25L");
  await page.locator(".listpop__filter").press("Enter");
  await expect(page.locator(".msgs")).toContainText("More than 40° off the IRFD-25L final course");

  // load another generated sweatbox from the session panel
  await page.locator(".barfield", { hasText: "Session" }).click();
  const panel = page.locator(".hostpanel");
  await panel.getByLabel("Position").selectOption("TWR");
  await panel.getByLabel("Runway format").selectOption("07");
  await panel.getByRole("button", { name: "Load sweatbox" }).click();
  await expect(page.locator(".bar")).toContainText("TWR-IRFD-07");

  // command line
  await command(page, "LDARPT IRFD GND");
  await expect(page.locator(".bar")).toContainText("IRFD_GND");
  await expect(page.getByText(/Departures IRFD/)).toBeVisible();

  // end the session
  await panel.getByRole("button", { name: "End session" }).click();
  await panel.getByRole("button", { name: "Click again to end the session" }).click();
  await expect(page.getByRole("dialog")).toContainText("Session ended");
  await expect(page.getByRole("dialog")).toContainText("TWR-IRFD-07");
});

test("a GND sweatbox at IRFD parks aircraft on stands and the trainer pushes one back", async ({ page }) => {
  await devLogin(page, "host");
  await createSweatbox(page, "IRFD", "GND", "25");
  await expect(page.locator(".bar")).toContainText("GND-IRFD-25");
  await expect(page.locator(".bar")).toContainText("IRFD_GND");
  await page.locator(".barfield", { hasText: "Play" }).click();
  await page.locator(".barfield", { hasText: "ASEL" }).click();
  await page.locator(".listpop__item").first().click();
  await expect(page.locator(".gndstatus")).toContainText("STAND");
  await page.locator(".barfield", { hasText: "PUSH" }).click();
  await page.getByRole("button", { name: /^Face \d{3} on / }).first().click();
  await expect(page.locator(".gndstatus")).toContainText("PUSHING");
});

test("a DEL sweatbox: a departure cleared in the C column leaves a minute later", async ({ page }) => {
  await devLogin(page, "host");
  await createSweatbox(page, "IRFD", "DEL", "25");
  await expect(page.locator(".bar")).toContainText("DEL-IRFD-25");
  await page.locator(".barfield", { hasText: "Play" }).click();
  // the departures list has the clearance / status column and no DEL column
  const deps = page.locator(".panel", { hasText: "Departures IRFD" });
  await expect(deps.locator("th", { hasText: /^C$/ })).toBeVisible();
  await expect(deps.locator("th", { hasText: /^DEL$/ })).toHaveCount(0);
  const first = deps.getByRole("button", { name: /^Clearance / }).first();
  const label = (await first.getAttribute("aria-label"))!;
  const cell = deps.getByRole("button", { name: label, exact: true });
  await expect(cell).toHaveText("");
  await cell.click();
  // just a tick; it stays on its stand and leaves the list a minute later
  await expect(cell).toHaveText("✓");
  await expect(cell).toHaveAttribute("title", /^CLR:/);
  await command(page, "SBSPEED 15");
  await expect(cell).toHaveCount(0, { timeout: 30_000 });
});

test("trainees can join with a code but get no trainer tools", async ({ browser }) => {
  const host = await browser.newPage();
  await devLogin(host, "host");
  const code = await createSweatbox(host, "IPPH", "APP", "29");

  const ctx = await browser.newContext();
  const viewer = await ctx.newPage();
  await devLogin(viewer, "viewer");
  await expect(viewer.getByRole("heading", { name: "Create Sweatbox" })).toHaveCount(0);
  await expect(viewer.getByRole("link", { name: "Replay" })).toBeVisible();
  await expect(viewer.getByRole("link", { name: "Maker" })).toHaveCount(0);
  await viewer.getByLabel("Session code").fill(code);
  await viewer.getByRole("button", { name: "Join Sweatbox" }).click();
  await expect(viewer).toHaveURL(new RegExp(`/s/${code}$`));
  await expect(viewer.locator(".bar__code")).toHaveText(code);
  await expect(viewer.locator(".barfield", { hasText: "Session" })).toHaveCount(0);
  await command(viewer, "SBPLAY");
  await expect(viewer.locator(".msgs")).toContainText("SBPLAY is for hosts only");
  await viewer.goto("/maker");
  await expect(viewer.getByText("The Maker is only available to trainers.")).toBeVisible();
  await ctx.close();
});

test("the maker generates traffic that is ready to load", async ({ page }) => {
  await devLogin(page, "host");
  await page.getByRole("link", { name: "Maker" }).click();
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByLabel("Airport").selectOption("IRFD");
  await page.getByLabel("Position").selectOption("APP");
  await page.getByRole("button", { name: "Generate traffic" }).click();
  await expect(page.locator(".maker__toolbar")).toContainText("APP-IRFD-");
  await expect(page.locator(".maker__toolbar")).toContainText("ready");
  await expect(page.locator(".maker__table tbody tr").first()).toContainText(":");
});
