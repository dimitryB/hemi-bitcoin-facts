#!/usr/bin/env bash
# The regtest gate: start bitcoind (regtest, Docker), run sdk/test/bond.regtest.test.ts against it, stop it.
#
#   regtest/run.sh                    # run the gate
#   regtest/run.sh --update-fixture   # also rewrite sdk/test/fixtures/regtest-bond.json (the e2e test replays it)
#   regtest/run.sh --keep             # leave bitcoind running afterwards (stop: docker compose -f regtest/docker-compose.yml down -v)
#
# Environment: HBF_REGTEST_PORT (default 18443) for the host port. Nothing here touches any network but the local
# regtest node; the chain is in a tmpfs and is gone when the container stops.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
COMPOSE=(docker compose -f "$ROOT/regtest/docker-compose.yml")
PORT=${HBF_REGTEST_PORT:-18443}
UPDATE=0
KEEP=0
for a in "$@"; do
  case $a in
    --update-fixture) UPDATE=1 ;;
    --keep) KEEP=1 ;;
    *) echo "usage: $0 [--update-fixture] [--keep]" >&2; exit 2 ;;
  esac
done

command -v docker >/dev/null || { echo "docker not found" >&2; exit 2; }
# a fresh chain every run
"${COMPOSE[@]}" down -v >/dev/null 2>&1 || true
[ "$KEEP" = 1 ] || trap '"${COMPOSE[@]}" down -v >/dev/null 2>&1 || true' EXIT
HBF_REGTEST_PORT=$PORT "${COMPOSE[@]}" up -d --wait
echo "bitcoind: $(docker exec hbf-regtest-bitcoind-1 bitcoind -version | head -1) on 127.0.0.1:$PORT"

export HBF_REGTEST_RPC="http://hbf:hbf-regtest-only@127.0.0.1:$PORT"
if [ "$UPDATE" = 1 ]; then export HBF_REGTEST_FIXTURE="$ROOT/sdk/test/fixtures/regtest-bond.json"; fi
cd "$ROOT/sdk"
node --import tsx --test --test-reporter=spec test/bond.regtest.test.ts
