# Shared helpers for check-live.sh. Sourced, not run. Everything here is read-only: eth_call,
# eth_getCode, eth_getStorageAt, eth_estimateGas and Esplora GETs. Nothing is signed or sent.
#
# Section files (contracts/live/<name>.sh) define `live_<name>` and use these helpers. A section
# prints one "PASS …" or "FAIL …" line per check and returns non-zero if any check failed.

CREATE2_DEPLOYER=0x4e59b44847b379578588920cA78FbF26c0B4956C

live_die() { printf 'check-live.sh: %s\n' "$*" >&2; exit 2; }

# Requests to the public Hemi RPC are paced to stay under ~4 a second (300 a minute allowed).
live_pace() { sleep 0.3; }

# rpc <method> <params-json...>: raw JSON-RPC via cast, result with quotes stripped. Fails on error.
rpc() {
  local method=$1; shift
  live_pace
  cast rpc "$method" "$@" --rpc-url "$RPC" 2>&1 | tr -d '"'
  return "${PIPESTATUS[0]}"
}

# initcode <Contract> [ctor-sig ctor-args...]: creation bytecode with ABI-encoded constructor args.
initcode() {
  local name=$1; shift
  local code args=""
  code=$(cd "$CONTRACTS_DIR" && forge inspect "$name" bytecode 2>/dev/null) || live_die "forge inspect $name failed"
  if [ $# -gt 0 ]; then args=$(cast abi-encode "$@"); args=${args#0x}; fi
  printf '%s%s' "$code" "$args"
}

# create2_address <salt> <initcode>: where the CREATE2 deployer puts it.
create2_address() {
  cast create2 --deployer "$CREATE2_DEPLOYER" --salt "$1" --init-code "$2" 2>/dev/null | grep -oE '0x[0-9a-fA-F]{40}' | head -1
}

# runtime_of <initcode> [overrides-json]: the runtime code a creation would leave, by eth_call of the
# initcode on the live node (so the constructor runs there too).
runtime_of() {
  local out
  out=$(rpc eth_call "{\"data\":\"$1\",\"gas\":\"0x1c9c380\"}" latest ${2:+"$2"}) || { printf '%s' "$out"; return 1; }
  [[ $out =~ ^0x[0-9a-f]+$ ]] || { printf '%s' "$out"; return 1; }
  printf '%s' "$out"
}

# place <name> <salt> <initcode>: sets ADDR_<name> to the CREATE2 address and, if nothing is deployed
# there, appends a code override for it to OVERRIDES (a JSON object body, no braces).
OVERRIDES=""
place() {
  local name=$1 salt=$2 ic=$3 addr code rt ov=""
  addr=$(create2_address "$salt" "$ic") || live_die "create2 address for $name"
  code=$(rpc eth_getCode "$addr" latest)
  if [ "$code" != "0x" ] && [ -n "$code" ]; then
    echo "   $name at $addr: deployed, using it"
  else
    [ -n "$OVERRIDES" ] && ov="{$OVERRIDES}"
    rt=$(runtime_of "$ic" "$ov") || live_die "creating $name by eth_call failed: $rt"
    OVERRIDES+="${OVERRIDES:+,}\"$addr\":{\"code\":\"$rt\"}"
    echo "   $name at $addr: not deployed; compiled code placed by state override ($(( (${#rt} - 2) / 2 )) bytes)"
  fi
  printf -v "ADDR_$name" '%s' "$addr"
}

# overrides_json [extra-body]: the current overrides as a JSON object, plus extra entries.
overrides_json() {
  local body=$OVERRIDES
  [ -n "${1:-}" ] && body+="${body:+,}$1"
  printf '{%s}' "$body"
}

# call <to> <calldata> [overrides-json]: eth_call at latest with a 30M gas allowance; raw hex result.
# On a revert prints "REVERT <reason>" and fails.
call() {
  local params out
  params="{\"to\":\"$1\",\"data\":\"$2\",\"gas\":\"0x1c9c380\"}"
  if out=$(rpc eth_call "$params" latest ${3:+"$3"}); then
    printf '%s' "$out"
  else
    printf 'REVERT %s' "$(printf '%s' "$out" | grep -oE 'execution reverted[^,]*(, data: "?0x[0-9a-f]*)?' | head -1)"
    return 1
  fi
}

# esplora <path>: GET from Esplora (mempool.space, then blockstream.info).
esplora() {
  local base out
  for base in ${ESPLORA_URLS:-https://mempool.space/api https://blockstream.info/api}; do
    sleep 0.3
    if out=$(curl -fsS --max-time 20 "$base$1" 2>/dev/null); then printf '%s' "$out"; return 0; fi
  done
  return 1
}

# Result bookkeeping.
LIVE_FAILS=0
LIVE_SKIPS=() # checks a section could not run; reported in the final line
pass() { echo "   PASS $*"; }
fail() { echo "   FAIL $*"; LIVE_FAILS=$((LIVE_FAILS + 1)); }
expect_eq() { # <label> <got> <want>
  if [ "$2" = "$3" ]; then pass "$1: $2"; else fail "$1: got $2, want $3"; fi
}
