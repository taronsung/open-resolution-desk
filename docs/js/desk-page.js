// desk-page.js - the case workspace of the Open Resolution Desk.
//
// One DeskPage object holds the case. The page's own buttons and the agent's
// website_* tools call the same methods, so both follow one set of rules.
// Methods refuse bad input by returning {ok: false, reason} and change nothing.
// Nothing here sends case data to any server: the desk is a static site, and the
// only contacts with other sites are public file reads after the visitor agrees.

import { hashOf, shortHash } from "../protocol/v1/canonical.js";
import { CLAIM_TYPES, REMEDIES, money, summarizeOutcome } from "../protocol/v1/evaluate.js";
import {
  computeOutcome, newCase, appendEvent, verifyChain, latest, priceOffer,
  packForLink, unpackFromLink, engineHash, normalizeClaim,
} from "../protocol/v1/case.js";
import { fingerprintMark } from "./fingerprint-mark.js";

const FACT_LABELS = {
  unused: "The item is unused",
  original_packaging: "It is in its original packaging",
  photo_evidence: "I have a photo of the problem",
  received: "The parcel arrived",
};
const FACTS_BY_TYPE = {
  change_of_mind: ["unused", "original_packaging"],
  arrived_damaged: ["photo_evidence"],
  wrong_item: [],
  faulty: [],
  not_received: ["received"],
};
const DECISION_TEXT = {
  eligible: "Eligible",
  not_eligible: "Not eligible",
  needs_review: "Needs review by a person",
  incomplete: "Incomplete",
};

/**
 * The line under the decision word: the remedy and its value when eligible,
 * otherwise the reason, without repeating the decision word above it.
 */
function verdictLine(outcome) {
  if (outcome.decision === "eligible") {
    const shipping = outcome.return_shipping === "merchant" ? " The shop pays return shipping."
      : outcome.return_shipping === "customer" ? " You pay return shipping." : "";
    return `${REMEDIES[outcome.remedy]}, value ${money(outcome.refund.total_cents, outcome.currency)}.${shipping}`;
  }
  return summarizeOutcome(outcome).replace(/^[^:]+:\s*/, "");
}

/** Today's date in the visitor's time zone, as YYYY-MM-DD. */
export function today() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Format a YYYY-MM-DD date with its weekday, such as "Fri, 13 Nov 2026". */
export function longDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return String(value || "");
  const [y, m, d] = value.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", {
    weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
  });
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function refuse(reason, field) {
  return field ? { ok: false, reason, field } : { ok: false, reason };
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return String(url || ""); }
}

/**
 * The case workspace. Create it once with DeskPage.create() and use Desk.page.
 */
export class DeskPage {
  constructor({ root, deskBase, consent, confirm, onShopResolved, onChange }) {
    this.root = root;
    this.deskBase = deskBase.replace(/\/$/, "");
    this.consent = consent; // async ({host, label, purpose, via}) => "allow" | "always" | "decline"
    this.confirm = confirm; // async ({title, sentence, details, confirmLabel, declineLabel}) => boolean
    this.onShopResolved = onShopResolved || (() => {});
    this.onChange = onChange || (() => {});
    this.engineSha256 = null;
    this.publishedEngineSha256 = null;
    this.contacts = [];
    this.reset();
  }

  /** Start with no case. */
  reset() {
    this.state = {
      status: "empty",
      source: null,
      story: "",
      shopDecision: "",
      handoffClaim: null,
      claimDate: null,
      receipt: null,
      shop: null,
      claim: null,
      outcome: null,
      fingerprint: null,
      offers: [],
      caseFile: null,
      accepted: null,
      shopLink: null,
      response: null,
    };
  }

  // ---------------------------------------------------------------- setup

  /**
   * Hash this page's copy of the decision function and read the fingerprint the
   * desk publishes in its manifest, so the page can show that they match.
   */
  async loadEngine() {
    const source = await (await fetch(new URL("../protocol/v1/evaluate.js", import.meta.url))).text();
    this.engineSha256 = await engineHash(source);
    try {
      const manifest = await (await fetch(`${this.deskBase}/agent-manifest.json`)).json();
      this.publishedEngineSha256 = manifest?.resolution_desk?.engine?.sha256 || null;
    } catch {
      this.publishedEngineSha256 = null;
    }
  }

  /**
   * Open whatever the address bar carries: a handoff from a shop or a case file.
   *
   * :return: true when something was opened.
   */
  async openFromLocation() {
    const params = new URLSearchParams(location.hash.slice(1));
    try {
      if (params.get("handoff")) {
        await this.loadHandoff(await unpackFromLink(params.get("handoff")), "handoff");
        return true;
      }
      if (params.get("sample")) {
        const result = await this.loadSample(params.get("sample"));
        if (!result.ok) this.flash(result.reason, "error");
        return result.ok;
      }
      if (params.get("case")) {
        await this.loadCaseFile(await unpackFromLink(params.get("case")));
        return true;
      }
    } catch (error) {
      this.flash(`This link could not be opened: ${error.message}`, "error");
    }
    return false;
  }

  // ----------------------------------------------------------- operations

  /**
   * Open a handoff package: a receipt plus the customer's account, sent by a shop.
   *
   * :param handoff: {protocol: "ord-handoff/1", receipt, story, shop_decision}
   * :param source: "handoff", "sample" or "receipt".
   * :return: {ok, case} or a refusal.
   */
  async loadHandoff(handoff, source = "handoff") {
    if (handoff?.protocol !== "ord-handoff/1" || handoff?.receipt?.protocol !== "ord-receipt/1") {
      return refuse("This is not a handoff from a shop that uses the ord/1 procedure.");
    }
    this.reset();
    Object.assign(this.state, {
      status: "draft",
      source,
      story: String(handoff.story || "").slice(0, 600),
      shopDecision: String(handoff.shop_decision || "").slice(0, 400),
      // A sample from this site's own samples/ folder keeps its fixed filing date, so it
      // gives the same outcome and fingerprint on any day. Other cases are filed today.
      claimDate: source === "sample" && /^\d{4}-\d{2}-\d{2}$/.test(String(handoff.claim?.reported_on || "")) ? handoff.claim.reported_on : null,
      handoffClaim: handoff.claim && typeof handoff.claim === "object" ? normalizeClaim({ ...handoff.claim, reported_on: today() }) : null,
      receipt: handoff.receipt,
      shop: { site: String(handoff.receipt.merchant?.site || ""), name: String(handoff.receipt.merchant?.name || "the shop"), verified: null },
    });
    if (this.state.claimDate && this.state.handoffClaim) this.state.handoffClaim.reported_on = this.state.claimDate;
    this.changed();
    return { ok: true, case: this.getCase() };
  }

