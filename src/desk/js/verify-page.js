// verify-page.js - checks a case file without trusting whoever sent it: the
// event chain, the terms the receipt pins (read from the shop's own site after
// the visitor agrees), and the outcome, recomputed with this page's copy of the
// published decision function.

import { hashOf, shortHash } from "../protocol/v1/canonical.js";
import { money } from "../protocol/v1/evaluate.js";
import { computeOutcome, verifyChain, latest, unpackFromLink, engineHash } from "../protocol/v1/case.js";
import { fingerprintMark } from "./fingerprint-mark.js";
import { consentDialog } from "./dialogs.js";

const root = document.querySelector("#verify-root");
const out = root.querySelector("#verify-result");
let engineSha256 = null;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "text") node.textContent = v;
    else if (k === "class") node.className = v;
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}
const checkItem = (ok, label, detail) => el("li", { "data-passed": ok === true ? "yes" : ok === false ? "no" : "open" },
  el("span", { class: "mark", "aria-hidden": "true", text: ok === true ? "✓" : ok === false ? "✕" : "?" }),
  el("span", { class: "visually-hidden", text: ok === true ? "Passed: " : ok === false ? "Failed: " : "Not checked: " }),
  el("span", { class: "check-label", text: label }),
  detail ? el("span", { class: "check-detail", text: detail }) : null);

async function show(caseFile) {
  out.replaceChildren(el("p", { text: "Checking…" }));
  if (caseFile?.protocol !== "ord-case/1" || !Array.isArray(caseFile.events)) {
    out.replaceChildren(el("p", { class: "error", text: "This is not an ord/1 case file." }));
    return;
  }
  const chain = await verifyChain(caseFile);
  const outcomeEvent = latest(caseFile, "outcome");
  const filed = [...caseFile.events].reverse().find((e) => e.type === "filed");
  const confirmed = latest(caseFile, "confirmed");
  const checks = el("ol", { class: "checks" },
    checkItem(chain.ok, "No step was changed, removed or reordered", chain.ok ? `${caseFile.events.length} steps, each linked to the one before.` : chain.problems.join(" ")),
    checkItem(outcomeEvent?.data?.engine?.sha256 === engineSha256, "The outcome used the decision function this desk publishes", `${shortHash(outcomeEvent?.data?.engine?.sha256)} in the case, ${shortHash(engineSha256)} here.`));
  const timeline = el("ol", { class: "checks" }, caseFile.events.map((e) => el("li", { "data-passed": "yes" },
    el("span", { class: "mark", "aria-hidden": "true", text: String(e.seq) }),
    el("span", { class: "check-label", text: `${e.type.replace(/_/g, " ")} by ${e.actor}` }),
    el("span", { class: "check-detail", text: `${new Date(e.at).toLocaleString()}${e.data?.label ? `: ${e.data.label}` : ""}${e.data?.value_cents !== undefined ? `, ${money(e.data.value_cents)}` : ""}` }))));
  const recompute = el("button", { type: "button", class: "btn primary", text: `Recompute with ${caseFile.receipt?.merchant?.name || "the shop"}'s published terms` });
  const recomputeBox = el("div", {});
  recompute.addEventListener("click", async () => {
    recompute.disabled = true;
    recomputeBox.replaceChildren(await recomputeOutcome(caseFile, outcomeEvent, filed, confirmed));
    recompute.disabled = false;
  });
  out.replaceChildren(
    el("h2", { text: `Case ${caseFile.case_id}` }),
    el("p", { text: `${caseFile.receipt?.merchant?.name}, order ${caseFile.receipt?.order_id}. Recorded fingerprint ${shortHash(outcomeEvent?.data?.fingerprint)}.` }),
    checks,
    el("h3", { text: "Steps in the case file" }), timeline,
    el("div", { class: "row" }, recompute),
    el("p", { class: "small muted", text: "Recomputing reads two public files from the shop's site after you agree. Nothing from the case is sent." }),
    recomputeBox);
}

async function recomputeOutcome(caseFile, outcomeEvent, filed, confirmed) {
  const receipt = caseFile.receipt;
  let base;
  try { base = new URL(receipt.merchant.site.replace(/\/?$/, "/")); } catch { return el("p", { class: "error", text: "The receipt names no valid shop address." }); }
  const decision = await consentDialog({ host: base.host, label: `${receipt.merchant.name} (published terms)`, purpose: "Read the shop's public agent manifest and the terms version the receipt pins. Nothing from the case is sent." });
  if (decision === "decline") return el("p", { text: "You declined, so nothing was contacted and nothing was recomputed." });
  try {
    const manifest = await (await fetch(new URL("agent-manifest.json", base), { credentials: "omit" })).json();
    const entry = manifest?.resolution?.terms?.versions?.[receipt.terms.version];
    if (!entry) throw new Error(`the shop publishes no terms version ${receipt.terms.version}`);
    const terms = await (await fetch(new URL(entry.url, base), { credentials: "omit" })).json();
    const termsSha = await hashOf(terms);
    const result = await computeOutcome({ terms, receipt, claim: filed.data.claim, engineSha256 });
    const same = result.fingerprint === outcomeEvent?.data?.fingerprint;
    const sameConfirmed = !confirmed || confirmed.data.fingerprint === result.fingerprint;
    return el("div", { class: "outcome-grid verify-result" },
      el("ol", { class: "checks" },
        checkItem(termsSha === receipt.terms.sha256 && termsSha === entry.sha256, `Terms version ${receipt.terms.version} match the receipt and the shop's archive`, shortHash(termsSha)),
        checkItem(same, "Recomputed fingerprint equals the recorded one", `${shortHash(result.fingerprint)}`),
        confirmed ? checkItem(sameConfirmed, "The shop confirmed the same fingerprint", `${confirmed.data.ledger_ref || ""}`) : checkItem(null, "The shop has not confirmed yet", "")),
      el("figure", { class: "fingerprint" }, fingerprintMark(result.fingerprint, { size: 132, matched: same && sameConfirmed }),
        el("figcaption", {}, el("span", { class: "fp-title", text: same ? "Matches the case file" : "Does not match" }), el("code", { class: "hash", text: shortHash(result.fingerprint) }))));
  } catch (error) {
    return el("p", { class: "error", text: `Could not recompute: ${error.message}` });
  }
}

async function start() {
  engineSha256 = await engineHash(await (await fetch(new URL("../protocol/v1/evaluate.js", import.meta.url))).text());
  root.querySelector("#case-file").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try { await show(JSON.parse(await file.text())); } catch (error) { out.replaceChildren(el("p", { class: "error", text: `This file could not be read: ${error.message}` })); }
  });
  root.querySelector("#paste-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = root.querySelector("#paste").value.trim();
    try {
      if (text.startsWith("{")) await show(JSON.parse(text));
      else {
        const packed = new URLSearchParams(text.slice(text.indexOf("#") + 1)).get("case");
        await show(await unpackFromLink(packed || ""));
      }
    } catch (error) { out.replaceChildren(el("p", { class: "error", text: `This could not be read: ${error.message}` })); }
  });
  const packed = new URLSearchParams(location.hash.slice(1)).get("case");
  if (packed) {
    try { await show(await unpackFromLink(packed)); } catch (error) { out.replaceChildren(el("p", { class: "error", text: error.message })); }
  }
}
start();
