// dialogs.js - the page's own dialogs for consent and confirmation. The runtime
// shows its consent cards in the chat; these dialogs cover the same decisions
// when the visitor uses the page's buttons instead of the assistant.

function make(tag, attrs = {}, text = "") {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text) node.textContent = text;
  return node;
}

/**
 * Ask before contacting another site.
 *
 * :param info: {host, label, purpose}
 * :return: "allow", "always" or "decline".
 */
export function consentDialog({ host, label, purpose }) {
  return new Promise((resolve) => {
    const dialog = make("dialog", { class: "page-dialog", "aria-labelledby": "consent-title" });
    const heading = make("h2", { id: "consent-title", tabindex: "-1" }, `Contact ${host}?`);
    heading.autofocus = true;
    const who = make("p", { class: "dialog-who" }, label);
    const why = make("p", {}, purpose);
    const actions = make("div", { class: "dialog-actions" });
    const once = make("button", { type: "button", class: "btn primary", value: "allow" }, "Allow once");
    const always = make("button", { type: "button", class: "btn", value: "always" }, "Allow for this visit");
    const no = make("button", { type: "button", class: "btn quiet", value: "decline" }, "Don't contact");
    for (const b of [once, always, no]) b.addEventListener("click", () => dialog.close(b.value));
    actions.append(once, always, no);
    dialog.append(heading, who, why, actions);
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(["allow", "always"].includes(dialog.returnValue) ? dialog.returnValue : "decline");
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}

/**
 * Ask the visitor to confirm a step that cannot be undone.
 *
 * :param content: {title, sentence, details, confirmLabel, declineLabel, exact}
 * :return: true when the visitor confirms.
 */
export function reviewDialog({ title, sentence, details = {}, confirmLabel, declineLabel, exact }) {
  return new Promise((resolve) => {
    const dialog = make("dialog", { class: "page-dialog assistant-review", "aria-labelledby": "review-title" });
    const heading = make("h2", { id: "review-title", tabindex: "-1" }, title);
    heading.autofocus = true;
    dialog.append(heading, make("p", {}, sentence));
    const entries = Object.entries(details).filter(([, v]) => v !== undefined && v !== null && v !== "");
    if (entries.length) {
      const list = make("dl");
      for (const [k, v] of entries) list.append(make("dt", {}, k), make("dd", {}, String(v)));
      dialog.append(list);
    }
    if (exact) {
      const more = make("details");
      more.append(make("summary", {}, "Technical details"), make("pre", {}, exact));
      dialog.append(more);
    }
    const actions = make("div", { class: "dialog-actions" });
    const yes = make("button", { type: "button", class: "btn primary" }, confirmLabel);
    const no = make("button", { type: "button", class: "btn quiet" }, declineLabel);
    yes.addEventListener("click", () => dialog.close("confirm"));
    no.addEventListener("click", () => dialog.close("decline"));
    actions.append(yes, no);
    dialog.append(actions);
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(dialog.returnValue === "confirm");
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}
