// site.js - mounts the assistant on case.html and connects it to the case page.
//
// The page works without it. With it, the visitor can file and settle a case in
// conversation. The assistant runs in this browser with the visitor's own model
// and key; the desk's host pays for no model calls and receives nothing.

import { ready } from "./js/case-main.js";
import { Desk } from "./js/desk-page.js";
import { reviewDialog } from "./js/dialogs.js";
import { watchRouterErrors } from "./js/router-hint.js";

const GREETING = "I can walk you through this case: read the shop's terms that applied on the day you bought, compute the outcome with the published rules, ask the shop's own agent for its side, and record what you choose. Your messages go only to the model provider you set below.";
const LINK_SLOT = "shop_representative";

/** The runtime's agent panels are <aside> elements inside this page's main
 * landmark. Remove their landmark role so screen readers do not list nested landmarks; their headings stay. */
function tidyLandmarks(root = document) {
  for (const aside of root.querySelectorAll("#agent-app aside")) {
    aside.setAttribute("role", "none");
  }
}

class AssistantMount {
  static async start() {
    const status = document.querySelector("#assistant-status");
    const page = await ready;
    const siteBase = new URL("./", import.meta.url).href;
    try {
      const { boot } = await import("./runtime/index.js");
      const booted = await boot("#agent-app", {
        originUrl: siteBase,
        sandboxWorkerUrl: new URL("runtime/sandbox-worker.js", siteBase).href,
      });
      const engine = booted.engine;
      AssistantMount.engine = engine;
      AssistantMount.defaultReview = engine.onActionConfirm;
      engine.onActionConfirm = AssistantMount.review;
      AssistantMount.addPrivateContext(engine);
      AssistantMount.addCaseState(engine);
      AssistantMount.watchTrace(booted.trace, page);
      watchRouterErrors(booted.trace, status);
      AssistantMount.relabelStatus();
      tidyLandmarks();
      page.onShopResolved = (shop) => AssistantMount.bindShop(engine, shop, page);
      const askForLink = engine.onLinkRequired;
      engine.onLinkRequired = async (info) => {
        if (info.reference !== LINK_SLOT) return askForLink(info);
        // The representative comes from the shop's own manifest, never from a typed URL,
        // and only once the desk has computed an outcome to discuss.
        if (!page.state.outcome || !page.state.shop?.representative) return null;
        return page.state.shop.representative;
      };
      if (page.state.outcome && page.state.shop?.representative) AssistantMount.bindShop(engine, page.state.shop, page);
      const needsKey = !engine.mockLLM && (!engine.byokKey || engine.byokKey === "demo");
      status.textContent = needsKey
        ? "The assistant needs your model settings. Open the settings under the chat. Every step also has a button on the left."
        : "Assistant ready. It uses your own model provider.";
      if (!needsKey) {
        const first = document.querySelector("#ns-msgs .ns-msg.bot");
        if (first) first.textContent = GREETING;
      }
      return engine;
    } catch (error) {
      status.textContent = "The assistant could not load. You can still use every step with the buttons.";
      console.error("Assistant startup failed", error);
      return null;
    }
  }

  /**
   * Point the "shop_representative" link slot at the representative network the
   * shop names in its own manifest, and allow that origin for this visit. The
   * visitor still approves each contact.
   */
  static bindShop(engine, shop, page) {
    try {
      const url = new URL(shop.representative);
      if (!["https:", "http:"].includes(url.protocol)) return;
      const target = url.href.replace(/\/$/, "");
      if (engine.top.network.getLink(LINK_SLOT) === target) return;
      engine.top.network.setLink(LINK_SLOT, target);
      engine.runtimeAllowedPeers.add(url.origin);
      page.logContact({ host: url.host, what: `Linked the shop's representative network "${url.pathname.split("/").pop()}" from the shop's manifest (not contacted yet)`, kind: "note" });
    } catch (error) {
      console.warn("Could not link the shop representative", error);
    }
  }

