// check.js - runs one of the specification's "visible stop" checks on a page of
// its own. It mounts the agentic-web runtime (unchanged) on the check's test
// network with the runtime's built-in mock model, which calls each tool once in
// order. The check therefore needs no key and gives the same result every time.
// The stop message shown in the result box is copied from the runtime's trace;
// the chat shows the same message in the mock model's summary.

import { boot } from "../runtime/index.js";

// The mock router, whatever key or model this browser has saved for the site.
// "demo" counts as no key, and the runtime trims a blank model name to none, so a
// saved profile cannot switch these checks to a real model.
const MOCK = { byokKey: "demo", router: "browser://mock", model: " " };

const STOPS = {
  invalid: [{ pattern: /Network '[^']+' \([^)]*\) failed validation: [^"\\]+/, label: "The runtime refused the network before running it" }],
  cycle: [{ pattern: /Skipped [^:]+: that network is already in this request's call chain\./, label: "The runtime stopped the cycle" }],
  budget: [{ pattern: /Skipped [^:]+: the per-query limit of \d+ third-party calls was reached\./, label: "The runtime refused the call over its budget" }],
  denied: [
    { pattern: /Policy: \S+ is not in \S+ allowed_peers; refusing to contact it\./, label: "The runtime refused the origin under the site's peer policy" },
    { pattern: /The user declined to contact [^.]+\./, label: "You declined the contact, and nothing was sent" },
  ],
};

const main = document.querySelector("main");
const kind = main.dataset.check;
const stop = STOPS[kind];
const result = document.querySelector("#check-result");
const runButton = document.querySelector("[data-run]");
const steps = [];

function show(state, title, detail) {
  result.dataset.state = state;
  result.replaceChildren();
  const strong = document.createElement("strong");
  strong.textContent = title;
  result.append(strong);
  if (detail) {
    const p = document.createElement("p");
    const code = document.createElement("code");
    code.textContent = detail;
    p.append(code);
    result.append(p);
  }
  if (steps.length) {
    const list = document.createElement("ol");
    list.className = "check-steps";
    for (const step of steps) {
      const li = document.createElement("li");
      li.textContent = step;
      list.append(li);
    }
    result.append(list);
  }
}

function watch(trace) {
  let found = null;
  trace.addEventListener("event", (event) => {
    const ev = event.detail || {};
    if (ev.kind === "tool" && ev.phase === "start") steps.push(`Called ${ev.tool}`);
    if (ev.kind === "remote_fetch" && ev.phase === "end") {
      steps.push(ev.status === "error" ? `Loading ${ev.peerOrigin || "a network"} failed` : `Loaded the network "${ev.network}" to run here`);
    }
    if (ev.kind === "composition_limit") steps.push(`Composition limit: ${ev.reason}`);
    if (found) return;
    const text = [ev.error, ev.resultPreview, ev.preview, ev.reason].filter(Boolean).join(" ");
    for (const { pattern, label } of stop) {
      const match = pattern.exec(text);
      if (match) {
        found = match[0].trim();
        show("stopped", label, found);
        break;
      }
    }
  });
  return () => found;
}

async function start() {
  if (!stop) return;
  const siteBase = new URL("./", location.href).href;
  let booted;
  try {
    booted = await boot("#agent-app", {
      originUrl: siteBase,
      sandboxWorkerUrl: new URL("../runtime/sandbox-worker.js", import.meta.url).href,
      ...MOCK,
    });
  } catch (error) {
    show("error", "The runtime could not start this check", String(error?.message || error));
    return;
  }
  const found = watch(booted.trace);
  for (const aside of document.querySelectorAll("#agent-app aside")) aside.setAttribute("role", "none");
  // The conversation can scroll, so keyboard users must be able to reach it.
  const log = document.querySelector("#ns-msgs");
  if (log) { log.tabIndex = 0; log.setAttribute("aria-label", "Conversation"); }
  runButton.disabled = false;
  runButton.addEventListener("click", () => {
    steps.length = 0;
    show("running", "Running the check with the runtime's mock model…");
    const input = document.querySelector("#ns-input");
    input.value = "Run the check.";
    document.querySelector("#ns-send").click();
  });
  // When the turn ends without the expected stop, say so.
  new MutationObserver(() => {
    const bar = document.querySelector(".ns-inputbar");
    if (bar?.dataset.turnActive === "false" && result.dataset.state === "running" && !found()) {
      show("missing", "The run ended without the expected stop", "");
    }
  }).observe(document.querySelector("#agent-app"), { subtree: true, attributes: true, attributeFilter: ["data-turn-active"] });
  document.documentElement.dataset.ready = "true";
}

start();
