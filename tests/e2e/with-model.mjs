// with-model.mjs - checks the assistants with a real model, on the published sites
// (default) or the local build (--dev). The flow: the shop's assistant refuses
// under today's terms and loads the desk's public network (a peer on another
// origin) -> handoff -> the desk's outcome -> the desk's assistant loads the
// shop's representative (a peer) -> the customer accepts -> the shop confirms on
// its own site -> settled. Then the Coppice case, and the page's hint when the
// browser blocks a model server on this computer. A unique test key shows that
// the key goes to the model router and nowhere else.
//
// Usage: node tests/e2e/with-model.mjs [--dev] [--router URL] [--model NAME]
// Default router: LM Studio on http://127.0.0.1:1234/v1 (lms server start --cors).
// Model replies vary from run to run. The checks look for the facts that matter.
import { chromium } from "playwright";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const config = JSON.parse(await readFile(path.join(root, "config.json"), "utf8"))[args.includes("--dev") ? "dev" : "prod"];
const DESK = config.desk;
const BL = config.shops.brackenlight;
const DESK_HOST = new URL(DESK).host;
const SHOP_HOST = new URL(BL).host;
const MODEL = option("--model", "qwen/qwen3-30b-a3b-2507");
const ROUTER = option("--router", "http://127.0.0.1:1234/v1");
const KEY = `sk-local-check-${Math.random().toString(36).slice(2, 10)}`;
const shots = path.join(root, "tests/e2e/output/with-model/");
await mkdir(shots, { recursive: true });
const now = new Date().toISOString();
const store = { version: 1, selectedId: "p1", updatedAt: now, profiles: [{ id: "p1", name: "Local LLM", key: KEY, model: MODEL, router: ROUTER, runner: false, updatedAt: now }] };

const browser = await chromium.launch();
const results = [];
const note = (ok, label) => { results.push({ ok, label }); console.log(`${ok ? "ok  " : "FAIL"} ${label}`); };

async function makeContext({ grant = true, viewport = { width: 1360, height: 1000 } } = {}) {
  const context = await browser.newContext({ viewport });
  if (grant) {
    for (const origin of [new URL(DESK).origin, new URL(BL).origin]) {
      await context.grantPermissions(["local-network-access"], { origin });
    }
  }
  await context.addInitScript((s) => { try { localStorage.setItem("nsweb-byok-profiles-v1", s); } catch {} }, JSON.stringify(store));
  return context;
}

