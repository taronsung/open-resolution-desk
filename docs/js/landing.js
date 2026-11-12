// landing.js - draws the fingerprint marks on the landing page.
import { fingerprintMark } from "./fingerprint-mark.js";
import { shortHash } from "../protocol/v1/canonical.js";

for (const node of document.querySelectorAll("[data-fp]")) {
  node.append(fingerprintMark(node.dataset.fp, { size: 150, matched: node.dataset.matched === "true" }));
}
for (const node of document.querySelectorAll("[data-fp-text]")) {
  node.textContent = shortHash(node.dataset.fpText);
  node.title = node.dataset.fpText;
}
