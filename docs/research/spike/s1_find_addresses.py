#!/usr/bin/env python3
"""S1 helper: find two quiet addresses of each type (P2PKH, P2SH, P2WPKH, P2WSH, P2TR) on Bitcoin mainnet.

Quiet = a positive confirmed balance, nothing in the mempool, and the newest confirmed transaction at or below
block FROM_HEIGHT (well below the height hVM's 0x44 reports). Then Esplora's chain_stats funded - spent is the
balance as of any later height, including hVM's.

  python3 -I docs/research/spike/s1_find_addresses.py <from_height> > docs/research/spike/out/s1-addresses.json

Esplora GETs only (blockstream.info), paced at about 2 requests a second, with backoff on 429/5xx.
"""
import json
import sys
import time
import urllib.error
import urllib.request

BASE = "https://blockstream.info/api"  # mempool.space throttled this client to ~75 s per request during the spike
WANT = {"p2pkh": "P2PKH", "p2sh": "P2SH", "v0_p2wpkh": "P2WPKH", "v0_p2wsh": "P2WSH", "v1_p2tr": "P2TR"}
PER_TYPE = 2


def get(path, as_json=True):
    for attempt in range(7):
        time.sleep(0.5)
        try:
            req = urllib.request.Request(BASE + path, headers={"User-Agent": "spike-client/1"})
            with urllib.request.urlopen(req, timeout=60) as r:
                body = r.read().decode()
                return json.loads(body) if as_json else body
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504):
                time.sleep(2 ** attempt)
                continue
            raise
        except (urllib.error.URLError, TimeoutError):
            time.sleep(2 ** attempt)
    raise SystemExit(f"giving up on {path}")


def main():
    from_height = int(sys.argv[1])
    found = {k: [] for k in WANT}
    seen = set()
    height = from_height
    log = []
    while any(len(v) < PER_TYPE for v in found.values()) and height > from_height - 20:
        bhash = get(f"/block-height/{height}", as_json=False).strip()
        for start in (25, 50, 75, 100):  # skip the coinbase page; four pages of 25 txs
            if all(len(v) >= PER_TYPE for v in found.values()):
                break
            txs = get(f"/block/{bhash}/txs/{start}")
            for tx in txs:
                for o in tx["vout"]:
                    t = o.get("scriptpubkey_type")
                    a = o.get("scriptpubkey_address")
                    if t not in WANT or not a or a in seen or len(found[t]) >= PER_TYPE:
                        continue
                    seen.add(a)
                    info = get(f"/address/{a}")
                    cs, ms = info["chain_stats"], info["mempool_stats"]
                    bal = cs["funded_txo_sum"] - cs["spent_txo_sum"]
                    if ms["tx_count"] != 0 or bal <= 0 or cs["tx_count"] > 5:
                        log.append({"address": a, "skip": "mempool/zero/too many txs", "chain_tx_count": cs["tx_count"], "mempool_tx_count": ms["tx_count"], "balance": bal})
                        continue
                    hist = get(f"/address/{a}/txs")
                    heights = [h["status"].get("block_height") for h in hist if h["status"].get("confirmed")]
                    newest = max(heights) if heights else None
                    if newest is None or newest > from_height:
                        log.append({"address": a, "skip": "newest tx above from_height", "newest": newest})
                        continue
                    found[t].append({
                        "type": WANT[t], "address": a, "scriptpubkey": o["scriptpubkey"],
                        "esplora_balance": bal, "funded": cs["funded_txo_sum"], "spent": cs["spent_txo_sum"],
                        "chain_tx_count": cs["tx_count"], "mempool_tx_count": ms["tx_count"], "newest_tx_height": newest,
                        "seen_in_tx": tx["txid"], "seen_in_block": height,
                    })
                    print(f"found {WANT[t]} {a} balance {bal} newest {newest}", file=sys.stderr, flush=True)
                    if all(len(v) >= PER_TYPE for v in found.values()):
                        break
                if all(len(v) >= PER_TYPE for v in found.values()):
                    break
        height -= 1
    print(json.dumps({"from_height": from_height, "found": found, "skipped": log}, indent=1))


if __name__ == "__main__":
    main()
