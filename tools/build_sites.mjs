// build_sites.mjs - assembles the desk and the two fictional shops from src/
// into dist/<env>/{desk,shops}. Generated files: data modules, manifests,
// network JSON (through the agentic-web skill's build_network.mjs, which uses the
// browser runtime's own parser and validator), handoff samples, HTML from
// templates. Usage: node tools/build_sites.mjs dev|prod [--publish]
// --publish (prod only) copies dist/prod/desk to docs/ (this repository's GitHub
// Pages folder) and dist/prod/shops to the shops repository named in config.json.
import { cp, mkdir, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashOf } from "../protocol/v1/canonical.js";
import { engineHash } from "../protocol/v1/case.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.resolve(here, "..");
const SRC = path.join(BUILD, "src");
// The browser runtime and the network builder from the agentic-web repository
// (Apache 2.0), vendored unchanged. See vendor/agentic-web/VENDORED.md.
const SKILL = path.join(BUILD, "vendor/agentic-web");
const RUNTIME = path.join(SKILL, "runtime");
const NETWORK_BUILDER = path.join(SKILL, "scripts/build_network.mjs");

const env = process.argv[2] || "dev";
const publish = process.argv.includes("--publish");
const config = JSON.parse(await readFile(path.join(BUILD, "config.json"), "utf8"))[env];
if (!config) throw new Error(`Unknown environment ${env}`);
const OUT = path.join(BUILD, "dist", env);
const deskOut = path.join(OUT, "desk");
const shopsOut = path.join(OUT, "shops");

const read = (p) => readFile(p, "utf8");
const json = async (p) => JSON.parse(await read(p));
const write = async (p, text) => { await mkdir(path.dirname(p), { recursive: true }); await writeFile(p, text); };
const fill = (text, values) => text.replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, key) => {
  if (!(key in values)) throw new Error(`No value for {{${key}}}`);
  return values[key];
});
const originOf = (url) => new URL(url).origin;

function buildNetwork(hocon, manifest, runtimeDir) {
  try {
    const output = execFileSync("node", [NETWORK_BUILDER, hocon, "--manifest", manifest, "--runtime", runtimeDir], { encoding: "utf8" });
    const lines = output.split("\n").filter((l) => /warn|error|fail/i.test(l));
    console.log(`  built ${path.relative(OUT, hocon)}${lines.length ? `\n    ${lines.join("\n    ")}` : ""}`);
  } catch (error) {
    console.error(error.stdout || error.message);
    throw new Error(`Network build failed for ${hocon}`);
  }
}

async function sampleQueries(hoconPath) {
  const { parseHocon } = await import(path.join(RUNTIME, "hocon.js"));
  const parsed = parseHocon(await read(hoconPath));
  return parsed.metadata.sample_queries;
}

async function copyCommon(siteDir) {
  await cp(path.join(BUILD, "protocol/v1"), path.join(siteDir, "protocol/v1"), { recursive: true });
  await cp(path.join(SRC, "common/js"), path.join(siteDir, "js"), { recursive: true });
  await cp(RUNTIME, path.join(siteDir, "runtime"), { recursive: true });
}

// ------------------------------------------------------------------ engine
const engineSource = await read(path.join(BUILD, "protocol/v1/evaluate.js"));
const ENGINE = { name: "ord-evaluate", version: "1.0.0", sha256: await engineHash(engineSource) };

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

