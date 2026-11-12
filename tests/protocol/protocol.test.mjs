// Tests for the ord/1 protocol module: canonical JSON, the decision function,
// fingerprints, case chains and link packing. Run: node --test build/protocol/tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { canonicalize, hashOf, shortHash } from "../../protocol/v1/canonical.js";
import { evaluateClaim, summarizeOutcome, dayNumber, money } from "../../protocol/v1/evaluate.js";
import { computeOutcome, newCase, appendEvent, verifyChain, packForLink, unpackFromLink, priceOffer, engineHash, latest } from "../../protocol/v1/case.js";

const shops = new URL("../../src/shops/", import.meta.url);
const load = async (rel) => JSON.parse(await readFile(new URL(rel, shops), "utf8"));
const v2 = await load("brackenlight/terms/v2.json");
const v3 = await load("brackenlight/terms/v3.json");
const coppice = await load("coppice/terms/v1.json");

async function receiptFor(terms, overrides = {}) {
  return {
    protocol: "ord-receipt/1",
    merchant: { id: terms.merchant.id, name: terms.merchant.name, site: "http://127.0.0.1:8091/brackenlight" },
    order_id: "BL-2207",
    placed_on: "2026-09-21",
    dispatched_on: "2026-09-22",
    delivered_on: "2026-09-25",
    currency: "USD",
    items: [{ sku: "lamp-ash-glaze", name: "Ash Glaze Table Lamp", unit_price_cents: 7900, quantity: 1, tags: [] }],
    delivery_charge_cents: 650,
    terms: { version: terms.version, url: `./terms/v${terms.version}.json`, sha256: await hashOf(terms) },
    ...overrides,
  };
}
const changeOfMind = (reported_on, facts = { unused: true, original_packaging: true }) =>
  ({ type: "change_of_mind", sku: "lamp-ash-glaze", quantity: 1, reported_on, facts });

test("canonical JSON sorts keys and rejects non-integers", () => {
  assert.equal(canonicalize({ b: 1, a: [true, null, "x"], c: { z: 0, y: "é" } }), '{"a":[true,null,"x"],"b":1,"c":{"y":"é","z":0}}');
  assert.throws(() => canonicalize({ a: 1.5 }), TypeError);
  assert.throws(() => canonicalize({ a: undefined }), TypeError);
  assert.throws(() => canonicalize({ a: NaN }), TypeError);
});

test("hashOf is stable and independent of key order", async () => {
  const one = await hashOf({ a: 1, b: [1, 2] });
  const two = await hashOf({ b: [1, 2], a: 1 });
  assert.equal(one, two);
  assert.match(one, /^sha256:[0-9a-f]{64}$/);
  assert.match(shortHash(one), /^sha256:[0-9a-f]{4}…[0-9a-f]{4}$/);
});

test("dates are calendar dates and money is formatted from cents", () => {
  assert.equal(dayNumber("2026-09-25") + 49, dayNumber("2026-11-13"));
  assert.throws(() => dayNumber("2026-02-30"), RangeError);
  assert.throws(() => dayNumber("13/11/2026"), RangeError);
  assert.equal(money(7900), "$79.00");
  assert.equal(money(5), "$0.05");
});

test("the version-2 lamp case is eligible under the terms the receipt pins", async () => {
  const outcome = evaluateClaim({ terms: v2, receipt: await receiptFor(v2), claim: changeOfMind("2026-11-13") });
  assert.equal(outcome.decision, "eligible");
  assert.equal(outcome.remedy, "refund");
  assert.equal(outcome.refund.item_cents, 7900);
  assert.equal(outcome.refund.delivery_cents, 0);
  assert.equal(outcome.refund.total_cents, 7900);
  assert.equal(outcome.return_shipping, "merchant");
  assert.deepEqual(outcome.clauses, ["2.1", "2.2"]);
  assert.match(summarizeOutcome(outcome), /^Eligible: Refund, refund value \$79\.00\. The shop pays return shipping\.$/);
  assert.ok(outcome.notes.some((n) => n.includes("$6.50")));
});

test("the same claim under version 3 would fail the 30-day window", async () => {
  const outcome = evaluateClaim({ terms: v3, receipt: await receiptFor(v3), claim: changeOfMind("2026-11-13") });
  assert.equal(outcome.decision, "not_eligible");
  const failed = outcome.checks.find((c) => c.passed === false);
  assert.equal(failed.id, "in_time");
  assert.equal(failed.clause, "2.1");
  assert.match(failed.detail, /49 days after delivery/);
});

test("the decision function refuses terms that are not the pinned version", async () => {
  const pinnedV2 = await receiptFor(v2);
  assert.throws(() => evaluateClaim({ terms: v3, receipt: pinnedV2, claim: changeOfMind("2026-11-13") }), RangeError);
});

test("window boundaries: day 120 is in, day 121 is out", async () => {
  const receipt = await receiptFor(v2);
  assert.equal(evaluateClaim({ terms: v2, receipt, claim: changeOfMind("2027-01-23") }).decision, "eligible");
  assert.equal(evaluateClaim({ terms: v2, receipt, claim: changeOfMind("2027-01-24") }).decision, "not_eligible");
});

