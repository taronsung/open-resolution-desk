// backoffice-page.js - the shop's own case page. A customer sends the shop a link
// from the Open Resolution Desk; the shop opens it here, on its own site, and
// recomputes everything with its own copy of the published decision function
// and its own records before it confirms. Nothing is sent to any server.

import { SHOP } from "../data/shop-data.js";
import { hashOf, shortHash } from "../protocol/v1/canonical.js";
import { money, summarizeOutcome } from "../protocol/v1/evaluate.js";
import { computeOutcome, verifyChain, latest, appendEvent, priceOffer, packForLink, unpackFromLink, engineHash } from "../protocol/v1/case.js";
import { fingerprintMark } from "./fingerprint-mark.js";
import { reviewDialog } from "./dialogs.js";

const ORDERS_KEY = `${SHOP.id}-demo-orders-v1`;
const LEDGER_KEY = `${SHOP.id}-demo-ledger-v1`;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}
function readJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || "null") ?? fallback; } catch { return fallback; }
}
function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* keep in memory */ }
}

export class BackOffice {
  constructor(root) {
    this.root = root;
    this.caseFile = null;
    this.result = null;
    this.responseLink = null;
  }

  async start() {
    const source = await (await fetch(new URL("../protocol/v1/evaluate.js", import.meta.url))).text();
    this.engineSha256 = await engineHash(source);
    this.renderLedger();
    await this.openFromLocation();
    window.addEventListener("hashchange", () => this.openFromLocation());
  }

  async openFromLocation() {
    const packed = new URLSearchParams(location.hash.slice(1)).get("case");
    const box = this.root.querySelector("#bo-case");
    if (!packed) {
      box.replaceChildren(el("p", { class: "muted", text: "No case is open. A customer's link from the Open Resolution Desk opens here." }));
      return;
    }
    try {
      this.caseFile = await unpackFromLink(packed);
    } catch (error) {
      box.replaceChildren(el("p", { class: "error", text: `This case link could not be opened: ${error.message}` }));
      return;
    }
    this.result = await this.verify(this.caseFile);
    this.render();
  }

