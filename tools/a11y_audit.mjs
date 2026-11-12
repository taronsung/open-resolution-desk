// a11y_audit.mjs - runs axe-core on each page (desk and shops) at desktop and
// phone width and prints violations. Usage: node tools/a11y_audit.mjs [deskBase] [shopsBase]
import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
const axeSource = await readFile(new URL("../node_modules/axe-core/axe.min.js", import.meta.url), "utf8");
const DESK = process.argv[2] || "http://127.0.0.1:8090/open-resolution-desk";
const SHOPS = process.argv[3] || "http://127.0.0.1:8091";
const pages = [
  `${DESK}/`, `${DESK}/case.html`, `${DESK}/case.html#sample=brackenlight-BL-2207`, `${DESK}/verify.html`, `${DESK}/protocol.html`,
  `${SHOPS}/brackenlight/`, `${SHOPS}/brackenlight/terms.html`, `${SHOPS}/brackenlight/backoffice.html`, `${SHOPS}/coppice/`,
];
const browser = await chromium.launch();
let total = 0;
for (const [label, viewport] of [["desktop", { width: 1360, height: 900 }], ["phone", { width: 390, height: 844 }]]) {
  const context = await browser.newContext({ viewport });
  for (const url of pages) {
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForTimeout(1500);
    await page.addScriptTag({ content: axeSource });
    const result = await page.evaluate(async () => await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"] } }));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    for (const v of result.violations) {
      total += 1;
      console.log(`[${label}] ${url.replace(/^https?:\/\/[^/]+/, "")} ${v.impact} ${v.id}: ${v.help} (${v.nodes.length})`);
      for (const n of v.nodes.slice(0, 3)) console.log(`    ${n.target.join(" ")} ${n.failureSummary?.split("\n")[1]?.trim() || ""}`);
    }
    if (overflow > 0) { total += 1; console.log(`[${label}] ${url} horizontal overflow ${overflow}px`); }
    await page.close();
  }
  await context.close();
}
console.log(total ? `${total} issue(s)` : "no issues");
await browser.close();
