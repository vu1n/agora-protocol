/**
 * Stealth address derivation using ECDH on secp256k1.
 *
 * Protocol (ERC-5564 compatible):
 *   1. Buyer generates ephemeral keypair (r, R = r·G)
 *   2. Shared secret: S = r · viewingPubKey
 *   3. Hashed secret: s = keccak256(S)
 *   4. Stealth pubkey: P = spendingPubKey + s·G
 *   5. Stealth address: addr(P)
 *   6. View tag: first byte of s (for fast scanning)
 */
import { keccak256, toHex, hexToBytes as viemHexToBytes, type Hex, type Address, getAddress } from "viem";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import type { StealthMetaAddress, StealthAddressResult } from "./types.js";

const CURVE_ORDER = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;

function strip0x(hex: Hex): string {
  return hex.startsWith("0x") ? hex.slice(2) : hex;
}

function hexToBytes(hex: Hex): Uint8Array {
  return viemHexToBytes(hex);
}

function pubKeyToAddress(pubKeyHex: string): Address {
  // Uncompressed pubkey is 04 || x(32 bytes) || y(32 bytes). Skip the 04 prefix.
  const xy = pubKeyHex.startsWith("04") ? pubKeyHex.slice(2) : pubKeyHex;
  const hash = keccak256(("0x" + xy) as Hex);
  return getAddress("0x" + hash.slice(26)) as Address;
}

/** Generate a fresh stealth address for a payment to the given meta-address. */
export function deriveStealthAddress(
  meta: StealthMetaAddress,
): StealthAddressResult {
  const ephPriv = secp256k1.utils.randomSecretKey();
  const ephPub = secp256k1.getPublicKey(ephPriv, false);

  // ECDH: shared secret = ephPriv · viewingPubKey
  const shared = secp256k1.getSharedSecret(ephPriv, hexToBytes(meta.viewingPubKey), false);
  const hashedSecret = keccak256(toHex(shared));
  const viewTag = parseInt(hashedSecret.slice(2, 4), 16);

  // Stealth pubkey: spendingPubKey + hashedSecret·G
  const spendPoint = secp256k1.Point.fromHex(strip0x(meta.spendingPubKey));
  const offset = secp256k1.Point.BASE.multiply(BigInt(hashedSecret) % CURVE_ORDER);
  const stealthPoint = spendPoint.add(offset);
  const stealthAddress = pubKeyToAddress(stealthPoint.toHex(false));

  return {
    stealthAddress,
    ephemeralPubKey: toHex(ephPub),
    viewTag,
  };
}

/** Check if a stealth address belongs to us (merchant scanning). */
export function checkStealthAddress(
  ephemeralPubKey: Hex,
  viewTag: number,
  viewingPrivKey: Hex,
  spendingPubKey: Hex,
): { match: boolean; stealthAddress?: Address } {
  const shared = secp256k1.getSharedSecret(hexToBytes(viewingPrivKey), hexToBytes(ephemeralPubKey), false);
  const hashedSecret = keccak256(toHex(shared));

  if (parseInt(hashedSecret.slice(2, 4), 16) !== viewTag) {
    return { match: false };
  }

  const spendPoint = secp256k1.Point.fromHex(strip0x(spendingPubKey));
  const offset = secp256k1.Point.BASE.multiply(BigInt(hashedSecret) % CURVE_ORDER);
  const stealthPoint = spendPoint.add(offset);
  const stealthAddress = pubKeyToAddress(stealthPoint.toHex(false));

  return { match: true, stealthAddress };
}

/** Generate a stealth meta-address keypair for a merchant. */
export function generateStealthKeys(): {
  spendingPrivKey: Hex;
  viewingPrivKey: Hex;
  meta: StealthMetaAddress;
} {
  const spendPriv = secp256k1.utils.randomSecretKey();
  const viewPriv = secp256k1.utils.randomSecretKey();

  return {
    spendingPrivKey: toHex(spendPriv),
    viewingPrivKey: toHex(viewPriv),
    meta: {
      spendingPubKey: toHex(secp256k1.getPublicKey(spendPriv, false)),
      viewingPubKey: toHex(secp256k1.getPublicKey(viewPriv, false)),
    },
  };
}

// ── Receipt encryption (reuses stealth ECDH with domain separation) ──

import { xchacha20poly1305 } from "@noble/ciphers/chacha";

/**
 * Derive an encryption key from ECDH shared secret with domain separation.
 * Uses a different domain than stealth address derivation to prevent key reuse.
 */
function deriveReceiptKey(privKey: Hex, pubKey: Hex): Uint8Array {
  const shared = secp256k1.getSharedSecret(hexToBytes(privKey), hexToBytes(pubKey), false);
  // Domain-separated: "agora-receipt" distinguishes from stealth address derivation
  const domain = new TextEncoder().encode("agora-receipt");
  const input = new Uint8Array([...shared, ...domain]);
  return hexToBytes(keccak256(toHex(input)));
}

/**
 * Encrypt a receipt for a specific buyer.
 * Uses XChaCha20-Poly1305 (AEAD) with a domain-separated ECDH key.
 *
 * Merchant calls this after detecting a stealth payment.
 * The encrypted receipt is served at GET /receipts/{ephemeralPubKey}.
 */
export function encryptReceipt(
  receipt: string,
  merchantViewingPrivKey: Hex,
  buyerEphemeralPubKey: Hex,
): { encrypted: Hex; nonce: Hex } {
  const key = deriveReceiptKey(merchantViewingPrivKey, buyerEphemeralPubKey);
  const nonce = crypto.getRandomValues(new Uint8Array(24)); // XChaCha20 uses 24-byte nonce
  const plaintext = new TextEncoder().encode(receipt);

  const cipher = xchacha20poly1305(key, nonce);
  const ciphertext = cipher.encrypt(plaintext);

  return { encrypted: toHex(ciphertext), nonce: toHex(nonce) };
}

/**
 * Decrypt a receipt using the buyer's ephemeral private key.
 * Throws if the ciphertext has been tampered with (Poly1305 auth tag check).
 *
 * Buyer calls this after fetching from GET /receipts/{ephemeralPubKey}.
 */
export function decryptReceipt(
  encrypted: Hex,
  nonce: Hex,
  buyerEphemeralPrivKey: Hex,
  merchantViewingPubKey: Hex,
): string {
  const key = deriveReceiptKey(buyerEphemeralPrivKey, merchantViewingPubKey);
  const cipher = xchacha20poly1305(key, hexToBytes(nonce));
  const plaintext = cipher.decrypt(hexToBytes(encrypted));

  return new TextDecoder().decode(plaintext);
}
