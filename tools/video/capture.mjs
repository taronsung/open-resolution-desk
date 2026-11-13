// capture.mjs - records the silent demo walk-through on the published sites, for
// the submission video. The entrant records the narration separately.
//
// It opens the live desk and the live Brackenlight shop, uses an
// OpenAI-compatible model server for the assistants (LM Studio by default), and
// writes the raw video plus a timeline of marks and page addresses for the edit
// (tools/video/edit.mjs).
//
// Usage:
//   node tools/video/capture.mjs <outDir> [--model qwen/qwen3-30b-a3b-2507]
//        [--router http://127.0.0.1:1234/v1] [--key lm-studio]
// LM Studio: lms server start --port 1234 --cors, then load the model.
import { chromium } from "playwright";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const config = JSON.parse(await readFile(path.join(repo, "config.json"), "utf8")).prod;
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const outDir = path.resolve(args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--")) || "video-out");
const MODEL = option("--model", "qwen/qwen3-30b-a3b-2507");
const ROUTER = option("--router", "http://127.0.0.1:1234/v1");
const KEY = option("--key", "lm-studio");
// 1280 x 680 pixels, recorded 1:1. The edit scales it to 1920 x 1020 and adds a
// 60-pixel address strip. (Playwright records CSS pixels: a higher device scale
// factor does not make the frames sharper.)
const W = 1280, H = 680;
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: W, height: H },
  recordVideo: { dir: outDir, size: { width: W, height: H } },
});
// A public https page may reach a model server on this computer only with the
// visitor's permission ("apps and services on this device" in Chrome).
for (const site of [config.desk, config.shops_root]) {
  await context.grantPermissions(["local-network-access"], { origin: new URL(site).origin });
}
const now = new Date().toISOString();
const store = { version: 1, selectedId: "p1", updatedAt: now, profiles: [{ id: "p1", name: "Local model (LM Studio)", key: KEY, model: MODEL, router: ROUTER, runner: false, updatedAt: now }] };
await context.addInitScript((s) => {
  try { localStorage.setItem("nsweb-byok-profiles-v1", s); localStorage.setItem("nsweb-dev", "0"); } catch { /* storage off */ }
  // A visible pointer for the recording only: the video has no system cursor.
  addEventListener("DOMContentLoaded", () => {
    const dot = document.createElement("div");
    dot.id = "__pointer";
    dot.setAttribute("aria-hidden", "true");
    dot.style.cssText = "position:fixed;left:0;top:0;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(52,66,160,.25);border:2px solid rgba(52,66,160,.9);z-index:2147483647;pointer-events:none;transition:transform .12s ease;transform:translate(-100px,-100px)";
    document.documentElement.append(dot);
    let x = -100, y = -100;
    addEventListener("mousemove", (e) => { x = e.clientX; y = e.clientY; dot.style.transform = `translate(${x}px,${y}px)`; }, true);
    addEventListener("mousedown", () => { dot.style.transform = `translate(${x}px,${y}px) scale(.7)`; }, true);
    addEventListener("mouseup", () => { dot.style.transform = `translate(${x}px,${y}px)`; }, true);
  });
}, JSON.stringify(store));

const page = await context.newPage();
const t0 = Date.now();
const marks = [];
const addresses = [];
const replies = [];
const at = () => (Date.now() - t0) / 1000;
const mark = (label) => { marks.push({ t: at(), label }); console.log(`${at().toFixed(1).padStart(6)}  ${label}`); };
page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) addresses.push({ t: at(), url: frame.url() }); });
page.on("pageerror", (e) => console.log(`  page error: ${e.message}`));
const pause = (ms) => page.waitForTimeout(ms);

async function moveTo(locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 20 });
  await pause(250);
}
async function click(selector) {
  const locator = page.locator(selector).first();
  await moveTo(locator);
  await locator.click();
}
async function scrollTo(selector, block = "start") {
  await page.evaluate(([s, b]) => document.querySelector(s)?.scrollIntoView({ behavior: "smooth", block: b }), [selector, block]);
  await pause(900);
}
async function say(text, label) {
  mark(`${label}:type`);
  await click("#ns-input");
  await page.type("#ns-input", text, { delay: 24 });
  await pause(250);
  await page.press("#ns-input", "Enter");
  mark(`${label}:sent`);
  await page.waitForFunction(() => document.querySelector(".ns-inputbar")?.dataset.turnActive === "true", null, { timeout: 15000, polling: 100 });
}
async function waitTurn(label, { onDialog = null } = {}) {
  for (;;) {
    const consent = page.locator(".ns-consent .ns-consent-actions button[data-d='allow']");
    if (await consent.count()) {
      mark(`${label}:consent`);
      await pause(2200);
      await moveTo(consent.first());
      await consent.first().click();
      mark(`${label}:allowed`);
    }
    if (onDialog && await page.locator("dialog.page-dialog[open]").count()) {
      mark(`${label}:dialog`);
      await pause(2600);
      await click("dialog.page-dialog[open] .btn.primary");
      mark(`${label}:confirmed`);
      onDialog = null;
    }
    if (await page.evaluate(() => document.querySelector(".ns-inputbar")?.dataset.turnActive === "false")) break;
    await pause(150);
  }
  const bots = await page.$$eval("#ns-msgs .ns-msg.bot:not(.ns-consent):not(.ns-turn-status)", (els) => els.map((e) => e.innerText));
  replies.push({ label, text: bots[bots.length - 1] || "" });
  mark(`${label}:done`);
}

