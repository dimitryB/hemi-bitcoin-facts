#!/usr/bin/env bash
# Fix review, second follow-up: what `forge script --resume` can still send, and runs with no RPC. LOCAL ANVILS ONLY.
# Start two fresh anvils with Hemi mainnet's chain id (A stands for a rehearsal fork, B for "another RPC of chain
# 43111"), e.g.
#   anvil --port 18641 --chain-id 43111 ; anvil --port 18642 --chain-id 43111
# then: bash contracts/test/review/fix/fix-resume-norpc-anvil.sh http://127.0.0.1:18641 http://127.0.0.1:18642
# Refuses any RPC that is not a local anvil; uses anvil's unlocked first account (no key); temporary build and
# broadcast directories.
set -euo pipefail
A=${1:?usage: fix-resume-norpc-anvil.sh <anvil A url> <anvil B url>}
B=${2:?usage: fix-resume-norpc-anvil.sh <anvil A url> <anvil B url>}
for R in "$A" "$B"; do
  case "$R" in http://127.0.0.1:* | http://localhost:*) ;; *) echo "refusing: not a local RPC: $R" >&2; exit 1 ;; esac
  cast rpc web3_clientVersion --rpc-url "$R" | grep -qi anvil || { echo "refusing: not anvil: $R" >&2; exit 1; }
  [ "$(cast chain-id --rpc-url "$R")" = 43111 ] || { echo "start $R with --chain-id 43111" >&2; exit 1; }
done
cd "$(dirname "$0")/../../.."   # contracts/
PINNED="0xAecbC8F5f6bB401c7d8A7625f53fE2225b730FfC 0x0706C1582E7C27c09953803384396efd4fa62486 0xC527EDfEEE8972797D74252aA9111A05ea2C9A4e"
SENDER=$(cast rpc eth_accounts --rpc-url "$A" | tr -d '[]" ' | cut -d, -f1)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export FOUNDRY_OUT="$TMP/out" FOUNDRY_CACHE_PATH="$TMP/cache" FOUNDRY_BROADCAST="$TMP/broadcast"
unset CONFIRM_MAINNET_DEPLOY FOUNDRY_CHAIN_ID ETH_RPC_URL

state() { # rpc
  local s="nonce $(cast nonce "$SENDER" --rpc-url "$1"); code"
  for a in $PINNED; do s="$s $(( ($(cast code "$a" --rpc-url "$1" | wc -c) - 3) / 2 ))"; done
  echo "$s"
}
show() { grep -E "^ *chain id:|^ *mode:|RPC eth_chainId|\[deploy\]|\[skip\]|script failed|ONCHAIN EXECUTION|No transactions|SIMULATION COMPLETE|Transactions saved|Error" "$1" \
  | grep -v "console::log" | grep -v "Failed to decode return value" | sed -E "s#(/private)?$TMP/##g; s/^ +//; s/^/    /" || true; }
files() { if [ -d "$FOUNDRY_BROADCAST" ]; then (cd "$FOUNDRY_BROADCAST" && find . -name '*.json' | sort | sed 's/^/    file: /'); else echo "    (no broadcast files)"; fi; }

echo "A: $(state "$A") | B: $(state "$B")"
echo
echo "-- X1 a confirmed preview (dry run) of deployAll(true) against A, e.g. a rehearsal on a mainnet fork"
CONFIRM_MAINNET_DEPLOY=yes forge script script/Deploy.s.sol --rpc-url "$A" --sig 'deployAll(bool)' true \
  --unlocked --sender "$SENDER" > "$TMP/x1.log" 2>&1 || true
show "$TMP/x1.log"; files
echo "    A: $(state "$A") | B: $(state "$B")"
echo "-- X2 later: --resume against B (same chain id, a different RPC), no CONFIRM"
forge script script/Deploy.s.sol --rpc-url "$B" --sig 'deployAll(bool)' true --resume \
  --unlocked --sender "$SENDER" > "$TMP/x2.log" 2>&1 || true
show "$TMP/x2.log"
echo "    A: $(state "$A") | B: $(state "$B")"
for f in "$FOUNDRY_BROADCAST"/Deploy.s.sol/43111/deployAll-latest.json; do
  [ -f "$f" ] && echo "    rpc recorded in the sent sequence: $(grep -oE '"rpc": *"[^"]*"' "$f" | sort -u | tr '\n' ' ')"
done

echo
echo "-- X3 no RPC at all: run() (simulation) and deployAll(true) (dry run), no CONFIRM"
FOUNDRY_BROADCAST="$TMP/bc-x3" forge script script/Deploy.s.sol > "$TMP/x3a.log" 2>&1 || true
show "$TMP/x3a.log"
FOUNDRY_BROADCAST="$TMP/bc-x3" forge script script/Deploy.s.sol --sig 'deployAll(bool)' true > "$TMP/x3b.log" 2>&1 || true
show "$TMP/x3b.log"
grep -qE "vm.rpc|rpc|fork" "$TMP/x3b.log" && grep -E "rpc|fork" "$TMP/x3b.log" | grep -v "^ *├\|^ *│\|^ *└" | head -3 | sed 's/^/    /' || true
echo "-- X4 no RPC: deployAll(true) --broadcast"
FOUNDRY_BROADCAST="$TMP/bc-x4" forge script script/Deploy.s.sol --sig 'deployAll(bool)' true --broadcast \
  --unlocked --sender "$SENDER" > "$TMP/x4.log" 2>&1 || true
show "$TMP/x4.log"
echo "    A: $(state "$A") | B: $(state "$B")"
