import { concat, keccak256, type Hex } from "viem";
import { isBytes32 } from "./hex.js";

/**
 * Sorted-pair Merkle tree, compatible with OpenZeppelin MerkleProof (commutative keccak256).
 *
 * Construction (docs/SCHEMA.md §3):
 *  1. Leaves are lowercase bytes32. A duplicate leaf is an error.
 *  2. Leaves are sorted ascending, so the root does not depend on submission order.
 *  3. Each level pairs neighbours left to right; hashPair(a, b) = keccak256(min(a,b) ‖ max(a,b)).
 *     An odd node at the end of a level is carried up unchanged.
 *  4. A one-leaf tree's root is the leaf, and its proof is empty.
 * A proof lists one sibling per level where one exists, bottom-up.
 */
export function hashPair(a: Hex, b: Hex): Hex {
  return BigInt(a) <= BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

export interface MerkleTree {
  root: Hex;
  /** Sorted leaves, as committed. */
  leaves: Hex[];
  /** layers[0] = sorted leaves; the last layer holds only the root. */
  layers: Hex[][];
  proof(leaf: Hex): Hex[];
}

export function buildMerkleTree(input: readonly Hex[]): MerkleTree {
  if (input.length === 0) throw new Error("merkle: at least one leaf is required");
  const leaves = input.map((leaf) => {
    const lower = leaf.toLowerCase() as Hex;
    if (!isBytes32(lower)) throw new Error(`merkle: leaf ${leaf} is not bytes32`);
    return lower;
  });
  leaves.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (let i = 1; i < leaves.length; i++) {
    if (leaves[i] === leaves[i - 1]) throw new Error(`merkle: duplicate leaf ${leaves[i]}`);
  }

  const layers: Hex[][] = [leaves];
  while (layers[layers.length - 1]!.length > 1) {
    const level = layers[layers.length - 1]!;
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? hashPair(level[i]!, level[i + 1]!) : level[i]!);
    }
    layers.push(next);
  }
  const index = new Map(leaves.map((leaf, i) => [leaf, i]));

  return {
    root: layers[layers.length - 1]![0]!,
    leaves,
    layers,
    proof(leaf: Hex): Hex[] {
      let i = index.get(leaf.toLowerCase() as Hex);
      if (i === undefined) throw new Error(`merkle: ${leaf} is not a leaf of this tree`);
      const proof: Hex[] = [];
      for (let level = 0; level < layers.length - 1; level++) {
        const nodes = layers[level]!;
        const sibling = i ^ 1;
        if (sibling < nodes.length) proof.push(nodes[sibling]!);
        i >>= 1;
      }
      return proof;
    },
  };
}

/** Same algorithm as OpenZeppelin MerkleProof.verify with commutative hashing. */
export function processProof(leaf: Hex, proof: readonly Hex[]): Hex {
  let computed = leaf.toLowerCase() as Hex;
  for (const node of proof) computed = hashPair(computed, node.toLowerCase() as Hex);
  return computed;
}

export function verifyMerkleProof(leaf: Hex, proof: readonly Hex[], root: Hex): boolean {
  return processProof(leaf, proof) === root.toLowerCase();
}
