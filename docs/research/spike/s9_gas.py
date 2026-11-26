#!/usr/bin/env python3
"""S9: gas of each precompile call measured in a contract, and the cost of one record transaction.

  python3 -I docs/research/spike/s9_gas.py > docs/research/spike/out/s9-gas.txt

Gas: the probe (docs/research/spike/probe/src/Probe.sol, placed by state override) measures gasleft() around one
staticcall{gas: cap}. Fee: Hemi's OP-stack GasPriceOracle (getL1Fee / getL1FeeUpperBound), the latest
base fee, eth_gasPrice and eth_maxPriorityFeePerGas; ETH/USD from two public spot APIs.
Read-only throughout.
"""
import hashlib
import json
import os
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hvmlib import MAIN, call, out, pc, res, rpc, u16, u32, last_header  # noqa: E402

PROBE = "0x51ce000000000000000000000000000000000001"
CODE = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "out", "probe-runtime.hex")).read().strip()
SEL_PROBE = "0xe4a8012e"  # probe(address,bytes,uint256)
SEL_TWICE = "0x34a5f869"  # probeTwice(address,bytes,uint256)
U = "43cb9bdcba36fc4c222b311ac176189081d644c64fef328d12982d1edb92cea4"
ADDR = "bc1qv6v32p9kw0az6lv6mz62famwf5acajp3wyntsa"
GPO = "0x420000000000000000000000000000000000000F"
BRIEF_GAS = {0x40: 50000, 0x41: 100000, 0x42: 25000, 0x43: 5000, 0x44: 5000, 0x45: 6000, 0x46: 25000, 0x47: 15000, 0x48: 15000, 0x49: 15000}


def abi(sel, target, inp, cap):
    data = bytes.fromhex(inp[2:])
    head = target[2:].rjust(64, "0") + format(0x60, "064x") + format(cap, "064x")
    tail = format(len(data), "064x") + data.hex() + "00" * ((32 - len(data) % 32) % 32)
    return sel + head + tail


def words(b, n):
    return [int.from_bytes(b[i * 32:(i + 1) * 32], "big") for i in range(n)]


def probe(target, inp, cap):
    r = res(call(PROBE, abi(SEL_PROBE, target, inp, cap), override={PROBE: {"code": CODE}}))
    b = bytes.fromhex(r[2:])
    ok, used, off = words(b, 3)
    ln = int.from_bytes(b[off:off + 32], "big")
    return bool(ok), used, ln


def twice(target, inp, cap):
    r = res(call(PROBE, abi(SEL_TWICE, target, inp, cap), override={PROBE: {"code": CODE}}))
    ok1, u1, ok2, u2, l1, l2 = words(bytes.fromhex(r[2:]), 6)
    return bool(ok1), u1, bool(ok2), u2, l1, l2


def spot(url, path):
    req = urllib.request.Request(url, headers={"User-Agent": "spike-client/1"})
    with urllib.request.urlopen(req, timeout=30) as r:
        j = json.loads(r.read().decode())
    for p in path:
        j = j[p]
    return float(j[0] if isinstance(j, list) else j)


