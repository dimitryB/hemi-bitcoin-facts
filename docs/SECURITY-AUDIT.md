# Security audit of the contracts and SDK

This is the one record of every security review and audit of hemi-bitcoin-facts: the three contracts on Hemi that
read Bitcoin through hVM's precompiles, the deployment script, and the TypeScript SDK and `hbf` CLI. All of it took
place on 2026-11-21 and 2026-11-22, before the contracts were deployed on Hemi mainnet.

**Status.**
- The internal reviews were done by AI agents with fresh context, on request. They are careful internal reviews, not
  independent third-party audits, and should not be presented as such.
- Two audits, the "independent audit" and the "pre-mainnet audit", were handed in by the owner. This document records
  their findings and what was done about each. It does not say who performed them.
- The mainnet contracts are the build the last reviews covered. Nothing under `contracts/src` or `contracts/script`
  changed after the pre-mainnet audit's fixes, and the final pre-deploy review checked that build byte for byte
  before it was deployed ([DECISIONS.md](DECISIONS.md) D-025).
- No finding of Low or higher is open. A few Info items were kept rather than fixed; [What stays open](#what-stays-open)
  lists them with why.

Every finding keeps the ID it was reported with, because the contract source, the SDK and the tests cite those IDs,
and the deployed source cannot change. Some rounds reused the same letters (R-, F-), so a citation resolves only
together with its round. The next table says which round each form names.

## How the code cites these

`<hash>` stands for a commit of the archived development history. The ID letter and the file the comment is in name
the round.

| Citation in the code | Section |
| --- | --- |
| "security review finding n", "review finding n", "Security review", "docs/security-review.md finding n", "the first review's finding n", "the first review", "security review: heminetwork crawler.go"; "Finding n" in `contracts/test/review/*.t.sol` and `contracts/test/PopFinality.t.sol` | [Internal review](#internal-review), findings 1 to 10 |
| "What the tag and the thresholds do not cover (docs/security-review.md)" in `FidelityBonds.sol` | [What the tag and the thresholds do not cover](#what-the-tag-and-the-thresholds-do-not-cover) |
| "delta review finding n", "delta finding n", "Finding (informational)" and `test_delta_F_*` in `contracts/test/review/delta/` | [Delta review](#delta-review), findings 1 to 6 |
| "review of `<hash>`, finding n" in `Deploy.s.sol`; "Review of `<hash>`" in `contracts/test/review/fix/` | [Fix review](#fix-review), findings 1 to 3 |
| "follow-up of `<hash>`, F-n" in `Deploy.s.sol`; "Follow-up review of `<hash>`" in `contracts/test/review/fix/` | [Fix review follow-ups](#fix-review-follow-ups), F-1 and F-2 |
| "independent audit, finding n", "independent audit finding n", "audit finding n"; A-1 to A-3 in `contracts/test/audit/Audit.t.sol` | [Independent audit](#independent-audit) |
| "review of `<hash>`, R-n"; "Review of `<hash>`", "finding R-n" and "Follow-up review of `<hash>` (R-5, R-6, R-7)" in `contracts/test/review/audit-fixes/` | [Review of the audit fixes](#review-of-the-audit-fixes), R-1 to R-7 |
| "review F-n" in `sdk/test/common.test.ts` | [Audit fixes follow-ups](#audit-fixes-follow-ups), F-1 to F-3 |
| "pre-mainnet audit M-n / L-n / I-n", "pre-mainnet L-n / I-n", "audit M-1", "M-2 item 3"; bare M-, L- and I- IDs in the SDK and in `contracts/test/audit/PreMainnetAudit.t.sol` | [Pre-mainnet audit](#pre-mainnet-audit) |
| "review of the pre-mainnet audit fixes"; "review of the audit fixes, R-n" in `sdk/src/common.ts` (it means the pre-mainnet audit's fixes) | [Review of the pre-mainnet fixes](#review-of-the-pre-mainnet-fixes) |
| "review R-n" and bare "R-n" | By topic. The wall clock, `check-live`'s field, the per-URL registry check, `simulated`, `--skip-exact` and `agree`: [Review of the audit fixes](#review-of-the-audit-fixes). The RPC fallback, the code check in every command, `watch`, `recordFact`'s re-check and the runtime lists: [Review of the pre-mainnet fixes](#review-of-the-pre-mainnet-fixes) |
| "review of `<hash>`, N-n", "Follow-up review of `<hash>`: N-n", bare "N-n" | [Pre-mainnet fixes, first follow-up](#pre-mainnet-fixes-first-follow-up) |
| "of `<hash>`, P-n", bare "P-n" | [Pre-mainnet fixes, second follow-up](#pre-mainnet-fixes-second-follow-up) |
| "review of `<hash>`" with no ID, in `sdk/test/common.test.ts` (the `redactUrls` cases) | [Pre-mainnet fixes, first follow-up](#pre-mainnet-fixes-first-follow-up) (the punctuation case) and [the final check](#pre-mainnet-fixes-final-check) (the quote and zone-id cases) |
| "branch review/security" | [Internal review](#internal-review) |
| "branch review/delta" | [Delta review](#delta-review) |
| "branch review/fix-`<hash>`" | [Fix review](#fix-review) |
| `docs/security-review.md` | [Internal review](#internal-review) |
| `docs/security-review-delta.md` | [Delta review](#delta-review) |
| `docs/security-review-fix-1f85744.md` | [Fix review](#fix-review) and its follow-ups |
| `docs/security-review-audit-fixes.md` | [Review of the audit fixes](#review-of-the-audit-fixes) and its follow-ups |
| `docs/pre-mainnet-audit-handoff.md` | [Pre-mainnet audit](#pre-mainnet-audit) |
| `docs/security-review-pre-mainnet.md` | [Review of the pre-mainnet fixes](#review-of-the-pre-mainnet-fixes) and its follow-ups |

## Scope

| File | Lines | Role |
| --- | ---: | --- |
| `contracts/src/Hvm.sol` | 431 | Library: calls hVM's precompiles `0x40` to `0x49` with gas caps and parses their answers |
| `contracts/src/BitcoinFacts.sol` | 467 | Output and balance facts, recorded once with the Bitcoin height they are as of |
| `contracts/src/PopFinality.sol` | 617 | Keystone checkpoints, PoP publications and the finality views |
| `contracts/src/FidelityBonds.sol` | 546 | Bitcoin fidelity bonds: `checkBond`, `recordBond`, `liveBond`, `refresh` |
| `contracts/script/Deploy.s.sol` | 210 | CREATE2 deployment: pinned init-code hashes and the broadcast guard |
| `sdk/src` | | The SDK and the `hbf` CLI, in scope from the independent audit on |

Toolchain: solc 0.8.28, EVM `cancun`, optimizer on at 200 runs, no CBOR metadata (`cbor_metadata = false`,
`bytecode_hash = "none"`), Foundry 1.8.6. The contracts have no owner, no constructor arguments, no payable function
and no upgrade path. Precompile behaviour was read from upstream source: hemilabs/op-geth `67f25b90` and `539f4e33`
(the build mainnet runs), hemilabs/heminetwork `44781989923a` (the version mainnet pins) and btcd v0.24.2.

Deployed on Hemi mainnet (chain 43111), each at its CREATE2 address:

| Contract | Address | keccak256 of the init code |
| --- | --- | --- |
| BitcoinFacts | `0xAecbC8F5f6bB401c7d8A7625f53fE2225b730FfC` | `0x6b9a239be1b8d8ecd1fdad96ba73d03dd6bf5f13b89891b6713fac57b9a1234c` |
| PopFinality | `0x0706C1582E7C27c09953803384396efd4fa62486` | `0x205b751f96b0a815e61940a2e10f9161e07837d826bb55e00cc0245de296c6bd` |
| FidelityBonds | `0xC527EDfEEE8972797D74252aA9111A05ea2C9A4e` | `0x2197004a2e44e2c65c00e439b04f9fa8e3072fca49cf36eccb9941cbca74b9b9` |

Earlier rounds name earlier pins and addresses. Each round of contract fixes changed the bytecode, so the pins
changed with it. Only the table above is live.

## Rounds

| Section | What it covered | Findings | Open |
| --- | --- | --- | --- |
| [Internal review](#internal-review) | The four contract files and the deploy script, in full | 1 Medium, 1 Low, 8 Info | None (four Info kept, documented) |
| [Delta review](#delta-review) | The contract changes made for the internal review | 2 Low, 4 Info | None (one Info kept: behaviour) |
| [Fix review](#fix-review) | The changes made for the delta review, then two follow-ups | 2 Low, 3 Info | None (two Info kept, documented) |
| [Independent audit](#independent-audit) | Contracts and SDK after the fix review | 1 Medium, 2 Low, 2 Info | None (one Info kept) |
| [Review of the audit fixes](#review-of-the-audit-fixes) | The fixes for the independent audit, then two follow-ups | 1 Low, 9 Info | None (R-2's two clock edges documented) |
| [Pre-mainnet audit](#pre-mainnet-audit) | Contracts and SDK after the review of the audit fixes | 2 Medium, 5 Low, 7 Info | None |
| [Review of the pre-mainnet fixes](#review-of-the-pre-mainnet-fixes) | The fixes for the pre-mainnet audit, then three follow-ups | 3 Low, 16 Info, and the final check's notes | None (four residuals kept, documented) |
| [Final pre-deploy review](#final-pre-deploy-review) | The build and the script, just before deployment | None | GO |

Critic passes over the README's Definition of done ran between rounds; they are not security reviews.

## Internal review

**Scope.** `Hvm.sol`, `BitcoinFacts.sol`, `PopFinality.sol`, `FidelityBonds.sol` and `Deploy.s.sol`, read line by
line as they stood before any review. Intended behaviour came from [BRIEF.md](BRIEF.md), [SCHEMA.md](SCHEMA.md) and
the decision log up to D-019. Nothing was changed during the review; every finding was reported, then fixed or kept.

**Method.** Each precompile's byte layout and failure modes were read in op-geth and heminetwork source and checked
against the parsers. The reviewer wrote 25 scratch tests (now `contracts/test/review/`, rewritten to assert the
fixes), ran every never-revert fuzzer at 20,000 runs, and made about 55 read-only Hemi mainnet reads and two Esplora
reads. Nothing was signed or sent. `live-review.sh` repeats the mainnet reads.

**Verdict.** No finding let a `record…` call store a false Bitcoin fact, or made `liveBond` report a spent bond as
live. One Medium: anyone could make PopFinality's one-slot finality view true for a keystone Hemi ignores.

| ID | Severity | Finding | Outcome | Covered by |
| --- | --- | --- | --- | --- |
| 1 | Medium | `recordPublication` checked only the version, K and K's 12-byte hash prefix. One Bitcoin fee could make `isBtcFinal` (since renamed `isBtcAnchored`) true for a keystone Hemi's consensus ignores, and with one slot per K a forgery mined first kept the real publication out for good. | Fixed ([DECISIONS.md](DECISIONS.md) D-023). Every valid publication is kept, keyed by (K, txid, vout). `isBtcFinalVia` answers about one named publication, and the best-pointer view is documented as "anchored", forgeable. | `ReviewPopFinality.t.sol`: `test_review_forgedKeystone_isRecordedAndReadsAnchoredOnly`, `test_review_forgedFirst_realPublicationIsStillRecorded`, `test_review_forgedEarlier_takesTheBestButNotTheRealEntry` |
| 2 | Low | `Deploy.s.sol` did not pin the init code. A build-setting change (the `verify` profile's CBOR metadata) moved all three addresses away from the ones the docs, the SDK and every bond tag name. | Fixed (D-024). The init-code hashes are pinned in `Deployments` and checked before any broadcast. The `verify` profile is gone. | `ReviewHvmDeploy.t.sol`: `test_review_initCodeIsPinned`, `test_review_predictedAddressesMatchTheDocs`, `test_review_frontRunDeploymentIsHarmless` |
| 3 | Info | hVM lists the genesis coinbase in its UTXO set, so it read as an unspent 50 BTC output. | Fixed. `GENESIS_COINBASE_TXID` is reported `Unspendable`. | `test_review_genesisCoinbaseReadsAsAnUnspent50BtcOutput` |
| 4 | Info | The transaction a caller picks bounds gas: about 1.1M for an unspent 10,000-byte script (a redundant parse), about 300k on the `0x42` paths. | The redundant parse on the `0x48` path is gone (TBC's UTXO set never holds an unparseable script). `liveBond`'s budget of about 310k, and calling it in try/catch, are documented. | `test_review_gas_unspent10000ByteScript`, `test_review_gas_spentPathParses128x128`, `test_review_gas_liveBondSpentPathWorstCase` |
| 5 | Info | One output could be a bond for two agents in two FidelityBonds deployments. | Fixed. Any second `"HFB1"` tag, for any chain or contract, makes the bond `AmbiguousTag`. | `test_review_oneOutputIsABondForTwoAgentsInTwoDeployments`, `testFuzz_delta_anyTagRule` |
| 6 | Info | The tag binds only if every funding input signs SIGHASH_ALL (or taproot's DEFAULT). | Kept, documented. `hbf bond create` signs ALL/DEFAULT only. | Reasoning; `test_checkBond_ambiguousTag` |
| 7 | Info | Keys were checked only for their 02/03 prefix, so an unusable key was accepted. | Partly fixed. x ≥ p is refused on chain, and `witnessScriptFor` builds only valid keys. Whether x is on the curve is checked by the SDK, not on chain, as documented. | `test_review_offCurveKeyIsAccepted`, `test_review_witnessScriptForDoesNotCheckTheKeyLength`, `test_delta_fieldPrimeBoundary` |
| 8 | Info | The 6 and 9 confirmation thresholds count against hVM's upstream tip, about two blocks past the `0x44` view. "Live" means unspent as of `0x44`. | Kept, documented in NatSpec and the README. | Reasoning |
| 9 | Info | If the stored publication's Bitcoin transaction was reorged away, finality read false until someone recorded another. | Fixed with 1. Re-submitting any stored publication re-chooses K's best, and `isBtcFinalVia` never depends on the best. | `test_review_storedReorgedAway_viaUnaffectedAndBestRestoredByResubmitting` |
| 10 | Info | The contracts are frozen to today's hVM: gas caps at twice today's charges, and today's byte meanings. | Kept, documented with the redeploy path. | Reasoning |

### What the tag and the thresholds do not cover

`FidelityBonds.sol` lists three limits under this heading. They are findings 6, 7 and 8 above:
- **Finding 6.** The tag binds only if every input of the funding transaction signs SIGHASH_ALL or DEFAULT. With NONE
  or SINGLE, whoever relays the transaction can add a zero-value output: a second tag makes the bond `AmbiguousTag`
  for good, and an untagged output can be tagged for the relayer's own agent. Mainnet's hVM strips witnesses, so the
  contract cannot check sighash types.
- **Finding 7.** A key must be 02/03 with x below the field prime. Whether it is on the curve is not checked, and a
  bond to an off-curve key can never be redeemed, though it reads Expired after the locktime.
- **Finding 8.** `MIN_CONFIRMATIONS = 6` is about 4 in hVM's indexed view, and a spend in the last two Bitcoin blocks
  is not seen yet. A consumer should require a margin before the locktime.

### Checked and found sound

- Every parser checks one exact total length before reading, and offsets match op-geth. No answer is ever read as a
  value: an empty or failed precompile call gives a "no answer" verdict, never zero or "unspent".
- "Spent" comes only from a positive answer ([DECISIONS.md](DECISIONS.md) D-014). heminetwork's indexer leaves out of
  the UTXO set exactly what btcd's `IsUnspendable` rejects, and op-geth moves the UTXO and transaction indexes together.
- Starving one hVM call of gas leaves too little for any later call or SSTORE, so it cannot flip an outcome.
- Views never revert except out of gas. Records are written once per id and ids cannot collide.
- The windows, the CLTV template, the tag layout, the casts and every assembly block hold. Nothing is payable, there is
  no owner, and the only external calls are STATICCALLs. A front-run of the CREATE2 deployment deploys the same code.
- The two BIP30 duplicate coinbases get empty answers and read NotFound.

At that point `isBtcFinal(B, K)` attested only that K's 12-byte hash prefix sat in a stored publication with 9 or more
confirmations. It did not attest that Hemi's PoP consensus counts that transaction, nor the other 59 bytes of the
keystone. That is still what `isBtcAnchored` means.

The mocks differ from the real precompiles: MockHvm's gas is not the precompiles' fixed charge, the fork tests lay
MockHvm over a fork because forge cannot run hVM, and the mocks do not model the genesis or BIP30 cases. Only
`check-live.sh`, `live-review.sh` and `live-delta.sh` touch the real precompiles.

## Delta review

**Scope.** The contract changes made to act on the internal review: BitcoinFacts' genesis verdict and the dropped
`0x48` parse, FidelityBonds' any-tag rule and field-prime check, PopFinality keeping every publication, and
`Deploy.s.sol`'s pins. Every changed file was read in full, with `Hvm.sol` as the base. Nothing was deployed yet.

**Method.** The changes were read against op-geth, heminetwork and btcd v0.24.2 source. The reviewer wrote 25 scratch
tests in `contracts/test/review/delta/`. Five of them, `test_delta_F_*`, asserted a property the code or docs claimed
and failed as the evidence for a finding; since the fixes they pass. Every fuzzer ran at 20,000 runs. The deploy
script was exercised on a local anvil (`deploy-bypass.sh`), and about 18 read-only mainnet reads were made
(`live-delta.sh`).

**Verdict.** No change let a `record…` store a false fact, made a spent bond read live, or made `isBtcFinalVia` true
without a stored publication of K with 9 or more confirmations. The best pointer always names a stored entry that
verifies right after any submission, gas is flat in the number of stored publications, and dropping the `0x48` parse
is safe.

| ID | Severity | Finding | Outcome | Covered by |
| --- | --- | --- | --- | --- |
| 1 | Low | The pin check and the mainnet confirmation lived only in `run()`. `deployAll(bool)` is public and broadcast with neither (`--sig 'deployAll(bool)' true --broadcast`), as reproduced on a local anvil. | Fixed. Every broadcast goes through `_guardBroadcast()`: the pin check, and on Hemi mainnet `CONFIRM_MAINNET_DEPLOY=yes`. `plan()` prints whether each hash is the pinned one. | `test_delta_F_deployAllBroadcastNeedsTheSameGuardsAsRun`, `deploy-bypass.sh` |
| 2 | Low | `witnessScriptFor` returned empty bytes for a refused key, and `bondScript` of empty bytes is P2WSH of the empty script, which anyone can spend. | Fixed. `bondScript` and `witnessScriptFor` return empty bytes for anything `checkBond` would refuse: template, key or locktime. | `test_delta_F_witnessScriptForInvalidKey_doesNotComposeToAnyoneCanSpend`; the fix review's `bondScript` fuzzers |
| 3 | Info | After the best stops verifying, the next valid submission becomes the best whatever its count. The docs said "the most confirmations". | Wording fixed in NatSpec, SCHEMA.md and the README. Behaviour kept: it heals when the better entry is re-submitted, and `isBtcFinalVia` is unaffected. | `test_delta_bestAfterFailure_isTheNextValidSubmission`, `test_delta_bestAfterFailure_healsByResubmitting` |
| 4 | Info | testnet4's genesis coinbase would read as an unspent 50 BTC output on a Hemi network that follows testnet4. | Fixed. `TESTNET4_GENESIS_COINBASE_TXID` is also `Unspendable`. | `test_delta_F_testnet4GenesisCoinbaseIsUnspendable` |
| 5 | Info | `witnessScriptFor`'s NatSpec said it never builds a script `checkBond` refuses, but it did not check the locktime. | Fixed. It returns empty outside [500,000,000, 2^31). | `test_delta_F_witnessScriptFor_neverBuildsAScriptCheckBondRefuses` |
| 6 | Info | Docs lagged the new rules: `Unspendable`, `BadWitnessScript`, SCHEMA's tag rule, the failure case of the best's confirmations. | Updated in NatSpec and SCHEMA.md. [BRIEF.md](BRIEF.md) stays as written; DECISIONS.md D-018 and D-023 record where it is superseded. | Reading |

## Fix review

**Scope.** The changes made to act on the delta review: `bondScript` and `witnessScriptFor`, the testnet4 genesis
txid, comments in PopFinality, and the shared broadcast guard in `Deploy.s.sol`. Each changed file was read in full,
together with the README, SCHEMA.md and the SDK's generated ABIs, which the change re-pinned.

**Method.** The code before and after the change was built from clean exports, and the bytecode and pins compared.
PopFinality's bytecode was byte-identical. The genesis txids of all five Bitcoin networks were derived independently
from Bitcoin Core's `chainparams.cpp` (master `442b152c`) and btcd's `genesis.go` (master `dd169fe0`) by `genesis.py`.
The reviewer wrote 17 scratch tests in `contracts/test/review/fix/`. The differential ones load the two changed
contracts as they were before the fix, from `contracts/test/fixtures/review-fix/BitcoinFacts-before-fix.initcode.hex`
and `FidelityBonds-before-fix.initcode.hex`, and compare them with the new code under the same mock hVM. Every path
of `Deploy.s.sol` was run on local anvils only.

**Verdict.** `bondScript` and `witnessScriptFor` accept exactly the scripts `checkBond` accepts and only remove
answers; the testnet4 txid is right and hides no other output; every path that broadcasts runs the pin check. One Low.
After this review and its follow-ups, the internal, delta and fix reviews together covered every line of
`contracts/src` and `contracts/script`.

| ID | Severity | Finding | Outcome | Covered by |
| --- | --- | --- | --- | --- |
| 1 | Low | The mainnet confirmation keyed on `block.chainid`, which forge's `--chain` and `FOUNDRY_CHAIN_ID` change while forge still sends to the RPC's chain. On a local anvil as chain 43111, `run() --broadcast --chain 1` deployed without the confirmation (the pin check still held). | Fixed. In a script run, `_guardBroadcast` reads `eth_chainId` and refuses unless it equals `block.chainid`. | `fix-deploy-anvil.sh` A7 to A9; `RpcChainIdGuard.s.sol`; `test_fix_guardFollowsBlockChainId` (in-EVM, where there is no RPC, so it still shows `block.chainid` alone) |
| 2 | Info | A simulation of `run()` records no transactions, so it previews no gas or cost. | Kept, documented. The README gives a separate preview command. | `fix-deploy-anvil.sh` A2, A5 |
| 3 | Info | Three comments lagged the code: `plan()`'s format, the `Deployments` comment, `checkOutput`'s verdict order. | Fixed. Comments only. | Reading |

### Fix review follow-ups

The same reviewer checked the fix for finding 1, then the fix for F-1. All three contracts' bytecode stayed the same.

| ID | Severity | Finding | Outcome | Covered by |
| --- | --- | --- | --- | --- |
| F-1 | Low | `forge script --resume` never runs the script, so no guard runs on resume. A dry run of `deployAll(true)` with `--chain 1` recorded the three deployments unchecked, and `--resume` then sent them to 43111 without the confirmation. | Fixed. The RPC chain-id check runs in every script run (`ScriptGroup`: dry run and broadcast), so no unchecked sequence can be recorded. | `fix-guard-bypass-anvil.sh` D1, `ContextProbe.s.sol`, `fix-resume-norpc-anvil.sh` |
| F-2 | Info | The README's preview step leaves a dry-run sequence that a later `--resume` sends without asking again. | Kept, documented. The README says to delete `contracts/broadcast/Deploy.s.sol/43111/dry-run/` after previewing. | `fix-guard-bypass-anvil.sh` D3, `fix-resume-norpc-anvil.sh` X1, X2 |

The second follow-up found no new finding. It also showed that `--resume` sends to the RPC a sequence was recorded
with, not the one given, and that with no RPC at all a broadcast fails closed. Sending the init code to the
deterministic deployer directly is permissionless by design: the guard governs `Deploy.s.sol` only.

## Independent audit

**Scope.** The contracts and the SDK as they stood after the fix review. It came with five findings, numbered 1 to 4
and 6, and three demonstration tests, A-1 to A-3, kept as `contracts/test/audit/Audit.t.sol`. All three
demonstrations held on the code as it stood. Each finding was acted on.

| ID | Severity | Finding | Outcome | Covered by |
| --- | --- | --- | --- | --- |
| 6 | Medium | `hbf finality status` could exit 0 with `final: true` when its exact-match check never ran (`match.exact === null`), so a one-fee forged keystone could read as Hemi PoP finality. | Fixed in the SDK. `shownHemiPopFinal` counts only `match.exact === true` with `isBtcFinalVia` true. An unchecked match is `final: false` (exit 1), with a note. | `finality.test.ts` (`shownHemiPopFinal`), `finality.e2e.test.ts`; `check-live.sh` asserts `final: true` on mainnet's real exact match |
| 1 | Low | `liveBond` stayed Live while hVM's Bitcoin view was stale, even after the owner could redeem (A-1). | Fixed. Expired once either the `0x44` header's time or Hemi's `block.timestamp` reaches the locktime (`_expired`, also used for `checkBond`'s `expired`). An early Expired can turn back into Live only while Hemi's clock is before the locktime (A-2). | `test_audit_A1_liveWhileHemiClockIsHoursPastTheLocktime`, `test_audit_A2_expiredCanTurnBackIntoLive`, `AuditFixes.t.sol` |
| 2 | Low | `hbf bond create` locked BTC for a registry address without checking that a contract is there. | Fixed in the SDK. The code at the address must equal this SDK's FidelityBonds runtime before any key is read. Without `--rpc` it refuses unless `--no-registry-check` is given. | `bond.e2e.test.ts`, `bonds.test.ts` |
| 4 | Info | `isBtcFinal` promised more than it checks, and could not be renamed after deployment. | Renamed. `isBtcFinal` is now `isBtcAnchored` and `btcConfirmations` is `anchorConfirmations`. The exact-match pair keeps `isBtcFinalVia` and `btcConfirmationsVia`. | `PopFinality.t.sol` |
| 3 | Info | Ended is permanent, even if the output later reads unspent again (A-3). | Kept, documented in `refresh`'s NatSpec and the README. It errs on the side of "not live", and the key holder can spend after the locktime anyway. | `test_audit_A3_endedStaysEndedWhenTheOutputReadsUnspentAgain` |

## Review of the audit fixes

**Scope.** The change that acted on the independent audit: FidelityBonds' two-clock expiry, the PopFinality rename,
the new pins, the SDK's `shownHemiPopFinal` and `bond create`'s registry check, the tests it changed, and
`contracts/live/finality.sh`.

**Method.** PopFinality's source from before the change, with the two names renamed, built to byte-identical
bytecode, which proves the rename pure. The clocks were reasoned through (BIP113 median time past, CLTV, OP Stack
timestamps) and measured read-only: Hemi's head ran 5 s behind the wall clock, Bitcoin's median time past 1 h 51 min
behind. Every path to `final: true`, to `status`'s exit 0 and to `bond create`'s key read was traced. Scratch tests in
`contracts/test/review/audit-fixes/` fuzz the two-clock rule at 20,000 runs.

**Verdict.** The fixes weaken no guarantee. Live now needs both clocks before the locktime, and once Hemi's clock
reaches it the bond is Expired for good. `final: true` needs a checked 76-byte match. The registry check runs before
any key is read. Live can still be reported for a redeemable bond in two edge cases: Hemi's clock behind real time
(catch-up blocks after a sequencer halt) or Bitcoin's median time past ahead of it. Normally Expired comes one to two
hours before the owner can spend, on the safe side.

| ID | Severity | Finding | Outcome | Covered by |
| --- | --- | --- | --- | --- |
| R-1 | Low | The new clock made two suites depend on the wall clock. The bond e2e replayed a regtest bond whose locktime had already passed (4 tests failed), and `FidelityBondsForkTest` would fail from 2027-01-15. | Fixed. The regtest gate locks the fixture bond until 2033-05-18 (`FIXTURE_LOCKTIME = 2_000_000_000`) and redeems it under bitcoind's `setmocktime`. The fork test warps to a day before its locktime. | `fork-clock-anvil.sh`, `test_audit_forkFixtureStopsBeingLiveAtItsLocktime`, `regtest/run.sh` |
| R-2 | Info | "Live always means not yet redeemable" holds only while Hemi's clock is not behind Bitcoin's median time past, and Expired comes one to two hours early, not about one. | Reworded in NatSpec and the README, with both exceptions and the advice to keep a margin. | `testFuzz_audit_twoClockRule`, `testFuzz_audit_expiredForGoodFromHemiClock` |
| R-3 | Info | Four descriptions of Expired still named only the header's time, so the CLI could say the header was past the locktime when it was not. | Fixed: `BondCheck.expired`, the SDK's `BOND_STATUS_MEANING`, `bond record`'s note, SCHEMA.md. | `test_audit_expiredFlagWithHeaderTimeBeforeTheLocktime` |
| R-4 | Info | One rename in `check-live`'s finality script went too far: `.reader.btcConfirmations` is the receipts reader's own field. | Reverted. | `check-live.sh` |
| R-5 | Info | The registry check took the chain id from the first `--rpc` and the code from whichever URL the fallback reached. | Fixed. Every `--rpc` URL is asked on its own for its chain id and its code. The library's `createBond` documents that it does not check. | `followup-r5-r7-anvil.sh`, `bond.e2e.test.ts` |
| R-6 | Info | Under `--state-override` or `--code-override`, `status` could report `final: true` without saying the contract state was simulated. | Fixed. The output carries `simulated: true`, a note and a text line. The exit code still follows `final`. | `followup-r5-r7-anvil.sh`, `finality.e2e.test.ts` |
| R-7 | Info | Tidying: a detached doc comment, `status` ignoring `--skip-exact`, `agree` comparing an unchecked match, old test names. | Fixed. `status` refuses `--skip-exact`, and `agree` compares only a checked exact path. | `finality.e2e.test.ts` |

### Audit fixes follow-ups

The same reviewer checked the fixes for R-1 to R-7, then the fixes for F-1 to F-3. The bytecode of all three
contracts stayed identical (comments only), so the pins held. The second follow-up found nothing new.

| ID | Severity | Finding | Outcome | Covered by |
| --- | --- | --- | --- | --- |
| F-1 | Info | `Status.Live`'s NatSpec still said "the owner cannot spend it yet" without R-2's qualification; one comment line was over-long; a README sentence contradicted itself. | Reworded ("normally", pointing to `_expired`), rewrapped and rewritten. | Reading |
| F-2 | Info | The registry check's URL redaction kept credentials and query strings, and `fetchChainId`'s error printed the whole URL. | Fixed. `redactUrl` prints scheme and host only, in both places. | `common.test.ts` |
| F-3 | Info | No suite test covered the per-URL registry check, `--skip-exact` or `simulated`, and `status --help` did not mention `simulated`. | Tests added in `bond.e2e` and `finality.e2e`; the help explains it. The `agree` rule needs a reader source, so only `check-live.sh` exercises it, on mainnet. | `bond.e2e.test.ts`, `finality.e2e.test.ts` |

## Pre-mainnet audit

**Scope.** `contracts/` and `sdk/` as they stood after the review of the audit fixes. It was handed in as a written
report with locations, the fix it required, the tests to add, a re-pinning checklist and a final verification gate.
It has 14 findings: 2 Medium, 5 Low and 7 Info, and nothing Critical or High. Each was checked against the code
before it was changed, each held, and all 14 are fixed. Four of them change contract bytecode (L-1, L-2, I-1, I-2).
Nothing was deployed yet, so they were taken before deployment and all three contracts were re-pinned.

| ID | Severity | Finding | Outcome | Covered by |
| --- | --- | --- | --- | --- |
| M-1 | Medium | `verify` and `bond status` refused any recording whose transaction was not sent straight to the contract (`receipt.to`). Anyone could record a bond or publication first through a one-line wrapper and make it invalid for good, and a Safe, smart account or multicall did the same to its own records. | Fixed. The `receipt.to` check and the `tx-wrong-target` code are gone. What counts is the event the contract itself emitted (`log.address`), which only its code can emit: none of the three has a `delegatecall`. | The "M-1" e2e tests in `facts`, `finality` and `bond.e2e.test.ts`, through the forwarder in `sdk/test/helpers/anvil.ts` |
| M-2 | Medium | `hbf finality watch` dropped a valid publication for good when hVM had not indexed its block yet, missed one mined in a block a reorg put at an already-scanned height, and its `done` set grew without bound. | Fixed. NotFound, NoBitcoinView and NoConfirmations are retried until the output has `max(minConf + 12, 20)` confirmations; other verdicts drop it at once. The newest 6 scanned blocks are remembered by hash and scanned again when replaced. `done` keeps at most 10,000 entries. | The "M-2" tests in `finality.e2e.test.ts`; `watch.test.ts` |
| L-1 | Low | `coveringKeystone(0)` was 0, and above 4,294,967,275 it gave multiples of 25 past 32 bits. Neither is a keystone. | Fixed in the contract: 25 for block 0, and 0 above the new `MAX_KEYSTONE`. The SDK's `coveringKeystone` is the contract's. | `PreMainnetAudit.t.sol` `test_L1_*`, `testFuzz_delta_viaCoveringRule`, `finality.test.ts` |
| L-2 | Low | `tagScript` built tags `checkBond` refuses: for the zero agent, and on a chain id above 2^32 − 1. | Fixed. Empty for both, as `bondScript` and `witnessScriptFor` are for what they refuse. | `test_L2_*` |
| L-3 | Low | `connect()` read the chain id from the first `--rpc` only, while the client falls back to the others mid-run. | Fixed. Every URL is asked, and one serving another chain stops the command, naming its redacted URL. (A URL that does not answer: see R-1 below.) | `common.test.ts` |
| L-4 | Low | When its transaction was a no-op, `recordFact` built the file from the check's id. If hVM's tip had moved and someone recorded the newer fact first, it failed or returned the older fact. | Fixed. The id is looked up again; if none is stored, it says the tip moved and to run again. | The "L-4" test in `facts.e2e.test.ts` |
| L-5 | Low | `finalityStatus` (with the receipts reader's txid, which has no vout) and `finality record --btc-txid` without `--vout` compared only the first PoP output for K. | Fixed. `rankByExactMatch` checks every output for K against one rebuild of the canonical keystone and puts exact matches first. `record` refuses only when none matches. | `finality.test.ts`, the "L-5" test in `finality.e2e.test.ts` |
| I-1 | Info | `Hvm.balance`, `utxos` and `addressScript` did not refuse addresses over 200 bytes, which mainnet's op-geth rejects after burning the call's gas cap. | Fixed. `Hvm.MAX_ADDRESS_BYTES = 200` is checked before any call, and BitcoinFacts uses that constant. | `test_I1_*` |
| I-2 | Info | A stored checkpoint was recognized by a nonzero hash prefix, which misses one in 2^96. | Fixed. By its nonzero `hemiBlock`, from the same slot; the SDK's `readCheckpoint` likewise. | `test_I2_*` |
| I-3 | Info | `verify` checked only that some code was at the address, so a look-alike at an address copied from an untrusted file could emit matching events without reading hVM. | Fixed. The runtime must equal this SDK's build byte for byte (the contracts have no immutables and no metadata). Library callers can pass `allowOtherCode`. | The "I-3" e2e tests |
| I-4 | Info | A plain file named `.secrets`, which git does not ignore, passed the key-file check. | Fixed. The key file must be inside a directory named `.secrets`. | `common.test.ts` |
| I-5 | Info | `bond create --agent 0x0…0` read the chain id and the key before failing. `bond refresh` asked for the key before knowing whether it would send, took a bond file for another chain or contract, and ignored `--id` beside it. | Fixed. The zero agent and a chain id over 32 bits are refused first. `refresh` refuses both flags together, checks the file's chain and contract, and asks for a key only when a simulation says it would mark the bond ended. | The "I-5" tests in `bond.e2e.test.ts`, `bonds.test.ts` |
| I-6 | Info | `readBondFile` took negative or hex `sats` and `fee` and did not check the funding transaction. The SDK's `txOutputs` returned partial lists for a truncated `0x42` answer. | Fixed. Unsigned decimals only, and `hex` must be the transaction `txid` names, paying what the file says. `txOutputs` parses as `Hvm.txOutputs` does. | `bonds.test.ts`, `finality.test.ts` |
| I-7 | Info | Two verdict meanings were stale, and Esplora URLs were printed whole. | Fixed. `AmbiguousTag` and `Unspendable` reworded. Esplora URLs and the CLI's last-resort error line are redacted. | `common.test.ts` |

## Review of the pre-mainnet fixes

**Scope.** The change that acted on the 14 findings: `contracts/src`, `Deploy.s.sol`, `sdk/src`, their tests, the
README and SCHEMA.md. Each fix was checked against the problem the audit describes, not against the fix's own
wording. Three follow-ups then read each later round of SDK fixes. Nothing under `contracts/` changed after the
first.

**Method.** The reviewer read the diff and the code each fix depends on: every event-matching path, `watch()` in full,
`connect()` and its callers. The pins were rebuilt and re-derived, and `sdk_vs_build.py` compared the SDK's init code,
runtime and ABI with the build. The suites ran offline. Scratch tests drove `watch()` with a fake Hemi client and an
in-memory Esplora; they now live in `sdk/test/watch.test.ts` and `sdk/test/common.test.ts`, asserting the fixes.

**Verdict.** All 14 are fixed and none opens a bypass. Dropping the `receipt.to` check cannot let a forged event
verify, because every event match requires `log.address === contract`, and with I-3 that address must hold this
SDK's exact code.

| ID | Severity | Finding | Outcome | Covered by |
| --- | --- | --- | --- | --- |
| R-1 | Low | L-3's fix made a fallback `--rpc` that does not answer fatal, after 15 to 90 s, so a dead backup took down a healthy primary. | Fixed. A URL that does not answer is left out with a warning; one that serves another chain still stops the command; it fails only when none answers. | `common.test.ts` |
| R-2 | Info | I-3's code check was only in `verify` and `bond status`, so a look-alike could make `finality status` exit 0. | Fixed. Every CLI command that reads or writes a contract checks its code (`hasKnownCode`). An override that places code skips it and says "simulated". Library functions do not check: the caller chooses the address. | The look-alike e2e tests |
| R-3 | Info | A PoP given up after the retry window went into `done`, so a later block carrying it again (a reorg re-mining it) was ignored. | Fixed. Given up means forgotten, not done. | `watch.test.ts` |
| R-4 | Info | A PoP whose keystone the Hemi RPC had not served yet was dropped silently. | Fixed. Retried within the same window, with a log line. | `watch.test.ts` |
| R-5 | Info | One failed request, such as a 404 from a lagging Esplora fallback, ended `watch`. | Fixed. A failure ends that pass only; scanned heights and waiting outputs are kept. | `watch.test.ts` |
| R-6 | Info | Only `done` was bounded; the keystone cache and the stats lists grew for ever. | Fixed. The cache keeps 1,000 entries and each stats list its newest 1,000. | `watch.test.ts` (`remember`) |
| R-7 | Info | After a no-op, L-4's re-check and the file read used different blocks, so a further tip move could make `recordFact` throw. | Fixed. Both use one block (`CheckOptions.blockNumber`). A residual is kept: see [What stays open](#what-stays-open). | The "L-4" test in `facts.e2e.test.ts` |
| R-8 | Info | L-5's two call sites, I-7's call sites and the `done` cap had no test. | Fixed. Tests with two PoP outputs, for the Esplora name, for the CLI's error line and for `remember`. | `finality.e2e.test.ts`, `common.test.ts` |
| R-9 | Info | Two doc comments were displaced by inserted code, and the record called the non-answering case a usage error. | Fixed. | Reading |
| R-10 | Info | I-3 pinned one runtime per contract, so after a v2 a newer SDK would refuse every v1 fact. | Fixed. Each contract has a list of accepted runtimes (`*_RUNTIMES`, one entry each today). | Every e2e `verify` |

### Pre-mainnet fixes, first follow-up

| ID | Severity | Finding | Outcome | Covered by |
| --- | --- | --- | --- | --- |
| N-1 | Low | R-5's fix had no per-output isolation. An output that threw the same way every pass (a PoP output at vout 65,536, which viem cannot encode as `uint16`) stopped every later publication for good, while the process stayed up. | Fixed. Outputs past vout 65,535 are ignored when their block is scanned. A throwing output goes to the back of the queue and is given up after `WATCH_MAX_FAILURES` (5) failures, as P-1 refined. | `watch.test.ts` |
| N-2 | Info | A send that failed after it went out was sent again every pass. | Fixed. Bounded per output and per keystone's checkpoint, as P-1 and P-2 refined. | `watch.test.ts` |
| N-3 | Info | R-4's fix held a forged PoP for a far-future keystone for the whole window and logged it every pass. | Fixed. A keystone more than `WATCH_LAG_BLOCKS` (300) past the RPC's newest block is dropped at once; a retried output is logged once. | `watch.test.ts` |
| N-4 | Info | The runtime lists also gated `bond create` and the write commands, so after a v2 the SDK would lock BTC for, or send to, a v1 deployment. | Fixed. Writes and the registry check require this build's runtime exactly; the lists are for `verify` and reads. | The look-alike e2e tests |
| N-5 | Info | A hanging fallback still cost about 30 s; with the first URL dead a fallback picked the chain; `bond create` warned that a dead URL was left out, then failed on it. | Fixed. Fallbacks get two 5-second probes. Without `--chain-id` the first URL sets the chain and must answer. `bond create` checks the URLs the connection kept. A residual is kept: see [What stays open](#what-stays-open). | `common.test.ts` |
| N-6 | Info | The summary printed the capped list lengths as counts. | Fixed. `WatchStats.totals`. | `watch.test.ts` |

Found while fixing these: `redactUrls` printed a URL followed by punctuation in running text as `<invalid URL>`. It
now cuts by pattern and keeps the punctuation, with unit cases in `common.test.ts`.

### Pre-mainnet fixes, second follow-up

| ID | Severity | Finding | Outcome | Covered by |
| --- | --- | --- | --- | --- |
| P-1 | Low | N-1's give-up counted failing passes, not evidence that the output was at fault, and ignored M-2's window. A partial outage gave every waiting publication up for good after 5 passes each, bringing back M-2's outcome. | Fixed. A failing output backs off 1, 2, 4, … up to 32 passes (`WATCH_MAX_BACKOFF`), a success clears its count, and it is given up only after 5 failures in a row and once past the retry window. | `watch.test.ts` |
| P-2 | Info | The checkpoint cap skipped a keystone for good on failures unrelated to it, such as an account out of gas. | Fixed. A failing checkpoint keeps its place and backs off; it is left behind only when it leaves the block-hash window. | `watch.test.ts` |
| P-3 | Info | `redactUrls` ended the credentials at the first `@`, so a password holding one printed its tail, and an IPv6 host printed as `http://[`. | Fixed. The credentials run to the last `@` before the path, and an IPv6 literal is a host. | `common.test.ts` |

### Pre-mainnet fixes, final check

The last follow-up found P-1 to P-3 fixed and nothing of Low or higher open. Its Info notes: a raw `'` in the
credentials or path ended the `redactUrls` match, an IPv6 zone id was not matched, and a checkpoint-failure entry was
left behind when a timed-out send turned out mined. All three were fixed, with unit cases. One behaviour is kept: see
[What stays open](#what-stays-open).

## Final pre-deploy review

**Scope.** The build and the deployment script just before deployment, for a permanent deployment. Read-only on
mainnet.

**Verdict: GO**, with no blocker. It checked:
- **Reviewed code.** Nothing under `contracts/` changed after the pre-mainnet fixes, every change to `contracts/src`
  or `contracts/script` falls in a reviewed round, and every Low in every round is fixed.
- **Bytes.** A default-profile build reproduces the three pins and the README's addresses, and `sdk_vs_build.py`
  reports ALL MATCH. Creating each contract by `eth_call` on mainnet gives forge's `deployedBytecode`. The runtimes
  hold no SELFDESTRUCT, DELEGATECALL, CALL, CALLCODE or CREATE.
- **Script.** Exactly three CREATE2 calls. An unpinned build is refused, the chain id must be the RPC's, 43111 needs
  `CONFIRM_MAINNET_DEPLOY=yes`, and an address that already has code is skipped. A rehearsal on a local fork was
  refused without the confirmation, then deployed the build's code at each address, and a rerun skipped all three.
- **Mainnet, read-only.** Chain 43111, the standard deterministic deployer, the three addresses empty, node
  `539f4e33`, and a cost estimate for funding the signer.
- **Tests.** `forge test` 284 passed and 2 opt-in skipped, the opt-in deploy-guard suite 6 passed, and
  `check-live.sh mainnet` passed.
- **Constants and hazards.** Precompile addresses and gas, the EIP-2935 window (a hash at 8,191 blocks, a revert at
  8,192), the runtime chain id in the tag, `MIN_SATS`, the confirmation thresholds and the keystone bounds are as
  specified. There is no admin, pause, payable function or state that could brick a contract.

Its notes, none blocking: `isBtcAnchored` becomes permanent, forgeable ABI; the contracts are fixed to today's hVM;
delete the preview's dry-run directory if the preview is run; a rate-limited broadcast is safe to rerun; Blockscout
source verification must use the no-metadata settings, or the verified bytecode will not match.

## What stays open

No finding of Low or higher is open. These Info items were kept on purpose:

| From | Item | Why it is kept |
| --- | --- | --- |
| Internal review 1, independent audit 4 | `isBtcAnchored` reads K's best publication and is forgeable for one Bitcoin fee. | It is documented as "anchored", not Hemi PoP finality. Use `isBtcFinalVia` on a publication whose 76 bytes were checked off chain, as `hbf finality status` does. |
| Internal review 6, 7, 8 | Sighash types, on-curve keys and the lag of hVM's view are not checked on chain. | Mainnet's hVM strips witnesses, the curve is checked by the SDK only, and the lag is hVM's own. See [What the tag and the thresholds do not cover](#what-the-tag-and-the-thresholds-do-not-cover). |
| Internal review 10 | The contracts are frozen to today's hVM. | They are not upgradeable. A repricing above twice today's gas, or a change in byte meanings, needs a new deployment, and bond tags name the FidelityBonds address. |
| Delta review 3 | After the best fails, the next valid submission becomes the best whatever its count. | It heals when the better entry is re-submitted, and `isBtcFinalVia` is unaffected. |
| Fix review 2, F-2 | A simulation previews no transactions; the separate preview leaves a dry-run sequence that `--resume` would send. | Documented in the README's deploy steps, which say to delete that directory. |
| Independent audit 3 | Ended is permanent. | It errs on the side of "not live". |
| Review of the audit fixes, R-2 | Live can be wrong while Hemi's clock lags real time, or Bitcoin's median time past runs ahead of it. | Documented; keep a margin before the locktime. |
| Review of the pre-mainnet fixes, R-2 | The SDK's library functions do not check the code at an address. | A library caller chooses its own address. The CLI checks. |
| Review of the pre-mainnet fixes, R-7 | hVM's answer is live whatever the block, so a second tip move can still make `recordFact` say "run record again". | It never returns a wrong file. |
| Pre-mainnet fixes, N-5 | With `--chain-id`, a first `--rpc` that hangs rather than refuses still takes its full retries, about 82 s. | A delay only; the other URLs then serve. |
| Pre-mainnet fixes, final check | If the Bitcoin tip Esplora reports stops moving, an output whose send always fails is sent once every 32 passes. | The rate is bounded, and the transient-verdict window behaves the same way then. |

## Rerunning the checks

The suites, from `contracts/` and `sdk/`. The four `*ForkTest` suites and the SDK's e2e suites read Hemi mainnet's
public RPC, rate-limited.

```
cd contracts
forge build
forge test                                                     # every suite, fork tests included
forge test --no-match-contract ForkTest                        # no network
FOUNDRY_FUZZ_RUNS=20000 forge test --no-match-contract ForkTest
REVIEW_FIX_ENV_TESTS=true forge test --match-contract FixDeployTest -j 1   # the two opt-in deploy-guard tests
forge test --match-path 'test/review/**/*.t.sol'               # the internal reviews' suites
forge test --match-path 'test/audit/*.t.sol'                   # the two audits' suites

cd ../sdk
npm run typecheck
npm test                                                       # unit and e2e, on an anvil fork of Hemi mainnet
HBF_E2E_NO_FORK=1 npm test                                     # offline
node --import tsx --test test/watch.test.ts                    # the watch() harness from the pre-mainnet review

cd ..
python3 -I contracts/test/review/fix/sdk_vs_build.py . contracts/out   # SDK init code, runtime and ABI vs the build
python3 -I contracts/test/review/fix/genesis.py                        # the genesis txids of all five networks
regtest/run.sh                                                 # bond create and redeem on a local bitcoind (Docker)
./check-live.sh mainnet                                        # read-only, against the real precompiles
```

The pins and addresses, as the reviews re-derived them after each change (from `contracts/`, default profile):

```
for C in BitcoinFacts PopFinality FidelityBonds; do
  IC=$(forge inspect "$C" bytecode)
  echo "$C $(cast keccak "$IC") $(cast create2 --deployer 0x4e59b44847b379578588920cA78FbF26c0B4956C \
    --salt "$(cast keccak "hemi-bitcoin-facts/$C/v1")" --init-code "$IC")"
done
```

Read-only reads of Hemi mainnet, paced well under the public RPC's limit. Nothing is signed or sent:

```
bash contracts/test/review/live-review.sh          # internal review, about 55 requests
bash contracts/test/review/delta/live-delta.sh     # delta review, about 18 requests
```

The deploy-script checks run on local anvils only. Each script refuses any RPC that is not a local anvil, uses
anvil's unlocked first account (no key is read), and builds and writes broadcast files in a temporary directory.
Start each anvil in its own terminal, fresh for each run:

```
anvil --port 18546 --chain-id 43111
bash contracts/test/review/delta/deploy-bypass.sh http://127.0.0.1:18546        # delta review finding 1
anvil --port 18611 --chain-id 43111
bash contracts/test/review/fix/fix-deploy-anvil.sh http://127.0.0.1:18611       # fix review: every path, A1 to C3
anvil --port 18613 --chain-id 43111
bash contracts/test/review/fix/fix-resume-anvil.sh http://127.0.0.1:18613       # --resume does not rerun the script
anvil --port 18621 --chain-id 43111     # one fresh anvil per section: D1, D3, D5 and E on 43111, T on 743111
bash contracts/test/review/fix/fix-guard-bypass-anvil.sh http://127.0.0.1:18621 D1   # fix review F-1 and F-2
anvil --port 18641 --chain-id 43111
anvil --port 18642 --chain-id 43111
bash contracts/test/review/fix/fix-resume-norpc-anvil.sh http://127.0.0.1:18641 http://127.0.0.1:18642

cd contracts       # the two probe scripts, against any of those anvils
forge script test/review/fix/RpcChainIdGuard.s.sol --rpc-url http://127.0.0.1:<port> --chain 1
forge script test/review/fix/ContextProbe.s.sol --rpc-url http://127.0.0.1:<port>
```

These two start their own anvils:

```
bash contracts/test/review/audit-fixes/fork-clock-anvil.sh       # R-1: a local fork of Hemi mainnet, read lazily
bash contracts/test/review/audit-fixes/followup-r5-r7-anvil.sh   # R-5 to R-7: three non-fork anvils (after forge build)
```

Related records: [DECISIONS.md](DECISIONS.md) (D-014 the spend rule, D-023 why PopFinality keeps every publication,
D-024 the pinned build, D-025 the deployment), [SCHEMA.md](SCHEMA.md) for the fact files and what each verdict means,
and the [README](../README.md) for the limits a consumer should know.
