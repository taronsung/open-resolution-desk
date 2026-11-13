// router-hint.js - turns a failed model call into a plain next step on the page.
//
// The runtime reports a failed call in the chat with the browser's own words,
// such as "Failed to fetch". The two common causes in this demo are a browser
// that blocks a public page from reaching a model server on the visitor's own
// computer, and a provider that does not accept requests from web pages (CORS).

const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

/**
 * Watch the runtime's trace and explain failed model calls in a status line.
 *
 * :param trace: The runtime's trace bus (booted.trace).
 * :param status: The element that shows the assistant's status.
 */
export function watchRouterErrors(trace, status) {
  if (!trace || !status) return;
  let before = null;
  trace.addEventListener("event", (event) => {
    const ev = event.detail;
    if (ev?.kind !== "model_call" || ev.phase !== "end") return;
    if (ev.status !== "error") {
      if (before !== null) {
        status.textContent = before;
        before = null;
      }
      return;
    }
    const message = String(ev.error || "");
    const host = String(ev.routerHost || "the model provider");
    let hint = null;
    if (/Failed to fetch|NetworkError|Load failed/i.test(message)) {
      hint = LOOPBACK.test(host)
        ? `The browser did not let this page reach the model server at ${host}. In Chrome or Edge, allow this site to access apps and services on this device (site settings, left of the address bar). Check that the server allows CORS (LM Studio: lms server start --cors). Then send the message again.`
        : `The page could not reach ${host}. The provider must accept requests from web pages (CORS). Check the router address in the settings under the chat.`;
    } else if (/LLM HTTP 40[13]/.test(message)) {
      hint = `${host} did not accept the key. Check the key in the settings under the chat.`;
    } else if (/LLM HTTP 404/.test(message)) {
      hint = `${host} does not know that model, or the router address is wrong. Check both in the settings under the chat.`;
    }
    if (hint) {
      if (before === null) before = status.textContent;
      status.textContent = hint;
    }
  });
}
