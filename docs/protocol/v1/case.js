// case.js - case files, outcome fingerprints and links for the Open Resolution
// protocol (ord/1).
//
// A case file is a portable JSON document that the customer and the shop pass
// to each other as a link. Every step is an event whose hash covers the step
// before it, so a changed or removed step breaks the chain. The desk that
// publishes this code never receives case files: they live in the parties'
// browsers and in the links they send each other.

import { canonicalize, hashOf, sha256Hex } from "./canonical.js";
import { ENGINE, evaluateClaim } from "./evaluate.js";

export const PROTOCOL = "ord/1";
const FACT_KEYS = ["unused", "original_packaging", "photo_evidence", "received"];
const EVENT_TYPES = new Set(["filed", "outcome", "offer", "accepted", "confirmed", "declined", "review_requested"]);

/**
 * Keep only the claim fields the protocol knows, in a stable shape.
 *
 * :param claim: A claim from a form or an agent.
 * :return: {type, sku, quantity, reported_on, facts}
 */
export function normalizeClaim(claim) {
  const facts = {};
  for (const key of FACT_KEYS) {
    const value = claim?.facts?.[key];
    if (value === true || value === false) facts[key] = value;
  }
  return {
    type: String(claim?.type || ""),
    sku: String(claim?.sku || ""),
    quantity: Number.isInteger(claim?.quantity) ? claim.quantity : 1,
    reported_on: String(claim?.reported_on || ""),
    facts,
  };
}

/**
 * Hash the source text of the decision function, as fetched or read from disk.
 *
 * :param sourceText: The exact text of evaluate.js.
 * :return: "sha256:" and 64 hex characters.
 */
export async function engineHash(sourceText) {
  return `sha256:${await sha256Hex(sourceText)}`;
}

/**
 * Compute the outcome and its fingerprint. The fingerprint names the engine,
 * the terms, the receipt, the claim and the outcome together, so two parties
 * that compute the same fingerprint used the same inputs and got the same result.
 *
 * :param input: {terms, receipt, claim, contested, engineSha256}
 * :return: {outcome, fingerprint, termsSha256, receiptSha256, claim}
 * :raises Error: When the terms do not match the hash the receipt pins.
 */
export async function computeOutcome({ terms, receipt, claim, contested = [], engineSha256 }) {
  const termsSha256 = await hashOf(terms);
  if (termsSha256 !== receipt?.terms?.sha256) {
    const error = new Error(`These terms (${termsSha256}) are not the terms the receipt pins (${receipt?.terms?.sha256}).`);
    error.code = "TERMS_MISMATCH";
    throw error;
  }
  const normalized = normalizeClaim(claim);
  const outcome = evaluateClaim({ terms, receipt, claim: normalized, contested });
  const receiptSha256 = await hashOf(receipt);
  const fingerprint = await hashOf({
    protocol: "ord-outcome/1",
    engine: { name: ENGINE.name, version: ENGINE.version, sha256: engineSha256 || null },
    terms: termsSha256,
    receipt: receiptSha256,
    claim: normalized,
    outcome,
  });
  return { outcome, fingerprint, termsSha256, receiptSha256, claim: normalized };
}

/**
 * Start a case file with its "filed" event.
 *
 * :param input: {receipt, claim, at, actor}
 * :return: The new case file.
 */
export async function newCase({ receipt, claim, at, actor = "customer" }) {
  const caseFile = {
    protocol: "ord-case/1",
    case_id: "",
    receipt,
    events: [],
  };
  await appendEvent(caseFile, { type: "filed", actor, at, data: { claim: normalizeClaim(claim) } });
  caseFile.case_id = `ORD-${caseFile.events[0].hash.slice(7, 15).toUpperCase()}`;
  return caseFile;
}

/**
 * Add an event to a case file. Its hash covers its content and the previous hash.
 *
 * :param caseFile: The case file to change.
 * :param event: {type, actor, at, data}
 * :return: The stored event.
 */
