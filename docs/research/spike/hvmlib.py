"""Shared helpers for the read-only hVM spike (Python side). Sends no transaction, needs no key.

Every Hemi RPC call is an eth_call / eth_getCode / eth_getBlockByNumber style read, paced at <= 2.5 req/s
(the public RPC allows about 300 a minute), with exponential backoff on 429/5xx and transport errors.
Esplora GETs are paced at 2 req/s with the same backoff.
"""
import json
import sys
import time
import urllib.error
import urllib.request

MAIN = "https://rpc.hemi.network/rpc"
MAIN_FALLBACK = "https://hemi.drpc.org"
TEST = "https://testnet.rpc.hemi.network/rpc"
MEMPOOL = "https://mempool.space/api"
BLOCKSTREAM = "https://blockstream.info/api"
UA = {"User-Agent": "spike-client/1", "content-type": "application/json"}

_last = {"rpc": 0.0, "esplora": 0.0}


def _pace(kind, gap):
    now = time.time()
    wait = _last[kind] + gap - now
    if wait > 0:
        time.sleep(wait)
    _last[kind] = time.time()


def rpc(url, method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    for attempt in range(7):
        _pace("rpc", 0.4)
        try:
            req = urllib.request.Request(url, data=body, headers=UA)
            with urllib.request.urlopen(req, timeout=90) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504):
                time.sleep(2 ** attempt)
                continue
            try:
                return json.loads(e.read().decode())
            except Exception:
                return {"transport_error": f"HTTP {e.code}"}
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            time.sleep(2 ** attempt)
    return {"transport_error": "gave up"}


def esplora(path, base=BLOCKSTREAM, as_json=True):
    for attempt in range(7):
        _pace("esplora", 0.5)
        try:
            req = urllib.request.Request(base + path, headers={"User-Agent": "spike-client/1"})
            with urllib.request.urlopen(req, timeout=90) as r:
                body = r.read().decode()
                return json.loads(body) if as_json else body.strip()
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504):
                time.sleep(2 ** attempt)
                continue
            raise
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            time.sleep(2 ** attempt)
    raise RuntimeError(f"esplora gave up on {base}{path}")


def pc(n):
    return "0x" + format(n, "040x")


def blk(b):
    if b is None or b == "latest":
        return "latest"
    if isinstance(b, int):
        return hex(b)
    return b


def call(to, data, block="latest", gas=None, url=MAIN, override=None):
    tx = {"to": to, "data": data}
    if gas is not None:
        tx["gas"] = hex(gas)
    params = [tx, blk(block)]
    if override is not None:
        params.append(override)
    return rpc(url, "eth_call", params)


def cast_cmd(to, data, block=None, gas=None, url=MAIN):
    s = f"cast call {to} {data} --rpc-url {url}"
    if block not in (None, "latest"):
        s += f" --block {block}"
    if gas is not None:
        s += f" --gas-limit {gas}"
    return s


def res(r):
    """'0x..' result, or 'ERROR: <message>' for a JSON-RPC error."""
    if "result" in r:
        return r["result"]
    if "error" in r:
        e = r["error"]
        return f"ERROR: code {e.get('code')} {e.get('message')}" + (f" data {e.get('data')}" if e.get("data") else "")
    return f"ERROR: {r}"


def hb(h):
    h = h[2:] if h.startswith("0x") else h
    return bytes.fromhex(h)


def u16(n):
    return format(n, "04x")


def u32(n):
    return format(n, "08x")


def header(r):
    if len(r) != 116:
        return None
    return {
        "height": int.from_bytes(r[0:4], "big"), "hash": r[4:36].hex(), "version": "0x" + r[36:40].hex(),
        "prev": r[40:72].hex(), "merkle": r[72:104].hex(), "time": int.from_bytes(r[104:108], "big"),
        "bits": "0x" + r[108:112].hex(), "nonce": int.from_bytes(r[112:116], "big"),
    }


def output48(r):
    if len(r) < 11:
        return None
    return {"sats": int.from_bytes(r[0:8], "big"), "fullScriptLength": int.from_bytes(r[8:10], "big"),
            "script": r[10:-1].hex(), "returnedScriptBytes": len(r) - 11, "flagByte": r[-1]}


def parse42(r, flags):
    """Parse a 0x42 btcTxByTxid answer for the 4 flag bytes it was called with (layout from contracts.go)."""
    f1, f2, f3, f4 = flags
    inc_block = f1 & 0x40
    inc_version = f1 & 0x20
    inc_sizes = f1 & 0x10
    inc_locktime = f1 & 0x08
    inc_inputs = f1 & 0x04
    inc_in_source = f1 & 0x02
    inc_in_sig = f1 & 0x01
    inc_in_seq = f2 & 0x80
    inc_witness_count = f1 & 0x40  # sic: the source tests bitflag1 bit 6, the same bit as the containing block
    inc_outputs = f2 & 0x20
    inc_out_script = f2 & 0x10
    inc_unspendable = f2 & 0x08
    inc_out_spent = f2 & 0x04
    max_inputs = 1 << ((f3 >> 3) & 7)
    max_outputs = 1 << (f3 & 7)
    max_sig = 1 << (4 + ((f4 >> 2) & 3))
    max_script = 1 << (4 + (f4 & 3))
    p = 0
    d = {}

    def take(n):
        nonlocal p
        if p + n > len(r):
            raise ValueError(f"short answer: need {n} at {p}, have {len(r)}")
        v = r[p:p + n]
        p += n
        return v

    if inc_block:
        d["blockHash"] = take(32).hex()
    if inc_version:
        d["version"] = int.from_bytes(take(4), "big")
    if inc_sizes:
        d["size"] = int.from_bytes(take(4), "big")
        d["strippedSize"] = int.from_bytes(take(4), "big")
    if inc_locktime:
        d["locktime"] = int.from_bytes(take(4), "big")
    if inc_inputs:
        n = int.from_bytes(take(2), "big")
        d["inputCount"] = n
        ins = []
        for _ in range(min(n, max_inputs)):
            i = {}
            if inc_witness_count:
                i["witnessCount"] = int.from_bytes(take(2), "big")
            i["prevoutSats"] = int.from_bytes(take(8), "big")
            if inc_in_source:
                i["prevTxid"] = take(32).hex()
                i["prevVout"] = int.from_bytes(take(4), "big")
            if inc_in_sig:
                ln = int.from_bytes(take(2), "big")
                i["scriptSigFullLength"] = ln
                i["scriptSig"] = take(min(ln, max_sig)).hex()
            if inc_in_seq:
                i["sequence"] = "0x" + take(4).hex()
            ins.append(i)
        d["inputs"] = ins
    if inc_outputs:
        n = int.from_bytes(take(2), "big")
        d["outputCount"] = n
        outs = []
        for _ in range(min(n, max_outputs)):
            o = {"sats": int.from_bytes(take(8), "big")}
            if inc_out_script:
                ln = int.from_bytes(take(2), "big")
                o["scriptFullLength"] = ln
                o["script"] = take(min(ln, max_script)).hex()
            if inc_out_spent:
                o["spentByte"] = take(1)[0]
            outs.append(o)
        d["outputs"] = outs
    d["trailingBytes"] = len(r) - p
    return d


def last_header(url=MAIN, block="latest"):
    r = res(call(pc(0x44), "0x", block=block, url=url))
    return r, header(hb(r)) if r.startswith("0x") else None


def out(*a):
    print(*a)
    sys.stdout.flush()
