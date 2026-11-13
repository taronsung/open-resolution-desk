// End-to-end checks in a real browser, without a language model. Walks a case
// from the sample to the shop's confirmation, then the error states, the verify
// page and a phone-width run.
// Usage:
//   npm run test:e2e        builds the dev sites and serves them on two local
//                           origins like GitHub Pages (needs Python 3)
//   npm run test:e2e:prod   runs the same checks against the published sites
//                           named in config.json (prod), without building
// Both need Playwright's Chromium.
import { spawn, execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const target = process.argv.includes("--prod") ? "prod" : "dev";
const config = JSON.parse(await readFile(path.join(root, "config.json"), "utf8"))[target];
const DESK = config.desk;
const BRACKENLIGHT = config.shops.brackenlight;
const SHOPS_ORIGIN = new URL(config.shops_root).origin;
const out = path.join(root, "tests/e2e/output", target);
await mkdir(out, { recursive: true });
const servers = [];
if (target === "dev") {
  execFileSync("node", ["tools/build_sites.mjs", "dev"], { cwd: root, stdio: "inherit" });
  servers.push(
    spawn("python3", ["tools/serve.py", "dist/dev/desk", "8090", "--prefix", "/open-resolution-desk"], { cwd: root, stdio: "ignore" }),
    spawn("python3", ["tools/serve.py", "dist/dev/shops", "8091"], { cwd: root, stdio: "ignore" }),
  );
}
for (let i = 0; i < 40; i++) {
  try { if ((await fetch(`${DESK}/case.html`)).ok && (await fetch(`${BRACKENLIGHT}/`)).ok) break; } catch { /* starting */ }
  await new Promise((r) => setTimeout(r, 250));
}
console.log(`Target: ${target} (desk ${DESK}, shops ${config.shops_root})`);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const pageErrors = [];
const watch = (p) => { p.on("pageerror", (e) => pageErrors.push(e.message)); p.on("console", (m) => { if (m.type() === "error") pageErrors.push(m.text()); }); return p; };
let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok   ${name}`); } catch (error) { failures += 1; console.log(`FAIL ${name}\n     ${error.message.split("\n")[0]}`); }
}

await check("sample case settles across two origins", async () => {
  const page = watch(await context.newPage());
  await page.goto(`${DESK}/case.html#sample=brackenlight-BL-2207`);
  await page.click('[data-action="check-terms"]');
  await page.click('dialog.page-dialog button[value="allow"]');
  await page.waitForSelector(".verdict");
  assert.match(await page.textContent(".terms-status"), /Version 2 checked/);
  assert.match(await page.textContent(".verdict"), /Eligible.*\$79\.00/);
  const deskFingerprint = await page.getAttribute("#outcome-body .hash", "title");
  await page.click('.choices button[data-option="outcome"]');
  await page.click("dialog.page-dialog .btn.primary");
  const link = await page.getAttribute('a.btn.primary[target="_blank"]', "href");
  assert.ok(link.startsWith(`${BRACKENLIGHT}/backoffice.html#case=`), link);
  await page.goto(link);
  await page.waitForSelector("#bo-case .checks");
  const passed = await page.$$eval("#bo-case .checks li", (els) => els.map((e) => e.dataset.passed));
  assert.deepEqual(passed, Array(7).fill("yes"));
  assert.equal(await page.getAttribute("#bo-case .hash", "title"), deskFingerprint);
  await page.click("#bo-case .bo-actions .btn.primary");
  await page.click("dialog.page-dialog .btn.primary");
  const back = await page.getAttribute("#bo-case a.btn.primary", "href");
  await page.goto(back);
  await page.waitForSelector(".settled");
  assert.match(await page.textContent(".settled"), /Confirmed by the shop/);
  await page.screenshot({ path: path.join(out, "settled.png"), fullPage: true });
  await page.close();
});

await check("the sample case gives the fingerprint shown on the front page, on any day", async () => {
  const page = watch(await context.newPage());
  await page.goto(`${DESK}/`);
  const shown = await page.getAttribute(".copy.customer [data-fp]", "data-fp");
  // Run the sample as if it were judging week: its filing date is fixed, so the outcome is too.
  await page.addInitScript(() => {
    const fixed = new Date("2027-01-15T12:00:00Z").getTime();
    const RealDate = Date;
    globalThis.Date = class extends RealDate {
      constructor(...a) { super(...(a.length ? a : [fixed])); }
      static now() { return fixed; }
    };
  });
  await page.goto(`${DESK}/case.html#sample=brackenlight-BL-2207`);
  await page.click('[data-action="check-terms"]');
  await page.click('dialog.page-dialog button[value="allow"]');
  await page.waitForSelector(".verdict");
  assert.match(await page.textContent(".verdict"), /Eligible.*\$79\.00/);
  assert.equal(await page.getAttribute("#outcome-body .hash", "title"), shown);
  await page.close();
});