export async function appendEvent(caseFile, { type, actor, at, data = {} }) {
  if (!EVENT_TYPES.has(type)) throw new RangeError(`Unknown case event type: ${type}.`);
  if (typeof at !== "string" || !at) throw new TypeError("Every case event needs a time.");
  const prev = caseFile.events.length ? caseFile.events[caseFile.events.length - 1].hash : null;
  const body = { seq: caseFile.events.length + 1, type, actor: String(actor), at, data, prev };
  const event = { ...body, hash: await hashOf(body) };
  caseFile.events.push(event);
  return event;
}

/**
 * Check that no event was changed, removed or reordered.
 *
 * :param caseFile: A case file.
 * :return: {ok, problems}
 */
export async function verifyChain(caseFile) {
  const problems = [];
  let prev = null;
  for (const [index, event] of (caseFile?.events || []).entries()) {
    const { hash, ...body } = event;
    if (body.seq !== index + 1) problems.push(`Event ${index + 1} has sequence number ${body.seq}.`);
    if (body.prev !== prev) problems.push(`Event ${index + 1} does not point to the event before it.`);
    if (await hashOf(body) !== hash) problems.push(`Event ${index + 1} (${body.type}) was changed after it was recorded.`);
    prev = hash;
  }
  if (caseFile?.events?.length) {
    const expectedId = `ORD-${caseFile.events[0].hash.slice(7, 15).toUpperCase()}`;
    if (caseFile.case_id !== expectedId) problems.push("The case number does not match the first event.");
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Find the latest event of a type.
 *
 * :param caseFile: A case file.
 * :param type: The event type.
 * :return: The event, or null.
 */
export function latest(caseFile, type) {
  const events = caseFile?.events || [];
  for (let i = events.length - 1; i >= 0; i--) if (events[i].type === type) return events[i];
  return null;
}

/**
 * Work out what a published shop offer is worth for an outcome. Offers are
 * published by the shop as data, so their value never comes from a model.
 *
 * :param offer: One entry of the shop's published offers.
 * :param outcome: The computed outcome.
 * :return: {id, kind, label, value_cents, detail} or null when the offer does
 *   not apply to this outcome.
 */
export function priceOffer(offer, outcome) {
  if (!offer || typeof offer.id !== "string") return null;
  const appliesTo = offer.applies_to || ["eligible"];
  if (!appliesTo.includes(outcome.decision)) return null;
  if (Array.isArray(offer.claim_types) && !offer.claim_types.includes(outcome.claim_type)) return null;
  if (offer.kind === "store_credit" && Number.isInteger(offer.percent_of_refund)) {
    const base = outcome.decision === "eligible" ? outcome.refund.total_cents : (offer.base_cents || 0);
    return {
      id: offer.id,
      kind: offer.kind,
      label: offer.label,
      value_cents: Math.round(base * offer.percent_of_refund / 100),
      detail: offer.detail || "",
    };
  }
  if (offer.kind === "store_credit_fixed" && Number.isInteger(offer.value_cents)) {
    return { id: offer.id, kind: offer.kind, label: offer.label, value_cents: offer.value_cents, detail: offer.detail || "" };
  }
  return null;
}

function toBase64Url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function pipeBytes(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/**
 * Pack a JSON document into compact text for a URL fragment. Fragments are not
 * sent to web servers, so a case link does not reach any host on the way.
 *
 * :param value: A JSON value.
 * :return: Compressed base64url text.
 */
export async function packForLink(value) {
  const bytes = new TextEncoder().encode(canonicalize(value));
  return toBase64Url(await pipeBytes(bytes, new CompressionStream("deflate-raw")));
}

/**
 * Unpack text made by packForLink.
 *
 * :param text: The packed text.
 * :return: The JSON value.
 * :raises Error: When the text is damaged or too large.
 */
export async function unpackFromLink(text) {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]+$/.test(text) || text.length > 200_000) {
    throw new Error("This link is damaged or incomplete.");
  }
  let bytes;
  try {
    bytes = await pipeBytes(fromBase64Url(text), new DecompressionStream("deflate-raw"));
  } catch {
    throw new Error("This link is damaged or incomplete.");
  }
  if (bytes.length > 1_000_000) throw new Error("This link holds too much data.");
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("This link is damaged or incomplete.");
  }
}