  /**
   * Check the case against this shop's own records and published files.
   *
   * :param caseFile: An ord-case/1 document.
   * :return: {checks, ok, recomputed, accepted, outcomeEvent}
   */
  async verify(caseFile) {
    const checks = [];
    const add = (label, ok, detail) => checks.push({ label, ok, detail });
    const chain = await verifyChain(caseFile);
    add("No step in the case file was changed or removed", chain.ok, chain.ok ? `${caseFile.events.length} steps, each linked to the one before.` : chain.problems.join(" "));
    const receipt = caseFile.receipt;
    const ours = receipt?.merchant?.id === SHOP.id;
    add(`The case is about a ${SHOP.name} order`, ours, ours ? `Order ${receipt.order_id}.` : `It names ${receipt?.merchant?.name || "another shop"}.`);
    const orders = [...SHOP.orders, ...readJson(ORDERS_KEY, [])];
    const stored = orders.find((o) => o.order_id === receipt?.order_id);
    const sameReceipt = !!stored && (await hashOf(stored)) === (await hashOf(receipt));
    add("The receipt matches our order record", sameReceipt, sameReceipt ? "Every field matches what we issued." : stored ? "Our record differs from the receipt in the case." : "We have no record of this order in this browser.");
    const version = String(receipt?.terms?.version || "");
    const entry = SHOP.terms.versions[version];
    let terms = null;
    if (entry) terms = await (await fetch(new URL(`../${entry.path}`, import.meta.url))).json();
    const termsOk = !!terms && (await hashOf(terms)) === receipt.terms.sha256 && entry.sha256 === receipt.terms.sha256;
    add(`Terms version ${version} is the one we published`, termsOk, termsOk ? `Matches our archive: ${shortHash(entry.sha256)}.` : "The pinned terms do not match our archive.");
    const outcomeEvent = latest(caseFile, "outcome");
    const filed = [...caseFile.events].reverse().find((e) => e.type === "filed");
    const engineOk = this.engineSha256 === SHOP.engine.sha256 && outcomeEvent?.data?.engine?.sha256 === SHOP.engine.sha256;
    add("The desk used the decision function we adopted", engineOk, engineOk ? `${SHOP.engine.name} ${SHOP.engine.version}, ${shortHash(SHOP.engine.sha256)}.` : "The engine fingerprint differs from the one we pinned.");
    let recomputed = null;
    if (terms && stored && filed) {
      try {
        recomputed = await computeOutcome({ terms, receipt: stored, claim: filed.data.claim, engineSha256: this.engineSha256 });
      } catch (error) {
        add("We can recompute the outcome", false, error.message);
      }
    }
    const fpOk = !!recomputed && recomputed.fingerprint === outcomeEvent?.data?.fingerprint;
    if (recomputed) add("Our own computation gives the same fingerprint", fpOk, fpOk ? summarizeOutcome(recomputed.outcome) : `We got ${shortHash(recomputed.fingerprint)}, the case says ${shortHash(outcomeEvent?.data?.fingerprint)}.`);
    const accepted = latest(caseFile, "accepted");
    let valueOk = false;
    if (accepted && recomputed) {
      if (accepted.data.option === "outcome") {
        valueOk = recomputed.outcome.decision === "eligible" && accepted.data.value_cents === recomputed.outcome.refund.total_cents;
      } else {
        const offer = SHOP.offers.find((o) => o.id === accepted.data.option);
        const priced = offer ? priceOffer(offer, recomputed.outcome) : null;
        valueOk = !!priced && priced.value_cents === accepted.data.value_cents;
      }
      add("The customer's choice is one we offer, at the right value", valueOk, `${accepted.data.label}: ${money(accepted.data.value_cents)}.`);
    } else {
      add("The customer has chosen an option", false, "The case has no recorded choice yet.");
    }
    const settled = latest(caseFile, "confirmed") || latest(caseFile, "declined");
    return { checks, ok: checks.every((c) => c.ok), recomputed, accepted, outcomeEvent, settled };
  }

  async confirmCase() {
    const { accepted, recomputed } = this.result;
    const yes = await reviewDialog({
      title: "Confirm and settle this case?",
      sentence: `${SHOP.name} confirms the customer's choice. In this demo a refund or credit is recorded in this browser only, and no money moves.`,
      details: { Case: this.caseFile.case_id, Order: this.caseFile.receipt.order_id, Choice: accepted.data.label, Value: money(accepted.data.value_cents), Fingerprint: shortHash(recomputed.fingerprint) },
      confirmLabel: "Confirm and settle",
      declineLabel: "Not yet",
    });
    if (!yes) return;
    const ledger = readJson(LEDGER_KEY, []);
    const ref = `${SHOP.prefix}-R${String(ledger.length + 1).padStart(3, "0")}`;
    await appendEvent(this.caseFile, {
      type: "confirmed",
      actor: "shop",
      at: new Date().toISOString(),
      data: { option: accepted.data.option, value_cents: accepted.data.value_cents, fingerprint: recomputed.fingerprint, ledger_ref: ref, confirmed_by: location.host },
    });
    ledger.push({ ref, case_id: this.caseFile.case_id, order_id: this.caseFile.receipt.order_id, label: accepted.data.label, value_cents: accepted.data.value_cents, at: new Date().toISOString() });
    writeJson(LEDGER_KEY, ledger);
    await this.afterResponse();
  }

  async declineCase() {
    const yes = await reviewDialog({
      title: "Decline and ask for review by a person?",
      sentence: "The case file will record that the shop does not confirm and wants a person to review it.",
      details: { Case: this.caseFile.case_id, Order: this.caseFile.receipt.order_id },
      confirmLabel: "Decline and ask for review",
      declineLabel: "Go back",
    });
    if (!yes) return;
    await appendEvent(this.caseFile, { type: "declined", actor: "shop", at: new Date().toISOString(), data: { reason: "The shop asked for review by a person.", declined_by: location.host } });
    await this.afterResponse();
  }

