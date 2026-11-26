#!/usr/bin/env python3
"""S10: hVM on Hemi testnet (chain 743111): which Bitcoin test network it follows, how far behind, and
whether 0x40 / 0x43 / 0x48 answer.

  python3 -I docs/research/spike/s10_testnet.py > docs/research/spike/out/s10-testnet.txt

Read-only: eth_call against https://testnet.rpc.hemi.network/rpc, Esplora GETs on mempool.space.
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hvmlib import TEST, call, cast_cmd, esplora, hb, header, out, output48, pc, res, rpc, u16  # noqa: E402

NETS = {"testnet3": "https://mempool.space/testnet/api", "testnet4": "https://mempool.space/testnet4/api",
        "signet": "https://mempool.space/signet/api"}


def balance_as_of(base, addr, height):
    """Exact confirmed balance of addr as of `height`, from its full confirmed history (paged)."""
    txs, last = [], None
    while True:
        page = esplora(f"/address/{addr}/txs/chain" + (f"/{last}" if last else ""), base=base)
        if not page:
            break
        txs += page
        if len(page) < 25:
            break
        last = page[-1]["txid"]
    bal = 0
    for t in txs:
        if t["status"]["block_height"] > height:
            continue
        for o in t["vout"]:
            if o.get("scriptpubkey_address") == addr:
                bal += o["value"]
        for i in t["vin"]:
            p = i.get("prevout") or {}
            if p.get("scriptpubkey_address") == addr:
                bal -= p["value"]
    return bal, len(txs), [t["status"]["block_height"] for t in txs]


def main():
    out(f"# S10 testnet run at {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}")
    out(f"$ cast chain-id --rpc-url {TEST}\n{int(res(rpc(TEST, 'eth_chainId', [])), 16)}")
    out(f"$ cast rpc web3_clientVersion --rpc-url {TEST}\n{res(rpc(TEST, 'web3_clientVersion', []))}")
    r = res(call(pc(0x44), "0x", url=TEST))
    h = header(hb(r))
    out(f"$ {cast_cmd(pc(0x44), '0x', url=TEST)}\n{r}")
    out(f"0x44: height {h['height']} hash {h['hash']} time {h['time']} ({time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(h['time']))})")
    match = None
    for name, base in NETS.items():
        try:
            tip = int(esplora("/blocks/tip/height", base=base, as_json=False))
            hh = esplora(f"/block-height/{h['height']}", base=base, as_json=False)
        except Exception as e:  # noqa: BLE001
            out(f"{name}: esplora error {e}")
            continue
        same = hh == h["hash"]
        out(f"{name} ({base}): tip {tip}; block at {h['height']} = {hh} -> {'MATCH' if same else 'different'}"
            + (f"; lag {tip - h['height']} blocks" if same else ""))
        if same:
            match = (name, base, tip)
    if not match:
        out("0x44's hash matches none of the three networks")
        return
    name, base, tip = match
    tipinfo = esplora(f"/block/{esplora('/blocks/tip/hash', base=base, as_json=False)}", base=base)
    out(f"{name} tip {tip} time {tipinfo['timestamp']} ({time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(tipinfo['timestamp']))}); "
        f"0x44 header is {(tipinfo['timestamp'] - h['time']) / 3600:.1f} h older than the tip")

    # A transaction hVM should know: a block 6 below 0x44's height.
    hgt = h["height"] - 6
    bh = esplora(f"/block-height/{hgt}", base=base, as_json=False)
    txs = esplora(f"/block/{bh}/txs/0", base=base)
    pick = None
    for t in txs[1:] + txs[:1]:
        for i, o in enumerate(t["vout"]):
            if o.get("scriptpubkey_address") and o["scriptpubkey_type"] in ("v0_p2wpkh", "v1_p2tr", "p2pkh", "v0_p2wsh", "p2sh"):
                pick = (t, i, o)
                break
        if pick:
            break
    t, vout, o = pick
    txid = t["txid"]
    spends = esplora(f"/tx/{txid}/outspends", base=base)
    out(f"\nfixture: {name} tx {txid} in block {hgt}, vout {vout}: {o['value']} sats {o['scriptpubkey_type']} {o['scriptpubkey_address']}; "
        f"esplora outspend now: {spends[vout]}")
    d43 = "0x" + txid
    r43 = res(call(pc(0x43), d43, url=TEST, gas=30000))
    c = int(r43, 16) if r43.startswith("0x") and len(r43) == 10 else None
    out(f"$ {cast_cmd(pc(0x43), d43, gas=30000, url=TEST)}\n{r43}")
    if c is not None:
        out(f"0x43 = {c}; {name} tip-h+1 = {tip - hgt + 1} (offset {c - (tip - hgt + 1)}); 0x44 height-h+1 = {h['height'] - hgt + 1} (offset {c - (h['height'] - hgt + 1)})")
    d48 = "0x" + txid + u16(vout) + u16(100)
    r48 = res(call(pc(0x48), d48, url=TEST))
    out(f"$ {cast_cmd(pc(0x48), d48, url=TEST)}\n{r48}")
    d = output48(hb(r48)) if r48.startswith("0x") and len(r48) > 2 else None
    if d:
        ok = d["sats"] == o["value"] and d["script"] == o["scriptpubkey"] and d["fullScriptLength"] == len(o["scriptpubkey"]) // 2
        out(f"0x48: sats {d['sats']} len {d['fullScriptLength']} flag 0x{d['flagByte']:02x} -> {'MATCH' if ok else 'MISMATCH'} vs Esplora")
    addr = o["scriptpubkey_address"]
    d40 = "0x" + addr.encode().hex()
    r40 = res(call(pc(0x40), d40, url=TEST))
    out(f"$ {cast_cmd(pc(0x40), d40, url=TEST)}\n{r40}")
    bal, n, heights = balance_as_of(base, addr, h["height"])
    v = int(r40, 16) if r40.startswith("0x") and len(r40) == 18 else None
    out(f"0x40 {addr} = {v}; Esplora balance as of height {h['height']} (from {n} txs at heights {heights[:10]}) = {bal} -> {'MATCH' if v == bal else 'MISMATCH'}")
    # a made-up txid on testnet
    r = res(call(pc(0x43), "0x" + "deadbeef" * 8, url=TEST, gas=30000))
    out(f"$ {cast_cmd(pc(0x43), '0x' + 'deadbeef' * 8, gas=30000, url=TEST)}\n{r}")
    out(f"\n(the Hemi testnet block at the time: {int(res(rpc(TEST, 'eth_blockNumber', [])), 16)})")


if __name__ == "__main__":
    main()