// 1. The desk's front page.
mark("desk:landing");
await page.goto(`${config.desk}/`);
await page.waitForSelector("html[data-ready], main", { timeout: 15000 });
await pause(4000);
await page.mouse.wheel(0, 380);
await pause(2000);

// 2. The shop, its own assistant, and the visitor's model settings.
mark("shop:open");
await page.goto(`${config.shops.brackenlight}/`);
await pause(2500);
await scrollTo("#assistant");
await page.waitForFunction(() => !!window.__nsweb?.engine, null, { timeout: 30000 });
mark("shop:settings");
await click("#agent-app .ns-settings > summary");
await page.evaluate(() => document.querySelector("#agent-app .ns-settings-body")?.scrollIntoView({ behavior: "smooth", block: "center" }));
await pause(3200);
await click("#agent-app .ns-settings > summary");
await scrollTo("#assistant");
await pause(300);
await say("Hi. Can I return the lamp from order BL-2207? My email is mina.park@example.com. I changed my mind. It is unused and still in its box.", "shop1");
await waitTurn("shop1");
await pause(3200);
await say("I disagree. I bought it in early October, before your terms changed. What can I do?", "shop2");
await waitTurn("shop2");
await pause(3200);
mark("shop:handoff");
await scrollTo("#order-body .handoff", "center");
const handoff = page.locator("#order-body .handoff a.btn.primary");
await moveTo(handoff);
const handoffHref = await handoff.getAttribute("href");
await pause(1200);

// 3. The desk reads the pinned terms from the shop's site and computes the outcome.
mark("desk:case");
await page.goto(handoffHref);
await page.waitForFunction(() => !!window.__nsweb?.engine, null, { timeout: 30000 });
await pause(3500);
mark("desk:check-terms");
await click('[data-action="check-terms"]');
await page.waitForSelector("dialog.page-dialog[open]");
mark("desk:consent-dialog");
await pause(2800);
await click('dialog.page-dialog[open] button[value="allow"]');
await page.waitForSelector(".verdict");
mark("desk:outcome");
await scrollTo("#step-outcome", "start");
await pause(4200);
await scrollTo("#step-terms .terms-status", "center");
mark("desk:terms-status");
await pause(3000);
await scrollTo("#step-outcome", "start");
await pause(1000);

// 4. A clause question: the case assistant hands it to the terms analyst, the
// second agent in the desk's network. The runtime's developer view shows the graph.
await say("What does clause 2.1 of my terms say?", "desk0");
await waitTurn("desk0");
await pause(3000);
mark("desk:graph");
await click("#agent-app button:has-text('Developer')");
await page.evaluate(() => document.querySelector('[data-ns-slot="agents"]')?.scrollIntoView({ behavior: "smooth", block: "start" }));
await pause(4200);
await click("#agent-app button:has-text('Developer')");
await pause(400);

// 5. The shop's representative network, loaded by URL, runs in this browser.
await say("Does the shop have anything to add? Please ask them.", "desk1");
await waitTurn("desk1");
await pause(3200);
mark("desk:across");
await page.evaluate(() => document.querySelector(".across")?.scrollIntoView({ behavior: "smooth", block: "center" }));
await pause(4500);

// 6. The customer chooses, and the page asks to confirm.
await page.evaluate(() => document.querySelector("#ns-input")?.scrollIntoView({ behavior: "smooth", block: "center" }));
await pause(700);
await say("I'll take the refund.", "desk2");
await waitTurn("desk2", { onDialog: true });
await pause(2000);
mark("desk:agreement");
await scrollTo("#step-agreement", "start");
await pause(2800);
const shopLink = page.locator('#agreement-body a.btn.primary[target="_blank"]');
await moveTo(shopLink);
const shopHref = await shopLink.getAttribute("href");
await pause(800);

// 7. The shop checks the case on its own site and confirms.
mark("office:open");
await page.goto(shopHref);
await page.waitForSelector("#bo-case .checks");
await pause(4600);
mark("office:confirm");
await click("#bo-case .bo-actions .btn.primary");
await page.waitForSelector("dialog.page-dialog[open]");
await pause(2200);
await click("dialog.page-dialog[open] .btn.primary");
await page.waitForSelector("#bo-case a.btn.primary");
mark("office:confirmed");
await pause(2600);
const back = await page.getAttribute("#bo-case a.btn.primary", "href");
await moveTo(page.locator("#bo-case a.btn.primary"));
await pause(500);

// 8. Back at the desk: settled.
mark("desk:settled");
await page.goto(back);
await page.waitForSelector(".settled");
await scrollTo("#step-agreement", "start");
await pause(4800);
mark("end");

const raw = await page.video().path();
await context.close();
await browser.close();
const video = path.join(outDir, "raw.webm");
await rename(raw, video);
await writeFile(path.join(outDir, "timeline.json"), JSON.stringify({ video, frame: { width: W, height: H }, model: MODEL, recorded_at: now, marks, addresses, replies }, null, 2));
console.log(`video: ${video}`);