await check("the verify page recomputes a settled case", async () => {
  const page = watch(await context.newPage());
  await page.goto(`${DESK}/case.html#sample=coppice-CC-5531`);
  await page.click('[data-action="check-terms"]');
  await page.click('dialog.page-dialog button[value="allow"]');
  await page.waitForSelector(".verdict");
  assert.match(await page.textContent(".verdict"), /Not eligible.*clause 4\.1/);
  await page.click('.choices button[data-option="workshop-credit-40"]');
  await page.click("dialog.page-dialog .btn.primary");
  const link = await page.getAttribute('a.btn.primary[target="_blank"]', "href");
  await page.goto(link);
  await page.waitForSelector("#bo-case .checks");
  await page.click("#bo-case .bo-actions .btn.primary");
  await page.click("dialog.page-dialog .btn.primary");
  const back = await page.getAttribute("#bo-case a.btn.primary", "href");
  await page.goto(`${DESK}/verify.html${new URL(back).hash}`);
  await page.waitForSelector("#verify-result .btn.primary");
  await page.click("#verify-result .btn.primary");
  await page.click('dialog.page-dialog button[value="allow"]');
  await page.waitForSelector("#verify-result .fingerprint");
  const text = await page.textContent("#verify-result");
  assert.match(text, /Recomputed fingerprint equals the recorded one/);
  assert.match(text, /The shop confirmed the same fingerprint/);
  assert.equal(await page.$$eval("#verify-result .checks li[data-passed='no']", (els) => els.length), 0);
  await page.close();
});

await check("a declined contact sends nothing and says so", async () => {
  const page = watch(await context.newPage());
  const requests = [];
  page.on("request", (r) => { if (r.url().startsWith(SHOPS_ORIGIN)) requests.push(r.url()); });
  await page.goto(`${DESK}/case.html#sample=brackenlight-BL-2207`);
  await page.click('[data-action="check-terms"]');
  await page.click('dialog.page-dialog button[value="decline"]');
  await page.waitForSelector("#case-flash:not([hidden])");
  assert.match(await page.textContent("#case-flash"), /declined/);
  assert.equal(requests.length, 0);
  await page.close();
});

