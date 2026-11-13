// shop-main.js - renders the storefront, basket, orders and returns, and wires
// the page's own forms to ShopPage. site.js adds the assistant on top.

import { Shop, ShopPage, longDate } from "./shop-page.js";
import { SHOP } from "../data/shop-data.js";
import { CLAIM_TYPES, money } from "../protocol/v1/evaluate.js";
import { shortHash } from "../protocol/v1/canonical.js";
import { exposeWebMcpTools } from "./webmcp.js";

const FACTS = {
  change_of_mind: [["unused", "The item is unused"], ["original_packaging", "It is in its original packaging"]],
  arrived_damaged: [["photo_evidence", "I have a photo of the damage"]],
  wrong_item: [],
  faulty: [],
  not_received: [["received", "The parcel arrived"]],
};

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

function showError(form, result) {
  const box = form.querySelector(".form-error");
  if (box) box.textContent = result.ok ? "" : result.reason;
  if (!result.ok && result.field) form.querySelector(`[name="${result.field}"]`)?.focus();
}

function renderProducts(page) {
  const list = document.querySelector("#products");
  list.replaceChildren(...SHOP.catalog.map((p) => {
    const add = el("button", { type: "button", class: "btn", text: "Add to basket", "aria-label": `Add ${p.name} to basket` });
    add.addEventListener("click", () => {
      page.addToCart({ sku: p.sku, quantity: 1 });
      add.textContent = "Added";
      setTimeout(() => { add.textContent = "Add to basket"; }, 1200);
    });
    return el("li", { class: "product" },
      el("img", { src: `./img/${p.image}`, alt: "", width: "240", height: "180", loading: "lazy" }),
      el("h3", { text: p.name }),
      el("p", { class: "blurb", text: p.blurb }),
      (p.tags || []).includes("personalised") || (p.tags || []).includes("custom") ? el("p", { class: "tag", text: "Made for you: no change-of-mind returns" }) : null,
      el("p", { class: "price", text: money(p.price_cents) }),
      add);
  }));
}

function renderCart(page) {
  const cart = page.cartView();
  const count = cart.lines.reduce((s, l) => s + l.quantity, 0);
  document.querySelectorAll("[data-cart-count]").forEach((n) => { n.textContent = String(count); });
  const body = document.querySelector("#cart-body");
  const form = document.querySelector("#checkout-form");
  if (!cart.lines.length) {
    body.replaceChildren(el("p", { class: "muted", text: "Your basket is empty." }));
    form.hidden = true;
    return;
  }
  form.hidden = false;
  body.replaceChildren(el("table", { class: "cart" },
    el("caption", { class: "visually-hidden", text: "Basket" }),
    el("thead", {}, el("tr", {}, el("th", { scope: "col", text: "Item" }), el("th", { scope: "col", text: "Quantity" }), el("th", { scope: "col", text: "Price" }))),
    el("tbody", {}, cart.lines.map((l) => {
      const qty = el("input", { type: "number", min: "0", max: "9", value: String(l.quantity), "aria-label": `Quantity of ${l.name}`, inputmode: "numeric" });
      qty.addEventListener("change", () => page.setQuantity(l.sku, Number(qty.value)));
      return el("tr", {}, el("td", { text: l.name }), el("td", {}, qty), el("td", { text: money(l.line_cents) }));
    })),
    el("tfoot", {},
      el("tr", {}, el("th", { scope: "row", colspan: "2", text: "Delivery" }), el("td", { text: money(cart.delivery_cents) })),
      el("tr", {}, el("th", { scope: "row", colspan: "2", text: "Total" }), el("td", { text: money(cart.total_cents) })))));
}