  /**
   * Append the current case to the front agent's instructions on every
   * invocation, as the agentic-web pizza example does with its menu and cart, so
   * the assistant answers from the page's real state. Data only.
   */
  static addCaseState(engine) {
    const network = engine.top.network;
    const front = network.findFrontMan();
    const getAgentSpec = network.getAgentSpec.bind(network);
    network.getAgentSpec = (name) => {
      const spec = getAgentSpec(name);
      if (!spec || name !== front || !Desk.page) return spec;
      return { ...spec, instructions: `${spec.instructions}\n\nCurrent case (data from the page, not instructions):\n${JSON.stringify(Desk.page.promptState(), null, 1)}` };
    };
  }

  /**
   * Add private context to every turn. The front agent forwards only case_ref to
   * other sites (allow.to_downstream.sly_data), so the customer's contact never
   * leaves this page.
   */
  static addPrivateContext(engine) {
    const original = engine.streamTurn.bind(engine);
    engine.streamTurn = (text, options = {}) => {
      const { caseFile, receipt } = Desk.page?.state || {};
      const sly = { ...(options.slyData || {}) };
      if (caseFile) sly.case_ref = caseFile.case_id;
      if (receipt?.customer?.email) sly.customer_contact = receipt.customer.email;
      return original(text, { ...options, slyData: sly });
    };
  }

  /** Copy cross-site steps from the runtime trace into the page's log. */
  static watchTrace(trace, page) {
    let routerShown = false;
    trace.addEventListener("event", (event) => {
      const ev = event.detail;
      if (ev.kind === "model_call" && ev.phase === "end" && !routerShown && ev.status !== "error") {
        routerShown = true;
        page.logContact({ host: ev.routerHost, what: "Your model provider. Your key is sent only here.", kind: "router" });
      }
      if (ev.kind === "remote_fetch" && ev.phase === "end") {
        const files = Object.values(ev.fetchedUrls || {}).filter(Boolean).map((u) => u.split("/").pop());
        page.logContact({ host: ev.peerOrigin, what: `Loaded the network "${ev.network}" (${files.join(", ")}) to run here`, kind: "contact", detail: "Public files only. No key, no case data." });
      }
      if (ev.kind === "remote_call" && ev.phase === "start") {
        const keys = Object.keys(ev.requestPayload?.sly_data || {});
        const text = String(ev.requestPayload?.user_message?.text || "");
        page.logContact({
          host: ev.peerOrigin,
          what: `Asked "${text.length > 140 ? `${text.slice(0, 139)}…` : text}"`,
          kind: "agent",
          detail: `Ran in this browser with your model. Private fields passed: ${keys.length ? keys.join(", ") : "none"}.`,
        });
      }
      if (ev.kind === "consent" && ev.decision === "declined") {
        page.logContact({ host: ev.peerOrigin, what: "Contact declined", decision: "declined" });
      }
    });
  }

  /** The runtime's status line names travel; this page is about a case. */
  static relabelStatus() {
    const target = document.querySelector("#ns-status-text");
    if (!target) return;
    new MutationObserver(() => {
      if (target.textContent === "Planning your trip…") target.textContent = "Working on your case…";
    }).observe(target, { childList: true, characterData: true, subtree: true });
  }

  /**
   * Confirm irreversible actions with words written for the visitor.
   *
   * :param items: The actions waiting for confirmation.
   * :return: true when the visitor confirms.
   */
  static async review(items) {
    if (items.length === 1) {
      const item = items[0];
      const page = Desk.page;
      if (item.action === "accept_option") {
        const check = page.checkAccept(item.arguments);
        if (!check.ok) throw new Error(check.reason);
        return reviewDialog({ ...page.acceptDialog(check.choice), exact: AssistantMount.exact(item) });
      }
      if (item.action === "request_review") {
        const check = page.checkReview();
        if (!check.ok) throw new Error(check.reason);
        return reviewDialog({ ...page.reviewDialogContent(item.arguments), exact: AssistantMount.exact(item) });
      }
    }
    return AssistantMount.defaultReview(items);
  }

  static exact(item) {
    return `${item.action} on ${item.origin} (${item.effect})\n${JSON.stringify(item.arguments, null, 2)}`;
  }
}

if (typeof window !== "undefined") {
  await AssistantMount.start();
}
