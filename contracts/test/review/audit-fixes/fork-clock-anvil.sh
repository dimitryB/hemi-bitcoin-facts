#!/usr/bin/env bash
# Review of the audit fixes, R-1: FidelityBondsForkTest::test_fork_deployRecordLiveRefresh forks Hemi mainnet at its
# latest block and asserts Live for the fixture's locktime 1,800,000,000 (2027-01-15T08:00:00Z). Since the independent audit's fixes the
# fork's real block.timestamp takes part in Live/Expired, so the test fails once the chain's clock reaches that date.
# This runs it twice against a local anvil fork of Hemi mainnet: at today's time (passes), then after mining one local
# block at the locktime (with those fixes it failed there: 2 = Expired, 1 = Live; since the R-1 fix the test warps to a day
# before its locktime and passes both runs). Nothing is sent anywhere but the local anvil; the fork's lazy state reads
# stay under 4 requests a second.
#
#   bash contracts/test/review/audit-fixes/fork-clock-anvil.sh
set -euo pipefail
cd "$(dirname "$0")/../../.."
PORT=${PORT:-18547}
URL="http://127.0.0.1:$PORT"
anvil --fork-url "${HEMI_RPC:-https://rpc.hemi.network/rpc}" --compute-units-per-second 60 --fork-retry-backoff 1000 \
  --retries 8 --port "$PORT" --silent &
ANVIL=$!
trap 'kill $ANVIL 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do cast chain-id --rpc-url "$URL" >/dev/null 2>&1 && break; sleep 2; done
echo "anvil head: block $(cast block latest -f number --rpc-url "$URL"), time $(cast block latest -f timestamp --rpc-url "$URL")"

echo "== control: today's clock"
HEMI_FORK_URL="$URL" forge test --match-test test_fork_deployRecordLiveRefresh 2>&1 | grep -E '^\[(PASS|FAIL)' || true

cast rpc --rpc-url "$URL" evm_setNextBlockTimestamp 1800000000 >/dev/null
cast rpc --rpc-url "$URL" evm_mine >/dev/null
echo "== after one local block at the fixture's locktime: time $(cast block latest -f timestamp --rpc-url "$URL")"
HEMI_FORK_URL="$URL" forge test --match-test test_fork_deployRecordLiveRefresh 2>&1 | grep -E '^\[(PASS|FAIL)' || true
