// fingerprint-mark.js - draws an outcome fingerprint as a dial of 64 ticks, one
// per hex digit of the SHA-256 hash. Two parties who computed the same outcome
// see the same mark, which is easier to compare than 64 characters.

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Build the dial for a "sha256:<64 hex>" hash.
 *
 * :param hash: The fingerprint text.
 * :param options: {size, matched} size in CSS pixels; matched adds the outer ring.
 * :return: An <svg> element with an accessible label.
 */
export function fingerprintMark(hash, { size = 120, matched = false } = {}) {
  const hex = /^sha256:([0-9a-f]{64})$/.exec(String(hash || ""))?.[1];
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 120 120");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("role", "img");
  svg.classList.add("fp-mark");
  if (!hex) {
    svg.setAttribute("aria-label", "No fingerprint yet");
    const empty = document.createElementNS(SVG_NS, "circle");
    empty.setAttribute("cx", "60");
    empty.setAttribute("cy", "60");
    empty.setAttribute("r", "40");
    empty.setAttribute("class", "fp-empty");
    svg.append(empty);
    return svg;
  }
  svg.setAttribute("aria-label", `Fingerprint ${hex.slice(0, 4)} to ${hex.slice(-4)}${matched ? ", matched" : ""}`);
  const title = document.createElementNS(SVG_NS, "title");
  title.textContent = `sha256:${hex}`;
  svg.append(title);
  if (matched) {
    const ring = document.createElementNS(SVG_NS, "circle");
    ring.setAttribute("cx", "60");
    ring.setAttribute("cy", "60");
    ring.setAttribute("r", "58");
    ring.setAttribute("class", "fp-ring");
    svg.append(ring);
  }
  const hub = document.createElementNS(SVG_NS, "circle");
  hub.setAttribute("cx", "60");
  hub.setAttribute("cy", "60");
  hub.setAttribute("r", "30");
  hub.setAttribute("class", "fp-hub");
  svg.append(hub);
  const ticks = document.createElementNS(SVG_NS, "g");
  ticks.setAttribute("class", "fp-ticks");
  for (let i = 0; i < 64; i++) {
    const value = parseInt(hex[i], 16);
    const angle = (i / 64) * Math.PI * 2 - Math.PI / 2;
    const inner = 34;
    const outer = inner + 5 + value * 1.25;
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", (60 + inner * Math.cos(angle)).toFixed(2));
    line.setAttribute("y1", (60 + inner * Math.sin(angle)).toFixed(2));
    line.setAttribute("x2", (60 + outer * Math.cos(angle)).toFixed(2));
    line.setAttribute("y2", (60 + outer * Math.sin(angle)).toFixed(2));
    ticks.append(line);
  }
  svg.append(ticks);
  const label = document.createElementNS(SVG_NS, "text");
  label.setAttribute("x", "60");
  label.setAttribute("y", "64");
  label.setAttribute("text-anchor", "middle");
  label.setAttribute("class", "fp-text");
  label.textContent = hex.slice(0, 4);
  svg.append(label);
  return svg;
}
