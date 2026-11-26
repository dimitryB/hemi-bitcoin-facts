#!/usr/bin/env bash
# Audit-fixes review follow-up (R-5, R-6, R-7): `hbf bond create`'s per-URL registry check and `hbf finality status`'s
# --skip-exact refusal and `simulated` flag, against three local, non-fork anvils. No mainnet call; nothing is sent
# (the registry is placed with anvil_setCode); no key exists, so a case that passes the registry check stops at the
# key read (ENOENT, exit 1) and a refused one exits 2 before it.
#
#   bash contracts/test/review/audit-fixes/followup-r5-r7-anvil.sh      (after `forge build` in contracts/)
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
HBF=(node "$ROOT/sdk/bin/hbf.mjs")
REG=0xC527EDfEEE8972797D74252aA9111A05ea2C9A4e
FB_RT=$(jq -r .deployedBytecode.object "$ROOT/contracts/out/FidelityBonds.sol/FidelityBonds.json")
BF_RT=$(jq -r .deployedBytecode.object "$ROOT/contracts/out/BitcoinFacts.sol/BitcoinFacts.json")
A=http://127.0.0.1:19701 B=http://127.0.0.1:19702 C=http://127.0.0.1:19703 DEAD=http://127.0.0.1:19709
anvil --port 19701 --chain-id 31337 --silent & PA=$!
anvil --port 19702 --chain-id 31337 --silent & PB=$!
anvil --port 19703 --chain-id 999 --silent & PC=$!
trap 'kill $PA $PB $PC 2>/dev/null || true' EXIT
for u in $A $B $C; do for _ in $(seq 1 30); do cast chain-id --rpc-url "$u" >/dev/null 2>&1 && break; sleep 0.5; done; done
cast rpc --rpc-url "$A" anvil_setCode "$REG" "$FB_RT" >/dev/null
cast rpc --rpc-url "$C" anvil_setCode "$REG" "$FB_RT" >/dev/null

BASE=(bond create --agent 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 --sats 20000 --lock-for 1h --btc-network regtest
  --btc-rpc http://u:p@127.0.0.1:9 --btc-key-file /nonexistent/.secrets/none.key --contract "$REG")
PASS=0 FAIL=0
case_() { # <label> <want exit> <want stderr regex> <args…>
  local label=$1 want=$2 re=$3; shift 3
  local err code
  err=$("${HBF[@]}" "$@" 2>&1 >/dev/null); code=$?
  if [ "$code" = "$want" ] && grep -Eq -e "$re" <<<"$err"; then PASS=$((PASS + 1)); echo "ok    $label (exit $code)"
  else FAIL=$((FAIL + 1)); echo "FAIL  $label: exit $code, stderr: $(tail -c 300 <<<"$err")"; fi
}

case_ "one URL with the registry: passes, stops at the key" 1 'ENOENT|no such file' "${BASE[@]}" --rpc $A
case_ "second URL serves another chain: refused" 2 'serves chain 999, but the tag names chain 31337' "${BASE[@]}" --rpc $A --rpc $C
case_ "second URL has no contract: refused" 2 'no contract at .* \(http://127\.0\.0\.1:19702\)' "${BASE[@]}" --rpc $A --rpc $B
cast rpc --rpc-url "$B" anvil_setCode "$REG" "$BF_RT" >/dev/null
case_ "second URL has other code (BitcoinFacts): refused" 2 "is not this SDK's FidelityBonds" "${BASE[@]}" --rpc $A --rpc $B
cast rpc --rpc-url "$B" anvil_setCode "$REG" "$FB_RT" >/dev/null
case_ "both URLs right: passes, stops at the key" 1 'ENOENT|no such file' "${BASE[@]}" --rpc $A --rpc $B
case_ "first URL names chain 999, second serves 31337: refused" 2 'serves chain 31337, but the tag names chain 999' "${BASE[@]}" --rpc $C --rpc $A
case_ "--chain-id disagrees with the RPC: refused" 2 '--chain-id 999, but the RPC serves chain 31337' "${BASE[@]}" --rpc $A --chain-id 999
case_ "a dead second URL: fails (exit 1), never reaches the key" 1 'cannot read chain id from http://127\.0\.0\.1:19709' "${BASE[@]}" --rpc $A --rpc $DEAD
case_ "--no-registry-check still skips it, with the warning" 1 'warning: --no-registry-check' "${BASE[@]}" --rpc $A --rpc $C --no-registry-check

case_ "status refuses --skip-exact before any call" 2 '--skip-exact applies to finality verify' finality status --block 30 --skip-exact --rpc $DEAD --contract "$REG"
for mode in code state; do
  if [ $mode = code ]; then extra=(--code-override); else
    ov=$(mktemp); echo '{}' >"$ov"; extra=(--code-override --state-override "$ov"); fi
  out=$("${HBF[@]}" finality status --block 30 --skip-reader --rpc $A "${extra[@]}" --json 2>/dev/null); code=$?
  if [ "$code" = 1 ] && [ "$(jq -r .simulated <<<"$out")" = true ] && jq -e '.notes | any(startswith("simulated:"))' <<<"$out" >/dev/null; then
    PASS=$((PASS + 1)); echo "ok    status under --$mode-override: simulated true, the note, final $(jq -r .final <<<"$out") (exit $code)"
  else FAIL=$((FAIL + 1)); echo "FAIL  status under --$mode-override: exit $code, $(head -c 300 <<<"$out")"; fi
done
echo "pass $PASS fail $FAIL"
[ "$FAIL" = 0 ]
