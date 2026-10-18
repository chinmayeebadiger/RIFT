import { createHash } from "node:crypto";
import type { EvidenceItem, JsonValue, Sha256Hash } from "./contracts.js";

/**
 * Serialise JSON values with object keys in lexical order. JSON.stringify's
 * insertion-order behaviour is not a sufficient identity function because two
 * equivalent objects can be assembled in different orders.
 */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Cannot hash a non-finite JSON number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  const object = value as { readonly [key: string]: JsonValue };
  const keys = Object.keys(object).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

export function sha256(value: JsonValue): Sha256Hash {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

/** Hash just the evidence payload, useful when hashing an imported artifact. */
export function hashContent(content: JsonValue): Sha256Hash {
  return sha256(content);
}

/**
 * Hash an EvidenceItem as specified by the shared VersionedContract: the
 * contentHash field itself is excluded from the payload being hashed.
 */
export function computeEvidenceHash(item: Omit<EvidenceItem, "contentHash">): Sha256Hash {
  return sha256(item as unknown as JsonValue);
}

export const calculateEvidenceContentHash = computeEvidenceHash;

export function withEvidenceHash(
  item: Omit<EvidenceItem, "contentHash">,
): EvidenceItem {
  return { ...item, contentHash: computeEvidenceHash(item) };
}
