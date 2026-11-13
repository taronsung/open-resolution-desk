# Open Resolution Desk

An open agentic website for settling post-sale disputes between customers and
online shops, under the returns terms the shop published on the day of
purchase. It was built for the Open Agentic Web Challenge.

The two shops in the demo are fictional. The desk gives no legal advice, and it
is not a court, a public body or a dispute resolution entity.

- Desk: https://taronsung.github.io/open-resolution-desk/
- Fictional shops: https://ord-demo-shops.github.io/brackenlight/ and
  https://ord-demo-shops.github.io/coppice/

## What it does

1. At checkout, a shop's receipt pins its returns terms by version number and
   SHA-256 fingerprint.
2. When the customer and the shop disagree, the shop hands the case to the desk
   with a link. With the visitor's consent, the desk reads the pinned version
   from the shop's own site and checks the fingerprint.
3. A published decision function computes the outcome from the terms, the
   receipt and the claim. No language model decides it.
4. The desk's assistant explains the outcome. When asked, it loads the shop's
   own representative agent network by URL and runs it in the visitor's
   browser, with the visitor's model and key. The representative can offer
   alternatives that the shop publishes as data.
5. The customer chooses an option. The shop opens the case link on its own
   site, recomputes the outcome with its own records and its own copy of the
   decision function, sees the same fingerprint and confirms.

The desk never receives a case. The site is static, and a case travels inside
the fragment of the links the parties send each other.

## Try it

Open the desk and press **Open the sample case**. Every step has a button, so
the whole case works without a model key. To use the assistants, open the
settings under a chat and enter an OpenAI-compatible router that allows browser
requests (for example `https://api.openai.com/v1`), a model and your key. The
key stays in your browser and goes only to that router.

The second sample is a made-to-order wheelset. There the desk sides with the
shop, and the shop offers a goodwill credit it publishes as data.

To start at a shop instead, open Brackenlight Home, find order `BL-2207` with
`mina.park@example.com`, and start a return. The shop's own form judges it
under today's terms and refuses. The desk applies the terms on the receipt.

## Agent networks

| Network | Where | Front agent and tools |
| --- | --- | --- |
| `desk_clerk` | desk, `agent-manifest.json` | `case_assistant` with 5 website actions and the `shop_representative` link slot |
| `desk_preview` | desk, `agents/agent-manifest.json` | `procedure_guide`, a public network other sites load by URL |
| `brackenlight_assistant`, `coppice_assistant` | each shop, `agent-manifest.json` | `shop_assistant` with 4 website actions and the desk's `desk_preview` by URL |
| `brackenlight_claims`, `coppice_claims` | each shop, `agents/agent-manifest.json` | `shop_representative`, whose instructions are the shop's published mandate |

Networks that other sites call live under `agents/`, in a manifest without
website actions, so a caller can load them at once.

## How it follows the specification

| MVP specification | In this project |
| --- | --- |
| Data-only network and manifest (2, 3.3) | HOCON sources built into `.network.json` with the runtime's own parser and validator |
| Browser execution and site actions (3.1) | `get_case` and `check_terms` read, `file_claim` writes, `accept_option` and `request_review` are irreversible and confirmed by the page |
| Loading a peer site (3.2) | The desk binds the shop's representative at run time from the shop's manifest, and shops load the desk's guide by URL. Each contact with another origin asks first. |
| Pluggable inference, BYOK (4) | The visitor's key goes only to the chosen router. Peer networks run with the caller's router and never see the key. |
| Private context (5) | Only `case_ref` may pass to the shop's representative (`allow.to_downstream.sly_data`). The customer's contact stays on the page. |
| Fail closed (5) | Terms that do not match the receipt's hash stop the case. Unknown offers are refused. A declined contact stops that step and says so. |
| Observable execution (5) | The Across sites panel lists every contact, what was read, and which private fields were passed |
| Extensions (7) | Post-sale arbitration, and integrity pinning of terms and of the decision function |

Browsers with WebMCP (`document.modelContext`) also get the same operations as
tools. The page still asks before each contact and each irreversible step.

## Repository layout

| Path | Contents |
| --- | --- |
| `src/desk` | Desk pages, case workspace, networks and site actions |
| `src/shops` | Shared shop template, and data, terms and art for each fictional shop |
| `src/common` | Shared UI: fingerprint mark, dialogs, WebMCP, fonts |
| `protocol/v1` | The ord/1 protocol: canonical JSON, the decision function, case files |
| `tests` | Protocol unit tests and browser end-to-end tests |
| `tools` | Build script, a site conformance checker, a local server that sends GitHub Pages headers, accessibility audit, art generator |
| `vendor/agentic-web` | The browser runtime and network builder from the agentic-web repository, unchanged |
| `docs` | The built desk, served by GitHub Pages |

## Build and test

Node.js 22 or newer and Python 3.

```sh
npm install
npm test                 # protocol unit tests
npm run dev              # build and serve the desk on :8090 and the shops on :8091
npm run test:e2e         # browser checks without a model, on the local build
npm run test:e2e:prod    # the same checks against the published sites
npm run audit:a11y       # axe-core, WCAG 2.1 AA, desktop and phone widths
npm run audit:a11y:prod  # the same audit against the published sites
npm run publish:prod     # build for GitHub Pages into docs/ and the shops repository
```

## Checking any agentic site

`tools/check_agentic_site.mjs` checks the public files of any open agentic
website against MVP Profile 0.2, the way a browser on another origin reads
them: the manifest, each network definition it names, `links.json`, CORS and
HTTPS, and the peer networks those files point to. It parses and validates each
network with the runtime's own `hocon.js` and `kernel.js`. It checks published
files only, not runtime behaviour.

```sh
node tools/check_agentic_site.mjs https://taronsung.github.io/open-resolution-desk/
node tools/check_agentic_site.mjs https://ord-demo-shops.github.io/brackenlight/agents/brackenlight_claims
node tools/check_agentic_site.mjs <url> --runtime <agentic-web>/skills/agentify-website/runtime --json
```

A URL that ends in a network name is treated as a peer-network reference
(section 3.2): the tool reads the manifest one level up and requires an entry
with exactly that name. The exit code is 1 when a check fails.

For a local model, LM Studio works: `lms server start --port 1234 --cors`, load
`qwen/qwen3-30b-a3b-2507`, then use router `http://127.0.0.1:1234/v1` with any
key.

## Notes for small models

The desk's assistant gets the current case appended to its instructions on
every call, as the agentic-web pizza example does with its menu and cart. The
shop's representative is linked only once an outcome exists, and a refused
return already carries its claim to the desk. With these, a non-reasoning
30B model on a laptop settles the sample case in three short turns.

## Limits

- Steps are hashed, not signed. A case file shows that nothing changed after a
  step was recorded, but not who recorded it.
- Facts are recorded as stated. When the shop disputes one, the case goes to a
  person.
- The decision function runs as a site action on the desk and as a pinned
  module on the shop. The runtime's coded-tool sandbox needs a response header
  that GitHub Pages cannot set.
- Everything is tab-scoped. There are no accounts and no notifications.

## Specification version

Built against https://github.com/cognizant-ai-labs/agentic-web at `e4a8727`,
the last commit before the submission period opened. The later `db56616` has
the same specification and the same skill runtime.

## License

Apache License 2.0. See `NOTICE` for the vendored runtime and the fonts.
