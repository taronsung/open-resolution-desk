#!/bin/sh
# Build the dev sites and serve them like GitHub Pages (CORS *), on two origins:
#   desk:  http://127.0.0.1:8090/open-resolution-desk/
#   shops: http://127.0.0.1:8091/brackenlight/  and  /coppice/
# Optional local model: ~/.lmstudio/bin/lms server start --port 1234 --cors
#   then load qwen/qwen3-30b-a3b-2507 and use router http://127.0.0.1:1234/v1, key "lm-studio".
set -e
cd "$(dirname "$0")/.."
node tools/build_sites.mjs dev
pkill -f "tools/serve.py dist/dev" 2>/dev/null || true
nohup python3 tools/serve.py dist/dev/desk 8090 --prefix /open-resolution-desk >/dev/null 2>&1 &
nohup python3 tools/serve.py dist/dev/shops 8091 >/dev/null 2>&1 &
echo "Desk:  http://127.0.0.1:8090/open-resolution-desk/"
echo "Shops: http://127.0.0.1:8091/brackenlight/  http://127.0.0.1:8091/coppice/"
