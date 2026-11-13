"""Write the spec-check HTML pages into src/desk/spec-checks/. Usage: python3 tools/spec_checks/make_pages.py src/desk/spec-checks"""
import os, sys, html

ROOT = sys.argv[1]

HEAD = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title}, Open Resolution Desk</title>
  <meta name="description" content="{description}">
  <link rel="icon" href="{up}img/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="{up}css/desk.css">
  {script}
</head>
<body>
  <a class="skip" href="#main">Skip to content</a>
  <header class="site-top">
    <div class="site-header">
    <a class="wordmark" href="{up}"><img src="{up}img/mark.svg" alt="" width="34" height="34">Open Resolution Desk</a>
    <nav aria-label="Main">
      <a href="{up}case.html">Case workspace</a>
      <a href="{up}verify.html">Verify a case file</a>
      <a href="{up}protocol.html">For shops and agents</a>
    </nav>
    </div>
    <p class="demo-strip">A demo for the Open Agentic Web Challenge. The shops are fictional. This is not legal advice.</p>
  </header>
"""

FOOT = """  <footer class="site-footer"><p>Open Resolution Desk, an open-source demo for the Open Agentic Web Challenge. <a href="https://github.com/taronsung/open-resolution-desk">Source code</a>.</p></footer>
</body>
</html>
"""

RUNTIME_NOTE = "This page runs the agentic-web browser runtime, unchanged, on the test network named below. The runtime's built-in mock model calls each tool once, in order, so the check needs no key and gives the same result every time. It does not use a model key saved for this site."

CHECKS = {
    "invalid": {
        "title": "Spec check: invalid network",
        "h1": "Invalid network",
        "description": "A reproducible check that the runtime refuses to run a published network that fails validation.",
        "networks": [
            ("invalid_check", "./invalid_check.network.json", "this page's network. Its one agent calls the network below."),
            ("broken_network", "./broken/broken_network.network.json", "a network on this site that fails validation on purpose: its front agent lists a tool named <code>ghost_agent</code>, which the network does not define."),
        ],
        "expected": "The runtime fetches the broken network's manifest and definition, validates it, and refuses to run it. It reports that the network failed validation and names the missing tool. Nothing from that network runs.",
    },
    "cycle": {
        "title": "Spec check: composition cycle",
        "h1": "Composition cycle",
        "description": "A reproducible check that the runtime stops a composition cycle between two networks.",
        "networks": [
            ("cycle_a", "./cycle_a.network.json", "this page's network. It calls network B."),
            ("cycle_b", "./b/cycle_b.network.json", "network B, published at its own path on this site. It calls network A again, which closes the cycle."),
        ],
        "expected": "The runtime runs B, then refuses to run A again inside the same request. It reports that the network is already in this request's call chain.",
    },
    "budget": {
        "title": "Spec check: over-budget request",
        "h1": "Over-budget request",
        "description": "A reproducible check that the runtime refuses a remote call beyond its per-query budget.",
        "networks": [
            ("budget_check", "./budget_check.network.json", "this page's network. Its one agent calls five peer networks."),
            ("peer_1 to peer_5", "./peers/agent-manifest.json", "five small networks published under one manifest on this site."),
        ],
        "expected": "The runtime allows four remote calls per query and one call per peer. It runs peers 1 to 4 and refuses the fifth, reporting that the per-query limit of 4 calls was reached.",
    },
    "denied": {
        "title": "Spec check: denied origin",
        "h1": "Denied origin",
        "description": "A reproducible check that the runtime refuses a peer on an origin that the site's manifest does not allow.",
        "networks": [
            ("denied_check", "./denied_check.network.json", "this page's network. It names Brackenlight Home's representative network on ord-demo-shops.github.io as a tool, while its <a href=\"./agent-manifest.json\">manifest</a> allows no other origin."),
        ],
        "expected": "The runtime asks before contacting the other origin. If you allow the contact, the runtime still refuses it, because the manifest's peer policy does not allow that origin, and it fetches nothing from the shop. If you decline, it reports that you declined.",
    },
}

SPEC_LINE = "“Stop an invalid network, a composition cycle, an over-budget request, and a denied origin with visible errors.” Minimum Viable Specification, section 6."


def check_page(kind, c):
    nets = "\n".join(
        f'      <li><a href="{href}"><code>{html.escape(name)}</code></a>: {text}</li>' for name, href, text in c["networks"])
    body = f"""  <main id="main" class="narrow doc spec-check" data-check="{kind}">
    <p class="crumb"><a href="../">Spec checks</a></p>
    <h1>{c["h1"]}</h1>
    <p class="lede-small">{SPEC_LINE}</p>
    <h2>Test networks</h2>
    <ul>
{nets}
    </ul>
    <h2>Expected result</h2>
    <p>{c["expected"]}</p>
    <p><button type="button" class="btn primary" data-run disabled>Run the check</button></p>
    <div id="check-result" class="check-result" role="status" aria-live="polite" data-state="idle"><strong>Not run yet.</strong></div>
    <section class="check-runtime" aria-labelledby="runtime-title">
      <h2 id="runtime-title">The runtime</h2>
      <p class="small">{RUNTIME_NOTE}</p>
      <div id="agent-app">
        <div data-ns-slot="header"></div>
        <div data-ns-slot="chat"></div>
        <div data-ns-slot="settings"></div>
        <div data-ns-slot="agents"></div>
      </div>
    </section>
  </main>
