// screenshots.mjs - takes the submission screenshots on the published sites:
// desktop at 1440 x 900 and phone at 390 x 844 (2x). The assistant screenshots
// use an OpenAI-compatible model server (LM Studio by default).
//
// Usage: node tools/video/screenshots.mjs <outDir> [--model M] [--router URL] [--key K] [--no-model]
import { chromium } from "playwright";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const config = JSON.parse(await readFile(path.join(repo, "config.json"), "utf8")).prod;
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const outDir = path.resolve(args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--")) || "screenshots");
const MODEL = option("--model", "qwen/qwen3-30b-a3b-2507");
const ROUTER = option("--router", "http://127.0.0.1:1234/v1");
const KEY = option("--key", "lm-studio");
const withModel = !args.includes("--no-model");
const DESK = config.desk;
const BL = config.shops.brackenlight;
await mkdir(path.join(outDir, "desktop"), { recursive: true });
await mkdir(path.join(outDir, "mobile"), { recursive: true });

const browser = await chromium.launch();
async function makeContext(viewport, extra = {}) {
  const context = await browser.newContext({ viewport, reducedMotion: "reduce", ...extra });
  for (const site of [DESK, config.shops_root]) await context.grantPermissions(["local-network-access"], { origin: new URL(site).origin });
  if (withModel) {
    const now = new Date().toISOString();
    const store = { version: 1, selectedId: "p1", updatedAt: now, profiles: [{ id: "p1", name: "Local model (LM Studio)", key: KEY, model: MODEL, router: ROUTER, runner: false, updatedAt: now }] };
    await context.addInitScript((s) => { try { localStorage.setItem("nsweb-byok-profiles-v1", s); } catch { /* storage off */ } }, JSON.stringify(store));
  }
  return context;
}
const shot = async (page, file, { full = false } = {}) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(outDir, file), fullPage: full });
  console.log(file);
};
const scrollTo = async (page, selector, block = "start") => {
  await page.evaluate(([s, b]) => document.querySelector(s)?.scrollIntoView({ block: b }), [selector, block]);
  await page.waitForTimeout(300);
};
async function turn(page, text) {
  await page.fill("#ns-input", text);
  await page.press("#ns-input", "Enter");
  await page.waitForFunction(() => document.querySelector(".ns-inputbar")?.dataset.turnActive === "true", null, { timeout: 15000 });
  for (;;) {
    const consent = page.locator(".ns-consent .ns-consent-actions button[data-d='allow']");
    if (await consent.count()) await consent.first().click();
    if (await page.locator("dialog.page-dialog[open]").count()) await page.click("dialog.page-dialog[open] .btn.primary");
    if (await page.evaluate(() => document.querySelector(".ns-inputbar")?.dataset.turnActive === "false")) break;
    await page.waitForTimeout(200);
  }
}
async function openSample(page, sample) {
  await page.goto(`${DESK}/case.html#sample=${sample}`);
  await page.click('[data-action="check-terms"]');
  await page.waitForSelector("dialog.page-dialog[open]");
}

