#!/usr/bin/env node
// check_agentic_site.mjs - checks the public files of any open agentic website
// against the Minimum Viable Specification for a Worldwide Agentic Web
// (MVP Profile 0.2, 6 November 2026). It reads what a browser on another origin
// would read: agent-manifest.json, each network definition it names, links.json
// and the peer networks those files point to. Networks are parsed and validated
// with the browser runtime's own hocon.js and kernel.js.
//
// It checks published files only. Runtime behaviour (consent, BYOK handling,
// execution limits) needs a browser test.
//
// Usage:
//   node tools/check_agentic_site.mjs <url> [<url> ...] [--runtime DIR] [--no-follow] [--json]
//
// <url> is a site base (https://example.org/site/) or a peer-network reference
// (https://example.org/agents/transit), which names one network in the manifest
// one level up, as in section 3.2 of the specification.
// --runtime DIR   the runtime to validate with (default: vendor/agentic-web/runtime)
// --no-follow     do not check the peer networks that the files point to
// --json          print the findings as JSON
// Exit code: 0 when nothing failed, 1 when a check failed, 2 on a usage error.

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const CALLER_ORIGIN = "https://caller.example";

function parseArgs(argv) {
  const options = { urls: [], runtime: path.join(here, "../vendor/agentic-web/runtime"), follow: true, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--runtime") options.runtime = path.resolve(argv[++i] || "");
    else if (arg === "--no-follow") options.follow = false;
    else if (arg === "--json") options.json = true;
    else if (arg.startsWith("--")) throw new Error(`Unknown option ${arg}`);
    else options.urls.push(arg);
  }
  if (!options.urls.length) throw new Error("Usage: node tools/check_agentic_site.mjs <url> [<url> ...] [--runtime DIR] [--no-follow] [--json]");
  return options;
}

const isLoopback = (url) => ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname);
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Collects findings as PASS, WARN or FAIL lines with the section they rest on. */
class Report {
  constructor() { this.findings = []; }
  add(level, subject, message, section) { this.findings.push({ level, subject, message, section }); }
  pass(subject, message, section) { this.add("PASS", subject, message, section); }
  warn(subject, message, section) { this.add("WARN", subject, message, section); }
  fail(subject, message, section) { this.add("FAIL", subject, message, section); }
  get failed() { return this.findings.filter((f) => f.level === "FAIL").length; }
  get warned() { return this.findings.filter((f) => f.level === "WARN").length; }
}

class SiteChecker {
  constructor(runtime, report, { follow }) {
    this.runtime = runtime;
    this.report = report;
    this.follow = follow;
    this.checkedNetworks = new Set();
    this.peerQueue = [];
  }

  /**
   * GET a public file the way a browser on another origin would: with an Origin
   * header and no credentials. Records whether CORS would let the caller read it.
   */
  async get(url, subject, section, { optional = false } = {}) {
    let response;
    try {
      response = await fetch(url, { headers: { Origin: CALLER_ORIGIN }, redirect: "follow" });
    } catch (error) {
      this.report.fail(subject, `${url} could not be fetched: ${error.message}`, section);
      return null;
    }
    if (response.status === 404 && optional) return { missing: true };
    if (!response.ok) {
      this.report.fail(subject, `${url} returned HTTP ${response.status}`, section);
      return null;
    }
    const allow = response.headers.get("access-control-allow-origin");
    const cors = allow === "*" || allow === CALLER_ORIGIN;
    const text = await response.text();
    const finalUrl = response.url || url;
    if (new URL(finalUrl).origin !== new URL(url).origin) {
      this.report.warn(subject, `${url} redirects to another origin (${new URL(finalUrl).origin}). A runtime treats that as a new destination for consent.`, "5");
    }
    return { text, cors, allow, finalUrl, contentType: response.headers.get("content-type") || "" };
  }

