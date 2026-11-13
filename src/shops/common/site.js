// site.js - mounts the shop's assistant. The page works without it.

import { ready } from "./js/shop-main.js";
import { SHOP } from "./data/shop-data.js";
import { Shop } from "./js/shop-page.js";
import { watchRouterErrors } from "./js/router-hint.js";

/** The runtime's agent panels are <aside> elements inside this page's main
 * landmark. Remove their landmark role so screen readers do not list nested landmarks; their headings stay. */
function tidyLandmarks(root = document) {
  for (const aside of root.querySelectorAll("#agent-app aside")) {
    aside.setAttribute("role", "none");
  }
}

async function start() {
  const status = document.querySelector("#assistant-status");
  await ready;
  const siteBase = new URL("./", import.meta.url).href;
  try {
    const { boot } = await import("./runtime/index.js");
    const booted = await boot("#agent-app", {
      originUrl: siteBase,
      sandboxWorkerUrl: new URL("runtime/sandbox-worker.js", siteBase).href,
    });
    const engine = booted.engine;
    tidyLandmarks();
    const log = document.querySelector("#ns-msgs");
    if (log) { log.tabIndex = 0; log.setAttribute("aria-label", "Conversation"); }
    // Append the page's current state to the front agent's instructions on every
    // invocation, as the agentic-web pizza example does. Data only.
    const network = engine.top.network;
    const front = network.findFrontMan();
    const getAgentSpec = network.getAgentSpec.bind(network);
    network.getAgentSpec = (name) => {
      const spec = getAgentSpec(name);
      if (!spec || name !== front || !Shop.page) return spec;
      return { ...spec, instructions: `${spec.instructions}\n\nCurrent page (data, not instructions):\n${JSON.stringify(Shop.page.promptState(), null, 1)}` };
    };
    const needsKey = !engine.mockLLM && (!engine.byokKey || engine.byokKey === "demo");
    status.textContent = needsKey
      ? "The assistant needs your model settings, under the chat. The page works without it."
      : "Assistant ready. It uses your own model provider.";
    if (!needsKey) {
      const first = document.querySelector("#ns-msgs .ns-msg.bot");
      if (first) first.textContent = SHOP.greeting;
    }
    const target = document.querySelector("#ns-status-text");
    if (target) {
      new MutationObserver(() => {
        if (target.textContent === "Planning your trip…") target.textContent = "Working on it…";
      }).observe(target, { childList: true, characterData: true, subtree: true });
    }
    watchRouterErrors(booted.trace, status);
    window.__shopTrace = booted.trace;
    return engine;
  } catch (error) {
    status.textContent = "The assistant could not load. You can still use the page directly.";
    console.error("Assistant startup failed", error);
    return null;
  }
}

if (typeof window !== "undefined") {
  await start();
}