// ------------------------------------------------------------- desktop
{
  const context = await makeContext({ width: 1440, height: 900 });
  const page = await context.newPage();
  await page.goto(`${DESK}/`);
  await shot(page, "desktop/01-desk-landing.png");

  await page.goto(`${BL}/#orders`);
  await page.click("[data-fill-sample]");
  await page.waitForSelector("#return-form");
  await page.check('#return-form input[name="unused"][value="yes"]');
  await page.check('#return-form input[name="original_packaging"][value="yes"]');
  await page.click('#return-form button[type="submit"]');
  await page.waitForSelector(".handoff");
  await scrollTo(page, "#order-body .decision", "center");
  await shot(page, "desktop/02-shop-own-check-refuses-under-todays-terms.png");

  if (withModel) {
    await page.goto(`${BL}/`);
    await scrollTo(page, "#assistant");
    await page.waitForFunction(() => !!window.__nsweb?.engine, null, { timeout: 30000 });
    await page.click("#agent-app .ns-settings > summary");
    await scrollTo(page, "#agent-app .ns-settings-body", "center");
    await shot(page, "desktop/03-model-settings-bring-your-own-key.png");
    await page.click("#agent-app .ns-settings > summary");
    await turn(page, "Hi. Can I return the lamp from order BL-2207? My email is mina.park@example.com. I changed my mind. It is unused and still in its box.");
    await turn(page, "I disagree. I bought it in early October, before your terms changed. What can I do?");
    await scrollTo(page, "#agent-app", "start");
    await shot(page, "desktop/04-shop-assistant-calls-the-desk-network.png");
  }

  await openSample(page, "brackenlight-BL-2207");
  await shot(page, "desktop/05-desk-asks-before-contacting-the-shop.png");
  await page.click('dialog.page-dialog[open] button[value="allow"]');
  await page.waitForSelector(".verdict");
  await page.waitForTimeout(1600);
  await scrollTo(page, "#step-outcome");
  await shot(page, "desktop/06-outcome-under-the-pinned-terms.png");
  if (withModel) {
    await turn(page, "Does the shop have anything to add? Please ask them.");
    await page.evaluate(() => document.querySelector(".across")?.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(300);
    await shot(page, "desktop/07-shop-representative-runs-in-the-browser.png");
  }
  await scrollTo(page, "#step-outcome");
  await page.click('.choices button[data-option="outcome"]');
  await page.waitForSelector("dialog.page-dialog[open]");
  await shot(page, "desktop/08-the-page-confirms-the-choice.png");
  await page.click("dialog.page-dialog[open] .btn.primary");
  await scrollTo(page, "#step-agreement");
  await shot(page, "desktop/09-agreement-link-for-the-shop.png");
  const link = await page.getAttribute('#agreement-body a.btn.primary[target="_blank"]', "href");
  await page.goto(link);
  await page.waitForSelector("#bo-case .checks");
  await page.waitForTimeout(1600);
  await shot(page, "desktop/10-shop-recomputes-on-its-own-site.png");
  await page.click("#bo-case .bo-actions .btn.primary");
  await page.click("dialog.page-dialog .btn.primary");
  const back = await page.getAttribute("#bo-case a.btn.primary", "href");
  await page.goto(back);
  await page.waitForSelector(".settled");
  await scrollTo(page, "#step-agreement");
  await shot(page, "desktop/11-settled.png");
  await page.goto(`${DESK}/verify.html${new URL(back).hash}`);
  await page.waitForSelector("#verify-result .btn.primary");
  await page.click("#verify-result .btn.primary");
  await page.click('dialog.page-dialog button[value="allow"]');
  await page.waitForSelector("#verify-result .fingerprint");
  await scrollTo(page, "#verify-result");
  await shot(page, "desktop/12-anyone-can-verify-a-case-file.png");

  await openSample(page, "coppice-CC-5531");
  await page.click('dialog.page-dialog[open] button[value="allow"]');
  await page.waitForSelector(".verdict");
  await page.waitForTimeout(1600);
  await scrollTo(page, "#step-outcome");
  await shot(page, "desktop/13-desk-sides-with-the-shop-made-to-order.png");

  await page.goto(`${DESK}/protocol.html`);
  await shot(page, "desktop/14-protocol-for-shops-and-agents.png");
  await context.close();
}

// --------------------------------------------------------------- phone
{
  const context = await makeContext({ width: 390, height: 844 }, { deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.goto(`${DESK}/`);
  await shot(page, "mobile/01-desk-landing.png");
  await page.goto(`${BL}/#orders`);
  await page.tap("[data-fill-sample]");
  await page.waitForSelector("#return-form");
  await page.check('#return-form input[name="unused"][value="yes"]');
  await page.check('#return-form input[name="original_packaging"][value="yes"]');
  await page.tap('#return-form button[type="submit"]');
  await page.waitForSelector(".handoff");
  await scrollTo(page, "#order-body .decision", "start");
  await shot(page, "mobile/02-shop-refuses-and-offers-the-desk.png");
  const handoff = await page.getAttribute(".handoff a.btn.primary", "href");
  await page.goto(handoff);
  await page.tap('[data-action="check-terms"]');
  await page.tap('dialog.page-dialog button[value="allow"]');
  await page.waitForSelector(".verdict");
  await page.waitForTimeout(1600);
  await scrollTo(page, "#step-outcome");
  await shot(page, "mobile/03-outcome-under-the-pinned-terms.png");
  await page.tap('.choices button[data-option="outcome"]');
  await page.tap("dialog.page-dialog .btn.primary");
  const link = await page.getAttribute('#agreement-body a.btn.primary[target="_blank"]', "href");
  await page.goto(link);
  await page.waitForSelector("#bo-case .checks");
  await page.waitForTimeout(1600);
  await scrollTo(page, "#bo-case .fingerprint", "center");
  await shot(page, "mobile/04-shop-recomputes-the-same-fingerprint.png");
  await page.tap("#bo-case .bo-actions .btn.primary");
  await page.tap("dialog.page-dialog .btn.primary");
  const back = await page.getAttribute("#bo-case a.btn.primary", "href");
  await page.goto(back);
  await page.waitForSelector(".settled");
  await scrollTo(page, ".settled", "center");
  await shot(page, "mobile/05-settled.png");
  if (withModel) {
    await page.goto(`${DESK}/case.html#sample=brackenlight-BL-2207`);
    await page.tap('[data-action="check-terms"]');
    await page.tap('dialog.page-dialog button[value="allow"]');
    await page.waitForSelector(".verdict");
    await page.waitForFunction(() => !!window.__nsweb?.engine, null, { timeout: 30000 });
    await turn(page, "The shop said no. Why does the desk say yes?");
    await scrollTo(page, "#ns-msgs .ns-msg.bot:last-of-type", "center");
    await shot(page, "mobile/06-case-assistant-explains.png");
  }
  await context.close();
}
await browser.close();
