// Registers the desk's operations with the agent runtime. agent-manifest.json
// loads this module through "actions.module"; the names in "actions.agentTools"
// become model tools called website_<name>. Every action wraps a DeskPage method
// that the page's own buttons also use, so the assistant follows the same rules.

import { Desk } from "./js/desk-page.js";
import { CLAIM_TYPES } from "./protocol/v1/evaluate.js";

const page = () => {
  if (!Desk.page) throw new Error("The case page is not ready yet.");
  return Desk.page;
};

class DeskActions {
  static registerActions(actions) {
    actions.register({
      name: "get_case",
      description: "Read the open case: shop, order, items, the terms version the receipt pins, whether the terms were checked, the claim, the computed outcome with its checks and clauses, the shop's published offers, the options the customer can accept, and the next step. Leaves out the customer's contact details.",
      effect: "read",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => page().getCase(),
    });
    actions.register({
      name: "check_terms",
      description: "Read the shop's published terms for the version the receipt pins, from the shop's own site, and check them against the receipt's hash and the shop's archive. The visitor is asked before the shop's site is contacted. Returns the clauses and whether the shop's current version differs.",
      effect: "read",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => page().checkTerms({ via: "agent" }),
    });
    actions.register({
      name: "file_claim",
      description: "File or amend the customer's claim and compute the outcome with the published decision function. The outcome, refund value and clauses come from this tool, never from you. Facts are what the customer states. Leave out a fact you do not know.",
      effect: "write",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["type"],
        properties: {
          type: { type: "string", enum: Object.keys(CLAIM_TYPES), description: "change_of_mind, arrived_damaged, wrong_item, faulty or not_received." },
          sku: { type: "string", maxLength: 80, description: "Item sku from website_get_case. Optional when the order has one item." },
          quantity: { type: "integer", minimum: 1, maximum: 99, description: "How many of the item. Default: all bought." },
          unused: { type: "boolean", description: "change_of_mind: the customer says the item is unused." },
          original_packaging: { type: "boolean", description: "change_of_mind: the customer says it is in its original packaging." },
          photo_evidence: { type: "boolean", description: "arrived_damaged: the customer has a photo of the damage." },
          received: { type: "boolean", description: "not_received: false when the customer says the parcel never arrived." },
        },
      },
      execute: (args) => page().fileClaim(args, { via: "agent" }),
    });
    actions.register({
      name: "accept_option",
      description: "Record the customer's chosen option and make the link for the shop. option is \"outcome\" or the id of a published shop offer from website_get_case. The browser asks the customer to confirm first.",
      effect: "irreversible",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["option"],
        properties: { option: { type: "string", maxLength: 40, description: "\"outcome\" or a published offer id." } },
      },
      execute: (args) => page().acceptOption(args, { via: "agent", confirmed: true }),
    });
    actions.register({
      name: "request_review",
      description: "Record that the customer wants a person to review the outcome. The browser asks the customer to confirm first. In this demo no reviewer is on duty.",
      effect: "irreversible",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { reason: { type: "string", maxLength: 300, description: "The customer's reason, in their words." } },
      },
      execute: (args) => page().requestReview(args, { via: "agent", confirmed: true }),
    });
  }
}

export const registerActions = DeskActions.registerActions;
