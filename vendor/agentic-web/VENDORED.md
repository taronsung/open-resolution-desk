# Vendored from the agentic-web repository

Source: https://github.com/cognizant-ai-labs/agentic-web, folder
`skills/agentify-website/`.

- `runtime/` is the skill's browser runtime, copied unchanged. Its own
  `README.md` lists how it differs from the nsdeploy runtime it copies, and
  `LICENSE.txt` holds its license.
- `scripts/build_network.mjs` is the skill's network builder. `tools/build_sites.mjs`
  runs it to turn each `.hocon` file into `.network.json` with the runtime's own
  parser and validator.

Commit: `e4a8727`, the last commit before the hackathon's submission period
opened (2026-11-11 20:00 PST). The later commit `db56616` has the same
specification and the same skill runtime.

License: Apache License 2.0 (`LICENSE` in this folder).
