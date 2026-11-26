#!/usr/bin/env bash
# Shared helpers for the read-only hVM spike. Sourced by docs/research/spike/s*.sh. Sends no transaction, needs no key.
#   MAIN=https://rpc.hemi.network/rpc   (fallback https://hemi.drpc.org)
#   TEST=https://testnet.rpc.hemi.network/rpc
# Every call sleeps first (pacing well under 4 req/s) and retries with backoff on 429/5xx/transport errors.

MAIN=${HEMI_MAINNET_RPC_URL:-https://rpc.hemi.network/rpc}
MAIN_FALLBACK=https://hemi.drpc.org
TEST=${HEMI_TESTNET_RPC_URL:-https://testnet.rpc.hemi.network/rpc}
ESPLORA=${ESPLORA:-https://mempool.space/api}
ESPLORA2=https://blockstream.info/api
PACE=${PACE:-0.4}

# rpc URL METHOD PARAMS_JSON  -> prints the full JSON-RPC response body
rpc() {
  local url=$1 method=$2 params=$3 body code try=0 out
  body="{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$method\",\"params\":$params}"
  while :; do
    sleep "$PACE"
    out=$(curl -sS --max-time 60 -w '\n%{http_code}' -H 'content-type: application/json' --data "$body" "$url" 2>&1) || out=$'\n000'
    code=${out##*$'\n'}; out=${out%$'\n'*}
    if [[ $code == 200 ]]; then printf '%s\n' "$out"; return 0; fi
    try=$((try + 1))
    if (( try >= 6 )); then printf '{"transport_error":"HTTP %s","body":%s}\n' "$code" "$(jq -Rs . <<<"$out")"; return 1; fi
    sleep $((2 ** try))
  done
}

# rawcall URL TO DATA [BLOCK] [GAS_HEX] [STATE_OVERRIDE_JSON] -> full JSON-RPC response of eth_call
rawcall() {
  local url=$1 to=$2 data=$3 block=${4:-latest} gas=${5:-} ov=${6:-}
  local tx="{\"to\":\"$to\",\"data\":\"$data\"${gas:+,\"gas\":\"$gas\"}}"
  if [[ $block =~ ^[0-9]+$ ]]; then block=$(printf '"0x%x"' "$block"); else block="\"$block\""; fi
  if [[ -n $ov ]]; then rpc "$url" eth_call "[$tx,$block,$ov]"; else rpc "$url" eth_call "[$tx,$block]"; fi
}

# esplora BASE PATH -> body (retries on 429/5xx)
esplora() {
  local base=$1 p=$2 out code try=0
  while :; do
    sleep "$PACE"
    out=$(curl -sS --max-time 60 -w '\n%{http_code}' "$base$p" 2>&1) || out=$'\n000'
    code=${out##*$'\n'}; out=${out%$'\n'*}
    if [[ $code == 200 ]]; then printf '%s\n' "$out"; return 0; fi
    if [[ $code == 404 || $code == 400 ]]; then printf 'HTTP %s %s\n' "$code" "$out"; return 1; fi
    try=$((try + 1))
    if (( try >= 6 )); then printf 'HTTP %s %s\n' "$code" "$out"; return 1; fi
    sleep $((2 ** try))
  done
}

# pad an address byte to a 20-byte precompile address
pc() { printf '0x%040x' "$1"; }
# ASCII -> hex (no 0x)
asciihex() { printf '%s' "$1" | xxd -p | tr -d '\n'; }
# u16 / u32 big-endian hex
u16() { printf '%04x' "$1"; }
u32() { printf '%08x' "$1"; }