const leaks = [];
const errors = [];
function watch(page, tag) {
  page.on("pageerror", (e) => errors.push(`[${tag} pageerror] ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`[${tag}] ${m.text().slice(0, 200)}`); });
  page.on("request", (r) => {
    const url = r.url();
    if (url.startsWith(ROUTER)) return;
    const blob = `${url} ${JSON.stringify(r.headers())} ${r.postData() || ""}`;
    if (blob.includes(KEY)) leaks.push(`${r.method()} ${url}`);
    if (r.headers().authorization) leaks.push(`authorization header on ${url}`);
  });
  return page;
}

async function turn(page, text, { allow = true, confirm = true, timeout = 240000 } = {}) {
  const t0 = Date.now();
  const consents = [];
  await page.fill("#ns-input", text);
  await page.press("#ns-input", "Enter");
  await page.waitForFunction(() => document.querySelector(".ns-inputbar")?.dataset.turnActive === "true", null, { timeout: 15000, polling: 200 });
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const consent = await page.$(".ns-consent .ns-consent-actions button[data-d='allow']");
    if (consent) {
      const card = (await page.$eval(".ns-consent:last-of-type", (el) => el.innerText)).replace(/\s+/g, " ");
      consents.push(card);
      await consent.click();
      if (!allow) break;
    }
    if (await page.$("dialog.page-dialog[open]")) {
      const dialog = (await page.$eval("dialog.page-dialog[open]", (el) => el.innerText)).replace(/\s+/g, " ");
      consents.push(`dialog: ${dialog}`);
      await page.click(confirm ? "dialog.page-dialog[open] .btn.primary" : "dialog.page-dialog[open] .btn.quiet");
    }
    if (await page.$(".ns-linker form")) { consents.push("runtime asked for a link URL"); await page.click(".ns-linker button.ghost"); }
    if (await page.evaluate(() => document.querySelector(".ns-inputbar")?.dataset.turnActive === "false")) break;
    await page.waitForTimeout(300);
  }
  const bots = await page.$$eval("#ns-msgs .ns-msg.bot:not(.ns-consent):not(.ns-turn-status)", (els) => els.map((e) => e.innerText));
  const reply = bots[bots.length - 1] || "";
  console.log(`\n  USER: ${text}\n  (${((Date.now() - t0) / 1000).toFixed(1)} s)${consents.map((c) => `\n  consent: ${c.slice(0, 200)}`).join("")}\n  BOT: ${reply.slice(0, 600).replace(/\n+/g, " / ")}\n`);
  return { reply, consents, seconds: (Date.now() - t0) / 1000 };
}

// 1. The shop's assistant refuses under today's terms and hands over to the desk.
const context = await makeContext();
const shop = watch(await context.newPage(), "shop");
await shop.goto(`${BL}/`);
await shop.waitForFunction(() => !!window.__nsweb?.engine, null, { timeout: 30000 });
const s1 = await turn(shop, "Hi. Can I return the lamp from order BL-2207? My email is mina.park@example.com. I changed my mind. It is unused and still in its box.");
note(/version 3/i.test(s1.reply) && /not eligible|can't|cannot|unable|not able/i.test(s1.reply) && !/notified|case is (now )?open/i.test(s1.reply), "shop assistant reports today's terms (version 3) refusal and claims no desk action");
const s2 = await turn(shop, "I disagree. I bought it in early October, before your terms changed. What can I do?");
note(s2.consents.some((c) => c.includes(DESK_HOST)), `shop assistant asks before loading the desk's public network from ${DESK_HOST}`);
const handoff = await shop.$("#order-body .handoff a.btn.primary");
note(!!handoff, "handoff link to the desk is on the shop page");
await shop.screenshot({ path: `${shots}shop.png`, fullPage: true });
const shopCalls = await shop.evaluate(() => window.__nsweb.trace.events.filter((e) => e.kind === "model_call" && e.phase === "end").map((e) => `${e.origin} ${Math.round(e.durationMs)} ms tools=[${(e.toolCalls || []).join(",")}]`));
console.log("  shop model calls:\n    " + shopCalls.join("\n    "));

// 2. The desk recomputes under the pinned terms; the assistant asks the shop's representative.
const desk = watch(await context.newPage(), "desk");
await desk.goto(await handoff.getAttribute("href"));
await desk.waitForFunction(() => !!window.__nsweb?.engine, null, { timeout: 30000 });
await desk.click('[data-action="check-terms"]');
await desk.click('dialog.page-dialog button[value="allow"]');
await desk.waitForSelector(".verdict");
note(/Eligible[\s\S]*\$79\.00/.test(await desk.textContent(".verdict")), "desk outcome under version 2: eligible, $79.00");
const d1 = await turn(desk, "The shop said no. Why does the desk say yes?");
note(/version 2|120|v2/i.test(d1.reply), "desk assistant explains that version 2 applies");
const d2 = await turn(desk, "Does the shop have anything to add? Please ask them.");
note(d2.consents.some((c) => c.includes(SHOP_HOST)), `desk assistant asks before loading the shop's representative from ${SHOP_HOST}`);
note(/115|credit/i.test(d2.reply), "the representative's store credit offer reaches the customer");
const log = (await desk.$$eval("#contact-log li", (els) => els.map((e) => e.innerText.replace(/\s+/g, " ")))).join("\n    ");
console.log(`  Across sites panel:\n    ${log}`);
note(/Private fields passed: case_ref/.test(log), "Across sites panel: only case_ref passed to the shop's representative");
const d3 = await turn(desk, "I'll take the refund.");
note(d3.consents.some((c) => /^dialog:/.test(c)), "accepting asks for confirmation in the page");
await desk.waitForSelector('#agreement-body a.btn.primary[target="_blank"]', { timeout: 20000 }).catch(() => {});
const toShop = await desk.$('#agreement-body a.btn.primary[target="_blank"]');
note(!!toShop, "agreement link for the shop is on the desk page");
await desk.screenshot({ path: `${shots}desk.png`, fullPage: true });
const deskCalls = await desk.evaluate(() => window.__nsweb.trace.events.filter((e) => e.kind === "model_call" && e.phase === "end").map((e) => `${e.origin} ${Math.round(e.durationMs)} ms tools=[${(e.toolCalls || []).join(",")}]`));
console.log("  desk model calls:\n    " + deskCalls.join("\n    "));

// 3. The shop confirms on its own site.
if (toShop) {
  const office = watch(await context.newPage(), "backoffice");
  await office.goto(await toShop.getAttribute("href"));
  await office.waitForSelector("#bo-case .checks");
  const passed = await office.$$eval("#bo-case .checks li", (els) => els.map((e) => e.dataset.passed));
  note(passed.length > 0 && passed.every((p) => p === "yes"), `shop recomputes on its own site: ${passed.filter((p) => p === "yes").length}/${passed.length} checks pass`);
  await office.click("#bo-case .bo-actions .btn.primary");
  await office.click("dialog.page-dialog .btn.primary");
  const back = await office.getAttribute("#bo-case a.btn.primary", "href");
  await office.goto(back);
  await office.waitForSelector(".settled");
  note(/Confirmed by the shop/.test(await office.textContent(".settled")), "desk shows the case settled");
}

// 4. Coppice: the desk sides with the shop; the shop's goodwill credit.
const cc = watch(await context.newPage(), "coppice");
await cc.goto(`${DESK}/case.html#sample=coppice-CC-5531`);
await cc.waitForFunction(() => !!window.__nsweb?.engine, null, { timeout: 30000 });
await cc.click('[data-action="check-terms"]');
await cc.click('dialog.page-dialog button[value="allow"]');
await cc.waitForSelector(".verdict");
note(/Not eligible[\s\S]*4\.1/.test(await cc.textContent(".verdict")), "Coppice outcome: not eligible under clause 4.1");
const c1 = await turn(cc, "Can you ask the shop if they can do anything for me?");
note(/40|credit|workshop/i.test(c1.reply), "Coppice representative offers its published goodwill credit");
const c2 = await turn(cc, "I'll take the workshop credit.");
note(c2.consents.some((c) => /^dialog:/.test(c)), "accepting the credit asks for confirmation");

// 5. Without the local-network permission, the page explains what to do.
const blocked = await makeContext({ grant: false });
const bp = await blocked.newPage();
await bp.goto(`${DESK}/case.html#sample=brackenlight-BL-2207`);
await bp.waitForFunction(() => !!window.__nsweb?.engine, null, { timeout: 30000 });
await bp.fill("#ns-input", "Hello");
await bp.press("#ns-input", "Enter");
await bp.waitForFunction(() => /did not let this page reach/.test(document.querySelector("#assistant-status")?.textContent || ""), null, { timeout: 30000 }).catch(() => {});
const hint = await bp.textContent("#assistant-status");
note(/did not let this page reach the model server/.test(hint), `blocked local server: page hint shown ("${hint.slice(0, 90)}...")`);
await blocked.close();

note(leaks.length === 0, `the key went only to ${ROUTER}${leaks.length ? `; leaks: ${leaks.join("; ")}` : ""}`);
note(errors.length === 0, `no page errors${errors.length ? `: ${errors.slice(0, 5).join(" | ")}` : ""}`);
await browser.close();
const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
