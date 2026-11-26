#!/usr/bin/env bash
# Delta review: the changed paths against Hemi mainnet's real hVM precompiles. Read-only: eth_call, eth_getCode,
# eth_getBlockByNumber and eth_estimateGas, with the compiled contracts placed at their CREATE2 addresses by state
# override and PopFinality's storage set by stateDiff. Nothing is signed or sent. About 18 requests, paced by lib.sh.
#   bash contracts/test/review/delta/live-delta.sh
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
CONTRACTS_DIR=$ROOT/contracts
RPC=${HEMI_MAINNET_RPC_URL:-https://rpc.hemi.network/rpc}
# shellcheck source=contracts/live/lib.sh
. "$CONTRACTS_DIR/live/lib.sh"
# shellcheck source=contracts/live/finality.sh
. "$CONTRACTS_DIR/live/finality.sh"
[ "$(cast chain-id --rpc-url "$RPC")" = 43111 ] || live_die "not Hemi mainnet"
(cd "$CONTRACTS_DIR" && forge build > /dev/null 2>&1)
echo "== Hemi block $(cast block-number --rpc-url "$RPC")"
hdr=$(call 0x0000000000000000000000000000000000000044 0x)
hvm_height=$(cast to-dec "0x${hdr:2:8}")
hvm_hash=0x${hdr:10:64}
echo "   0x44: height $hvm_height hash $hvm_hash"

# -- BitcoinFacts: the genesis coinbase through the real precompiles ---------------------------------
place BitcoinFacts "$(cast keccak hemi-bitcoin-facts/BitcoinFacts/v1)" "$(initcode BitcoinFacts)"
G=0x4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b
for v in 0 1; do
  r=$(call "$ADDR_BitcoinFacts" "$(cast calldata 'checkOutput(bytes32,uint16)' $G $v)" "$(overrides_json)")
  expect_eq "checkOutput(genesis coinbase, $v) verdict (4 = Unspendable)" "$(cast to-dec "0x${r:66:64}")" 4
done

# -- PopFinality: the best re-read with real 0x42/0x43, keystone 5620225 --------------------------
place PopFinality "$(cast keccak "$PF_SALT_STRING")" "$(initcode PopFinality)"
K=5620225
POP=0xd4ed6ec2eaa89b78906efc54c3dd309761bb30ca8a38b6477951033957a6845e
BOGUS=0x1111111111111111111111111111111111111111111111111111111111111111
live_pace
hash=$(cast rpc eth_getBlockByNumber "$(cast to-hex $K)" false --rpc-url "$RPC" | jq -r .hash)
cp_sd() { printf '"%s":"%s"' "$(cast index uint256 $K 0)" "$(printf '0x%024x%016x%s' 0 1 "${hash:2:24}")"; }
# entry <txid> <vout>: the three slots of a stored publication (K, txid, vout), as of the current 0x44 header
entry_sd() {
  local subject base
  subject=$(cast keccak "$(printf '0x%08x%s%04x' $K "${1:2}" "$2")")
  base=$(cast index bytes32 "$subject" 1)
  printf '"%s":"%s","%s":"%s","%s":"%s"' "$base" "$1" "$(pf_slot_add "$base" 1)" "$hvm_hash" \
    "$(pf_slot_add "$base" 2)" "$(printf '0x%028x%04x%08x%08x%016x' 0 "$2" 1 "$hvm_height" 1)"
}
best_sd() { printf '"%s":"%s"' "$(cast index uint256 $K 2)" "$(cast keccak "$(printf '0x%08x%s%04x' $K "${1:2}" "$2")")"; }

# 1. K's best is a stored entry whose transaction hVM does not know (as after an orphaned Bitcoin block)
ov=$(pf_overrides "{$(cp_sd),$(entry_sd $BOGUS 1),$(best_sd $BOGUS 1)}")
c=$(pf_check $K $POP 1 "$ov")
expect_eq "checkPublication(K, real PoP) with an unknown best: verdict" "$(pf_verdict "$(jq -r '.[0]' <<<"$c")")" Ok
expect_eq "  recorded / best / becomesBest" "$(jq -r '"\(.[9]) \(.[10]) \(.[11])"' <<<"$c")" "false false true"
expect_eq "  bestTxid" "$(jq -r '.[12]' <<<"$c")" $BOGUS
expect_eq "  bestConfirmations (fails now: 0)" "$(jq -r '.[14]' <<<"$c")" 0
r=$(call "$ADDR_PopFinality" "$(cast calldata 'isBtcAnchored(uint256,uint256)' $K $K)" "$ov")
expect_eq "isBtcAnchored(K, K) through the unknown best" "$(cast to-dec "$r")" 0
g=$(rpc eth_estimateGas "{\"from\":\"$PF_FROM\",\"to\":\"$ADDR_PopFinality\",\"data\":\"$(cast calldata 'recordPublication(uint256,bytes32,uint16)' $K $POP 1)\"}" latest "$ov")
echo "   eth_estimateGas recordPublication(K, real PoP) against the unknown best: $(cast to-dec "$g")"

# 2. the real publication is stored too (not the best): the via path answers; re-submitting would take the best
ov=$(pf_overrides "{$(cp_sd),$(entry_sd $BOGUS 1),$(best_sd $BOGUS 1),$(entry_sd $POP 1)}")
r=$(call "$ADDR_PopFinality" "$(cast calldata 'isBtcFinalVia(uint256,uint256,bytes32,uint16)' 5620209 $K $POP 1)" "$ov")
expect_eq "isBtcFinalVia(5620209, K, real PoP) while the best is unknown" "$(cast to-dec "$r")" 1
c=$(pf_check $K $POP 1 "$ov")
expect_eq "  re-submission: recorded / best / becomesBest" "$(jq -r '"\(.[9]) \(.[10]) \(.[11])"' <<<"$c")" "true false true"
g=$(rpc eth_estimateGas "{\"from\":\"$PF_FROM\",\"to\":\"$ADDR_PopFinality\",\"data\":\"$(cast calldata 'recordPublication(uint256,bytes32,uint16)' $K $POP 1)\"}" latest "$ov")
echo "   eth_estimateGas re-submitting it (pointer write only): $(cast to-dec "$g")"

# 3. the real publication is the best: a resubmission changes nothing
ov=$(pf_overrides "{$(cp_sd),$(entry_sd $POP 1),$(best_sd $POP 1)}")
c=$(pf_check $K $POP 1 "$ov")
expect_eq "checkPublication(K, real PoP) when it is the best: recorded / best / becomesBest" \
  "$(jq -r '"\(.[9]) \(.[10]) \(.[11])"' <<<"$c")" "true true false"
echo
[ "$LIVE_FAILS" -eq 0 ] && echo "OK: every delta live check passed" || { echo "FAILED: $LIVE_FAILS"; exit 1; }
