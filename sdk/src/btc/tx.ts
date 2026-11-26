/**
 * The two Bitcoin transactions of a bond, built and signed here with @scure/btc-signer; nothing is sent.
 *
 * Funding: inputs from one single-key wallet (P2WPKH or BIP86 P2TR), largest first (the vendored x402 wallet's
 * selection, sizes and dust limits); output 0 the bond (P2WSH of the witness script), output 1 the tag (OP_RETURN,
 * 0 sats), output 2 change to the wallet if it is above dust.
 *
 * Redeem: the bond output alone, nLockTime = the bond's locktime (a timestamp, the same kind CLTV checks), sequence
 * 0xfffffffe (non-final, so nLockTime is enforced and CLTV can pass), one output to the address given, and the
 * witness [signature, witness script] with SIGHASH_ALL. Bitcoin accepts it once the median time past of the last 11
 * blocks is greater than the locktime (BIP113), about an hour after the locktime itself.
 */
import { secp256k1 } from "@noble/curves/secp256k1";
import { Address as BtcAddress, OutScript, SigHash, Transaction } from "@scure/btc-signer";
import { DUST, selectLargestFirst, VSIZE, type Utxo } from "../vendor/x402-btc/wallet.js";
import type { BtcKey } from "./keys.js";
import { BTC_PARAMS, type BtcNet } from "./networks.js";
import { bondOutputScript, parseBondWitnessScript } from "./script.js";

export const BOND_VOUT = 0;
export const TAG_VOUT = 1;
/** Non-final: nLockTime applies and OP_CHECKLOCKTIMEVERIFY accepts the input (BIP65). */
export const REDEEM_SEQUENCE = 0xfffffffe;
/** The default refusal threshold for a fee rate, sat/vB. */
export const DEFAULT_MAX_FEE_RATE = 50;

export interface FundingTx {
  hex: string;
  txid: string;
  bondVout: number;
  tagVout: number;
  /** Undefined when the remainder was below dust and went to the fee. */
  changeVout?: number;
  fee: bigint;
  change: bigint;
  vsize: number;
  feeRate: number;
  inputs: Utxo[];
  outputs: { sats: bigint; script: Uint8Array }[];
}

export function assertFeeRate(feeRate: number, max: number): void {
  if (!(feeRate > 0) || !Number.isFinite(feeRate)) throw new Error(`fee rate must be a positive number of sat/vB, got ${feeRate}`);
  if (feeRate > max) throw new Error(`fee rate ${feeRate} sat/vB is above the cap of ${max} sat/vB (--max-fee-rate)`);
}

export function buildFundingTx(
  key: BtcKey,
  utxos: readonly Utxo[],
  plan: { sats: bigint; witnessScript: Uint8Array; tag: Uint8Array; feeRate: number },
): FundingTx {
  const bondScript = bondOutputScript(plan.witnessScript);
  const sel = selectLargestFirst(
    utxos,
    plan.sats,
    plan.feeRate,
    {
      input: VSIZE.input[key.addressType],
      paymentOutput: VSIZE.output(bondScript.length) + VSIZE.output(plan.tag.length),
      changeOutput: VSIZE.output(key.script.length),
    },
    DUST[key.addressType],
  );
  // The tag is an OP_RETURN, which @scure/btc-signer classes as an unknown output script.
  const tx = new Transaction({ allowUnknownOutputs: true });
  const xonly = key.addressType === "p2tr" ? key.publicKey.subarray(1) : undefined;
  for (const u of sel.inputs) {
    tx.addInput({
      txid: u.txid,
      index: u.vout,
      witnessUtxo: { script: key.script, amount: BigInt(u.value) },
      ...(xonly ? { tapInternalKey: xonly } : {}),
    });
  }
  tx.addOutput({ script: bondScript, amount: plan.sats });
  tx.addOutput({ script: plan.tag, amount: 0n });
  if (sel.change > 0n) tx.addOutput({ script: key.script, amount: sel.change });
  tx.sign(key.privateKey);
  tx.finalize();
  if (tx.fee !== sel.fee) throw new Error(`internal error: fee ${tx.fee} != selected ${sel.fee}`);
  const outputs = [{ sats: plan.sats, script: bondScript }, { sats: 0n, script: plan.tag }];
  if (sel.change > 0n) outputs.push({ sats: sel.change, script: key.script });
  return {
    hex: tx.hex,
    txid: tx.id,
    bondVout: BOND_VOUT,
    tagVout: TAG_VOUT,
    changeVout: sel.change > 0n ? 2 : undefined,
    fee: sel.fee,
    change: sel.change,
    vsize: tx.vsize,
    feeRate: plan.feeRate,
    inputs: sel.inputs,
    outputs,
  };
}

