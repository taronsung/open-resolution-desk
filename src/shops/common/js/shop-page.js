// shop-page.js - the storefront, orders and returns of a fictional demo shop.
//
// One ShopPage object holds the page state. The page's buttons and the agent's
// website_* tools call the same methods. Orders live in this browser only: the
// seeded sample orders ship with the site, and demo checkouts are kept in
// localStorage. No payment is taken and nothing is shipped.
//
// The shop's own returns form applies the shop's CURRENT terms to every order.
// That is the realistic flaw this demo is about: the Open Resolution Desk applies
// the terms each receipt pins, the ones in force on the day of purchase.

import { SHOP } from "../data/shop-data.js";
import { hashOf, shortHash } from "../protocol/v1/canonical.js";
import { CLAIM_TYPES, evaluateClaim, money, summarizeOutcome } from "../protocol/v1/evaluate.js";
import { packForLink } from "../protocol/v1/case.js";

const ORDERS_KEY = `${SHOP.id}-demo-orders-v1`;
const CART_KEY = `${SHOP.id}-demo-cart-v1`;

/** Today's date in the visitor's time zone, as YYYY-MM-DD. */
export function today() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** A date with its weekday, such as "Fri, 13 Nov 2026". */
export function longDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return String(value || "");
  const [y, m, d] = value.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

function readJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || "null") ?? fallback; } catch { return fallback; }
}
function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: keep in memory */ }
}
function refuse(reason, field) {
  return field ? { ok: false, reason, field } : { ok: false, reason };
}
function sameEmail(a, b) {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}

export class ShopPage {
  constructor() {
    this.terms = {}; // version -> terms document
    this.cart = readJson(CART_KEY, {});
    this.cartVersion = 0;
    this.localOrders = readJson(ORDERS_KEY, []);
    this.found = null; // the order shown in "Your orders"
    this.lastReturn = null; // the latest returns decision
    this.handoff = null; // {link, order_id}
    this.listeners = new Set();
  }

  /** Load every published terms version (same site). */
  async loadTerms() {
    for (const [version, entry] of Object.entries(SHOP.terms.versions)) {
      this.terms[version] = await (await fetch(new URL(`../${entry.path}`, import.meta.url))).json();
    }
  }

  onChange(fn) { this.listeners.add(fn); }
  changed() { for (const fn of this.listeners) fn(this); }

  currentTerms() { return this.terms[SHOP.terms.current]; }

  /** Every order this browser knows: the shipped samples and demo checkouts. */
  allOrders() { return [...SHOP.orders, ...this.localOrders]; }

  // --------------------------------------------------------------- reads

  /**
   * The shop's catalog, current returns terms in brief, and what it cannot do.
   *
   * :return: Plain data for the agent and the page.
   */
  getShopInfo() {
    const terms = this.currentTerms();
    const rules = terms?.rules || {};
    return {
      shop: SHOP.name,
      today: `${longDate(today())} (${today()})`,
      catalog: SHOP.catalog.map((p) => ({ sku: p.sku, name: p.name, price: money(p.price_cents), about: p.blurb, tags: p.tags })),
      delivery_charge: money(SHOP.delivery_charge_cents),
      returns_terms_now: {
        version: terms?.version,
        effective_from: terms?.effective_from,
        change_of_mind_days: rules.change_of_mind?.window_days ?? null,
        clauses: terms?.clauses || {},
      },
      older_versions: Object.entries(SHOP.terms.versions).filter(([v]) => v !== SHOP.terms.current)
        .map(([v, e]) => ({ version: v, in_force: `${e.effective_from} to ${e.effective_until || "-"}` })),
      disputes: `If a customer disagrees with a returns decision, they can take the case to the Open Resolution Desk (${SHOP.desk}), a neutral procedure this shop follows (clause 5.1).`,
      cannot_do: SHOP.cannot_do,
    };
  }

  /**
   * Find an order by number and the email on it. Returns the order only when both
   * match, so nobody can read someone else's order with a guess.
   *
   * :param input: {order_id, email}
   * :return: {ok, order} or a refusal.
   */
  lookUpOrder(input = {}) {
    const result = this.findOrder(input);
    if (!result.ok) return result;
    if (this.found?.order_id !== result.order.order_id) {
      this.lastReturn = null;
      this.handoff = null;
    }
    this.found = result.order;
    this.changed();
    return { ok: true, order: this.orderView(result.order) };
  }