function renderOrder(page) {
  const body = document.querySelector("#order-body");
  const order = page.found;
  if (!order) {
    body.replaceChildren();
    return;
  }
  const view = page.orderView(order);
  const pinned = SHOP.terms.versions[order.terms.version];
  const card = el("article", { class: "order-card", "aria-labelledby": "order-title" },
    el("h3", { id: "order-title", text: `Order ${order.order_id}` }),
    el("dl", { class: "facts" },
      el("dt", { text: "Placed" }), el("dd", { text: view.placed_on }),
      el("dt", { text: "Delivered" }), el("dd", { text: view.delivered_on }),
      el("dt", { text: "Items" }), el("dd", {}, el("ul", {}, view.items.map((it) => el("li", { text: `${it.quantity} × ${it.name}, ${it.price}` })))),
      el("dt", { text: "Returns terms on this receipt" }), el("dd", {}, `Version ${order.terms.version} `,
        el("code", { class: "hash", title: order.terms.sha256, text: shortHash(order.terms.sha256) }),
        pinned ? el("span", { class: "small", text: ` In force ${longDate(pinned.effective_from)} to ${pinned.effective_until ? longDate(pinned.effective_until) : "today"}.` }) : null)),
    order.demo_note ? el("p", { class: "small muted", text: order.demo_note }) : null);
  const form = el("form", { class: "return-form", id: "return-form", novalidate: true });
  const type = el("select", { name: "type", id: "return-type" }, Object.entries(CLAIM_TYPES).map(([k, label]) => el("option", { value: k, text: label })));
  const item = el("select", { name: "sku", id: "return-sku" }, order.items.map((it) => el("option", { value: it.sku, text: it.name })));
  const facts = el("div", { class: "facts-box" });
  const drawFacts = () => {
    facts.replaceChildren(...(FACTS[type.value] || []).map(([key, label]) => el("div", { class: "fact" },
      el("span", { class: "fact-label", id: `rf-${key}`, text: label }),
      el("span", { class: "seg", role: "radiogroup", "aria-labelledby": `rf-${key}` },
        el("label", {}, el("input", { type: "radio", name: key, value: "yes" }), "Yes"),
        el("label", {}, el("input", { type: "radio", name: key, value: "no" }), "No")))));
  };
  type.addEventListener("change", drawFacts);
  drawFacts();
  form.append(el("h4", { text: "Start a return" }),
    el("div", { class: "field" }, el("label", { for: "return-type", text: "Reason" }), type),
    el("div", { class: "field" }, el("label", { for: "return-sku", text: "Item" }), item),
    facts,
    el("p", { class: "form-error", role: "alert" }),
    el("button", { type: "submit", class: "btn primary", text: "Check my return" }));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const input = { order_id: order.order_id, email: order.customer.email, type: data.get("type"), sku: data.get("sku") };
    for (const [key] of FACTS[input.type] || []) {
      if (data.get(key) === "yes") input[key] = true;
      if (data.get(key) === "no") input[key] = false;
    }
    showError(form, await page.startReturn(input));
  });
  const parts = [card, form];
  if (page.lastReturn?.order_id === order.order_id) {
    const r = page.lastReturn;
    const box = el("div", { class: "decision", role: "status", "data-eligible": r.outcome_decision === "eligible" ? "yes" : "no" },
      el("p", {}, el("strong", { text: "Our decision: " }), r.decision));
    if (r.outcome_decision !== "eligible") {
      const story = el("textarea", { id: "handoff-story", name: "story", rows: "3", maxlength: "600" });
      story.value = page.handoffDraft || "";
      story.addEventListener("input", () => { page.handoffDraft = story.value; });
      const make = el("button", { type: "button", class: "btn", text: "Make the link for the desk" });
      make.addEventListener("click", async () => {
        const result = await page.prepareDeskHandoff({ order_id: order.order_id, email: order.customer.email, story: story.value });
        if (!result.ok) box.append(el("p", { class: "form-error", text: result.reason }));
      });
      box.append(
        el("p", { text: `Disagree? Clause 5.1 of our terms: you can take the case to the Open Resolution Desk, a neutral procedure we follow. The desk applies the terms on your receipt (version ${order.terms.version}).` }),
        el("label", { for: "handoff-story", text: "Your account for the desk (optional)" }), story, make);
    }
    parts.push(box);
  }
  if (page.handoff?.order_id === order.order_id) {
    parts.push(el("div", { class: "handoff", role: "status" },
      el("p", { text: "The link carries your receipt and our decision inside it. It is not sent anywhere until you open it." }),
      el("a", { class: "btn primary", href: page.handoff.link, target: "_blank", rel: "noopener", text: "Open the case at the Open Resolution Desk" })));
  }
  body.replaceChildren(...parts);
}

async function start() {
  const page = new ShopPage();
  Shop.page = page;
  // The order lookup works from the first click: it waits for the terms files
  // instead of ignoring a click that comes before they arrive.
  const termsLoaded = page.loadTerms();
  const lookup = document.querySelector("#lookup-form");
  lookup.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(lookup);
    await termsLoaded;
    showError(lookup, page.lookUpOrder({ order_id: data.get("order_id"), email: data.get("email") }));
  });
  document.querySelectorAll("[data-fill-sample]").forEach((button) => button.addEventListener("click", () => {
    lookup.querySelector('[name="order_id"]').value = button.dataset.order;
    lookup.querySelector('[name="email"]').value = button.dataset.email;
    lookup.requestSubmit();
  }));
  await termsLoaded;
  renderProducts(page);
  const render = () => { renderCart(page); renderOrder(page); };
  page.onChange(render);
  render();
  const checkout = document.querySelector("#checkout-form");
  checkout.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(checkout);
    const result = await page.checkout({ name: data.get("name"), email: data.get("email") });
    showError(checkout, result);
    if (result.ok) {
      checkout.reset();
      document.querySelector("#checkout-result").textContent = `Order ${result.receipt.order_id} placed (demo, no payment). Its receipt pins returns terms version ${result.receipt.terms.version}. It is shown under Your orders.`;
      document.querySelector("#orders").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    }
  });
  exposeWebMcpTools([
    { name: "shop_get_info", description: `Read ${SHOP.name}'s catalog, prices and today's returns terms.`, inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true }, run: () => page.getShopInfo() },
    { name: "shop_look_up_order", description: "Show an order when the order number and email match.", inputSchema: { type: "object", properties: { order_id: { type: "string" }, email: { type: "string" } }, required: ["order_id", "email"] }, run: (args) => page.lookUpOrder(args) },
    { name: "shop_start_return", description: "Run the shop's returns check for one item. It uses today's returns terms.", inputSchema: { type: "object", properties: { order_id: { type: "string" }, email: { type: "string" }, type: { type: "string", enum: Object.keys(CLAIM_TYPES) }, sku: { type: "string" }, unused: { type: "boolean" }, original_packaging: { type: "boolean" }, photo_evidence: { type: "boolean" }, received: { type: "boolean" } }, required: ["order_id", "email", "type"] }, run: (args) => page.startReturn(args) },
    { name: "shop_prepare_desk_handoff", description: "Make the link that opens this order's case at the Open Resolution Desk. Sends nothing.", inputSchema: { type: "object", properties: { order_id: { type: "string" }, email: { type: "string" }, story: { type: "string" } }, required: ["order_id", "email"] }, run: (args) => page.prepareDeskHandoff(args) },
  ]).then((n) => { if (n) console.info(`WebMCP: ${n} shop tools registered`); });
  document.documentElement.dataset.ready = "true";
  return page;
}

export const ready = start();
