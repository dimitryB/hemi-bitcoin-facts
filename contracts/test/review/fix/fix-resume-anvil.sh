#!/usr/bin/env bash
# Fix review: does `forge script --resume` run the script (and so the guard) again? LOCAL ANVIL ONLY:
#   anvil --port 18613 --chain-id 43111
#   bash contracts/test/review/fix/fix-resume-anvil.sh http://127.0.0.1:18613
# A confirmed broadcast, then --resume without the confirmation. Uses anvil's unlocked first account; no key.
set -euo pipefail
RPC=${1:?usage: fix-resume-anvil.sh http://127.0.0.1:<anvil port>}
case "$RPC" in http://127.0.0.1:* | http://localhost:*) ;; *) echo "refusing: not a local RPC: $RPC" >&2; exit 1 ;; esac
cast rpc web3_clientVersion --rpc-url "$RPC" | grep -qi anvil || { echo "refusing: not anvil" >&2; exit 1; }
[ "$(cast chain-id --rpc-url "$RPC")" = 43111 ] || { echo "start anvil with --chain-id 43111" >&2; exit 1; }
cd "$(dirname "$0")/../../.."
SENDER=$(cast rpc eth_accounts --rpc-url "$RPC" | tr -d '[]" ' | cut -d, -f1)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export FOUNDRY_OUT="$TMP/out" FOUNDRY_CACHE_PATH="$TMP/cache" FOUNDRY_BROADCAST="$TMP/broadcast"
unset CONFIRM_MAINNET_DEPLOY
echo "-- R1 CONFIRM=yes run() --broadcast"
CONFIRM_MAINNET_DEPLOY=yes forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast --unlocked --sender "$SENDER" 2>&1 \
  | grep -E "^ *chain id:|^ *mode:|\[deploy\]|ONCHAIN|script failed" | grep -v console::log || true
echo "   nonce $(cast nonce "$SENDER" --rpc-url "$RPC")"
echo "-- R2 --resume, no CONFIRM (does the script run again? it would log 'chain id:' and 'mode:')"
forge script script/Deploy.s.sol --rpc-url "$RPC" --resume --unlocked --sender "$SENDER" > "$TMP/r2.log" 2>&1 || true
grep -E "chain id:|mode:|\[deploy\]|\[skip\]|ONCHAIN|Error|script failed|[Rr]esum|[Tt]ransactions|Script ran" "$TMP/r2.log" \
  | grep -v console::log | sed 's/^/   /' || echo "   (none of: chain id:, mode:, [deploy], ONCHAIN, Error)"
echo "   last lines:"; grep -vE "^\s*$" "$TMP/r2.log" | tail -4 | sed 's/^/     /'
echo "   nonce $(cast nonce "$SENDER" --rpc-url "$RPC")"