  /** Find an order by number and email without changing the page. */
  findOrder({ order_id, email } = {}) {
    const id = String(order_id || "").trim().toUpperCase();
    if (!/^[A-Z]{2}-\d{4}$/.test(id)) return refuse(`Order numbers look like ${SHOP.prefix}-2207: two letters, a dash and four digits.`, "order_id");
    const order = this.allOrders().find((o) => o.order_id === id);
    if (!order || !sameEmail(order.customer?.email, email)) {
      return refuse("No order matches that number and email. Check both and try again.", "email");
    }
    return { ok: true, order };
  }

  orderView(order) {
    const pinned = SHOP.terms.versions[order.terms.version];
    return {
      order_id: order.order_id,
      placed_on: longDate(order.placed_on),
      dispatched_on: order.dispatched_on ? longDate(order.dispatched_on) : "not dispatched",
      delivered_on: order.delivered_on ? longDate(order.delivered_on) : "not delivered",
      items: order.items.map((it) => ({ sku: it.sku, name: it.name, quantity: it.quantity, price: money(it.unit_price_cents * it.quantity), tags: it.tags })),
      delivery_charge: money(order.delivery_charge_cents),
      terms_on_receipt: { version: order.terms.version, fingerprint: shortHash(order.terms.sha256), in_force: pinned ? `${pinned.effective_from} to ${pinned.effective_until || "today"}` : "unknown" },
      sample: SHOP.sample_order_ids.includes(order.order_id),
    };
  }

  /**
   * A compact copy of the page for the assistant's instructions, refreshed on
   * every invocation. It holds only what this customer already unlocked on the
   * page with their order number and email.
   *
   * :return: Plain data.
   */
  promptState() {
    const terms = this.currentTerms();
    const data = {
      today: today(),
      shop_terms_today: `version ${terms?.version}, in force from ${terms?.effective_from}`,
    };
    if (this.found) {
      const o = this.found;
      data.order_on_page = {
        order_id: o.order_id,
        email_matched: true,
        placed_on: o.placed_on,
        delivered_on: o.delivered_on,
        items: o.items.map((it) => `${it.sku}: ${it.name}`),
        terms_version_on_receipt: o.terms.version,
      };
    }
    if (this.lastReturn) data.last_returns_decision = this.lastReturn.decision;
    data.desk_handoff_link_ready = !!this.handoff;
    return data;
  }

  // ---------------------------------------------------------- operations

  /**
   * The shop's own returns check. It applies the shop's current terms to every
   * order, as many shops do. The decision is shown and returned; nothing else
   * changes.
   *
   * :param input: {order_id, email, sku, type, unused, original_packaging, photo_evidence, received}
   * :return: {ok, decision, ...} or a refusal.
   */
  async startReturn(input = {}) {
    const found = this.findOrder(input);
    if (!found.ok) return found;
    const order = found.order;
    this.found = order;
    const type = String(input.type || "");
    if (!Object.hasOwn(CLAIM_TYPES, type)) return refuse(`Choose a reason: ${Object.keys(CLAIM_TYPES).join(", ")}.`, "type");
    const sku = String(input.sku || (order.items.length === 1 ? order.items[0].sku : ""));
    if (!order.items.some((it) => it.sku === sku)) return refuse(`Choose an item on order ${order.order_id}: ${order.items.map((it) => it.sku).join(", ")}.`, "sku");
    const current = this.currentTerms();
    // The shop's form judges every order under today's terms (see the file header).
    const asIfToday = { ...order, terms: { version: current.version, url: SHOP.terms.versions[current.version].url, sha256: await hashOf(current) } };
    const facts = {};
    for (const key of ["unused", "original_packaging", "photo_evidence", "received"]) {
      if (input[key] === true || input[key] === false) facts[key] = input[key];
    }
    const outcome = evaluateClaim({ terms: current, receipt: asIfToday, claim: { type, sku, quantity: input.quantity || undefined, reported_on: today(), facts } });
    const decision = `${summarizeOutcome(outcome)} (our returns terms, version ${current.version})`;
    this.lastReturn = { order_id: order.order_id, type, sku, facts, decision, outcome_decision: outcome.decision, terms_version: current.version };
    this.handoff = null;
    if (outcome.decision !== "eligible") {
      // Clause 5.1: a refused customer can take the case to the desk. The link is
      // ready at once; it sends nothing until the customer opens it.
      await this.prepareDeskHandoff({ order_id: order.order_id, email: order.customer.email, story: this.handoffDraft || "" });
    }
    this.changed();
    return {
      ok: true,
      decision,
      eligible: outcome.decision === "eligible",
      terms_version_used: current.version,
      terms_version_on_receipt: order.terms.version,
      next: outcome.decision === "eligible"
        ? "A return label would be emailed. This demo shop sends nothing."
        : "The page now shows a button that opens this case at the Open Resolution Desk. To add the customer's own account to it, call website_prepare_desk_handoff.",
    };
  }