test("version 3 deducts the return label and needs the item unused", async () => {
  const receipt = await receiptFor(v3, { delivered_on: "2026-11-01", placed_on: "2026-10-28", dispatched_on: "2026-10-29" });
  const ok = evaluateClaim({ terms: v3, receipt, claim: changeOfMind("2026-11-13") });
  assert.equal(ok.decision, "eligible");
  assert.equal(ok.return_shipping, "customer");
  assert.deepEqual(ok.refund.deductions.map((d) => d.cents), [800]);
  assert.equal(ok.refund.total_cents, 7100);
  const used = evaluateClaim({ terms: v3, receipt, claim: changeOfMind("2026-11-13", { unused: false, original_packaging: true }) });
  assert.equal(used.decision, "not_eligible");
  const unknown = evaluateClaim({ terms: v3, receipt, claim: changeOfMind("2026-11-13", {}) });
  assert.equal(unknown.decision, "incomplete");
  assert.deepEqual(unknown.missing, ["unused", "original_packaging"]);
});

test("a contested fact sends the case to a person", async () => {
  const outcome = evaluateClaim({ terms: v2, receipt: await receiptFor(v2), claim: changeOfMind("2026-11-13"), contested: ["unused"] });
  assert.equal(outcome.decision, "needs_review");
  assert.equal(outcome.refund.total_cents, 0);
});

test("damaged items need a photo, then refund item and delivery", async () => {
  const receipt = await receiptFor(v2);
  const claim = { type: "arrived_damaged", sku: "lamp-ash-glaze", reported_on: "2026-10-01", facts: {} };
  assert.equal(evaluateClaim({ terms: v2, receipt, claim }).decision, "incomplete");
  claim.facts.photo_evidence = true;
  const outcome = evaluateClaim({ terms: v2, receipt, claim });
  assert.equal(outcome.decision, "eligible");
  assert.equal(outcome.refund.total_cents, 7900 + 650);
  assert.equal(outcome.remedy, "refund_or_replacement");
  claim.reported_on = "2026-10-10";
  assert.equal(evaluateClaim({ terms: v2, receipt, claim }).decision, "not_eligible");
});

test("made-to-order wheels are excluded from change-of-mind returns", async () => {
  const receipt = await receiptFor(coppice, {
    merchant: { id: "coppice", name: "Coppice Cycles", site: "http://127.0.0.1:8091/coppice" },
    order_id: "CC-5531", placed_on: "2026-10-30", dispatched_on: "2026-11-04", delivered_on: "2026-11-06",
    items: [{ sku: "wheelset-custom", name: "Hand-built 700c wheelset", unit_price_cents: 42000, quantity: 1, tags: ["custom"] }],
    delivery_charge_cents: 1200,
  });
  const claim = { type: "change_of_mind", sku: "wheelset-custom", reported_on: "2026-11-13", facts: { unused: true, original_packaging: true } };
  const outcome = evaluateClaim({ terms: coppice, receipt, claim });
  assert.equal(outcome.decision, "not_eligible");
  assert.equal(outcome.checks.find((c) => c.passed === false).clause, "4.1");
  const faulty = evaluateClaim({ terms: coppice, receipt, claim: { ...claim, type: "faulty", facts: {} } });
  assert.equal(faulty.decision, "eligible");
  assert.equal(faulty.remedy, "repair_replacement_or_refund");
});

test("restocking fee applies to change-of-mind returns at Coppice", async () => {
  const receipt = await receiptFor(coppice, {
    order_id: "CC-5600", placed_on: "2026-11-01", dispatched_on: "2026-11-02", delivered_on: "2026-11-04",
    items: [{ sku: "tyre-32", name: "32 mm road tyre", unit_price_cents: 5500, quantity: 2, tags: [] }],
    delivery_charge_cents: 600,
  });
  const outcome = evaluateClaim({ terms: coppice, receipt, claim: { type: "change_of_mind", sku: "tyre-32", quantity: 2, reported_on: "2026-11-13", facts: { unused: true, original_packaging: true } } });
  assert.equal(outcome.refund.item_cents, 11000);
  assert.deepEqual(outcome.refund.deductions, [{ label: "Restocking fee (10%)", cents: 1100, clause: "2.3" }]);
  assert.equal(outcome.refund.total_cents, 9900);
  assert.equal(outcome.return_shipping, "customer");
});

test("parcels that never arrived: wait time, carrier record and the customer's statement", async () => {
  const pending = await receiptFor(v2, { delivered_on: null });
  const claim = { type: "not_received", sku: "lamp-ash-glaze", reported_on: "2026-10-01", facts: { received: false } };
  assert.equal(evaluateClaim({ terms: v2, receipt: pending, claim }).decision, "not_eligible");
  claim.reported_on = "2026-10-06";
  const outcome = evaluateClaim({ terms: v2, receipt: pending, claim });
  assert.equal(outcome.decision, "eligible");
  assert.equal(outcome.refund.total_cents, 8550);
  assert.equal(outcome.return_shipping, "not_needed");
  const delivered = evaluateClaim({ terms: v2, receipt: await receiptFor(v2), claim });
  assert.equal(delivered.decision, "needs_review");
});