def main():
    _, h = last_header()
    inputs = {
        0x40: "0x" + ADDR.encode().hex(),
        0x41: "0x" + ADDR.encode().hex() + "000000" + "0a",
        0x42: "0x" + U + "003c0703",
        0x43: "0x" + U,
        0x44: "0x",
        0x45: "0x" + u32(h["height"] - 10),
        0x46: "0x" + ADDR.encode().hex(),
        0x47: "0x" + U + u16(0) + u16(100),
        0x48: "0x" + U + u16(0) + u16(100),
        0x49: "0x" + U + u16(0) + u16(0) + u16(100),
    }
    out(f"# S9 gas run; 0x44 height {h['height']}")
    out("probe = staticcall{gas: cap} measured by gasleft() before/after; 'used' includes the CALL's own access cost "
        "(warm 100 for hVM precompiles, see below) and copying the answer into memory.")
    # The fixed overhead: an hVM call that returns nothing (0x43 with a 31-byte input: charged 5000, returns empty).
    ok, base_used, _ = probe(pc(0x43), "0x" + U[:62], 30000)
    overhead = base_used - 5000
    out(f"overhead calibration: probe(0x43, 31-byte input, cap 30000) = used {base_used} -> overhead {overhead} gas over the 5000 charge")
    ok, u04, _ = probe(pc(0x04), "0x", 30000)
    ok, udead, _ = probe("0x000000000000000000000000000000000000dead", "0x", 30000)
    out(f"for comparison: identity precompile 0x04 (charge 15), empty input: used {u04}; a code-less address: used {udead} "
        f"(2600 cold access) -> upstream precompiles are {'COLD' if u04 > 2000 else 'warm'}, hVM precompiles are warm")
    out("")
    out("| precompile | input bytes | brief gas | cap | ok | returned bytes | used (cold frame) | used - overhead | second call in same frame |")
    out("|---|---|---|---|---|---|---|---|---|")
    rows = []
    for a in range(0x40, 0x4A):
        inp = inputs[a]
        cap = BRIEF_GAS[a] * 2
        ok, used, ln = probe(pc(a), inp, cap)
        ok1, u1, ok2, u2, l1, l2 = twice(pc(a), inp, cap)
        rows.append((a, used, ln, ok))
        out(f"| 0x{a:02x} | {(len(inp) - 2) // 2} | {BRIEF_GAS[a]} | {cap} | {ok} | {ln} | {used} | {used - overhead} | {u2} |")
    out("")
    out("exact-cap check (cap = brief gas, then brief gas - 1):")
    for a in range(0x40, 0x4A):
        okx, ux, lx = probe(pc(a), inputs[a], BRIEF_GAS[a])
        oky, uy, ly = probe(pc(a), inputs[a], BRIEF_GAS[a] - 1)
        out(f"  0x{a:02x}: cap {BRIEF_GAS[a]} -> ok {okx} used {ux} len {lx}; cap {BRIEF_GAS[a] - 1} -> ok {oky} used {uy} len {ly}")

    out("\n# Fee of one record transaction")
    blk = rpc(MAIN, "eth_getBlockByNumber", ["latest", False])["result"]
    base = int(blk["baseFeePerGas"], 16)
    gp = int(res(rpc(MAIN, "eth_gasPrice", [])), 16)
    tip_r = rpc(MAIN, "eth_maxPriorityFeePerGas", [])
    tip = int(res(tip_r), 16) if "result" in tip_r else None
    out(f"latest block {int(blk['number'], 16)}: baseFeePerGas {base} wei; eth_gasPrice {gp} wei; eth_maxPriorityFeePerGas {tip} wei")
    # ~200 incompressible bytes standing in for a signed record tx (worst case for the FastLZ estimate)
    seed = b"hemi-bitcoin-facts spike record tx"
    payload = b""
    while len(payload) < 200:
        seed = hashlib.sha256(seed).digest()
        payload += seed
    payload = payload[:200]
    ln = len(payload)
    enc = "0x49948e0e" + format(0x20, "064x") + format(ln, "064x") + payload.hex() + "00" * ((32 - ln % 32) % 32)
    l1 = res(call(GPO, enc))
    out(f"$ cast call {GPO} 'getL1Fee(bytes)(uint256)' 0x{payload.hex()[:16]}…(200 bytes) --rpc-url {MAIN}\n{l1}")
    l1fee = int(l1, 16) if l1.startswith("0x") else None
    ub = res(call(GPO, "0xf1c7a58b" + format(200, "064x")))
    out(f"$ cast call {GPO} 'getL1FeeUpperBound(uint256)(uint256)' 200 --rpc-url {MAIN}\n{ub}")
    l1ub = int(ub, 16) if ub.startswith("0x") else None
    for f, sel in (("l1BaseFee()", "0x519b4bd3"), ("blobBaseFee()", "0xf8206140"), ("baseFeeScalar()", "0xc5985918"),
                   ("blobBaseFeeScalar()", "0x68d5dca6"), ("decimals()", "0x313ce567")):
        out(f"GasPriceOracle.{f} = {int(res(call(GPO, sel)), 16)}")
    gas = 120_000
    op = res(call(GPO, "0x275aedd2" + format(gas, "064x")))
    out(f"$ cast call {GPO} 'getOperatorFee(uint256)(uint256)' {gas} --rpc-url {MAIN}\n{op}  (Isthmus operator fee; 0 = none)")
    for f, sel in (("operatorFeeScalar()", "0x4d5d9a2a"), ("operatorFeeConstant()", "0x16d3bc7f")):
        out(f"L1Block 0x4200…0015 {f} = {res(call('0x4200000000000000000000000000000000000015', sel))}")
    l2 = gas * gp
    out(f"L2 execution: {gas} gas x eth_gasPrice {gp} wei = {l2} wei")
    try:
        cb = spot("https://api.coinbase.com/v2/prices/ETH-USD/spot", ["data", "amount"])
    except Exception as e:  # noqa: BLE001
        cb = None
        out(f"coinbase spot failed: {e}")
    try:
        kr = spot("https://api.kraken.com/0/public/Ticker?pair=ETHUSD", ["result", "XETHZUSD", "c"])
    except Exception as e:  # noqa: BLE001
        kr = None
        out(f"kraken spot failed: {e}")
    out(f"ETH/USD: Coinbase spot {cb}, Kraken last trade {kr}")
    px = cb or kr
    for label, l1v in (("getL1Fee(200 random bytes)", l1fee), ("getL1FeeUpperBound(200)", l1ub)):
        if l1v is None or px is None:
            continue
        total = l1v + l2
        out(f"per record ({label}): L1 {l1v} + L2 {l2} = {total} wei = {total / 1e18:.12f} ETH = ${total / 1e18 * px:.6f} at ${px:,.2f}/ETH")


if __name__ == "__main__":
    main()