  async afterResponse() {
    this.responseLink = `${SHOP.desk}/case.html#case=${await packForLink(this.caseFile)}`;
    history.replaceState(null, "", `${location.pathname}#case=${await packForLink(this.caseFile)}`);
    this.result = await this.verify(this.caseFile);
    this.render();
    this.renderLedger();
  }

  render() {
    const box = this.root.querySelector("#bo-case");
    const { caseFile, result } = this;
    const receipt = caseFile.receipt;
    const filed = [...caseFile.events].reverse().find((e) => e.type === "filed");
    const head = el("div", { class: "bo-head" },
      el("h2", { text: `Case ${caseFile.case_id}` }),
      el("p", { text: `Order ${receipt.order_id}, ${receipt.customer?.name || "customer"}. Claim: ${filed?.data?.claim?.type?.replace(/_/g, " ")} on ${filed?.data?.claim?.reported_on}.` }));
    const list = el("ol", { class: "checks" }, result.checks.map((c) =>
      el("li", { "data-passed": c.ok ? "yes" : "no" },
        el("span", { class: "mark", "aria-hidden": "true", text: c.ok ? "✓" : "✕" }),
        el("span", { class: "visually-hidden", text: c.ok ? "Passed: " : "Failed: " }),
        el("span", { class: "check-label", text: c.label }),
        el("span", { class: "check-detail", text: c.detail }))));
    const fp = result.recomputed?.fingerprint || result.outcomeEvent?.data?.fingerprint;
    const matched = !!result.recomputed && result.recomputed.fingerprint === result.outcomeEvent?.data?.fingerprint;
    const figure = el("figure", { class: "fingerprint" }, fingerprintMark(fp, { size: 132, matched }),
      el("figcaption", {}, el("span", { class: "fp-title", text: matched ? "Same fingerprint as the desk" : "Fingerprint" }),
        el("code", { class: "hash", title: fp || "", text: shortHash(fp) })));
    const actions = el("div", { class: "bo-actions" });
    if (result.settled) {
      const confirmed = result.settled.type === "confirmed";
      actions.append(el("p", { class: confirmed ? "ok" : "warn", text: confirmed
        ? `Confirmed: ${result.accepted?.data?.label}, ${money(result.accepted?.data?.value_cents || 0)}. Ledger reference ${result.settled.data.ledger_ref}.`
        : "Declined: the shop asked for review by a person." }));
      if (this.responseLink) {
        actions.append(el("p", { text: "Send this link back to the customer. It opens the settled case at the desk." }),
          el("a", { class: "btn primary", href: this.responseLink, target: "_blank", rel: "noopener", text: "Open the settled case at the desk" }));
      }
    } else if (result.ok) {
      const yes = el("button", { type: "button", class: "btn primary", text: "Confirm and settle" });
      yes.addEventListener("click", () => this.confirmCase());
      const no = el("button", { type: "button", class: "btn quiet", text: "Decline and ask for review" });
      no.addEventListener("click", () => this.declineCase());
      actions.append(el("p", { text: "Every check passed. You can confirm the customer's choice." }), yes, no);
    } else {
      const no = el("button", { type: "button", class: "btn quiet", text: "Decline and ask for review" });
      no.addEventListener("click", () => this.declineCase());
      actions.append(el("p", { class: "warn", text: "Some checks failed, so this page will not confirm the case. Ask for review by a person." }), no);
    }
    box.replaceChildren(head, el("div", { class: "bo-grid" }, el("div", {}, el("h3", { text: "Checks on our side" }), list), figure), actions);
  }

  renderLedger() {
    const list = this.root.querySelector("#bo-ledger");
    if (!list) return;
    const ledger = readJson(LEDGER_KEY, []);
    list.replaceChildren(...(ledger.length ? ledger.map((l) => el("li", {},
      el("strong", { text: l.ref }), ` ${l.case_id}, order ${l.order_id}: ${l.label}, ${money(l.value_cents)}`)) : [el("li", { class: "muted", text: "No cases settled in this browser yet." })]));
  }
}