  /**
   * Open the sample case that ships with the desk.
   *
   * :param id: The sample file name, without ".json".
   * :return: {ok, case} or a refusal.
   */
  async loadSample(id = "brackenlight-BL-2207") {
    const response = await fetch(new URL(`../samples/${encodeURIComponent(id)}.json`, import.meta.url));
    if (!response.ok) return refuse(`The sample case "${id}" is missing.`);
    return this.loadHandoff(await response.json(), "sample");
  }

  /**
   * Open a receipt file the customer saved from a shop.
   *
   * :param text: The receipt JSON text.
   * :return: {ok, case} or a refusal.
   */
  async loadReceiptText(text) {
    let receipt;
    try { receipt = JSON.parse(text); } catch { return refuse("This file is not a receipt: it is not JSON."); }
    if (receipt?.protocol !== "ord-receipt/1") return refuse("This file is not an ord/1 receipt.");
    return this.loadHandoff({ protocol: "ord-handoff/1", receipt }, "receipt");
  }

  /**
   * Read the shop's published terms, check them against the hash the receipt pins,
   * and learn the shop's published offers and representative. Asks the visitor
   * before contacting the shop's site.
   *
   * :param options: {via} "agent" or "page".
   * :return: A summary of the terms check, or a refusal.
   */
  async checkTerms({ via = "page", autoFile = true } = {}) {
    const { receipt } = this.state;
    if (!receipt) return refuse("Open a case first: there is no receipt yet.");
    let site;
    try {
      site = new URL(receipt.merchant.site.replace(/\/?$/, "/"));
      if (!["https:", "http:"].includes(site.protocol)) throw new Error("bad protocol");
    } catch {
      return refuse("The receipt does not name a valid shop address.");
    }
    if (this.state.shop?.verified === true && this.state.shop.terms) return this.termsSummary();
    const host = site.host;
    const decision = await this.consent({
      host,
      label: `${receipt.merchant.name} (published terms)`,
      purpose: "Read the shop's public agent manifest and the terms version your receipt pins. Nothing about your case is sent.",
      via,
    });
    if (decision === "decline") {
      this.logContact({ host, what: "Read published terms", decision: "declined", via });
      return refuse(`You declined contact with ${host}, so the terms were not read. Nothing was sent.`);
    }
    const base = site.href.replace(/\/$/, "");
    let manifest;
    let terms;
    const files = [];
    try {
      const manifestUrl = `${base}/agent-manifest.json`;
      manifest = await (await fetchOk(manifestUrl)).json();
      files.push("agent-manifest.json");
      const resolution = manifest?.resolution;
      if (resolution?.protocol !== "ord/1") throw new Error("the shop does not publish an ord/1 resolution block");
      const entry = resolution.terms?.versions?.[String(receipt.terms.version)];
      if (!entry) throw new Error(`the shop publishes no terms version ${receipt.terms.version}`);
      const termsUrl = new URL(entry.url, `${base}/`).href;
      terms = await (await fetchOk(termsUrl)).json();
      files.push(termsUrl.slice(base.length + 1));
      const termsSha256 = await hashOf(terms);
      const pinned = receipt.terms.sha256;
      const listed = entry.sha256;
      const verified = termsSha256 === pinned && termsSha256 === listed;
      const currentVersion = String(resolution.terms.current || "");
      this.state.shop = {
        site: base,
        host,
        name: manifest.brand || receipt.merchant.name,
        manifest,
        terms,
        termsUrl,
        termsSha256,
        verified,
        verifyNote: verified
          ? `The terms file matches the hash on the receipt and in the shop's archive.`
          : termsSha256 !== pinned
            ? `The terms file the shop publishes for version ${receipt.terms.version} does not match the hash on your receipt.`
            : `The shop's archive lists a different hash for version ${receipt.terms.version}.`,
        currentVersion,
        currentTerms: resolution.terms.versions?.[currentVersion] || null,
        offers: Array.isArray(resolution.offers) ? resolution.offers : [],
        representative: typeof resolution.representative === "string" ? resolution.representative : null,
        casePage: typeof resolution.case_page === "string" ? new URL(resolution.case_page, `${base}/`).href : null,
        enginePinned: resolution.engine?.sha256 || null,
      };
      this.logContact({ host, what: `Read ${files.join(", ")}`, decision, via, files });
      this.changed();
      const handoffClaim = this.state.handoffClaim;
      if (autoFile && verified && handoffClaim && !this.state.outcome) {
        // The shop's returns form already collected the claim. Recompute it under the
        // terms the receipt pins, so the customer sees the desk's outcome right away.
        const input = { type: handoffClaim.type, sku: handoffClaim.sku, quantity: handoffClaim.quantity, ...handoffClaim.facts };
        const filed = await this.fileClaim(input, { via: `${via} (claim from the shop's returns form)` });
        return { ...this.termsSummary(), recomputed_claim_from_shop_form: filed.ok ? filed.outcome : filed.reason };
      }
      return this.termsSummary();
    } catch (caught) {
      const error = caught instanceof TypeError
        ? new Error(`${host} did not answer. The site may be down, or it may not let other sites read its files`)
        : caught;
      this.logContact({ host, what: `Read ${files.join(", ") || "agent-manifest.json"}`, decision, via, error: error.message });
      this.state.shop = { ...(this.state.shop || {}), verified: false, verifyNote: `Could not read the terms: ${error.message}.` };
      this.changed();
      return refuse(`Could not read ${receipt.merchant.name}'s published terms: ${error.message}. Nothing was sent.`);
    }
  }

  /**
   * Use a copy of the pinned terms that the customer saved, when the shop's site
   * does not provide a file with the hash the receipt pins. Any copy works if its
   * hash matches the receipt, so a shop cannot escape a version by changing or
   * removing it. Nothing is sent anywhere.
   *
   * :param text: The terms JSON text.
   * :param options: {via}
   * :return: A summary of the terms check, or a refusal.
   */
  async useTermsCopy(text, { via = "page" } = {}) {
    const { receipt } = this.state;
    if (!receipt) return refuse("Open a case first: there is no receipt yet.");
    let terms;
    try { terms = JSON.parse(text); } catch { return refuse("This file is not a terms document: it is not JSON."); }
    if (terms?.protocol !== "ord-terms/1") return refuse("This file is not an ord/1 terms document.");
    const termsSha256 = await hashOf(terms);
    if (termsSha256 !== receipt.terms.sha256) {
      return refuse(`This copy does not match the hash on your receipt for version ${receipt.terms.version}, so the desk cannot use it.`);
    }
    const before = this.state.shop || {};
    const why = before.verifyNote ? ` The shop's site did not provide it. ${before.verifyNote}` : "";
    this.state.shop = {
      ...before,
      site: before.site || String(receipt.merchant.site || "").replace(/\/$/, ""),
      host: before.host || (() => { try { return new URL(receipt.merchant.site).host; } catch { return ""; } })(),
      name: before.name || receipt.merchant.name,
      terms,
      termsSha256,
      termsUrl: null,
      termsSource: "copy",
      verified: true,
      verifyNote: `Your copy of version ${terms.version} matches the hash on the receipt.${why}`,
      currentVersion: before.currentVersion || "",
      offers: before.offers || [],
      representative: before.representative || null,
      casePage: before.casePage || null,
    };
    this.changed();
    const handoffClaim = this.state.handoffClaim;
    if (handoffClaim && !this.state.outcome) {
      const input = { type: handoffClaim.type, sku: handoffClaim.sku, quantity: handoffClaim.quantity, ...handoffClaim.facts };
      const filed = await this.fileClaim(input, { via: `${via} (claim from the shop's returns form)` });
      return { ...this.termsSummary(), recomputed_claim_from_shop_form: filed.ok ? filed.outcome : filed.reason };
    }
    return this.termsSummary();
  }

