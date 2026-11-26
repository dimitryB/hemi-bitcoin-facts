#!/usr/bin/env python3
"""S5 (0x43 confirmations), S6 (0x45 header by height), S7 (live vs pinned reads).

  python3 -I docs/research/spike/s5_s6_s7.py > docs/research/spike/out/s5-s6-s7.txt

Read-only: eth_call (raw precompile calls and the probe by state override), Esplora GETs.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hvmlib import (BLOCKSTREAM, MAIN, MEMPOOL, call, cast_cmd, esplora, hb, header, last_header, out, pc, res, rpc,  # noqa: E402
                    u32)

U = "43cb9bdcba36fc4c222b311ac176189081d644c64fef328d12982d1edb92cea4"
S = "95bca0291cdecef1dc71c3ff174ed827f6b34ada52c6f32649e85449ce9d367e"
POP = "d4ed6ec2eaa89b78906efc54c3dd309761bb30ca8a38b6477951033957a6845e"
FAKE = "deadbeef" * 8
PROBE = "0x51ce000000000000000000000000000000000001"
CODE = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "out", "probe-runtime.hex")).read().strip()
# probe(address,bytes,uint256) returns (bool ok, uint256 used, bytes ret)
SEL_PROBE = "0xe4a8012e"


def abi_probe(target, inp, gas_cap):
    data = bytes.fromhex(inp[2:] if inp.startswith("0x") else inp)
    head = target[2:].rjust(64, "0") + format(0x60, "064x") + format(gas_cap, "064x")
    tail = format(len(data), "064x") + data.hex() + "00" * ((32 - len(data) % 32) % 32)
    return SEL_PROBE + head + tail


def dec_probe(r):
    b = hb(r)
    ok = int.from_bytes(b[0:32], "big") == 1
    used = int.from_bytes(b[32:64], "big")
    off = int.from_bytes(b[64:96], "big")
    ln = int.from_bytes(b[off:off + 32], "big")
    return ok, used, "0x" + b[off + 32: off + 32 + ln].hex()


def probe(target, inp, gas_cap, block="latest"):
    r = res(call(PROBE, abi_probe(target, inp, gas_cap), block=block, override={PROBE: {"code": CODE}}))
    if not r.startswith("0x"):
        return r
    return dec_probe(r)


def conf(txid, block="latest", gas=None):
    return res(call(pc(0x43), "0x" + txid, block=block, gas=gas))


def main():
    out("# S5. 0x43 btcTxConfirmations against Esplora")
    for rnd in range(3):
        r44, h = last_header()
        tip_m = int(esplora("/blocks/tip/height", base=MEMPOOL, as_json=False))
        tip_b = int(esplora("/blocks/tip/height", base=BLOCKSTREAM, as_json=False))
        out(f"\n## round {rnd + 1}: 0x44 height {h['height']}; Esplora tip mempool.space {tip_m}, blockstream {tip_b}")
        for label, txid in (("unspent fixture", U), ("spent fixture", S), ("PoP 5620225", POP)):
            st = esplora(f"/tx/{txid}")["status"]
            c = conf(txid)
            cnt = int(c, 16) if c.startswith("0x") and len(c) == 10 else None
            e = tip_m - st["block_height"] + 1
            hv = h["height"] - st["block_height"] + 1
            out(f"$ {cast_cmd(pc(0x43), '0x' + txid)}\n{c}")
            out(f"{label}: block {st['block_height']}; 0x43 = {cnt}; Esplora tip-h+1 = {e} (offset {cnt - e if cnt is not None else 'n/a'}); "
                f"0x44 height-h+1 = {hv} (offset {cnt - hv if cnt is not None else 'n/a'})")

    out("\n## made-up txid " + FAKE)
    out(f"$ {cast_cmd(pc(0x43), '0x' + FAKE)}")
    out(conf(FAKE))
    out(f"$ {cast_cmd(pc(0x43), '0x' + FAKE, gas=30000)}")
    out(conf(FAKE, gas=30000))
    out("-- estimateGas of the raw call (no cap):")
    out(f"$ cast estimate {pc(0x43)} 0x{FAKE} --rpc-url {MAIN}")
    out(res(rpc(MAIN, "eth_estimateGas", [{"to": pc(0x43), "data": "0x" + FAKE}])))
    out("-- through the probe (staticcall with an explicit gas cap; gas measured with gasleft()):")
    for cap in (6000, 30000, 100000, 1000000):
        out(f"probe(0x43, made-up txid, gasCap {cap}) -> ok, used, ret = {probe(pc(0x43), '0x' + FAKE, cap)}")
    for cap in (6000, 30000):
        out(f"probe(0x43, unspent fixture, gasCap {cap}) -> ok, used, ret = {probe(pc(0x43), '0x' + U, cap)}")
    out(f"probe(0x43, 31-byte input, gasCap 30000) -> {probe(pc(0x43), '0x' + U[:62], 30000)}")
    out(f"probe(0x43, made-up txid, gasCap 4999 (below the 5000 charge)) -> {probe(pc(0x43), '0x' + FAKE, 4999)}")
    out(f"probe(no-code address 0x…dead, empty, gasCap 30000) -> baseline {probe('0x000000000000000000000000000000000000dead', '0x', 30000)}")

    out("\n# S6. 0x45 btcHeaderN around the tip")
    r44, h = last_header()
    tip = int(esplora("/blocks/tip/height", base=MEMPOOL, as_json=False))
    out(f"0x44 height {h['height']} hash {h['hash']}; Esplora tip {tip}")
    for label, n in (("tip", tip), ("tip-1", tip - 1), ("tip-2", tip - 2), ("tip-3", tip - 3), ("tip-10", tip - 10),
                     ("0x44 height", h["height"]), ("0x44 height + 1", h["height"] + 1), ("1", 1), ("0", 0)):
        data = "0x" + u32(n)
        r = res(call(pc(0x45), data))
        d = header(hb(r)) if r.startswith("0x") else None
        try:
            eh = esplora(f"/block-height/{n}", base=MEMPOOL, as_json=False)
        except Exception as ex:  # noqa: BLE001
            eh = f"(esplora: {ex})"
        verdict = ("answer" if d else "EMPTY") + (", hash matches Esplora" if d and d["hash"] == eh else (", hash DIFFERS" if d else ""))
        out(f"$ {cast_cmd(pc(0x45), data)}\n{r[:80]}{'...' if len(r) > 80 else ''}")
        out(f"{label} = {n}: {verdict}" + (f" (height field {d['height']}, hash {d['hash']}, time {d['time']})" if d else ""))
    out(f"$ {cast_cmd(pc(0x45), '0x' + u32(1)[:6])}  # 3-byte input\n{res(call(pc(0x45), '0x' + u32(1)[:6]))}")

    out("\n# S7. Same calls at latest, latest-100 and latest-7200 Hemi blocks")
    n = int(rpc(MAIN, "eth_blockNumber", [])["result"], 16)

    tx = esplora("/tx/6ac09b111f3819aa66a6d61a467c84f5f023bf30021bcf912038e9162f5a075b")
    fresh_addr = tx["vout"][32]["scriptpubkey_address"]
    a = esplora(f"/address/{fresh_addr}")
    hist = esplora(f"/address/{fresh_addr}/txs")
    out(f"fresh address {fresh_addr}: Esplora chain_stats {a['chain_stats']}, mempool {a['mempool_stats']}, "
        f"tx heights {[t['status'].get('block_height') for t in hist]} (block 976790 is about 7 h before the spike)")
    fixture_addr = "bc1qv6v32p9kw0az6lv6mz62famwf5acajp3wyntsa"
    for label, blk in (("latest", n), ("latest-100", n - 100), ("latest-7200", n - 7200)):
        b = rpc(MAIN, "eth_getBlockByNumber", [hex(blk), False])["result"]
        out(f"\n## {label}: Hemi block {blk} (timestamp {int(b['timestamp'], 16)})")
        r = res(call(pc(0x44), "0x", block=blk))
        d = header(hb(r)) if r.startswith("0x") else None
        out(f"$ {cast_cmd(pc(0x44), '0x', block=blk)}\n-> {('height ' + str(d['height']) + ' hash ' + d['hash']) if d else r}")
        for addr in (fixture_addr, fresh_addr):
            data = "0x" + addr.encode().hex()
            r = res(call(pc(0x40), data, block=blk))
            out(f"$ {cast_cmd(pc(0x40), data, block=blk)}\n-> {r} = {int(r, 16) if r.startswith('0x') and len(r) > 2 else r} sats ({addr})")
        for txid in (U, S):
            r = conf(txid, block=blk)
            out(f"$ {cast_cmd(pc(0x43), '0x' + txid, block=blk)}\n-> {r} = {int(r, 16) if r.startswith('0x') and len(r) > 2 else r}")
    out(f"\n(eth_blockNumber at start of S7: {n})")


if __name__ == "__main__":
    main()
