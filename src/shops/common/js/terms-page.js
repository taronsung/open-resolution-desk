// terms-page.js - renders every published version of the returns terms, newest
// first, with the fingerprint a receipt uses to pin it.

import { SHOP } from "../data/shop-data.js";
import { shortHash } from "../protocol/v1/canonical.js";

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") node.textContent = v;
    else if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}

const root = document.querySelector("#terms-root");
const versions = Object.entries(SHOP.terms.versions).sort((a, b) => Number(b[0]) - Number(a[0]));
for (const [version, entry] of versions) {
  const terms = await (await fetch(new URL(`../${entry.path}`, import.meta.url))).json();
  const current = version === SHOP.terms.current;
  root.append(el("section", { class: `terms-version${current ? " current" : ""}`, "aria-labelledby": `v${version}` },
    el("h2", { id: `v${version}`, text: `${terms.title}${current ? " (current)" : ""}` }),
    el("p", { class: "small" }, `In force from ${terms.effective_from}${terms.effective_until ? ` to ${terms.effective_until}` : ""}. Fingerprint `,
      el("code", { class: "hash", title: entry.sha256, text: shortHash(entry.sha256) }), ". ",
      el("a", { href: `./${entry.path}`, text: "Machine-readable file" }), "."),
    el("dl", { class: "clauses" }, Object.entries(terms.clauses).flatMap(([id, text]) => [el("dt", { text: id }), el("dd", { text })]))));
}