// ------------------------------------------------------------------- shops
const shopData = {};
for (const id of Object.keys(config.shops)) {
  const site = config.shops[id];
  const srcDir = path.join(SRC, "shops", id);
  const outDir = path.join(shopsOut, id);
  const shop = await json(path.join(srcDir, "shop.config.json"));
  await mkdir(outDir, { recursive: true });
  await copyCommon(outDir);
  await cp(path.join(SRC, "shops/common/js"), path.join(outDir, "js"), { recursive: true });
  await cp(path.join(SRC, "shops/common/css"), path.join(outDir, "css"), { recursive: true });
  await cp(path.join(srcDir, "theme.css"), path.join(outDir, "css/theme.css"));
  await cp(path.join(srcDir, "img"), path.join(outDir, "img"), { recursive: true });
  await cp(path.join(srcDir, "terms"), path.join(outDir, "terms"), { recursive: true });
  await cp(path.join(SRC, "shops/common/site.js"), path.join(outDir, "site.js"));
  await cp(path.join(SRC, "shops/common/site-actions.js"), path.join(outDir, "site-actions.js"));

  const versions = {};
  const termsDocs = {};
  for (const [version, entry] of Object.entries(shop.terms_versions)) {
    const doc = await json(path.join(srcDir, entry.path));
    termsDocs[version] = doc;
    versions[version] = {
      path: entry.path,
      url: `${site}/${entry.path}`,
      sha256: await hashOf(doc),
      effective_from: doc.effective_from,
      effective_until: doc.effective_until || null,
      title: doc.title,
    };
  }
  const orders = shop.orders.map((o) => {
    const { terms_version, ...rest } = o;
    return {
      protocol: "ord-receipt/1",
      merchant: { id: shop.id, name: shop.name, site },
      ...rest,
      currency: "USD",
      terms: { version: terms_version, url: versions[terms_version].url, sha256: versions[terms_version].sha256 },
    };
  });
  const representative = `${site}/agents/${shop.claims_network}`;
  const data = {
    id: shop.id,
    name: shop.name,
    prefix: shop.prefix,
    site,
    desk: config.desk,
    delivery_charge_cents: shop.delivery_charge_cents,
    catalog: shop.catalog,
    terms: { current: shop.terms_current, versions },
    orders,
    sample_order_ids: shop.sample_order_ids,
    offers: shop.offers,
    representative,
    engine: ENGINE,
    greeting: shop.greeting,
    cannot_do: shop.cannot_do,
  };
  shopData[id] = { shop, data, termsDocs };
  await write(path.join(outDir, "data/shop-data.js"),
    `// Generated by tools/build_sites.mjs from shop.config.json. Do not edit by hand.\nexport const SHOP = ${JSON.stringify(data, null, 2)};\n`);

  const firstSample = orders.find((o) => o.order_id === shop.sample_order_ids[0]);
  const mark = (await read(path.join(srcDir, "img/mark.svg"))).replace("<svg ", '<svg aria-hidden="true" ');
  const heroArt = (await read(path.join(srcDir, "img/hero.svg"))).replace("<svg ", '<svg aria-hidden="true" focusable="false" ');
  const pageValues = {
    SHOP_NAME: shop.name,
    TAGLINE: shop.tagline,
    PREFIX: shop.prefix,
    DESK_URL: config.desk,
    SAMPLE_ORDER: firstSample.order_id,
    SAMPLE_EMAIL: firstSample.customer.email,
    BRAND_MARK: mark.trim(),
    HERO_ART: heroArt.trim(),
    HERO_LINE: id === "brackenlight"
      ? "Every receipt names the returns terms that applied on the day you bought, so a later change never moves the goalposts on your order."
      : "Built by hand, sold with plain terms. Every receipt names the terms version that applies to it.",
    COLLECTION_TITLE: id === "brackenlight" ? "The collection" : "Wheels and parts",
  };
  for (const page of ["index", "terms", "backoffice"]) {
    await write(path.join(outDir, `${page}.html`), fill(await read(path.join(SRC, `shops/common/${page}.template.html`)), pageValues));
  }

  // Networks: the shop assistant (top) and the public representative (agents/).
  const assistantQueries = id === "brackenlight"
    ? ["What lamps do you sell, and what do they cost?", "Can I return the lamp from order BL-2207? My email is mina.park@example.com. I changed my mind; it is unused and still boxed.", "I disagree with that decision. What can I do?", "Can you give me a discount code?"]
    : ["Which parts are made to order?", "I want to return the wheelset from order CC-5531, email jonah.reyes@example.com. I changed my mind; it is unused.", "I disagree. Can a neutral party look at this?", "Can you book a fitting appointment?"];
  const claimsQueries = ["Case ORD-0000: order, item, change_of_mind, decision eligible, refund value $79.00. Anything to add?", "What happens after the customer chooses?"];
  const hoconValues = {
    SHOP_NAME: shop.name,
    ABOUT: shop.about,
    NETWORK: shop.network,
    DESK_URL: config.desk,
    CANNOT_DO: shop.cannot_do.join(", "),
    SAMPLE_QUERIES: JSON.stringify(assistantQueries),
    CLAIMS_SAMPLE_QUERIES: JSON.stringify(claimsQueries),
    MANDATE: shop.mandate,
    SERVICE_INFO: shop.service_info,
  };
  await write(path.join(outDir, `${shop.network}.hocon`), fill(await read(path.join(SRC, "shops/common/assistant.template.hocon")), hoconValues));
  await write(path.join(outDir, `agents/${shop.claims_network}.hocon`), fill(await read(path.join(SRC, "shops/common/claims.template.hocon")), hoconValues));

  const manifest = {
    brand: shop.name,
    networks: [{
      name: shop.network,
      front_man: shop.front_man,
      hocon: `./${shop.network}.network.json`,
      description: `Help with ${shop.name}'s products, orders and returns. Fictional demo shop.`,
      tags: ["agentified-website", "fictional-demo", "ord/1"],
      sample_queries: assistantQueries,
    }],
    llm_router: { base_url: "https://api.openai.com/v1", mock: false, byok_router: "https://api.openai.com/v1" },
    allowed_peers: [originOf(config.desk)],
    peer_policy: { mode: "closed", deny_origins: [], note: "The assistant may load the Open Resolution Desk's public procedure guide. The visitor approves each contact." },
    agent_mcp: { protocol: "nsdeploy-agent-mcp/v1", network: shop.network, front_man: shop.front_man, available: false, reason: "This is a static site; a public MCP facade requires an application host." },
    theme: { primary: shop.theme.primary },
    linking: {
      protocol: "nsdeploy-link/v1",
      exports: [{ network: shop.network, front_man: shop.front_man, aliases: [shop.network, shop.front_man], url: shop.network }],
      imports: [],
      link_updates: { mode: "browser-local" },
    },
    deployment: { mode: "static", self_contained_runtime: true, browser_mock: false, direct_byok: true, direct_mcp_requires_cors: true, public_mcp_facade: false },
    actions: { version: 1, module: "./site-actions.js", agentTools: ["get_shop_info", "look_up_order", "start_return", "prepare_desk_handoff"] },
    resolution: {
      protocol: "ord/1",
      desk: config.desk,
      engine: ENGINE,
      terms: { current: shop.terms_current, versions: Object.fromEntries(Object.entries(versions).map(([v, e]) => [v, { url: `./${e.path}`, sha256: e.sha256, effective_from: e.effective_from, effective_until: e.effective_until }])) },
      offers: shop.offers,
      representative,
      case_page: "./backoffice.html",
    },
  };
  await write(path.join(outDir, "agent-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await write(path.join(outDir, "links.json"), `${JSON.stringify({ version: 1, networks: { [shop.network]: {} } }, null, 2)}\n`);
  const claimsManifest = {
    brand: `${shop.name} (case representative)`,
    networks: [{
      name: shop.claims_network,
      front_man: "shop_representative",
      hocon: `./${shop.claims_network}.network.json`,
      description: `Speaks for ${shop.name} in Open Resolution Desk cases, within a published mandate. Other agentic websites call it by URL.`,
      tags: ["ord/1", "public-network", "fictional-demo"],
      sample_queries: claimsQueries,
    }],
    llm_router: { base_url: "https://api.openai.com/v1", mock: false, byok_router: "https://api.openai.com/v1" },
    allowed_peers: [],
    peer_policy: { mode: "closed", deny_origins: [], note: "This network calls no other site." },
    agent_mcp: { protocol: "nsdeploy-agent-mcp/v1", network: shop.claims_network, front_man: "shop_representative", available: false, reason: "This is a static site; a public MCP facade requires an application host." },
    linking: {
      protocol: "nsdeploy-link/v1",
      exports: [{ network: shop.claims_network, front_man: "shop_representative", aliases: [shop.claims_network, "shop_representative"], url: shop.claims_network }],
      imports: [],
      link_updates: { mode: "browser-local" },
    },
    deployment: { mode: "static", self_contained_runtime: false, browser_mock: false, direct_byok: true, direct_mcp_requires_cors: true, public_mcp_facade: false },
  };
  await write(path.join(outDir, "agents/agent-manifest.json"), `${JSON.stringify(claimsManifest, null, 2)}\n`);
  await write(path.join(outDir, "agents/links.json"), `${JSON.stringify({ version: 1, networks: { [shop.claims_network]: {} } }, null, 2)}\n`);
  buildNetwork(path.join(outDir, `${shop.network}.hocon`), path.join(outDir, "agent-manifest.json"), path.join(outDir, "runtime"));
  buildNetwork(path.join(outDir, `agents/${shop.claims_network}.hocon`), path.join(outDir, "agents/agent-manifest.json"), path.join(outDir, "runtime"));
}
await write(path.join(shopsOut, ".nojekyll"), "");
await write(path.join(shopsOut, "index.html"), fill(await read(path.join(SRC, "shops/root-index.template.html")), {
  BRACKENLIGHT_URL: config.shops.brackenlight,
  COPPICE_URL: config.shops.coppice,
  DESK_URL: config.desk,
}));

// -------------------------------------------------------------------- desk
await mkdir(deskOut, { recursive: true });
for (const entry of await readdir(path.join(SRC, "desk"), { withFileTypes: true })) {
  if (entry.name.endsWith(".template.json")) continue;
  await cp(path.join(SRC, "desk", entry.name), path.join(deskOut, entry.name), { recursive: true });
}
await rm(path.join(deskOut, "agents/agent-manifest.template.json"), { force: true });
await copyCommon(deskOut);
await cp(path.join(SRC, "common/fonts"), path.join(deskOut, "fonts"), { recursive: true });
const deskValues = {
  DESK_URL: config.desk,
  ENGINE_SHA256: ENGINE.sha256,
};
const deskManifest = JSON.parse(fill(await read(path.join(SRC, "desk/agent-manifest.template.json")), { ...deskValues, SAMPLE_QUERIES: "__Q__" }));
deskManifest.networks[0].sample_queries = await sampleQueries(path.join(SRC, "desk/desk_clerk.hocon"));
await write(path.join(deskOut, "agent-manifest.json"), `${JSON.stringify(deskManifest, null, 2)}\n`);
const previewManifest = JSON.parse(fill(await read(path.join(SRC, "desk/agents/agent-manifest.template.json")), { ...deskValues, SAMPLE_QUERIES: "__Q__" }));
previewManifest.networks[0].sample_queries = await sampleQueries(path.join(SRC, "desk/agents/desk_preview.hocon"));
await write(path.join(deskOut, "agents/agent-manifest.json"), `${JSON.stringify(previewManifest, null, 2)}\n`);
buildNetwork(path.join(deskOut, "desk_clerk.hocon"), path.join(deskOut, "agent-manifest.json"), path.join(deskOut, "runtime"));
buildNetwork(path.join(deskOut, "agents/desk_preview.hocon"), path.join(deskOut, "agents/agent-manifest.json"), path.join(deskOut, "runtime"));

// Sample handoffs: the same packages a shop's handoff link carries.
const samples = [
  { shop: "brackenlight", order: "BL-2207", claim: { type: "change_of_mind", sku: "lamp-ash-glaze", facts: { unused: true, original_packaging: true } }, story: "I bought the Ash Glaze lamp in early October, before the terms changed. The shade colour does not suit my room. It is unused and still in its box. The shop's assistant says I am past the 30-day window.", decision: "Not eligible: \"Reported within 30 days of delivery\" is not met, clause 2.1 (our returns terms, version 3)" },
  { shop: "coppice", order: "CC-5531", claim: { type: "change_of_mind", sku: "wheelset-custom", facts: { unused: true, original_packaging: true } }, story: "I ordered a custom wheelset and changed my mind before riding it. It is unused and in the box. I would like a refund.", decision: "Not eligible: \"The item is not excluded (made-to-order items)\" is not met, clause 4.1 (our returns terms, version 1)" },
];
for (const s of samples) {
  const receipt = shopData[s.shop].data.orders.find((o) => o.order_id === s.order);
  await write(path.join(deskOut, `samples/${s.shop}-${s.order}.json`), `${JSON.stringify({ protocol: "ord-handoff/1", receipt, story: s.story, shop_decision: s.decision, claim: s.claim }, null, 2)}\n`);
}
// The landing page shows the sample case's fingerprint, filed on a fixed date.
const sampleDate = "2026-11-13";
const bl = shopData.brackenlight;
const sampleReceipt = bl.data.orders.find((o) => o.order_id === "BL-2207");
const { computeOutcome } = await import("../protocol/v1/case.js");
const sampleOutcome = await computeOutcome({
  terms: bl.termsDocs[sampleReceipt.terms.version],
  receipt: sampleReceipt,
  claim: { type: "change_of_mind", sku: "lamp-ash-glaze", quantity: 1, reported_on: sampleDate, facts: { unused: true, original_packaging: true } },
  engineSha256: ENGINE.sha256,
});
await write(path.join(deskOut, ".nojekyll"), "");
for (const page of ["index.html", "protocol.html", "verify.html", "case.html"]) {
  const file = path.join(deskOut, page);
  if (existsSync(file)) await write(file, fill(await read(file), {
    DESK_URL: config.desk, BRACKENLIGHT_URL: config.shops.brackenlight, COPPICE_URL: config.shops.coppice, ENGINE_SHA256: ENGINE.sha256,
    SAMPLE_FINGERPRINT: sampleOutcome.fingerprint, SAMPLE_DATE_LONG: "Fri 13 Nov 2026",
  }));
}
console.log(`Built ${env}: engine ${ENGINE.sha256}`);

if (publish) {
  if (env !== "prod") throw new Error("--publish needs the prod build.");
  const docs = path.join(BUILD, "docs");
  await rm(docs, { recursive: true, force: true });
  await cp(deskOut, docs, { recursive: true });
  const shopsRepo = path.resolve(BUILD, config.shops_repo_dir);
  await mkdir(shopsRepo, { recursive: true });
  for (const entry of await readdir(shopsRepo)) {
    if ([".git", "README.md", "LICENSE"].includes(entry)) continue;
    await rm(path.join(shopsRepo, entry), { recursive: true, force: true });
  }
  await cp(shopsOut, shopsRepo, { recursive: true });
  console.log(`Published the desk to ${path.relative(BUILD, docs)}/ and the shops to ${shopsRepo}`);
}