  /**
   * File (or amend) the claim and compute the outcome with the published decision
   * function. The model never chooses the outcome.
   *
   * :param input: {type, sku, quantity, unused, original_packaging, photo_evidence, received}
   * :param options: {via}
   * :return: The outcome summary, or a refusal.
   */
  async fileClaim(input, { via = "page" } = {}) {
    if (!this.state.receipt) return refuse("Open a case first: there is no receipt yet.");
    if (!this.state.shop?.verified || !this.state.shop.terms) {
      // Read and check the pinned terms first (the visitor is asked before contact).
      const checked = await this.checkTerms({ via, autoFile: false });
      if (!checked.ok) return checked;
      if (!this.state.shop?.verified) return refuse(this.state.shop?.verifyNote || "The shop's terms could not be checked.");
    }
    const { receipt, shop, status } = this.state;
    if (["accepted", "confirmed", "declined", "review_requested"].includes(status)) {
      return refuse("This case already has an agreement step recorded. Start a new case to change the claim.");
    }
    const type = String(input?.type || "");
    if (!Object.hasOwn(CLAIM_TYPES, type)) return refuse(`Choose a claim type: ${Object.keys(CLAIM_TYPES).join(", ")}.`, "type");
    const rule = shop.terms.rules?.[type];
    if (!rule || rule.allowed === false) {
      return refuse(`${shop.name}'s terms version ${shop.terms.version} offer no "${CLAIM_TYPES[type]}" claims.`, "type");
    }
    const items = receipt.items || [];
    const sku = String(input?.sku || (items.length === 1 ? items[0].sku : ""));
    const item = items.find((it) => it.sku === sku);
    if (!item) return refuse(`Choose the item from the receipt: ${items.map((it) => `${it.sku} (${it.name})`).join(", ")}.`, "sku");
    const quantity = input?.quantity === undefined ? item.quantity : input.quantity;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > item.quantity) {
      return refuse(`The quantity must be between 1 and ${item.quantity}.`, "quantity");
    }
    const facts = {};
    for (const key of FACTS_BY_TYPE[type]) {
      if (input?.[key] === true || input?.[key] === false) facts[key] = input[key];
    }
    const claim = normalizeClaim({ type, sku, quantity, reported_on: this.state.claimDate || today(), facts });
    const result = await computeOutcome({ terms: shop.terms, receipt, claim, engineSha256: this.engineSha256 });
    const at = new Date().toISOString();
    if (!this.state.caseFile) {
      this.state.caseFile = await newCase({ receipt, claim, at });
    } else {
      await appendEvent(this.state.caseFile, { type: "filed", actor: "customer", at, data: { claim } });
    }
    await appendEvent(this.state.caseFile, {
      type: "outcome",
      actor: "desk",
      at,
      data: {
        fingerprint: result.fingerprint,
        decision: result.outcome.decision,
        total_cents: result.outcome.refund.total_cents,
        terms: { version: shop.terms.version, sha256: result.termsSha256 },
        engine: { name: result.outcome.engine.name, version: result.outcome.engine.version, sha256: this.engineSha256 },
        computed_by: hostOf(this.deskBase),
      },
    });
    const offers = shop.offers.map((offer) => priceOffer(offer, result.outcome)).filter(Boolean);
    Object.assign(this.state, { status: "filed", claim, outcome: result.outcome, fingerprint: result.fingerprint, offers });
    // The shop's representative is linked only once there is an outcome to discuss.
    if (shop.representative) this.onShopResolved(shop);
    this.changed();
    return { ok: true, ...this.outcomeSummary(), filed_via: via };
  }

  /**
   * Record the customer's choice and make the link for the shop. The visitor
   * confirms first, because the shop will see this choice.
   *
   * :param input: {option} "outcome" or the id of a published shop offer.
   * :param options: {via, confirmed} confirmed is true when the runtime's dialog
   *   already asked the visitor.
   * :return: {ok, case_id, choice, shop_link} or a refusal.
   */
  async acceptOption(input, { via = "page", confirmed = false } = {}) {
    const check = this.checkAccept(input);
    if (!check.ok) return check;
    if (!confirmed) {
      const yes = await this.confirm(this.acceptDialog(check.choice));
      if (!yes) return { ok: false, cancelled: true, reason: "You kept the case open. Nothing was recorded." };
    }
    const { choice } = check;
    await appendEvent(this.state.caseFile, {
      type: "accepted",
      actor: "customer",
      at: new Date().toISOString(),
      data: { option: choice.option, label: choice.label, value_cents: choice.value_cents, fingerprint: this.state.fingerprint },
    });
    const link = this.state.shop.casePage
      ? `${this.state.shop.casePage}#case=${await packForLink(this.state.caseFile)}`
      : null;
    Object.assign(this.state, { status: "accepted", accepted: choice, shopLink: link });
    this.changed();
    return {
      ok: true,
      case_id: this.state.caseFile.case_id,
      choice: `${choice.label}: ${money(choice.value_cents, this.state.outcome.currency)}`,
      next: link
        ? `The choice is recorded. The page shows a link for ${this.state.shop.name}. Tell the customer to send it to the shop: the shop opens it on its own site, checks the fingerprint and confirms. The case is settled only when the shop confirms, so do not call it final yet.`
        : "The shop publishes no case page, so send it the case file from Download record.",
      via,
    };
  }

  /**
   * Check a choice without recording it. site.js uses this before its dialog.
   *
   * :param input: {option}
   * :return: {ok, choice} or a refusal.
   */
  checkAccept(input) {
    const { outcome, status } = this.state;
    if (!outcome || !this.state.caseFile) return refuse("File the claim first, so there is an outcome to accept.");
    if (status !== "filed") return refuse("A choice is already recorded for this case.");
    const option = String(input?.option || "");
    if (option === "outcome") {
      if (outcome.decision !== "eligible") return refuse(`The computed outcome is "${DECISION_TEXT[outcome.decision]}", so there is no remedy to accept. You can choose a shop offer or ask for review by a person.`);
      return { ok: true, choice: { option, label: REMEDIES[outcome.remedy], value_cents: outcome.refund.total_cents, kind: "outcome" } };
    }
    const offer = this.state.offers.find((o) => o.id === option);
    if (!offer) {
      const ids = ["outcome", ...this.state.offers.map((o) => o.id)].join(", ");
      return refuse(`Unknown option "${option}". Choose one of: ${ids}.`, "option");
    }
    return { ok: true, choice: { option, label: offer.label, value_cents: offer.value_cents, kind: offer.kind, detail: offer.detail } };
  }

  /** The words of the confirmation dialog for a choice. */
  acceptDialog(choice) {
    const currency = this.state.outcome?.currency || "USD";
    return {
      title: "Record your choice?",
      sentence: `The case file will say you accept this option. ${this.state.shop?.name || "The shop"} then confirms it on its own site. You keep any rights you have under the law.`,
      details: {
        Case: this.state.caseFile?.case_id,
        Option: choice.label,
        Value: money(choice.value_cents, currency),
        Fingerprint: shortHash(this.state.fingerprint),
      },
      confirmLabel: "Record my choice",
      declineLabel: "Keep the case open",
    };
  }

  /**
   * Ask for a person to review the case. In this demo no reviewer is on duty, so
   * the request is recorded in the case file and the page says so.
   *
   * :param input: {reason}
   * :return: {ok, note} or a refusal.
   */
  async requestReview(input = {}, { via = "page", confirmed = false } = {}) {
    const check = this.checkReview();
    if (!check.ok) return check;
    if (!confirmed && !(await this.confirm(this.reviewDialogContent(input)))) {
      return { ok: false, cancelled: true, reason: "You did not ask for review. Nothing was recorded." };
    }
    await appendEvent(this.state.caseFile, {
      type: "review_requested",
      actor: "customer",
      at: new Date().toISOString(),
      data: { reason: String(input.reason || "").slice(0, 300) },
    });
    this.state.status = "review_requested";
    this.changed();
    return { ok: true, note: "Recorded in the case file. This demo has no reviewer on duty. A live desk would route the case file to a person.", via };
  }

  /** Check that review can be requested now. */
  checkReview() {
    if (!this.state.caseFile) return refuse("File the claim first, so there is a case to review.");
    if (["review_requested", "confirmed", "declined"].includes(this.state.status)) return refuse("This case cannot ask for review now.");
    return { ok: true };
  }

  /** The words of the confirmation dialog for a review request. */
  reviewDialogContent(input = {}) {
    return {
      title: "Ask for review by a person?",
      sentence: "The case file will record that you want a person to review the outcome. In this demo no reviewer is on duty, so nothing else happens.",
      details: { Case: this.state.caseFile?.case_id, Reason: input.reason || "Not given" },
      confirmLabel: "Ask for review",
      declineLabel: "Not now",
    };
  }

  /**
   * Open a case file, usually the one a shop sends back after confirming.
   *
   * :param caseFile: An ord-case/1 document.
   * :return: {ok, chain} or a refusal.
   */
  async loadCaseFile(caseFile) {
    if (caseFile?.protocol !== "ord-case/1" || !Array.isArray(caseFile.events)) return refuse("This is not an ord/1 case file.");
    const chain = await verifyChain(caseFile);
    this.reset();
    const filed = [...caseFile.events].reverse().find((e) => e.type === "filed");
    const outcomeEvent = latest(caseFile, "outcome");
    const confirmed = latest(caseFile, "confirmed");
    const declined = latest(caseFile, "declined");
    Object.assign(this.state, {
      status: confirmed ? "confirmed" : declined ? "declined" : latest(caseFile, "accepted") ? "accepted" : "filed",
      source: "case",
      receipt: caseFile.receipt,
      shop: { site: caseFile.receipt?.merchant?.site || "", name: caseFile.receipt?.merchant?.name || "the shop", verified: null },
      claim: filed?.data?.claim || null,
      fingerprint: outcomeEvent?.data?.fingerprint || null,
      caseFile,
      accepted: latest(caseFile, "accepted")?.data || null,
      response: { chain, confirmed: confirmed?.data || null, declined: declined?.data || null },
    });
    this.changed();
    return { ok: true, chain };
  }

  /** Download the case file as JSON. */
  downloadRecord() {
    if (!this.state.caseFile) return refuse("There is no case file yet.");
    const blob = new Blob([JSON.stringify(this.state.caseFile, null, 2)], { type: "application/json" });
    const a = el("a", { href: URL.createObjectURL(blob), download: `${this.state.caseFile.case_id}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    return { ok: true };
  }

  // ----------------------------------------------------------------- reads

  /**
   * The case as plain data for the agent. It leaves out the customer's contact
   * details, which stay in the page.
   *
   * :return: The case summary.
   */
  getCase() {
    const { status, receipt, shop, claim, outcome, story, shopDecision } = this.state;
    if (!receipt) {
      return {
        status,
        today: longDate(today()),
        next_step_for_assistant: "No case is open. Ask the visitor to open the link the shop gave them, or to press Open the sample case.",
      };
    }
    const summary = {
      status,
      today: `${longDate(today())} (${today()})`,
      case_id: this.state.caseFile?.case_id || null,
      shop: { name: shop?.name || receipt.merchant?.name, site: receipt.merchant?.site },
      order: {
        id: receipt.order_id,
        placed_on: longDate(receipt.placed_on),
        delivered_on: receipt.delivered_on ? longDate(receipt.delivered_on) : "not delivered",
        items: (receipt.items || []).map((it) => ({ sku: it.sku, name: it.name, quantity: it.quantity, price: money(it.unit_price_cents, receipt.currency), tags: it.tags || [] })),
        delivery_charge: money(receipt.delivery_charge_cents || 0, receipt.currency),
        terms_pinned: `version ${receipt.terms?.version}`,
      },
      customer_account: story || null,
      shop_form_said_before_the_desk: shopDecision ? `${shopDecision} This was the shop's own form, which used today's terms. It is not the desk's outcome.` : null,
      terms_check: shop?.verified === true
        ? { verified: true, version: shop.terms.version, current_version_today: shop.currentVersion, note: shop.verifyNote }
        : shop?.verified === false ? { verified: false, note: shop.verifyNote } : { verified: null, note: "Not read yet. website_file_claim reads them first, or call website_check_terms to show them now." },
      claim_types_offered: shop?.terms ? Object.keys(CLAIM_TYPES).filter((t) => shop.terms.rules?.[t]?.allowed !== false && shop.terms.rules?.[t]) : null,
      facts_needed: Object.fromEntries(Object.entries(FACTS_BY_TYPE).map(([t, f]) => [t, f])),
    };
    if (claim && outcome) Object.assign(summary, this.outcomeSummary());
    else summary.outcome = "Not computed yet. Do not state any decision, amount or clause until website_file_claim returns one.";
    if (this.state.accepted) summary.accepted = this.state.accepted;
    summary.next_step_for_assistant = this.nextStep();
    return summary;
  }

  /**
   * A compact copy of the case for the assistant's instructions, refreshed on
   * every invocation. Data only; it leaves out the customer's contact details.
   *
   * :return: Plain data.
   */
  promptState() {
    const { status, receipt, shop, outcome, fingerprint, offers, accepted, caseFile, story, shopDecision } = this.state;
    if (!receipt) return { status: "no case open", next: "Ask the visitor to open the link the shop gave them, or to press Open the sample case." };
    const currency = receipt.currency;
    const data = {
      today: today(),
      status,
      case_number: caseFile?.case_id || "not filed yet",
      shop: receipt.merchant?.name,
      order: `${receipt.order_id}, placed ${receipt.placed_on}, delivered ${receipt.delivered_on || "not delivered"}`,
      items: (receipt.items || []).map((it) => `${it.sku}: ${it.name}, ${money(it.unit_price_cents * it.quantity, currency)}`),
      terms_on_receipt: `version ${receipt.terms?.version}`,
      terms_check: shop?.verified === true ? `version ${shop.terms.version} read from the shop's site and matches the receipt. The shop's current version is ${shop.currentVersion}` : "not read yet",
      customer_account: story || null,
      shop_form_said: shopDecision ? `${shopDecision} (the shop's own form, using its current terms, not the desk's outcome)` : null,
    };
    const { claim } = this.state;
    if (claim) {
      const facts = Object.entries(claim.facts || {}).map(([k, v]) => `${k.replace(/_/g, " ")}: ${v ? "yes" : "no"}`).join(", ");
      data.claim = `${CLAIM_TYPES[claim.type] || claim.type} for ${claim.sku}, reported on ${claim.reported_on}${facts ? `, as stated by the customer: ${facts}` : ""}`;
    }
    if (outcome) {
      Object.assign(data, {
        outcome: summarizeOutcome(outcome),
        refund_value: money(outcome.refund.total_cents, currency),
        return_shipping: outcome.return_shipping,
        checks: outcome.checks.map((c) => `${c.passed === true ? "met" : c.passed === false ? "NOT met" : "open"}: ${c.label}${c.detail ? ` (${c.detail})` : ""}${c.clause ? ` [${c.clause}]` : ""}`),
        clauses_applied: outcome.clauses,
        notes: outcome.notes,
        fingerprint: shortHash(fingerprint),
        options_to_accept: [
          ...(outcome.decision === "eligible" ? [`outcome: ${REMEDIES[outcome.remedy]}, ${money(outcome.refund.total_cents, currency)}`] : []),
          ...offers.map((o) => `${o.id}: ${o.label}, ${money(o.value_cents, currency)} (published by the shop)`),
        ],
      });
    } else {
      data.outcome = "not computed yet: do not state a decision, amount or clause";
    }
    if (accepted) data.accepted = `${accepted.label}, ${money(accepted.value_cents, currency)}`;
    data.next = this.nextStep();
    return data;
  }

  termsSummary() {
    const { shop, receipt } = this.state;
    const clauses = shop.terms.clauses || {};
    return {
      ok: true,
      verified: shop.verified,
      note: shop.verifyNote,
      pinned_version: shop.terms.version,
      pinned_title: shop.terms.title,
      current_version_today: shop.currentVersion,
      differs_from_current: String(shop.currentVersion) !== String(shop.terms.version),
      clauses,
      claim_types_offered: Object.keys(CLAIM_TYPES).filter((t) => shop.terms.rules?.[t] && shop.terms.rules[t].allowed !== false),
      order_id: receipt.order_id,
    };
  }

  outcomeSummary() {
    const { outcome, fingerprint, offers, shop, claim } = this.state;
    const currency = outcome.currency;
    return {
      claim: { type: claim.type, label: CLAIM_TYPES[claim.type], sku: claim.sku, quantity: claim.quantity, reported_on: claim.reported_on, facts: claim.facts },
      outcome: {
        decision: outcome.decision,
        summary: summarizeOutcome(outcome),
        remedy: REMEDIES[outcome.remedy],
        refund_value: money(outcome.refund.total_cents, currency),
        item: money(outcome.refund.item_cents, currency),
        delivery: money(outcome.refund.delivery_cents, currency),
        deductions: outcome.refund.deductions.map((d) => `${d.label}: ${money(d.cents, currency)} (clause ${d.clause})`),
        return_shipping: outcome.return_shipping,
        checks: outcome.checks.map((c) => `${c.passed === true ? "met" : c.passed === false ? "NOT met" : "open"}: ${c.label}${c.detail ? ` (${c.detail})` : ""}${c.clause ? ` [clause ${c.clause}]` : ""}`),
        clauses_applied: Object.fromEntries(outcome.clauses.map((id) => [id, shop?.terms?.clauses?.[id] || ""])),
        missing_facts: outcome.missing,
        notes: outcome.notes,
        fingerprint,
        terms_version: shop?.terms?.version,
      },
      published_shop_offers: offers.map((o) => ({ id: o.id, label: o.label, value: money(o.value_cents, currency), detail: o.detail })),
      options_to_accept: [
        ...(outcome.decision === "eligible" ? [{ option: "outcome", label: REMEDIES[outcome.remedy], value: money(outcome.refund.total_cents, currency) }] : []),
        ...offers.map((o) => ({ option: o.id, label: o.label, value: money(o.value_cents, currency) })),
      ],
    };
  }

  nextStep() {
    const { status, shop, outcome } = this.state;
    if (status === "draft") return "No claim is filed. Ask for the claim type and the facts it needs, unless the customer has stated them. Then call website_file_claim with exactly what they stated. Never assume a fact.";
    if (status === "filed" && outcome?.decision === "incomplete") return `Ask for the missing facts (${outcome.missing.join(", ")}) and call website_file_claim again.`;
    if (status === "filed") return "Explain the outcome from the checks. For the text of a clause, call terms_analyst. If the visitor wants the shop's side, call shop_representative. When the visitor names an option, call website_accept_option.";
    if (status === "accepted") return "Waiting for the shop to confirm on its own site with the link on this page.";
    if (status === "confirmed") return "The shop confirmed. The case is settled.";
    if (status === "review_requested") return "A review by a person was requested.";
    return "";
  }

  // ------------------------------------------------------------ contacts

  /**
   * Add a line to the "Across sites" log.
   *
   * :param entry: {host, what, decision, via, files, error, kind}
   */
  logContact(entry) {
    this.contacts.push({ at: new Date().toISOString(), ...entry });
    this.renderContacts();
  }

  // ------------------------------------------------------------ rendering

  changed() {
    this.render();
    this.onChange(this.state);
  }

  flash(message, kind = "info") {
    const box = this.root.querySelector("#case-flash");
    if (!box) return;
    box.textContent = message;
    box.dataset.kind = kind;
    box.hidden = !message;
  }

  render() {
    const r = this.root;
    const { status, receipt, caseFile } = this.state;
    r.querySelector("#case-empty").hidden = status !== "empty";
    r.querySelector("#case-steps").hidden = status === "empty";
    r.querySelector("#case-title").textContent = caseFile ? `Case ${caseFile.case_id}` : receipt ? "New case" : "Open a case";
    r.querySelector("#case-meta").textContent = receipt
      ? `${receipt.merchant?.name || "Shop"}, order ${receipt.order_id}`
      : "Bring the link a shop gave you, a saved receipt, or try the sample case.";
    this.renderTerms();
    this.renderClaim();
    this.renderOutcome();
    this.renderShopSide();
    this.renderAgreement();
    this.renderContacts();
    for (const [id, active] of Object.entries(this.stepStates())) {
      const node = r.querySelector(`#${id}`);
      if (node) node.dataset.state = active;
    }
  }

  stepStates() {
    const { status, shop, outcome } = this.state;
    const verified = shop?.verified === true;
    return {
      "step-terms": verified ? "done" : status === "empty" ? "todo" : "current",
      "step-claim": outcome ? "done" : verified ? "current" : "todo",
      "step-outcome": outcome ? (status === "filed" ? "current" : "done") : "todo",
      "step-shop": outcome ? (status === "filed" ? "current" : "done") : "todo",
      "step-agreement": ["accepted", "confirmed", "declined", "review_requested"].includes(status)
        ? (status === "confirmed" ? "done" : "current") : outcome ? "current" : "todo",
    };
  }

  renderTerms() {
    const box = this.root.querySelector("#terms-body");
    box.replaceChildren();
    const { receipt, shop, story, shopDecision, source } = this.state;
    if (!receipt) return;
    const lines = el("dl", { class: "facts" },
      el("dt", { text: "Shop" }), el("dd", {}, el("span", { text: receipt.merchant?.name }), " ", el("span", { class: "host", text: hostOf(receipt.merchant?.site) })),
      el("dt", { text: "Order" }), el("dd", { text: `${receipt.order_id}, placed ${longDate(receipt.placed_on)}` }),
      el("dt", { text: "Delivered" }), el("dd", { text: receipt.delivered_on ? longDate(receipt.delivered_on) : "Not delivered" }),
      el("dt", { text: "Items" }), el("dd", {}, el("ul", { class: "items" }, (receipt.items || []).map((it) =>
        el("li", {}, `${it.quantity} × ${it.name}`, el("span", { class: "amount", text: money(it.unit_price_cents * it.quantity, receipt.currency) }))))),
      el("dt", { text: "Terms on the receipt" }), el("dd", {}, `Version ${receipt.terms?.version} `, el("code", { class: "hash", title: receipt.terms?.sha256, text: shortHash(receipt.terms?.sha256) })),
    );
    box.append(lines);
    if (source === "sample") box.append(el("p", { class: "note", text: `This is a sample case. Its receipt comes from the fictional ${receipt.merchant?.name || "shop"}${this.state.claimDate ? `, and it is filed as of ${longDate(this.state.claimDate)}, so it gives the same outcome on any day` : ""}.` }));
    if (story) box.append(el("blockquote", { class: "story" }, el("p", { text: story }), el("footer", { text: "The customer's account, from the shop's handoff" })));
    if (shopDecision) box.append(el("p", { class: "shop-decision" }, el("strong", { text: "What the shop decided: " }), shopDecision));
    const status = el("div", { class: "terms-status", role: "status" });
    if (shop?.verified === true) {
      status.dataset.kind = "ok";
      status.append(
        el("p", {}, el("strong", { text: `Version ${shop.terms.version} checked. ` }), shop.verifyNote),
        shop.termsSource === "copy"
          ? el("p", { class: "small", text: "Read from the copy you provided." })
          : el("p", { class: "small" }, `Read from ${shop.host}: `, el("a", { href: shop.termsUrl, text: shop.termsUrl.replace(/^https?:\/\//, "") })),
      );
      if (shop.currentVersion && String(shop.currentVersion) !== String(shop.terms.version)) {
        status.append(el("p", { class: "callout" }, `The shop's current terms are version ${shop.currentVersion}. Your case uses version ${shop.terms.version}, the version your receipt pins from the day you bought.`));
      }
    } else if (shop?.verified === false) {
      status.dataset.kind = "error";
      const copy = el("input", { type: "file", id: "terms-copy", accept: "application/json,.json" });
      copy.addEventListener("change", async () => {
        const file = copy.files?.[0];
        if (!file) return;
        const result = await this.useTermsCopy(await file.text());
        if (!result.ok) this.flash(result.reason, "error");
        copy.value = "";
      });
      status.append(
        el("p", { text: shop.verifyNote }),
        el("p", { class: "small", text: `A copy of version ${receipt.terms.version} that you saved also works, if its hash matches the receipt. Nothing is sent.` }),
        el("label", { for: "terms-copy", text: `Use your copy of version ${receipt.terms.version} (.json)` }),
        copy,
      );
    } else {
      status.append(
        el("p", { text: "The desk has not read the shop's terms yet. It reads two public files from the shop's site and sends nothing about you." }),
        el("button", { type: "button", class: "btn primary", "data-action": "check-terms", text: this.state.handoffClaim ? `Read ${receipt.merchant?.name || "the shop"}'s terms and recompute` : `Read ${receipt.merchant?.name || "the shop"}'s terms` }),
      );
    }
    box.append(status);
    if (shop?.verified === true) {
      const pinned = el("details", { class: "clauses" }, el("summary", { text: `Read version ${shop.terms.version} (${Object.keys(shop.terms.clauses || {}).length} clauses)` }),
        el("dl", {}, Object.entries(shop.terms.clauses || {}).flatMap(([id, text]) => [el("dt", { text: id }), el("dd", { class: "clause-text", text })])));
      box.append(pinned);
    }
  }

  renderClaim() {
    const box = this.root.querySelector("#claim-body");
    box.replaceChildren();
    const { receipt, shop, claim, status } = this.state;
    if (!receipt) return;
    const locked = ["accepted", "confirmed", "declined", "review_requested"].includes(status) || status === "filed" && this.state.source === "case";
    if (shop?.verified !== true) {
      box.append(el("p", { class: "muted", text: "Available after the terms check." }));
      return;
    }
    const offered = Object.keys(CLAIM_TYPES).filter((t) => shop.terms.rules?.[t] && shop.terms.rules[t].allowed !== false);
    const current = claim || { type: offered[0], sku: receipt.items?.[0]?.sku, facts: {} };
    const form = el("form", { class: "claim-form", id: "claim-form", novalidate: true });
    const typeSelect = el("select", { id: "claim-type", name: "type", disabled: locked },
      offered.map((t) => el("option", { value: t, selected: t === current.type, text: CLAIM_TYPES[t] })));
    const itemSelect = el("select", { id: "claim-sku", name: "sku", disabled: locked },
      (receipt.items || []).map((it) => el("option", { value: it.sku, selected: it.sku === current.sku, text: it.name })));
    form.append(
      el("div", { class: "field" }, el("label", { for: "claim-type", text: "What happened" }), typeSelect),
      el("div", { class: "field" }, el("label", { for: "claim-sku", text: "Item" }), itemSelect),
      el("div", { class: "field" }, el("span", { class: "label", text: "Reported on" }), el("span", { class: "value", text: `${longDate(claim?.reported_on || today())}${claim ? "" : " (today)"}` })),
    );
    const factsBox = el("fieldset", { class: "facts-box", disabled: locked }, el("legend", { text: "Facts you state" }));
    const drawFacts = () => {
      factsBox.querySelectorAll(".fact").forEach((n) => n.remove());
      const type = typeSelect.value;
      const keys = FACTS_BY_TYPE[type] || [];
      if (!keys.length) factsBox.append(el("p", { class: "fact muted", text: "No extra facts are needed for this claim type." }));
      for (const key of keys) {
        const id = `fact-${key}`;
        const value = claim?.type === type ? claim.facts?.[key] : undefined;
        factsBox.append(el("div", { class: "fact" },
          el("span", { class: "fact-label", id: `${id}-label`, text: FACT_LABELS[key] }),
          el("span", { class: "seg", role: "radiogroup", "aria-labelledby": `${id}-label` },
            el("label", {}, el("input", { type: "radio", name: key, value: "yes", checked: value === true }), "Yes"),
            el("label", {}, el("input", { type: "radio", name: key, value: "no", checked: value === false }), "No"))));
      }
    };
    typeSelect.addEventListener("change", drawFacts);
    drawFacts();
    form.append(factsBox);
    if (!locked) {
      form.append(el("div", { class: "form-actions" },
        el("button", { type: "submit", class: "btn primary", text: claim ? "Recompute the outcome" : "Compute the outcome" }),
        el("p", { class: "small muted", text: "The published decision function computes the outcome in your browser. No model decides it." })));
    }
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const input = { type: data.get("type"), sku: data.get("sku") };
      for (const key of FACTS_BY_TYPE[input.type] || []) {
        if (data.get(key) === "yes") input[key] = true;
        if (data.get(key) === "no") input[key] = false;
      }
      this.fileClaim(input, { via: "page" }).then((result) => {
        if (!result.ok) this.flash(result.reason, "error");
        else this.flash("");
      });
    });
    box.append(form);
  }

  renderOutcome() {
    const box = this.root.querySelector("#outcome-body");
    box.replaceChildren();
    const { outcome, fingerprint, shop, response } = this.state;
    if (!outcome) {
      if (fingerprint && this.state.source === "case") {
        box.append(this.fingerprintBlock(fingerprint, !!response?.confirmed), el("p", { class: "muted", text: "Open this record on the Verify page to recompute it from the published terms." }));
      } else {
        box.append(el("p", { class: "muted", text: "Appears when the claim is filed." }));
      }
      return;
    }
    const currency = outcome.currency;
    const head = el("div", { class: "verdict", "data-decision": outcome.decision },
      el("p", { class: "verdict-word", text: DECISION_TEXT[outcome.decision] }),
      el("p", { class: "verdict-line", text: verdictLine(outcome) }));
    const checks = el("ol", { class: "checks" }, outcome.checks.map((c) =>
      el("li", { "data-passed": c.passed === true ? "yes" : c.passed === false ? "no" : "open" },
        el("span", { class: "mark", "aria-hidden": "true", text: c.passed === true ? "✓" : c.passed === false ? "✕" : "?" }),
        el("span", { class: "visually-hidden", text: c.passed === true ? "Met: " : c.passed === false ? "Not met: " : "Open: " }),
        el("span", { class: "check-label", text: c.label }),
        c.clause ? el("span", { class: "clause-ref", text: `clause ${c.clause}` }) : null,
        c.detail ? el("span", { class: "check-detail", text: c.detail }) : null)));
    const amounts = el("table", { class: "amounts" },
      el("caption", { class: "visually-hidden", text: "Refund value" }),
      el("tbody", {},
        el("tr", {}, el("th", { scope: "row", text: "Item" }), el("td", { text: money(outcome.refund.item_cents, currency) })),
        el("tr", {}, el("th", { scope: "row", text: "Delivery charge" }), el("td", { text: money(outcome.refund.delivery_cents, currency) })),
        outcome.refund.deductions.map((d) => el("tr", {}, el("th", { scope: "row", text: `${d.label}, clause ${d.clause}` }), el("td", { text: `−${money(d.cents, currency)}` }))),
        el("tr", { class: "total" }, el("th", { scope: "row", text: "Refund value" }), el("td", { text: money(outcome.refund.total_cents, currency) }))));
    const shipping = outcome.return_shipping === "merchant" ? "The shop pays return shipping."
      : outcome.return_shipping === "customer" ? "You pay return shipping." : "";
    box.append(head, el("div", { class: "outcome-grid" },
      el("div", {}, el("h3", { text: "Checks against the terms" }), checks,
        outcome.notes.length ? el("ul", { class: "notes" }, outcome.notes.map((n) => el("li", { text: n }))) : null),
      el("div", {}, outcome.decision === "eligible" ? [el("h3", { text: "What you get" }), amounts, shipping ? el("p", { class: "small", text: shipping }) : null] : null,
        this.fingerprintBlock(fingerprint, false))));
    if (shop?.terms) {
      box.append(el("details", { class: "clauses" }, el("summary", { text: "Clauses applied" }),
        el("dl", {}, outcome.clauses.flatMap((id) => [el("dt", { text: id }), el("dd", { class: "clause-text", text: shop.terms.clauses?.[id] || "" })]))));
    }
  }

  fingerprintBlock(fingerprint, matched) {
    // Draw the mark in once, when a new fingerprint first appears.
    const animate = !!fingerprint && this.drawnFingerprint !== fingerprint;
    this.drawnFingerprint = fingerprint;
    return el("figure", { class: "fingerprint" },
      fingerprintMark(fingerprint, { size: 132, matched, animate }),
      el("figcaption", {},
        el("span", { class: "fp-title", text: "Outcome fingerprint" }),
        el("code", { class: "hash", title: fingerprint, text: shortHash(fingerprint) }),
        el("span", { class: "small", text: "Same terms, receipt, claim and decision function give the same fingerprint on any site." })));
  }

  renderShopSide() {
    const box = this.root.querySelector("#shop-body");
    box.replaceChildren();
    const { shop, outcome, offers } = this.state;
    if (!outcome) {
      box.append(el("p", { class: "muted", text: "Appears with the outcome." }));
      return;
    }
    const currency = outcome.currency;
    if (offers.length) {
      box.append(el("p", { text: `${shop.name} publishes these offers as data. The desk computes their value, so no agent can change it.` }),
        el("ul", { class: "offers" }, offers.map((o) => el("li", {}, el("strong", { text: o.label }), el("span", { class: "amount", text: money(o.value_cents, currency) }), o.detail ? el("span", { class: "small", text: o.detail }) : null))));
    } else {
      box.append(el("p", { text: `${shop?.name || "The shop"} publishes no offers for this outcome.` }));
    }
    if (shop?.representative) {
      box.append(el("p", { class: "small" }, "Ask the assistant to consult the shop's representative. It is the shop's own agent network, published at ",
        el("code", { text: shop.representative.replace(/^https?:\/\//, "") }), ". It runs in your browser with your model."));
    }
  }

  renderAgreement() {
    const box = this.root.querySelector("#agreement-body");
    box.replaceChildren();
    const { outcome, offers, status, accepted, shopLink, response, shop } = this.state;
    if (status === "confirmed" || status === "declined") {
      const ok = status === "confirmed";
      box.append(el("div", { class: "settled", "data-kind": ok ? "ok" : "warn" },
        el("p", { class: "verdict-word", text: ok ? "Confirmed by the shop" : "Declined by the shop" }),
        el("p", { text: ok
          ? `${shop?.name || "The shop"} recomputed the outcome on its own site and confirmed: ${accepted?.label || "the choice"}, ${money(accepted?.value_cents || 0)}.`
          : `${shop?.name || "The shop"} declined and asked for review by a person.` }),
        el("p", { class: "small", text: response?.chain?.ok ? "Every step in the case file links to the one before it. In this demo the shop's confirmation is not signed." : `The case file has problems: ${(response?.chain?.problems || []).join(" ")}` })));
      box.append(this.recordButtons());
      return;
    }
    if (status === "review_requested") {
      box.append(el("p", { text: "Review by a person was requested and recorded in the case file. This demo has no reviewer on duty." }), this.recordButtons());
      return;
    }
    if (!outcome) {
      box.append(el("p", { class: "muted", text: "Appears with the outcome." }));
      return;
    }
    if (status === "accepted") {
      box.append(el("p", {}, el("strong", { text: "Your choice is recorded: " }), `${accepted.label}, ${money(accepted.value_cents, outcome.currency)}.`));
      if (shopLink) {
        const copy = el("button", { type: "button", class: "btn", text: "Copy the link for the shop" });
        copy.addEventListener("click", async () => {
          try { await navigator.clipboard.writeText(shopLink); copy.textContent = "Link copied"; } catch { copy.textContent = "Copy failed: select the link below"; }
        });
        box.append(el("p", { text: `Send this link to ${shop.name}. The case travels inside the link, and no server keeps it. The shop opens it on its own site, recomputes the fingerprint and confirms.` }),
          el("div", { class: "row" }, copy, el("a", { class: "btn primary", href: shopLink, target: "_blank", rel: "noopener", text: `Open ${shop.name}'s case page` })),
          el("p", { class: "small" }, el("span", { text: "Link: " }), el("code", { class: "link-text", text: `${shopLink.slice(0, 72)}…` })));
      }
      box.append(this.recordButtons());
      return;
    }
    const choices = [];
    if (outcome.decision === "eligible") choices.push({ option: "outcome", label: REMEDIES[outcome.remedy], value_cents: outcome.refund.total_cents, detail: "The computed outcome under the pinned terms." });
    for (const o of offers) choices.push({ option: o.id, label: o.label, value_cents: o.value_cents, detail: o.detail });
    if (!choices.length) {
      box.append(el("p", { text: "There is nothing to accept under these terms. You can ask for review by a person." }));
    } else {
      box.append(el("ul", { class: "choices" }, choices.map((c) => {
        const btn = el("button", { type: "button", class: "btn", "data-option": c.option, text: `Accept: ${c.label}` });
        btn.addEventListener("click", () => this.acceptOption({ option: c.option }, { via: "page" }).then((res) => { if (!res.ok && !res.cancelled) this.flash(res.reason, "error"); }));
        return el("li", {}, el("div", {}, el("strong", { text: c.label }), el("span", { class: "amount", text: money(c.value_cents, outcome.currency) }), el("span", { class: "small", text: c.detail })), btn);
      })));
    }
    const review = el("button", { type: "button", class: "btn quiet", text: "Ask for review by a person" });
    review.addEventListener("click", () => this.requestReview({}, { via: "page" }).then((res) => { if (!res.ok) this.flash(res.reason, "error"); }));
    box.append(el("div", { class: "row" }, review));
  }

  recordButtons() {
    const download = el("button", { type: "button", class: "btn quiet", text: "Download the case file" });
    download.addEventListener("click", () => this.downloadRecord());
    return el("div", { class: "row" }, download, el("a", { class: "btn quiet", href: "./verify.html", text: "Verify a case file" }));
  }

  renderContacts() {
    const list = document.querySelector("#contact-log");
    if (!list) return;
    list.replaceChildren();
    if (!this.contacts.length) {
      list.append(el("li", { class: "muted", text: "No other site has been contacted yet." }));
      return;
    }
    for (const c of this.contacts) {
      const time = new Date(c.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
      list.append(el("li", { "data-kind": c.decision === "declined" || c.error ? "warn" : c.kind || "contact" },
        el("time", { datetime: c.at, text: time }),
        el("span", { class: "host", text: c.host }),
        el("span", { class: "what", text: c.what }),
        c.decision ? el("span", { class: "decision", text: c.decision === "always" ? "allowed for this visit" : c.decision === "allow" ? "allowed once" : c.decision }) : null,
        c.detail ? el("span", { class: "detail", text: c.detail }) : null,
        c.error ? el("span", { class: "detail", text: `Failed: ${c.error}` }) : null));
    }
  }
}

async function fetchOk(url) {
  const response = await fetch(url, { credentials: "omit" });
  if (!response.ok) throw new Error(`${new URL(url).pathname.split("/").pop()} returned HTTP ${response.status}`);
  return response;
}

/** Holds the page object, so site-actions.js and site.js share one copy. */
export class Desk {
  static page = null;
}
