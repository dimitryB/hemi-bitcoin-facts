#!/usr/bin/env python3
"""S1: raw 0x40 btcBalAddr (and 0x46 btcAddrToScript) for two quiet addresses of each type, against Esplora.

  python3 -I docs/research/spike/s1_balances.py docs/research/spike/out/s1-addresses.json > docs/research/spike/out/s1-balances.txt

Each address's balance is compared two ways: Esplora's chain_stats funded - spent now (valid because the
address has nothing in the mempool and no transaction above the height 0x44 reports), and an exact replay of
its full confirmed history up to 0x44's height.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hvmlib import BLOCKSTREAM, call, cast_cmd, esplora, last_header, out, pc, res  # noqa: E402


def balance_as_of(addr, height):
    txs, last = [], None
    while True:
        page = esplora(f"/address/{addr}/txs/chain" + (f"/{last}" if last else ""))
        txs += page
        if len(page) < 25:
            break
        last = page[-1]["txid"]
    bal = 0
    for t in txs:
        if t["status"]["block_height"] > height:
            continue
        bal += sum(o["value"] for o in t["vout"] if o.get("scriptpubkey_address") == addr)
        bal -= sum((i.get("prevout") or {}).get("value", 0) for i in t["vin"] if (i.get("prevout") or {}).get("scriptpubkey_address") == addr)
    return bal, [t["status"]["block_height"] for t in txs]


def main():
    found = json.load(open(sys.argv[1]))["found"]
    _, h = last_header()
    out(f"# S1 run. 0x44: height {h['height']} hash {h['hash']}; Esplora {BLOCKSTREAM} tip {esplora('/blocks/tip/height', as_json=False)}")
    out("| type | address | 0x40 sats | Esplora funded-spent now | Esplora replay to 0x44 height | mempool txs | newest tx height | 0x46 script = Esplora | verdict |")
    out("|---|---|---|---|---|---|---|---|---|")
    cmds = []
    rows = [a for k in ("p2pkh", "p2sh", "v0_p2wpkh", "v0_p2wsh", "v1_p2tr") for a in found[k]]
    for a in rows:
        addr = a["address"]
        d40 = "0x" + addr.encode().hex()
        r40 = res(call(pc(0x40), d40))
        r46 = res(call(pc(0x46), d40))
        cmds += [f"$ {cast_cmd(pc(0x40), d40)}\n{r40}", f"$ {cast_cmd(pc(0x46), d40)}\n{r46}"]
        v = int(r40, 16) if r40.startswith("0x") and len(r40) == 18 else None
        info = esplora(f"/address/{addr}")
        cs, ms = info["chain_stats"], info["mempool_stats"]
        now = cs["funded_txo_sum"] - cs["spent_txo_sum"]
        replay, heights = balance_as_of(addr, h["height"])
        newest = max(heights) if heights else None
        same_script = r46[2:] == a["scriptpubkey"]
        ok = v == now == replay and ms["tx_count"] == 0 and same_script
        out(f"| {a['type']} | {addr} | {v} | {now} | {replay} | {ms['tx_count']} | {newest} | {same_script} | {'MATCH' if ok else 'MISMATCH'} |")
    out("\n# Extra cases")
    extras = [
        ("zero balance (spent fixture's P2WSH, fully spent)", "bc1qlaj2gectshprauuj5klq7rl5p4qzfh3z848hyskhqac5k38qztzqyxh9w0"),
        ("upper-case spelling of a P2WPKH above", rows[4]["address"].upper()),
        ("the same P2WPKH, lower case", rows[4]["address"]),
        ("bad checksum (last character changed)", rows[4]["address"][:-1] + ("q" if rows[4]["address"][-1] != "q" else "p")),
        ("23 bytes (below the 24-byte minimum)", "1" * 23),
        ("testnet address on mainnet", "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx"),
    ]
    for label, addr in extras:
        d = "0x" + addr.encode().hex()
        r40 = res(call(pc(0x40), d))
        r46 = res(call(pc(0x46), d))
        out(f"\n## {label}: {addr}\n$ {cast_cmd(pc(0x40), d)}\n{r40}\n$ {cast_cmd(pc(0x46), d)}\n{r46}")
        if "spent fixture" in label:
            info = esplora(f"/address/{addr}")
            out(f"esplora chain_stats {info['chain_stats']} mempool {info['mempool_stats']['tx_count']} txs")
    out("\n# Commands and raw answers for the table")
    out("\n".join(cmds))
    _, h2 = last_header()
    out(f"\n# 0x44 at end: height {h2['height']} hash {h2['hash']}")


if __name__ == "__main__":
    main()
