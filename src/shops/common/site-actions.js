// Registers the shop's operations with the agent runtime. agent-manifest.json
// loads this module through "actions.module"; the names in "actions.agentTools"
// become model tools called website_<name>. Each action wraps a ShopPage method
// that the page's own forms also use.

import { Shop } from "./js/shop-page.js";
import { SHOP } from "./data/shop-data.js";
import { CLAIM_TYPES } from "./protocol/v1/evaluate.js";

const page = () => {
  if (!Shop.page) throw new Error("The shop page is not ready yet.");
  return Shop.page;
};

const orderFields = {
  order_id: { type: "string", maxLength: 12, description: `Order number from the customer, such as ${SHOP.prefix}-2207.` },
  email: { type: "string", maxLength: 120, description: "The email address on the order, from the customer." },
};

export function registerActions(actions) {
  actions.register({
    name: "get_shop_info",
    description: "Read the shop's catalog, prices, delivery charge, today's returns terms (version and clauses), older terms versions, what the shop cannot do, and the dispute procedure.",
    effect: "read",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: () => page().getShopInfo(),
  });
  actions.register({
    name: "look_up_order",
    description: "Show one order on the page when the order number and email match. Returns its dates, items, prices and the terms version printed on its receipt.",
    effect: "write",
    inputSchema: { type: "object", additionalProperties: false, required: ["order_id", "email"], properties: orderFields },
    execute: (args) => page().lookUpOrder(args),
  });
  actions.register({
    name: "start_return",
    description: "Run the shop's returns check for one item and show the decision on the page. The shop's check uses today's returns terms. Nothing is shipped or refunded in this demo.",
    effect: "write",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["order_id", "email", "type"],
      properties: {
        ...orderFields,
        type: { type: "string", enum: Object.keys(CLAIM_TYPES), description: "change_of_mind, arrived_damaged, wrong_item, faulty or not_received." },
        sku: { type: "string", maxLength: 80, description: "Item sku from website_look_up_order. Optional for one-item orders." },
        unused: { type: "boolean", description: "change_of_mind: the customer says the item is unused." },
        original_packaging: { type: "boolean", description: "change_of_mind: the customer says it is in its original packaging." },
        photo_evidence: { type: "boolean", description: "arrived_damaged: the customer has a photo." },
        received: { type: "boolean", description: "not_received: false when the parcel never arrived." },
      },
    },
    execute: (args) => page().startReturn(args),
  });
  actions.register({
    name: "prepare_desk_handoff",
    description: "Make the link that opens this order's case at the Open Resolution Desk, with the receipt, the shop's decision and the customer's account. Shows the link on the page. Sends nothing.",
    effect: "write",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["order_id", "email"],
      properties: {
        ...orderFields,
        story: { type: "string", maxLength: 600, description: "The customer's account in one to three sentences, in their words." },
      },
    },
    execute: (args) => page().prepareDeskHandoff(args),
  });
}
