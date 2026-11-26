import { parseAbi } from "viem";

/**
 * ReceiptRegistry ABI. Written from docs/SCHEMA.md §5 and checked against the compiled
 * artifact by contracts/test/abi-parity.ts, so a drift fails the contract tests.
 */
export const receiptRegistryAbi = parseAbi([
  "struct Receipt { bytes32 runId; bytes32 manifestHash; address agent; address principal; uint16 schemaVersion; }",
  "struct Batch { bytes32 root; uint32 count; uint16 schemaVersion; bool voided; address serviceSigner; uint64 attestedAt; uint64 blockNumber; }",

  // writes
  "function attestBatch(bytes32 root, uint32 count, uint16 schemaVersion, uint64 deadline, bytes serviceSignature) returns (uint256 batchId)",
  "function attest(Receipt receipt, bytes agentSignature, uint64 deadline, bytes serviceSignature) returns (uint256 batchId)",

  // reads
  "function verifyInclusion(uint256 batchId, bytes32 leaf, bytes32[] proof) view returns (bool)",
  "function verifyReceipt(uint256 batchId, Receipt receipt, bytes32[] proof) view returns (bool)",
  "function leafHash(bytes32 runId, bytes32 manifestHash, address agent, address principal) pure returns (bytes32)",
  "function receiptDigest(Receipt receipt) view returns (bytes32)",
  "function serviceAttestationDigest(bytes32 receiptDigest, uint64 deadline) view returns (bytes32)",
  "function batchAttestationDigest(bytes32 root, uint32 count, uint16 schemaVersion, uint64 deadline) view returns (bytes32)",
  "function getBatch(uint256 batchId) view returns (Batch)",
  "function batchCount() view returns (uint256)",
  "function batchIdOfRoot(bytes32 root) view returns (uint256)",
  "function batchIdOfRun(bytes32 runId) view returns (uint256)",
  "function serviceSigner() view returns (address)",
  "function schemaVersionEnabled(uint16 version) view returns (bool)",
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function paused() view returns (bool)",
  "function MAX_DEADLINE_WINDOW() view returns (uint64)",
  "function MAX_BATCH_COUNT() view returns (uint32)",
  "function RECEIPT_TYPEHASH() view returns (bytes32)",
  "function SERVICE_ATTESTATION_TYPEHASH() view returns (bytes32)",
  "function BATCH_ATTESTATION_TYPEHASH() view returns (bytes32)",
  "function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)",

  // administration (owner only)
  "function pause()",
  "function unpause()",
  "function voidBatch(uint256 batchId, bytes32 expectedRoot, string reason)",
  "function setServiceSigner(address newSigner)",
  "function setSchemaVersionEnabled(uint16 version, bool enabled)",
  "function transferOwnership(address newOwner)",
  "function acceptOwnership()",
  "function renounceOwnership()",

  // events
  "event BatchAttested(uint256 indexed batchId, bytes32 indexed root, address indexed serviceSigner, uint32 count, uint16 schemaVersion)",
  "event ReceiptAttested(bytes32 indexed runId, address indexed agent, address indexed principal, bytes32 manifestHash, uint256 batchId, uint16 schemaVersion)",
  "event BatchVoided(uint256 indexed batchId, bytes32 indexed root, string reason)",
  "event ServiceSignerUpdated(address indexed previousSigner, address indexed newSigner)",
  "event SchemaVersionSet(uint16 indexed version, bool enabled)",
  "event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner)",
  "event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)",
  "event Paused(address account)",
  "event Unpaused(address account)",
  "event EIP712DomainChanged()",

  // errors
  "error InvalidServiceSigner()",
  "error InvalidReceipt()",
  "error InvalidBatch()",
  "error SchemaVersionDisabled(uint16 version)",
  "error ExpiredSignature(uint64 deadline)",
  "error DeadlineTooDistant(uint64 deadline)",
  "error DuplicateRun(bytes32 runId, uint256 batchId)",
  "error RootAlreadyAttested(bytes32 root, uint256 batchId)",
  "error InvalidAgentSignature()",
  "error InvalidServiceSignature()",
  "error UnknownBatch(uint256 batchId)",
  "error BatchAlreadyVoided(uint256 batchId)",
  "error VoidTargetMismatch(bytes32 stored, bytes32 expected)",
  "error RenounceDisabled()",
  "error EnforcedPause()",
  "error ExpectedPause()",
  "error OwnableUnauthorizedAccount(address account)",
  "error OwnableInvalidOwner(address owner)",
  "error InvalidShortString()",
  "error StringTooLong(string str)",
]);