"""
    head = HEAD.format(title=c["title"], description=c["description"], up="../../", script='<script type="module" src="../check.js"></script>')
    return head + body + FOOT


HUB_ROWS = [
    ("Publish a two-agent HOCON network and a manifest from an ordinary HTTPS web host.",
     'The desk\'s <a href="../desk_clerk.network.json">case network</a> has two agents, a case assistant and a terms analyst (<a href="../desk_clerk.hocon">HOCON source</a>, <a href="../agent-manifest.json">manifest</a>), on GitHub Pages.'),
    ("Load and run that network in a browser with the site's published default router and model, and, if BYOK is offered, the user-selected path.",
     "The checks on this page run with the router their manifests publish (the runtime's mock), with no key. The desk and the shops offer BYOK under each chat, tested with a local model."),
    ("Call an internal agent and at least one grounded capability through MCP or a registered local site action.",
     'On the <a href="../case.html#sample=brackenlight-BL-2207">case page</a>, ask what a clause says: the case assistant calls the terms analyst, which reads the case through a site action. The Developer view shows the call.'),
    ("After user approval, load an exact named network from a second origin and run it locally in the caller's browser.",
     "The desk loads the shop's representative network from ord-demo-shops.github.io after a consent card, and the shops load the desk's procedure guide. The Across sites panel lists each load."),
    ("When a user key is active, show that the second site never receives it and cannot change the caller's router.",
     "The Across sites panel names the model router as the only place the key goes. The model test records every request and finds the test key only in requests to the router. Peers run with the caller's router."),
    ("Show that private context is absent at the peer unless a named field is explicitly allowed.",
     "The page puts the customer's contact in private context, and the case network allows only <code>case_ref</code> downstream. The Across sites panel shows the fields passed to the shop's network: <code>case_ref</code> only."),
    ("Stop an invalid network, a composition cycle, an over-budget request, and a denied origin with visible errors.",
     'The four checks below, each on its own page: <a href="./invalid/">invalid network</a>, <a href="./cycle/">composition cycle</a>, <a href="./budget/">over-budget request</a> and <a href="./denied/">denied origin</a>.'),
]


def hub_page():
    rows = "\n".join(
        f"        <tr><td>{html.escape(spec).replace('&#x27;', chr(39))}</td><td>{how}</td></tr>" for spec, how in HUB_ROWS)
    links = "\n".join(
        f'      <li><a href="./{kind}/">{c["h1"]}</a>: {c["expected"].split(". ")[0]}.</li>' for kind, c in CHECKS.items())
    body = f"""  <main id="main" class="narrow doc">
    <h1>Specification checks</h1>
    <p>Section 6 of the Minimum Viable Specification for a Worldwide Agentic Web lists what an implementation should be able to demonstrate. This page says where Open Resolution Desk shows each item, and runs the four visible stops on small test networks.</p>
    <table>
      <thead><tr><th scope="col">Section 6 item</th><th scope="col">Where and how it is shown</th></tr></thead>
      <tbody>
{rows}
      </tbody>
    </table>

    <h2 id="stops">The visible stops</h2>
    <p>{RUNTIME_NOTE.replace("on the test network named below", "on a small test network")}</p>
    <ul>
{links}
    </ul>
    <p>Each test network is published like any other: a manifest, a network definition in JSON, and <code>links.json</code>. Another runtime can load the same files to check its own behaviour.</p>

    <h2 id="checker">Check any site's public files</h2>
    <p>The repository includes <code>tools/check_agentic_site.mjs</code>, which reads a site's manifest, network definitions and <code>links.json</code> as a browser on another origin would, checks CORS and HTTPS, validates each network with the runtime's own parser and validator, and follows the peer networks they name. With Node.js 22 or newer:</p>
    <pre tabindex="0" aria-label="Command">node tools/check_agentic_site.mjs https://taronsung.github.io/open-resolution-desk/</pre>
    <p>It finds the same fault in the invalid-network check without a browser: run on <code>https://taronsung.github.io/open-resolution-desk/spec-checks/invalid/</code>, it follows the call to the broken network and reports two failures that name the missing tool <code>ghost_agent</code>.</p>
    <p><a href="https://github.com/taronsung/open-resolution-desk">Source code</a></p>
  </main>
"""
    head = HEAD.format(title="Specification checks", description="Where Open Resolution Desk shows each item of section 6 of the agentic web specification, with reproducible checks of the runtime's visible stops.", up="../", script="")
    return head + body + FOOT


for kind, c in CHECKS.items():
    os.makedirs(os.path.join(ROOT, kind), exist_ok=True)
    with open(os.path.join(ROOT, kind, "index.html"), "w") as f:
        f.write(check_page(kind, c))
with open(os.path.join(ROOT, "index.html"), "w") as f:
    f.write(hub_page())
print("pages ok")
