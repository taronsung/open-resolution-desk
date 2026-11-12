// evaluate.js - the Open Resolution decision function (ord/1).
//
// A pure function: published terms + receipt + claim in, outcome out. It reads
// no clock, no network and no storage, so every party that runs it on the same
// inputs gets the same outcome. Language models never choose the outcome; they
// only collect the claim and explain the result.

export const ENGINE = Object.freeze({ name: "ord-evaluate", version: "1.0.0" });

/** Claim types the protocol knows, with plain labels. */
export const CLAIM_TYPES = Object.freeze({
  change_of_mind: "Changed my mind",
  arrived_damaged: "Arrived damaged",
  wrong_item: "Wrong item sent",
  faulty: "Stopped working (fault)",
  not_received: "Never arrived",
});

/** Remedies the protocol knows, with plain labels. */
export const REMEDIES = Object.freeze({
  refund: "Refund",
  refund_or_replacement: "Refund or replacement",
  repair_replacement_or_refund: "Repair, replacement or refund",
  refund_or_reshipment: "Refund or new shipment",
  none: "No remedy under these terms",
});

const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a calendar date in YYYY-MM-DD form to a UTC day number.
 *
 * :param value: The date text.
 * :param field: The field name, for the error message.
 * :return: Whole days since 1970-01-01.
 * :raises RangeError: When the text is not a real calendar date.
 */
export function dayNumber(value, field = "date") {
  if (typeof value !== "string" || !DATE_RE.test(value)) {
    throw new RangeError(`${field} must be a date in YYYY-MM-DD form.`);
  }
  const ms = Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10)));
  if (new Date(ms).toISOString().slice(0, 10) !== value) {
    throw new RangeError(`${field} is not a real calendar date: ${value}.`);
  }
  return Math.round(ms / DAY_MS);
}

/**
 * Format integer cents as money text, such as "$79.00".
 *
 * :param cents: An integer amount in cents.
 * :param currency: The ISO currency code. Only USD has a symbol here.
 * :return: The money text.
 */