export interface RedeemTx {
  hex: string;
  txid: string;
  fee: bigint;
  vsize: number;
  feeRate: number;
  outputSats: bigint;
  lockTime: number;
  sequence: number;
}

/** Weight units of a redeem transaction with a 73-byte signature (the DER maximum, plus the sighash byte). */
export function redeemVsize(outputScriptLength: number): number {
  const base = 4 + 1 + (32 + 4 + 1 + 4) + 1 + (8 + 1 + outputScriptLength) + 4; // version, in, out, locktime
  const witness = 2 + 1 + (1 + 73) + (1 + 42); // marker+flag, item count, signature, witness script
  return Math.ceil((base * 4 + witness) / 4);
}

export function buildRedeemTx(o: {
  txid: string;
  vout: number;
  sats: bigint;
  witnessScript: Uint8Array;
  privateKey: Uint8Array;
  to: string;
  network: BtcNet;
  feeRate: number;
  /** Defaults to the bond's locktime; must be at least that and a timestamp too. */
  lockTime?: number;
}): RedeemTx {
  const { locktime, pubkey } = parseBondWitnessScript(o.witnessScript);
  const own = secp256k1.getPublicKey(o.privateKey, true);
  if (Buffer.compare(Buffer.from(own), Buffer.from(pubkey)) !== 0) {
    throw new Error("this key is not the bond's key: its public key differs from the one in the witness script");
  }
  const lockTime = o.lockTime ?? locktime;
  if (!Number.isInteger(lockTime) || lockTime < locktime || lockTime > 0xffffffff) {
    throw new Error(`nLockTime ${lockTime} must be at least the bond's locktime ${locktime}`);
  }
  let toScript: Uint8Array;
  try {
    toScript = OutScript.encode(BtcAddress(BTC_PARAMS[o.network]).decode(o.to));
  } catch (error) {
    throw new Error(`${o.to} is not a ${o.network} address (${(error as Error).message})`);
  }
  const type = OutScript.decode(toScript).type;
  const dust = type === "wpkh" ? DUST.p2wpkh : type === "tr" ? DUST.p2tr : 546n;
  const vsize = redeemVsize(toScript.length);
  const fee = BigInt(Math.ceil(vsize * o.feeRate));
  const outputSats = o.sats - fee;
  if (outputSats < dust) throw new Error(`the bond's ${o.sats} sats less a fee of ${fee} leaves ${outputSats}, below dust (${dust})`);

  const tx = new Transaction({ lockTime, allowUnknownInputs: true });
  tx.addInput({
    txid: o.txid,
    index: o.vout,
    sequence: REDEEM_SEQUENCE,
    witnessUtxo: { script: bondOutputScript(o.witnessScript), amount: o.sats },
  });
  tx.addOutput({ script: toScript, amount: outputSats });
  // BIP143 digest over the witness script itself (the scriptCode of a P2WSH spend), SIGHASH_ALL
  const digest = tx.preimageWitnessV0(0, o.witnessScript, SigHash.ALL, o.sats);
  const der = secp256k1.sign(digest, o.privateKey, { lowS: true }).toDERRawBytes();
  const sig = new Uint8Array(der.length + 1);
  sig.set(der);
  sig[der.length] = SigHash.ALL;
  tx.updateInput(0, { finalScriptWitness: [sig, o.witnessScript] }, true);
  return { hex: tx.hex, txid: tx.id, fee, vsize: tx.vsize, feeRate: o.feeRate, outputSats, lockTime, sequence: REDEEM_SEQUENCE };
}

/** Decodes a raw transaction's outputs (for files and fixtures). */
export function txOutputs(hex: string): { sats: bigint; script: Uint8Array }[] {
  return decodeTx(hex).outputs;
}

/** Decodes a raw transaction: its txid (display order, no 0x) and outputs. Throws if it does not decode. */
export function decodeTx(hex: string): { txid: string; outputs: { sats: bigint; script: Uint8Array }[] } {
  const tx = Transaction.fromRaw(Buffer.from(hex, "hex"), { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true });
  const outputs: { sats: bigint; script: Uint8Array }[] = [];
  for (let i = 0; i < tx.outputsLength; i++) {
    const o = tx.getOutput(i);
    outputs.push({ sats: o.amount ?? 0n, script: o.script ?? new Uint8Array() });
  }
  return { txid: tx.id, outputs };
}