await check("a receipt whose pinned hash does not match stops the case", async () => {
  const page = watch(await context.newPage());
  const sample = await (await fetch(`${DESK}/samples/brackenlight-BL-2207.json`)).json();
  await page.goto(`${DESK}/case.html`);
  await page.setInputFiles("#receipt-file", { name: "receipt.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ ...sample.receipt, terms: { ...sample.receipt.terms, sha256: `sha256:${"0".repeat(64)}` } })) });
  await page.click('[data-action="check-terms"]');
  await page.click('dialog.page-dialog button[value="allow"]');
  await page.waitForSelector(".terms-status[data-kind='error']");
  assert.match(await page.textContent(".terms-status"), /does not match the hash on your receipt/);
  assert.equal(await page.$("#claim-form"), null);
  await page.close();
});

await check("an edited case file is refused at the shop", async () => {
  const page = watch(await context.newPage());
  await page.goto(`${DESK}/case.html#sample=brackenlight-BL-2207`);
  await page.click('[data-action="check-terms"]');
  await page.click('dialog.page-dialog button[value="allow"]');
  await page.click('.choices button[data-option="outcome"]');
  await page.click("dialog.page-dialog .btn.primary");
  const link = await page.getAttribute('a.btn.primary[target="_blank"]', "href");
  const edited = await page.evaluate(async (href) => {
    const { unpackFromLink, packForLink } = await import("./protocol/v1/case.js");
    const file = await unpackFromLink(new URLSearchParams(new URL(href).hash.slice(1)).get("case"));
    file.events.find((e) => e.type === "accepted").data.value_cents = 99900;
    return `${href.split("#")[0]}#case=${await packForLink(file)}`;
  }, link);
  await page.goto(edited);
  await page.waitForSelector("#bo-case .checks");
  const failed = await page.$$eval("#bo-case .checks li[data-passed='no'] .check-label", (els) => els.map((e) => e.textContent));
  assert.ok(failed.includes("Each step in the case file links to the one before"));
  assert.equal(await page.$("#bo-case .bo-actions .btn.primary"), null);
  await page.close();
});

await check("a damaged link explains itself", async () => {
  const page = watch(await context.newPage());
  await page.goto(`${DESK}/case.html#handoff=not-a-real-link`);
  await page.waitForSelector("#case-flash:not([hidden])");
  assert.match(await page.textContent("#case-flash"), /damaged or incomplete/);
  await page.close();
});

await check("the shop's own returns form refuses under today's terms and offers the desk", async () => {
  const page = watch(await context.newPage());
  await page.goto(`${BRACKENLIGHT}/#orders`);
  await page.click("[data-fill-sample]");
  await page.waitForSelector("#return-form");
  await page.check('#return-form input[name="unused"][value="yes"]');
  await page.check('#return-form input[name="original_packaging"][value="yes"]');
  await page.click('#return-form button[type="submit"]');
  await page.waitForSelector(".decision");
  assert.match(await page.textContent(".decision"), /version 3/);
  const href = await page.getAttribute(".handoff a.btn.primary", "href");
  assert.match(href, /open-resolution-desk\/case\.html#handoff=/);
  await page.goto(href);
  await page.click('[data-action="check-terms"]');
  await page.click('dialog.page-dialog button[value="allow"]');
  await page.waitForSelector(".verdict");
  assert.match(await page.textContent(".verdict"), /Eligible/);
  await page.close();
});

await check("the agent runtime boots each published network without a key", async () => {
  const pages = [[`${DESK}/case.html`, "desk_clerk"], [`${BRACKENLIGHT}/`, "brackenlight_assistant"], [`${config.shops.coppice}/`, "coppice_assistant"]];
  for (const [url, network] of pages) {
    const page = watch(await context.newPage());
    await page.goto(url);
    await page.waitForFunction(() => !!window.__nsweb?.engine?.top?.network, null, { timeout: 30000 });
    const name = await page.evaluate(() => window.__nsweb.engine.top.network.name);
    assert.equal(name, network, url);
    assert.ok(await page.$("#ns-input"), `no chat input on ${url}`);
    await page.close();
  }
});

await check("browsers with WebMCP get the desk's and the shop's operations as tools", async () => {
  const page = watch(await context.newPage());
  await page.addInitScript(() => {
    window.__tools = [];
    document.modelContext = { registerTool: async (tool) => { window.__tools.push(tool); } };
  });
  await page.goto(`${DESK}/case.html#sample=brackenlight-BL-2207`);
  await page.waitForFunction(() => window.__tools.length >= 5, null, { timeout: 15000 });
  assert.deepEqual(await page.evaluate(() => window.__tools.map((t) => t.name)), ["ord_get_case", "ord_check_terms", "ord_file_claim", "ord_accept_option", "ord_request_review"]);
  const state = JSON.parse(await page.evaluate(() => window.__tools.find((t) => t.name === "ord_get_case").execute({})));
  assert.equal(state.order?.id, "BL-2207");
  await page.goto(`${BRACKENLIGHT}/`);
  await page.waitForFunction(() => window.__tools.length >= 4, null, { timeout: 15000 });
  assert.deepEqual(await page.evaluate(() => window.__tools.map((t) => t.name)), ["shop_get_info", "shop_look_up_order", "shop_start_return", "shop_prepare_desk_handoff"]);
  const order = JSON.parse(await page.evaluate(() => window.__tools.find((t) => t.name === "shop_look_up_order").execute({ order_id: "BL-2207", email: "mina.park@example.com" })));
  assert.equal(order.ok, true);
  await page.close();
});

await check("on a short laptop screen nothing covers the chat input", async () => {
  const short = await browser.newContext({ viewport: { width: 1280, height: 680 } });
  for (const url of [`${DESK}/case.html#sample=brackenlight-BL-2207`, `${BRACKENLIGHT}/`]) {
    const page = watch(await short.newPage());
    await page.goto(url);
    await page.waitForFunction(() => !!window.__nsweb?.engine, null, { timeout: 30000 });
    await page.locator("#ns-input").scrollIntoViewIfNeeded();
    const covered = await page.evaluate(() => {
      const box = document.querySelector("#ns-input").getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return hit && hit.id !== "ns-input" ? (hit.closest("[data-ns-slot]")?.dataset.nsSlot || hit.tagName) : null;
    });
    assert.equal(covered, null, `${url}: the chat input is covered by ${covered}`);
    await page.close();
  }
  await short.close();
});

await check("phone width: the sample case settles at 390 px without sideways scrolling", async () => {
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = watch(await phone.newPage());
  const overflow = async (where) => {
    const extra = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(extra <= 0, `${where}: ${extra}px of sideways scrolling`);
  };
  await page.goto(`${DESK}/`);
  await overflow("desk front page");
  await page.goto(`${DESK}/case.html#sample=brackenlight-BL-2207`);
  await page.tap('[data-action="check-terms"]');
  await page.tap('dialog.page-dialog button[value="allow"]');
  await page.waitForSelector(".verdict");
  await overflow("outcome");
  await page.tap('.choices button[data-option="outcome"]');
  await page.tap("dialog.page-dialog .btn.primary");
  const link = await page.getAttribute('a.btn.primary[target="_blank"]', "href");
  await overflow("agreement");
  await page.goto(link);
  await page.waitForSelector("#bo-case .checks");
  await overflow("shop back office");
  await page.tap("#bo-case .bo-actions .btn.primary");
  await page.tap("dialog.page-dialog .btn.primary");
  const back = await page.getAttribute("#bo-case a.btn.primary", "href");
  await page.goto(back);
  await page.waitForSelector(".settled");
  await overflow("settled case");
  await page.screenshot({ path: path.join(out, "settled-phone.png"), fullPage: true });
  await phone.close();
});

await check("no page errors", async () => { assert.deepEqual(pageErrors, []); });

await browser.close();
for (const s of servers) s.kill();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);