  /**
   * Make the handoff link that opens this case at the Open Resolution Desk. The
   * case travels inside the link's #fragment, which browsers do not send to any
   * server. Nothing is sent until the customer opens the link.
   *
   * :param input: {order_id, email, story}
   * :return: {ok, link} or a refusal.
   */
  async prepareDeskHandoff(input = {}) {
    const found = this.findOrder(input);
    if (!found.ok) return found;
    const order = found.order;
    const story = String(input.story || "").trim().slice(0, 600);
    const shopDecision = this.lastReturn?.order_id === order.order_id ? this.lastReturn.decision : "";
    const last = this.lastReturn?.order_id === order.order_id ? this.lastReturn : null;
    const claim = last ? { type: last.type, sku: last.sku, facts: last.facts } : undefined;
    const packed = await packForLink({ protocol: "ord-handoff/1", receipt: order, story, shop_decision: shopDecision, ...(claim ? { claim } : {}) });
    const link = `${SHOP.desk}/case.html#handoff=${packed}`;
    this.found = order;
    this.handoff = { link, order_id: order.order_id };
    this.changed();
    return { ok: true, link, note: "The page shows a button that opens the case at the Open Resolution Desk in a new tab." };
  }

  // ------------------------------------------------------------- the cart

  addToCart({ sku, quantity = 1 } = {}) {
    const product = SHOP.catalog.find((p) => p.sku === sku);
    if (!product) return refuse(`No product ${sku}.`, "sku");
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 9) return refuse("Choose a quantity from 1 to 9.", "quantity");
    this.cart[sku] = Math.min(9, (this.cart[sku] || 0) + quantity);
    this.cartVersion += 1;
    writeJson(CART_KEY, this.cart);
    this.changed();
    return { ok: true, cart: this.cartView() };
  }

  setQuantity(sku, quantity) {
    if (!this.cart[sku]) return refuse(`${sku} is not in the cart.`);
    if (quantity <= 0) delete this.cart[sku];
    else this.cart[sku] = Math.min(9, quantity);
    this.cartVersion += 1;
    writeJson(CART_KEY, this.cart);
    this.changed();
    return { ok: true, cart: this.cartView() };
  }

  cartView() {
    const lines = Object.entries(this.cart).map(([sku, quantity]) => {
      const p = SHOP.catalog.find((x) => x.sku === sku);
      return p ? { sku, name: p.name, quantity, line_cents: p.price_cents * quantity } : null;
    }).filter(Boolean);
    const items = lines.reduce((s, l) => s + l.line_cents, 0);
    return { lines, items_cents: items, delivery_cents: lines.length ? SHOP.delivery_charge_cents : 0, total_cents: items + (lines.length ? SHOP.delivery_charge_cents : 0), version: this.cartVersion };
  }

  /**
   * Place a demo order for the cart. No payment is taken. The receipt pins the
   * terms in force today by version and hash.
   *
   * :param input: {name, email}
   * :return: {ok, receipt} or a refusal.
   */
  async checkout({ name, email } = {}) {
    const cart = this.cartView();
    if (!cart.lines.length) return refuse("The cart is empty.");
    const cleanName = String(name || "").trim();
    const cleanEmail = String(email || "").trim();
    if (cleanName.length < 2 || cleanName.length > 80) return refuse("Enter your name (2 to 80 characters).", "name");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) return refuse("Enter an email address like you@example.com.", "email");
    const current = this.currentTerms();
    const number = 2400 + this.localOrders.length + 1;
    const date = today();
    const receipt = {
      protocol: "ord-receipt/1",
      merchant: { id: SHOP.id, name: SHOP.name, site: SHOP.site },
      order_id: `${SHOP.prefix}-${number}`,
      customer: { name: cleanName, email: cleanEmail },
      placed_on: date,
      dispatched_on: date,
      delivered_on: date,
      currency: "USD",
      items: cart.lines.map((l) => {
        const p = SHOP.catalog.find((x) => x.sku === l.sku);
        return { sku: l.sku, name: p.name, unit_price_cents: p.price_cents, quantity: l.quantity, tags: p.tags || [] };
      }),
      delivery_charge_cents: SHOP.delivery_charge_cents,
      terms: { version: current.version, url: SHOP.terms.versions[current.version].url, sha256: await hashOf(current) },
      demo_note: "Demo order: no payment taken. Marked delivered the same day so returns can be tried.",
    };
    this.localOrders.push(receipt);
    writeJson(ORDERS_KEY, this.localOrders);
    this.cart = {};
    this.cartVersion += 1;
    writeJson(CART_KEY, this.cart);
    this.found = receipt;
    this.changed();
    return { ok: true, receipt };
  }
}

export class Shop {
  static page = null;
}
