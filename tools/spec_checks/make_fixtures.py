"""Write the spec-check fixture networks into src/desk/spec-checks/. Usage: python3 tools/spec_checks/make_fixtures.py src/desk/spec-checks"""
import json, os, sys
ROOT = sys.argv[1]
BASE = "/open-resolution-desk/spec-checks"

def network(desc, agent, agent_desc, instructions, tools, labels=None, extra_agents=None):
    net = {
        "metadata": {"description": desc, "sample_queries": ["Run the check."]},
        "llm_config": {"model_name": "neuro-san-mock-browser"},
        "max_steps": 12,
        "tools": [{
            "name": agent,
            "function": {
                "description": agent_desc,
                "parameters": {"type": "object", "properties": {"request": {"type": "string", "description": "What to check, in plain language."}}, "required": ["request"]},
            },
            "instructions": instructions,
            "tools": tools,
        }] + (extra_agents or []),
    }
    if labels:
        net["link_labels"] = labels
    return net

def manifest(brand, name, front, desc):
    return {
        "brand": brand,
        "networks": [{"name": name, "front_man": front, "hocon": f"./{name}.network.json", "description": desc, "tags": ["spec-check", "test-fixture"], "sample_queries": ["Run the check."]}],
        "llm_router": {"base_url": "browser://mock", "mock": True},
        "allowed_peers": [],
        "peer_policy": {"mode": "open", "deny_origins": [], "note": "Test fixture. It calls only networks published on this site."},
        "deployment": {"mode": "static", "self_contained_runtime": False, "browser_mock": True, "direct_byok": False, "direct_mcp_requires_cors": True, "public_mcp_facade": False},
    }

def write(rel, data):
    path = os.path.join(ROOT, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")

RUNNER = "Call each of your tools once, with the request you received, and report what each one returned. Do not add anything else."

# 1. Invalid network: the caller is valid; the peer it calls is not.
write("invalid/agent-manifest.json", manifest("Spec check: invalid network", "invalid_check", "check_runner", "Calls a published network that fails validation."))
write("invalid/invalid_check.network.json", network(
    "Calls a published network that fails validation, to show that the runtime refuses to run it.",
    "check_runner", "Runs the invalid-network check.", RUNNER,
    [f"{BASE}/invalid/broken/broken_network"], {f"{BASE}/invalid/broken/broken_network": "Broken network"}))
write("invalid/links.json", {"version": 1, "networks": {"invalid_check": {}}})
write("invalid/broken/agent-manifest.json", manifest("Spec check: a network that fails validation", "broken_network", "broken_front", "Fails validation on purpose: its front agent names a tool that does not exist."))
write("invalid/broken/broken_network.network.json", network(
    "Fails validation on purpose: its front agent names a tool that does not exist.",
    "broken_front", "A front agent that refers to a missing agent.", RUNNER,
    ["ghost_agent"]))
write("invalid/broken/links.json", {"version": 1, "networks": {"broken_network": {}}})

# 2. Composition cycle: A calls B, and B calls A.
write("cycle/agent-manifest.json", manifest("Spec check: composition cycle", "cycle_a", "cycle_runner", "Calls network B, which calls this network again."))
write("cycle/cycle_a.network.json", network(
    "Calls network B on this site. B calls this network again, which closes a cycle.",
    "cycle_runner", "Runs the composition-cycle check.", RUNNER,
    [f"{BASE}/cycle/b/cycle_b"], {f"{BASE}/cycle/b/cycle_b": "Cycle network B"}))
write("cycle/links.json", {"version": 1, "networks": {"cycle_a": {}}})
write("cycle/b/agent-manifest.json", manifest("Spec check: composition cycle, network B", "cycle_b", "cycle_b_runner", "Calls network A, which called it."))
write("cycle/b/cycle_b.network.json", network(
    "Calls network A on this site, which called it. The runtime should stop the cycle.",
    "cycle_b_runner", "The second network in the cycle.", RUNNER,
    [f"{BASE}/cycle/cycle_a"], {f"{BASE}/cycle/cycle_a": "Cycle network A"}))
write("cycle/b/links.json", {"version": 1, "networks": {"cycle_b": {}}})

# 3. Over budget: five peer networks, one more than the runtime's per-query limit of four.
peers = [f"{BASE}/budget/peers/peer_{i}" for i in range(1, 6)]
write("budget/agent-manifest.json", manifest("Spec check: over-budget request", "budget_check", "budget_runner", "Calls five peer networks, one more than the runtime allows per query."))
write("budget/budget_check.network.json", network(
    "Calls five peer networks on this site. The runtime allows four remote calls per query, so it should refuse the fifth.",
    "budget_runner", "Runs the over-budget check.", RUNNER,
    peers, {p: f"Peer network {i}" for i, p in enumerate(peers, 1)}))
write("budget/links.json", {"version": 1, "networks": {"budget_check": {}}})
peer_manifest = manifest("Spec check: five peer networks", "peer_1", "peer_agent", "One of five small peer networks.")
peer_manifest["networks"] = [{"name": f"peer_{i}", "front_man": "peer_agent", "hocon": f"./peer_{i}.network.json", "description": f"Peer network {i} for the over-budget check.", "tags": ["spec-check", "test-fixture"], "sample_queries": ["Run the check."]} for i in range(1, 6)]
write("budget/peers/agent-manifest.json", peer_manifest)
for i in range(1, 6):
    write(f"budget/peers/peer_{i}.network.json", network(
        f"Peer network {i} for the over-budget check. It answers with its own name.",
        "peer_agent", f"Peer network {i}.", f"Answer with the words: peer network {i} answered.", []))
write("budget/peers/links.json", {"version": 1, "networks": {f"peer_{i}": {} for i in range(1, 6)}})
print("ok")

# 4. Denied origin: the network names a peer on another origin that its manifest does not allow.
PEER = "https://ord-demo-shops.github.io/brackenlight/agents/brackenlight_claims"
denied = manifest("Spec check: denied origin", "denied_check", "denied_runner", "Calls a network on an origin that this manifest does not allow.")
denied["peer_policy"] = {"mode": "closed", "deny_origins": [], "note": "Test fixture. No other origin is allowed, so the runtime must refuse the peer below."}
denied["allowed_peers"] = []
write("denied/agent-manifest.json", denied)
write("denied/denied_check.network.json", network(
    "Calls a network on another origin that this site's manifest does not allow. The runtime asks the visitor first and then refuses the contact under the manifest's peer policy.",
    "denied_runner", "Runs the denied-origin check.", RUNNER,
    [PEER], {PEER: "Brackenlight Home's representative"}))
write("denied/links.json", {"version": 1, "networks": {"denied_check": {}}})
print("denied ok")
