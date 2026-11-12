// End-to-end checks in a real browser, without a language model. Builds the dev
// sites, serves them on two origins like GitHub Pages, and walks a case from the
// sample to the shop's confirmation, then the error states and the verify page.
// Usage: npm run test:e2e   (needs Python 3 and Playwright's Chromium)
import { spawn, execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const out = path.join(root, "tests/e2e/output");
await mkdir(out, { recursive: true });
execFileSync("node", ["tools/build_sites.mjs", "dev"], { cwd: root, stdio: "inherit" });
const servers = [
  spawn("python3", ["tools/serve.py", "dist/dev/desk", "8090", "--prefix", "/open-resolution-desk"], { cwd: root, stdio: "ignore" }),
  spawn("python3", ["tools/serve.py", "dist/dev/shops", "8091"], { cwd: root, stdio: "ignore" }),
];
const DESK = "http://127.0.0.1:8090/open-resolution-desk";
for (let i = 0; i < 40; i++) {
  try { if ((await fetch(`${DESK}/case.html`)).ok && (await fetch("http://127.0.0.1:8091/brackenlight/")).ok) break; } catch { /* starting */ }
  await new Promise((r) => setTimeout(r, 250));
}

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
  assert.match(link, /^http:\/\/127\.0\.0\.1:8091\/brackenlight\/backoffice\.html#case=/);
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
  page.on("request", (r) => { if (r.url().includes(":8091")) requests.push(r.url()); });
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
  assert.ok(failed.includes("No step in the case file was changed or removed"));
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
  await page.goto("http://127.0.0.1:8091/brackenlight/#orders");
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

await check("no page errors", async () => { assert.deepEqual(pageErrors, []); });

await browser.close();
for (const s of servers) s.kill();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);