export function money(cents, currency = "USD") {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const text = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
  return currency === "USD" ? `${sign}$${text}` : `${sign}${text} ${currency}`;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * Evaluate one claim against the terms pinned by the receipt.
 *
 * The caller must pass the terms the receipt pins. evaluateClaim checks that the
 * version matches, but checking the hash is the caller's job (see caseEngine.js),
 * because hashing is asynchronous and this function stays synchronous and pure.
 *
 * :param input: {terms, receipt, claim, contested}
 *   terms: a published ord-terms/1 document.
 *   receipt: an ord-receipt/1 document from the shop.
 *   claim: {type, sku, quantity, reported_on, facts}
 *     facts: {unused, original_packaging, photo_evidence, received}
 *   contested: optional list of fact names the shop disputes.
 * :return: The outcome: decision, remedy, refund amounts, return shipping,
 *   ordered checks with clauses, missing facts and notes.
 */
export function evaluateClaim({ terms, receipt, claim, contested = [] }) {
  const checks = [];
  const missing = [];
  const notes = [];
  const currency = receipt?.currency || terms?.currency || "USD";
  const contestedSet = new Set(Array.isArray(contested) ? contested : []);
  let blocked = false; // a failed check makes the claim not eligible
  let incomplete = false; // a needed fact is missing
  let review = false; // a needed fact is contested

  const add = (id, clause, label, passed, detail = "") => {
    checks.push({ id, clause: clause || null, label, passed, detail });
    if (passed === false) blocked = true;
  };
  const needFact = (name, label, clause) => {
    const value = claim?.facts?.[name];
    if (contestedSet.has(name)) {
      review = true;
      add(`fact:${name}`, clause, label, null, "The shop disputes this fact. A person must review it.");
      return null;
    }
    if (value === undefined || value === null) {
      incomplete = true;
      missing.push(name);
      add(`fact:${name}`, clause, label, null, "Not stated yet.");
      return null;
    }
    return value;
  };

  // 1. Inputs that every claim needs.
  if (!terms || terms.protocol !== "ord-terms/1") {
    throw new TypeError("terms must be an ord-terms/1 document.");
  }
  if (!receipt || receipt.protocol !== "ord-receipt/1") {
    throw new TypeError("receipt must be an ord-receipt/1 document.");
  }
  if (String(receipt.terms?.version) !== String(terms.version)) {
    throw new RangeError(`The receipt pins terms version ${receipt.terms?.version}, but version ${terms.version} was given.`);
  }
  const type = claim?.type;
  if (!Object.hasOwn(CLAIM_TYPES, type)) {
    throw new RangeError(`Unknown claim type: ${type}.`);
  }
  const reported = dayNumber(claim.reported_on, "claim.reported_on");
  const placed = dayNumber(receipt.placed_on, "receipt.placed_on");
  if (reported < placed) {
    throw new RangeError("The claim cannot be reported before the order was placed.");
  }

  const rule = terms.rules?.[type];
  add("covered", rule?.clause, `The terms cover "${CLAIM_TYPES[type]}" claims`, !!(rule && rule.allowed !== false),
    rule && rule.allowed !== false ? "" : "These terms do not offer this kind of claim.");

  const item = (receipt.items || []).find((it) => it.sku === claim.sku);
  const quantity = Number.isInteger(claim.quantity) ? claim.quantity : 1;
  if (!item) {
    add("on_receipt", null, "The item is on the receipt", false, `No item ${claim.sku} on order ${receipt.order_id}.`);
  } else {
    add("on_receipt", null, "The item is on the receipt", true, `${item.name}, ${plural(item.quantity, "unit")} bought.`);
    if (quantity < 1 || quantity > item.quantity) {
      add("quantity", null, "The quantity is no more than was bought", false, `Claimed ${quantity}, bought ${item.quantity}.`);
    }
  }

  // 2. Exclusions published in the terms (for example personalised items).
  if (item && rule) {
    for (const exclusion of terms.rules.exclusions || []) {
      if ((exclusion.claim_types || []).includes(type) && (item.tags || []).includes(exclusion.tag)) {
        add(`excluded:${exclusion.tag}`, exclusion.clause, `The item is not excluded (${exclusion.label || exclusion.tag})`, false,
          `${item.name} is marked "${exclusion.tag}", which these terms exclude from this kind of claim.`);
      }
    }
  }

  // 3. Time limits and facts, per claim type.
  const delivered = receipt.delivered_on ? dayNumber(receipt.delivered_on, "receipt.delivered_on") : null;
  const dispatched = receipt.dispatched_on ? dayNumber(receipt.dispatched_on, "receipt.dispatched_on") : null;
  if (rule && rule.allowed !== false) {
    if (type === "not_received") {
      const waitDays = rule.after_days ?? 14;
      if (dispatched === null) {
        add("dispatched", rule.clause, "The order was dispatched", false, "The receipt shows no dispatch date yet.");
      } else {
        const waited = reported - dispatched;
        add("waited", rule.clause, `At least ${plural(waitDays, "day")} have passed since dispatch`, waited >= waitDays,
          `${plural(waited, "day")} since dispatch on ${receipt.dispatched_on}.`);
      }
      const received = needFact("received", "The customer says the parcel did not arrive", rule.clause);
      if (received === true) add("not_arrived", rule.clause, "The parcel did not arrive", false, "The customer says it arrived.");
      if (delivered !== null && received === false) {
        review = true;
        add("carrier_record", rule.clause, "The carrier record agrees", null,
          `The receipt records delivery on ${receipt.delivered_on}. A person must compare the carrier record.`);
      }
    } else {
      const limit = type === "change_of_mind" ? rule.window_days : rule.report_within_days;
      if (delivered === null) {
        add("delivered", rule.clause, "The order was delivered", false, "The receipt shows no delivery date, so the time limit cannot start.");
      } else if (Number.isInteger(limit)) {
        const elapsed = reported - delivered;
        add("in_time", rule.clause, `Reported within ${plural(limit, "day")} of delivery`, elapsed <= limit,
          `${plural(elapsed, "day")} after delivery on ${receipt.delivered_on}.`);
      }
      if (type === "change_of_mind") {
        const requires = rule.requires || [];
        if (requires.includes("unused")) {
          const unused = needFact("unused", "The item is unused", rule.clause);
          if (unused === false) add("unused", rule.clause, "The item is unused", false, "The customer says it has been used.");
        }
        if (requires.includes("original_packaging")) {
          const packed = needFact("original_packaging", "The item is in its original packaging", rule.clause);
          if (packed === false) add("packaging", rule.clause, "The item is in its original packaging", false, "The customer says the packaging is gone.");
        }
      }
      if ((rule.requires_evidence || []).includes("photo")) {
        const photo = needFact("photo_evidence", "A photo of the problem is available", rule.clause);
        if (photo === false) {
          incomplete = true;
          if (!missing.includes("photo_evidence")) missing.push("photo_evidence");
          add("photo", rule.clause, "A photo of the problem is available", null, "These terms ask for a photo before a decision.");
        }
      }
    }
  }

  // 4. Decision and amounts.
  let decision = "eligible";
  if (blocked) decision = "not_eligible";
  else if (review) decision = "needs_review";
  else if (incomplete) decision = "incomplete";

  const refund = { item_cents: 0, delivery_cents: 0, deductions: [], total_cents: 0 };
  let remedy = "none";
  let returnShipping = "not_needed";
  if (decision === "eligible" && item && rule) {
    remedy = rule.remedy || (type === "change_of_mind" ? "refund"
      : type === "faulty" ? "repair_replacement_or_refund"
        : type === "not_received" ? "refund_or_reshipment" : "refund_or_replacement");
    const parts = rule.refund || ["item"];
    refund.item_cents = parts.includes("item") ? item.unit_price_cents * quantity : 0;
    const wholeOrder = (receipt.items || []).length === 1 && quantity === item.quantity;
    if (parts.includes("delivery")) {
      if (wholeOrder) {
        refund.delivery_cents = receipt.delivery_charge_cents || 0;
      } else {
        notes.push("The delivery charge is refunded only when the claim covers the whole order.");
      }
    } else if (receipt.delivery_charge_cents) {
      notes.push(`The delivery charge (${money(receipt.delivery_charge_cents, currency)}) is not refunded for this kind of claim.`);
    }
    if (rule.restocking_fee_percent) {
      const fee = Math.round(refund.item_cents * rule.restocking_fee_percent / 100);
      refund.deductions.push({ label: `Restocking fee (${rule.restocking_fee_percent}%)`, cents: fee, clause: rule.fee_clause || rule.clause });
    }
    if (type !== "not_received") {
      returnShipping = rule.return_shipping === "customer" ? "customer" : "merchant";
      if (returnShipping === "customer" && rule.return_label_cents) {
        refund.deductions.push({ label: "Return label", cents: rule.return_label_cents, clause: rule.shipping_clause || rule.clause });
      }
    }
    const deducted = refund.deductions.reduce((sum, d) => sum + d.cents, 0);
    refund.total_cents = Math.max(0, refund.item_cents + refund.delivery_cents - deducted);
  }

  const clauses = [...new Set(checks.map((c) => c.clause).concat(refund.deductions.map((d) => d.clause))
    .concat(returnShipping !== "not_needed" ? [rule?.shipping_clause] : []).filter(Boolean))];

  return {
    engine: { ...ENGINE },
    claim_type: type,
    decision,
    remedy,
    refund,
    currency,
    return_shipping: returnShipping,
    checks,
    clauses,
    missing,
    notes,
  };
}

/**
 * Describe an outcome in one plain sentence, for receipts and agents.
 *
 * :param outcome: The result of evaluateClaim.
 * :return: The sentence.
 */
export function summarizeOutcome(outcome) {
  const failed = outcome.checks.find((c) => c.passed === false);
  switch (outcome.decision) {
    case "eligible": {
      const total = money(outcome.refund.total_cents, outcome.currency);
      const shipping = outcome.return_shipping === "merchant" ? " The shop pays return shipping."
        : outcome.return_shipping === "customer" ? " The customer pays return shipping." : "";
      return `Eligible: ${REMEDIES[outcome.remedy]}, refund value ${total}.${shipping}`;
    }
    case "not_eligible":
      return failed
        ? `Not eligible: "${failed.label}" is not met${failed.detail ? ` (${failed.detail.replace(/\.$/, "")})` : ""}${failed.clause ? `, clause ${failed.clause}` : ""}.`
        : "Not eligible: a condition in the terms is not met.";
    case "needs_review":
      return "Needs review by a person: a fact is disputed.";
    default:
      return `Incomplete: still needed: ${outcome.missing.join(", ")}.`;
  }
}