test("an item that is not on the receipt is not eligible", async () => {
  const outcome = evaluateClaim({ terms: v2, receipt: await receiptFor(v2), claim: { ...changeOfMind("2026-11-13"), sku: "vase-moss" } });
  assert.equal(outcome.decision, "not_eligible");
});

test("computeOutcome checks the pinned terms hash and gives a stable fingerprint", async () => {
  const receipt = await receiptFor(v2);
  const engineSha256 = await engineHash(await readFile(new URL("../../protocol/v1/evaluate.js", import.meta.url), "utf8"));
  const first = await computeOutcome({ terms: v2, receipt, claim: changeOfMind("2026-11-13"), engineSha256 });
  const second = await computeOutcome({ terms: JSON.parse(JSON.stringify(v2)), receipt: JSON.parse(JSON.stringify(receipt)), claim: changeOfMind("2026-11-13"), engineSha256 });
  assert.equal(first.fingerprint, second.fingerprint);
  const other = await computeOutcome({ terms: v2, receipt, claim: changeOfMind("2026-11-14"), engineSha256 });
  assert.notEqual(first.fingerprint, other.fingerprint);
  const tampered = JSON.parse(JSON.stringify(v2));
  tampered.rules.change_of_mind.window_days = 365;
  await assert.rejects(computeOutcome({ terms: tampered, receipt, claim: changeOfMind("2026-11-13"), engineSha256 }), (e) => e.code === "TERMS_MISMATCH");
});

test("case chains detect edits and keep a case number", async () => {
  const receipt = await receiptFor(v2);
  const caseFile = await newCase({ receipt, claim: changeOfMind("2026-11-13"), at: "2026-11-13T10:00:00Z" });
  assert.match(caseFile.case_id, /^ORD-[0-9A-F]{8}$/);
  await appendEvent(caseFile, { type: "outcome", actor: "desk", at: "2026-11-13T10:01:00Z", data: { fingerprint: "sha256:x" } });
  await appendEvent(caseFile, { type: "accepted", actor: "customer", at: "2026-11-13T10:02:00Z", data: { option: "outcome" } });
  assert.deepEqual(await verifyChain(caseFile), { ok: true, problems: [] });
  assert.equal(latest(caseFile, "accepted").data.option, "outcome");
  const edited = JSON.parse(JSON.stringify(caseFile));
  edited.events[1].data.fingerprint = "sha256:y";
  const result = await verifyChain(edited);
  assert.equal(result.ok, false);
  assert.match(result.problems.join(" "), /changed after it was recorded/);
  const removed = JSON.parse(JSON.stringify(caseFile));
  removed.events.splice(1, 1);
  assert.equal((await verifyChain(removed)).ok, false);
  await assert.rejects(appendEvent(caseFile, { type: "gossip", actor: "x", at: "t" }), RangeError);
});

test("links pack and unpack a case file", async () => {
  const receipt = await receiptFor(v2);
  const caseFile = await newCase({ receipt, claim: changeOfMind("2026-11-13"), at: "2026-11-13T10:00:00Z" });
  const packed = await packForLink(caseFile);
  assert.match(packed, /^[A-Za-z0-9_-]+$/);
  assert.ok(packed.length < 1500, `packed length ${packed.length}`);
  assert.deepEqual(await unpackFromLink(packed), JSON.parse(canonicalize(caseFile)));
  await assert.rejects(unpackFromLink("not a link!"), /damaged/);
});

test("published offers are priced from data, not from a model", async () => {
  const outcome = evaluateClaim({ terms: v2, receipt: await receiptFor(v2), claim: changeOfMind("2026-11-13") });
  const offer = { id: "credit-115", kind: "store_credit", label: "Store credit", percent_of_refund: 115, applies_to: ["eligible"] };
  assert.equal(priceOffer(offer, outcome).value_cents, 9085);
  const refused = evaluateClaim({ terms: v3, receipt: await receiptFor(v3), claim: changeOfMind("2026-11-13") });
  assert.equal(priceOffer(offer, refused), null);
  assert.equal(priceOffer({ id: "goodwill", kind: "store_credit_fixed", label: "Workshop credit", value_cents: 4000, applies_to: ["not_eligible"] }, refused).value_cents, 4000);
});

test("offers can be limited to claim types", async () => {
  const outcome = evaluateClaim({ terms: v2, receipt: await receiptFor(v2), claim: changeOfMind("2026-11-13") });
  const onlyDamaged = { id: "x", kind: "store_credit", label: "Credit", percent_of_refund: 110, applies_to: ["eligible"], claim_types: ["arrived_damaged"] };
  assert.equal(priceOffer(onlyDamaged, outcome), null);
  assert.equal(priceOffer({ ...onlyDamaged, claim_types: ["change_of_mind"] }, outcome).value_cents, 8690);
});