  checkTransport(url, file, subject, sectionCors = "3.3") {
    const https = new URL(url).protocol === "https:";
    if (!https && !isLoopback(url)) this.report.fail(subject, `${url} is not served over HTTPS`, "3.3");
    if (!file.cors) this.report.fail(subject, `${url} has no Access-Control-Allow-Origin for other origins (got ${file.allow ?? "none"})`, sectionCors);
    return https || isLoopback(url);
  }

  /** Check a site base, or one network when the URL names it (section 3.2). */
  async checkUrl(input, { asPeer = false, from = null } = {}) {
    const url = new URL(input);
    let base;
    let requested = null;
    const last = url.pathname.split("/").filter(Boolean).pop() || "";
    if (asPeer || (!url.pathname.endsWith("/") && last && !last.includes("."))) {
      requested = last;
      base = new URL("./", url).href;
    } else {
      base = new URL(url.pathname.endsWith("/") ? url.href : `${url.href}/`).href;
    }
    base = base.replace(/[?#].*$/, "");
    const key = `${base}::${requested ?? "*"}`;
    if (this.checkedNetworks.has(key)) return;
    this.checkedNetworks.add(key);
    const subject = requested ? `peer ${requested}` : `site ${base}`;
    if (from) this.report.pass(subject, `referenced by ${from}`, "3.2");

    const manifestUrl = new URL("agent-manifest.json", base).href;
    const file = await this.get(manifestUrl, subject, "3.3");
    if (!file) return;
    const okTransport = this.checkTransport(manifestUrl, file, subject);
    let manifest;
    try {
      manifest = JSON.parse(file.text);
    } catch (error) {
      this.report.fail(subject, `agent-manifest.json is not valid JSON: ${error.message}`, "3.3");
      return;
    }
    if (okTransport && file.cors) this.report.pass(subject, `agent-manifest.json: HTTP 200, CORS "${file.allow}", ${new URL(manifestUrl).protocol.replace(":", "")}`, "3.3, 3.4");
    const entries = this.checkManifest(manifest, subject);
    if (!entries) return;

    let targets = entries;
    if (requested) {
      const exact = entries.filter((e) => e.name === requested);
      if (!exact.length) {
        this.report.fail(subject, `the manifest has no network named exactly "${requested}" (it lists ${entries.map((e) => e.name).join(", ") || "none"}). A runtime must refuse to run another one.`, "3.2");
        return;
      }
      this.report.pass(subject, `the manifest lists "${requested}" by its exact name`, "3.2");
      targets = exact;
    }
    const links = await this.checkLinks(base, manifest, entries, subject);
    for (const entry of targets) await this.checkNetwork(base, manifest, entry, links, subject);
  }

  checkManifest(manifest, subject) {
    const r = this.report;
    if (!isPlainObject(manifest)) { r.fail(subject, "agent-manifest.json is not a JSON object", "3.3"); return null; }
    const networks = manifest.networks;
    if (!Array.isArray(networks) || !networks.length) { r.fail(subject, "networks is missing or empty", "3.3"); return null; }
    let ok = true;
    const names = new Set();
    for (const [i, entry] of networks.entries()) {
      for (const field of ["name", "front_man", "hocon"]) {
        if (typeof entry?.[field] !== "string" || !entry[field].trim()) { r.fail(subject, `networks[${i}].${field} is missing`, "3.3"); ok = false; }
      }
      if (names.has(entry?.name)) { r.fail(subject, `networks[${i}].name "${entry.name}" appears twice`, "3.2"); ok = false; }
      names.add(entry?.name);
      if (typeof entry?.name === "string" && /[/?#\s]/.test(entry.name)) { r.fail(subject, `network name "${entry.name}" cannot be the last path segment of a URL`, "3.2"); ok = false; }
    }
    if (ok) r.pass(subject, `networks: ${networks.map((e) => `${e.name} (front agent ${e.front_man})`).join(", ")}`, "3.3");
    const router = manifest.llm_router;
    if (!isPlainObject(router)) r.fail(subject, "llm_router (router metadata) is missing", "3.3, 4");
    else if (!router.base_url && !router.byok_router) r.fail(subject, "llm_router names neither base_url nor byok_router", "4");
    else r.pass(subject, `llm_router: base_url ${router.base_url || "none"}, byok_router ${router.byok_router || "none"}${router.mock ? ", mock" : ""}`, "3.3, 4");
    const policy = manifest.peer_policy || manifest.web_policy;
    if (!policy && !Array.isArray(manifest.allowed_peers)) r.fail(subject, "neither peer_policy nor allowed_peers is published", "3.3");
    else if (!policy) r.warn(subject, "allowed_peers is published but peer_policy is not", "3.3");
    else r.pass(subject, `peer policy: mode ${policy.mode || "unspecified"}, allowed_peers [${(manifest.allowed_peers || []).join(", ")}]`, "3.3");
    for (const key of ["byok_key", "api_key", "apiKey", "key", "token", "secret"]) {
      if (manifest[key] || router?.[key]) r.fail(subject, `the manifest carries a credential field "${key}"`, "4");
    }
    return networks.filter((e) => typeof e?.name === "string" && typeof e?.hocon === "string");
  }

  async checkLinks(base, manifest, entries, subject) {
    const url = new URL("links.json", base).href;
    const file = await this.get(url, subject, "3.3", { optional: true });
    if (!file) return {};
    if (file.missing) {
      this.report.warn(subject, "links.json is not published (needed only when a network uses named peer references)", "3.3");
      return {};
    }
    this.checkTransport(url, file, subject);
    let links;
    try { links = JSON.parse(file.text); } catch (error) {
      this.report.fail(subject, `links.json is not valid JSON: ${error.message}`, "3.3");
      return {};
    }
    if (!isPlainObject(links) || !isPlainObject(links.networks)) {
      this.report.fail(subject, 'links.json must be an object with a "networks" map', "3.3");
      return {};
    }
    const known = new Set(entries.map((e) => e.name));
    let bad = false;
    for (const [network, map] of Object.entries(links.networks)) {
      if (!known.has(network)) this.report.warn(subject, `links.json names "${network}", which this manifest does not list`, "3.3");
      if (!isPlainObject(map)) { this.report.fail(subject, `links.json networks.${network} is not a map of names to URLs`, "3.3"); bad = true; continue; }
      for (const [name, target] of Object.entries(map)) {
        if (typeof target !== "string" || !/^https?:\/\//i.test(target)) { this.report.fail(subject, `links.json ${network}.${name} is not an http(s) URL`, "3.3"); bad = true; }
      }
    }
    if (!bad) this.report.pass(subject, `links.json: version ${links.version ?? "unset"}, ${Object.entries(links.networks).map(([n, m]) => `${n} with ${Object.keys(m).length} binding(s)`).join(", ")}`, "3.3");
    return links.networks;
  }

  async checkNetwork(base, manifest, entry, links, parentSubject) {
    const r = this.report;
    const subject = `network ${entry.name}`;
    const url = new URL(entry.hocon, base).href;
    const file = await this.get(url, subject, "3.3");
    if (!file) return;
    this.checkTransport(url, file, subject);
    let raw;
    try {
      raw = JSON.parse(file.text);
      r.pass(subject, `${url.replace(base, "./")}: resolved JSON, ${file.text.length} bytes, CORS "${file.allow}"`, "2, 3.3");
    } catch {
      r.warn(subject, `${url} is not JSON. The profile publishes a resolved JSON document for browser loading; parsing it as HOCON instead.`, "2, 3.3");
    }
    // Data only: no includes, no environment substitutions, no publisher file paths.
    const strings = [];
    const walk = (v, keyPath) => {
      if (typeof v === "string") strings.push([keyPath, v]);
      else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${keyPath}[${i}]`));
      else if (isPlainObject(v)) for (const [k, x] of Object.entries(v)) { if (k === "include") r.fail(subject, `${keyPath}.include is a build-time include`, "2"); walk(x, `${keyPath}.${k}`); }
    };
    if (raw !== undefined) walk(raw, "$");
    const subst = strings.filter(([, s]) => /\$\{[^}]+\}/.test(s));
    if (subst.length) r.fail(subject, `${subst.length} string(s) keep a \${...} substitution, for example at ${subst[0][0]}`, "2");
    const paths = strings.filter(([, s]) => /(^|\s)(file:\/\/|\/Users\/|\/home\/|[A-Z]:\\)/.test(s));
    if (paths.length) r.warn(subject, `${paths.length} string(s) look like publisher file paths, for example at ${paths[0][0]}`, "2");
    if (!subst.length && !paths.length) r.pass(subject, "data only: no includes, substitutions or local file paths", "2, 2.2");

    let config;
    try {
      config = this.runtime.parseHocon(file.text);
    } catch (error) {
      r.fail(subject, `the runtime parser rejects it: ${error.message}`, "3.1");
      return;
    }
    config.links = { ...(config.links || {}), ...(links?.[entry.name] || {}) };
    const network = new this.runtime.AgentNetwork(config, entry.name);
    const validation = this.runtime.validateNetwork(network);
    if (validation.errors.length) {
      for (const message of validation.errors) r.fail(subject, `runtime validation: ${message}`, "3.1");
    } else {
      r.pass(subject, "the runtime validator accepts it", "3.1");
    }
    let front = null;
    try { front = network.findFrontMan(); } catch (error) { r.fail(subject, `no single front agent: ${error.message}`, "2.1"); }
    if (!front) r.fail(subject, "the runtime finds no front agent", "2.1");
    else if (front !== entry.front_man) r.fail(subject, `the front agent is "${front}", but the manifest names "${entry.front_man}"`, "3.3");
    else if (front) r.pass(subject, `front agent "${front}" matches the manifest`, "2.1, 3.3");

    const resolved = network.config;
    if (!resolved.metadata?.description) r.warn(subject, "metadata.description (a short description) is missing", "2.1");
    const agents = (resolved.tools || []).filter(isPlainObject);
    const called = new Set(agents.flatMap((a) => (a.tools || []).filter((t) => typeof t === "string")));
    const problems = [];
    for (const agent of agents) {
      const name = agent.name || "(unnamed)";
      const usesTool = agent.function && typeof agent.function === "object";
      if (!usesTool || !agent.function.description) problems.push(["FAIL", `${name}: function.description is missing`, "2.1"]);
      const coded = typeof agent.class === "string" || typeof agent.toolbox === "string";
      if (!coded && !agent.instructions) problems.push(["FAIL", `${name}: an LLM agent needs instructions`, "2.1"]);
      if (coded) problems.push(["WARN", `${name}: a coded tool (${agent.class || agent.toolbox}) is outside the minimum portable data profile`, "2.2"]);
      if (called.has(name) && name !== front) {
        const params = agent.function?.parameters;
        if (!isPlainObject(params)) problems.push(["WARN", `${name}: callable, but it declares no JSON Schema input (function.parameters)`, "2.1"]);
        else if (params.type !== "object" || !isPlainObject(params.properties)) problems.push(["WARN", `${name}: function.parameters is not an object schema with properties`, "2.1"]);
      }
      for (const direction of ["to_downstream", "from_downstream", "to_upstream", "from_upstream"]) {
        const sly = agent.allow?.[direction]?.sly_data;
        if (sly === undefined) continue;
        const wide = sly === true || sly === "*" || (Array.isArray(sly) && sly.includes("*")) || (isPlainObject(sly) && Object.keys(sly).includes("*"));
        if (wide) problems.push(["WARN", `${name}: allow.${direction}.sly_data does not name its fields`, "2.1, 5"]);
        else problems.push(["PASS", `${name}: allow.${direction}.sly_data names ${Array.isArray(sly) ? sly.join(", ") : Object.keys(sly || {}).join(", ") || "no fields"}`, "2.1, 5"]);
      }
    }
    for (const [level, message, section] of problems) r.add(level, subject, message, section);
    if (!problems.some(([level]) => level !== "PASS")) r.pass(subject, `${agents.length} agent(s), each with a function description${agents.some((a) => a.instructions) ? " and instructions" : ""}`, "2.1");

    // External references: peer networks, MCP servers and link slots.
    const remote = [];
    const mcps = [];
    for (const agent of agents) {
      for (const ref of agent.tools || []) {
        const kind = network.classifyTool(ref).kind;
        if (kind === "remote") remote.push(String(ref));
        else if (kind === "mcp") mcps.push(typeof ref === "string" ? ref : ref.url);
        else if (kind === "link") {
          const bound = network.getLink(ref);
          if (bound) remote.push(bound);
          else r.pass(subject, `link slot "${ref}" has no published binding; the caller binds it at run time`, "3.3");
        } else if (kind === "missing") {
          r.fail(subject, `${agent.name} lists "${typeof ref === "string" ? ref : JSON.stringify(ref)}", which is neither an agent, a URL nor a link`, "3.1");
        }
      }
    }
    for (const target of [...new Set([...remote, ...mcps])]) {
      let absolute;
      try { absolute = new URL(target, base).href; } catch { r.fail(subject, `the reference ${target} is not a URL`, "3.2"); continue; }
      const allowed = this.runtime.manifestAllowsPeer ? this.runtime.manifestAllowsPeer(absolute, manifest) : null;
      const sameOrigin = new URL(absolute).origin === new URL(base).origin;
      if (allowed === false && !sameOrigin) r.warn(subject, `${absolute} is not allowed by this manifest's peer policy; the reference runtime refuses it unless the page allows it at run time`, "3.2");
      else r.pass(subject, `refers to ${absolute}${sameOrigin ? " (same origin)" : ""}`, "2.1, 3.2");
      if (this.follow && remote.includes(target)) this.peerQueue.push({ url: absolute, from: entry.name });
    }
    if (mcps.length) r.warn(subject, `uses MCP at ${mcps.join(", ")}; reachability needs CORS on that server and is not checked here`, "3.4");
  }
}

async function loadRuntime(dir) {
  const hocon = await import(pathToFileURL(path.join(dir, "hocon.js")).href);
  const kernel = await import(pathToFileURL(path.join(dir, "kernel.js")).href);
  let manifestAllowsPeer = null;
  try {
    // engine.js imports browser-only modules in some builds; the policy check is optional.
    ({ manifestAllowsPeer } = await import(pathToFileURL(path.join(dir, "engine.js")).href));
  } catch { /* not available in Node */ }
  return { parseHocon: hocon.parseHocon, AgentNetwork: kernel.AgentNetwork, validateNetwork: kernel.validateNetwork, manifestAllowsPeer };
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); } catch (error) { console.error(error.message); return 2; }
  const runtime = await loadRuntime(options.runtime);
  const report = new Report();
  const checker = new SiteChecker(runtime, report, options);
  for (const url of options.urls) await checker.checkUrl(url);
  while (checker.peerQueue.length) {
    const { url, from } = checker.peerQueue.shift();
    await checker.checkUrl(url, { asPeer: true, from });
  }
  if (options.json) {
    console.log(JSON.stringify({ profile: "MVP Profile 0.2", runtime: options.runtime, findings: report.findings, failed: report.failed, warnings: report.warned }, null, 2));
  } else {
    let subject = null;
    for (const f of report.findings) {
      if (f.subject !== subject) { console.log(`\n${f.subject}`); subject = f.subject; }
      console.log(`  ${f.level.padEnd(4)}  ${f.message}  [§${f.section}]`);
    }
    console.log(`\n${report.failed} failed, ${report.warned} warning(s), ${report.findings.length - report.failed - report.warned} passed. Checked against MVP Profile 0.2 with the runtime in ${path.relative(process.cwd(), options.runtime) || options.runtime}.`);
  }
  return report.failed ? 1 : 0;
}

process.exitCode = await main();
