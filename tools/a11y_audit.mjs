// a11y_audit.mjs - runs axe-core on each page (desk and shops) at desktop and
// phone width, including the states a case passes through, and prints
// violations and sideways overflow.
// Usage: node tools/a11y_audit.mjs [--prod | deskBase shopsBase]
//   no arguments: the dev servers from npm run dev
//   --prod: the published sites named in config.json
import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
const axeSource = await readFile(new URL("../node_modules/axe-core/axe.min.js", import.meta.url), "utf8");
const config = JSON.parse(await readFile(new URL("../config.json", import.meta.url), "utf8"));
const args = process.argv.slice(2).filter((a) => a !== "--prod");
const target = process.argv.includes("--prod") ? config.prod : config.dev;
const DESK = args[0] || target.desk;
const SHOPS = args[1] || target.shops_root;
const pages = [
  `${DESK}/`, `${DESK}/case.html`, `${DESK}/case.html#sample=brackenlight-BL-2207`, `${DESK}/verify.html`, `${DESK}/protocol.html`,
  `${SHOPS}/brackenlight/`, `${SHOPS}/brackenlight/terms.html`, `${SHOPS}/brackenlight/backoffice.html`, `${SHOPS}/coppice/`,
];
const browser = await chromium.launch();
let total = 0;
let audited = 0;

/** Run axe on the page as it is now and print violations and sideways overflow. */
async function audit(page, label, where) {
  await page.addScriptTag({ content: axeSource });
  const result = await page.evaluate(async () => await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"] } }));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  audited += 1;
  for (const v of result.violations) {
    total += 1;
    console.log(`[${label}] ${where} ${v.impact} ${v.id}: ${v.help} (${v.nodes.length})`);
    for (const n of v.nodes.slice(0, 3)) console.log(`    ${n.target.join(" ")} ${n.failureSummary?.split("\n")[1]?.trim() || ""}`);
  }
  if (overflow > 0) { total += 1; console.log(`[${label}] ${where} horizontal overflow ${overflow}px`); }
}

for (const [label, viewport] of [["desktop", { width: 1360, height: 900 }], ["phone", { width: 390, height: 844 }]]) {
  const context = await browser.newContext({ viewport });
  for (const url of pages) {
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForTimeout(1500);
    await audit(page, label, url.replace(/^https?:\/\/[^/]+/, ""));
    await page.close();
  }
  // The states a case passes through: the consent dialog, the outcome, the
  // confirmation dialog, the agreement, the shop's case page, the settled case,
  // and the error when the shop's terms file does not match the receipt.
  const page = await context.newPage();
  await page.goto(`${DESK}/case.html#sample=brackenlight-BL-2207`);
  await page.click('[data-action="check-terms"]');
  await page.waitForSelector("dialog.page-dialog[open]");
  await audit(page, label, "case: consent dialog");
  await page.click('dialog.page-dialog button[value="allow"]');
  await page.waitForSelector(".verdict");
  await page.waitForTimeout(1600);
  await audit(page, label, "case: outcome");
  await page.click('.choices button[data-option="outcome"]');
  await page.waitForSelector("dialog.page-dialog[open]");
  await audit(page, label, "case: confirm dialog");
  await page.click("dialog.page-dialog .btn.primary");
  const link = await page.getAttribute('a.btn.primary[target="_blank"]', "href");
  await audit(page, label, "case: agreement");
  await page.goto(link);
  await page.waitForSelector("#bo-case .checks");
  await page.waitForTimeout(1600);
  await audit(page, label, "shop case page");
  await page.click("#bo-case .bo-actions .btn.primary");
  await page.click("dialog.page-dialog .btn.primary");
  const back = await page.getAttribute("#bo-case a.btn.primary", "href");
  await page.goto(back);
  await page.waitForSelector(".settled");
  await audit(page, label, "case: settled");
  // The error state when the shop's file no longer matches the receipt's hash.
  const original = await (await fetch(`${SHOPS}/brackenlight/terms/v2.json`)).json();
  await page.route(`${SHOPS}/brackenlight/terms/v2.json`, (route) => route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ ...original, title: "Changed after the fact" }) }));
  await page.goto(`${DESK}/case.html#sample=brackenlight-BL-2207`);
  await page.click('[data-action="check-terms"]');
  await page.click('dialog.page-dialog button[value="allow"]');
  await page.waitForSelector(".terms-status[data-kind='error']");
  await audit(page, label, "case: terms do not match the receipt");
  await page.close();
  await context.close();
}
console.log(`${DESK} and ${SHOPS}: ${audited} page states audited, ${total ? `${total} issue(s)` : "no issues"}`);
await browser.close();
