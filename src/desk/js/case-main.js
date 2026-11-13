// case-main.js - starts the case workspace on case.html. It works without the
// assistant: every step has a button. site.js adds the assistant on top.

import { Desk, DeskPage } from "./desk-page.js";
import { consentDialog, reviewDialog } from "./dialogs.js";
import { exposeWebMcpTools } from "./webmcp.js";
import { CLAIM_TYPES } from "../protocol/v1/evaluate.js";

const deskBase = new URL("../", import.meta.url).href.replace(/\/$/, "");

/**
 * Ask before contacting another site. Uses the runtime's consent card when the
 * assistant made the request, and the page's dialog when a button did, and
 * shares "allow for this visit" with the runtime.
 */
async function consent(info) {
  const engine = window.__nsweb?.engine;
  if (engine?.consent?.get(info.host) === "always") return "always";
  if (info.via === "agent" && engine && typeof engine.onConsent === "function") {
    return engine.requestConsent({
      kind: "network",
      peerLabel: info.label,
      peerOrigin: info.host,
      requestText: info.purpose,
      est: { totalTokens: 0, costText: null },
    });
  }
  const decision = await consentDialog(info);
  if (decision === "always") engine?.consent?.set(info.host, "always");
  return decision;
}

async function start() {
  const root = document.querySelector("#case-root");
  const page = new DeskPage({ root, deskBase, consent, confirm: reviewDialog });
  Desk.page = page;
  root.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    if (action === "check-terms") {
      page.checkTerms({ via: "page" }).then((r) => { if (!r.ok) page.flash(r.reason, "error"); });
    } else if (action === "sample") {
      page.loadSample(button.dataset.sample || undefined).then((r) => { if (!r.ok) page.flash(r.reason, "error"); });
    } else if (action === "new-case") {
      history.replaceState(null, "", location.pathname);
      page.reset();
      page.changed();
    }
  });
  const file = root.querySelector("#receipt-file");
  file?.addEventListener("change", async () => {
    const chosen = file.files?.[0];
    if (!chosen) return;
    const result = await page.loadReceiptText(await chosen.text());
    if (!result.ok) page.flash(result.reason, "error");
    file.value = "";
  });
  const linkForm = root.querySelector("#link-form");
  linkForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = linkForm.querySelector("input");
    const value = input.value.trim();
    const hashIndex = value.indexOf("#");
    if (hashIndex < 0) {
      page.flash("Paste the whole link, including the part after #.", "error");
      return;
    }
    history.replaceState(null, "", `${location.pathname}${value.slice(hashIndex)}`);
    if (await page.openFromLocation()) input.value = "";
  });
  try {
    await page.loadEngine();
  } catch (error) {
    page.flash(`The decision function could not load: ${error.message}`, "error");
  }
  page.render();
  await page.openFromLocation();
  // Browser agents with WebMCP get the same operations as the built-in assistant.
  // Contacts and irreversible steps still go through this page's dialogs.
  exposeWebMcpTools([
    { name: "ord_get_case", description: "Read the open Open Resolution Desk case: order, pinned terms, outcome, options and next step.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true, untrustedContentHint: true }, run: () => page.getCase() },
    { name: "ord_check_terms", description: "Read the shop's published terms for the version the receipt pins and check their hash. The page asks the visitor before contacting the shop.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true }, run: () => page.checkTerms({ via: "page" }) },
    { name: "ord_file_claim", description: "File or amend the claim and compute the outcome with the published decision function.", inputSchema: { type: "object", properties: { type: { type: "string", enum: Object.keys(CLAIM_TYPES) }, sku: { type: "string" }, unused: { type: "boolean" }, original_packaging: { type: "boolean" }, photo_evidence: { type: "boolean" }, received: { type: "boolean" } }, required: ["type"] }, run: (args) => page.fileClaim(args, { via: "page" }) },
    { name: "ord_accept_option", description: "Record the customer's choice (\"outcome\" or a published offer id). The page asks the visitor to confirm.", inputSchema: { type: "object", properties: { option: { type: "string" } }, required: ["option"] }, annotations: { consequentialHint: true }, run: (args) => page.acceptOption(args, { via: "page" }) },
    { name: "ord_request_review", description: "Ask for review of the case by a person. The page asks the visitor to confirm.", inputSchema: { type: "object", properties: { reason: { type: "string" } } }, annotations: { consequentialHint: true }, run: (args) => page.requestReview(args, { via: "page" }) },
  ]).then((n) => { if (n) console.info(`WebMCP: ${n} desk tools registered`); });
  window.addEventListener("hashchange", () => page.openFromLocation());
  document.documentElement.dataset.ready = "true";
  return page;
}

export const ready = start();
