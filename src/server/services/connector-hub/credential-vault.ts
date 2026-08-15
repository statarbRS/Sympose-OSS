import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const CONNECTOR_VAULT_KEY_ENV = "SYMPOSE_CONNECTOR_VAULT_KEY" as const;
export const CONNECTOR_SECRET_ALGORITHM = "aes-256-gcm" as const;
export const CONNECTOR_SECRET_KEY_VERSION = "aes-256-gcm-v1" as const;
export const CONNECTOR_SECRET_MASK = "••••••••" as const;
export const CONNECTOR_SECRET_MAX_BYTES = 4 * 1024;

const AES_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const ASSOCIATED_DATA_MAX_BYTES = 512;

export type ConnectorVaultErrorCode =
  | "CONNECTOR_VAULT_KEY_REQUIRED"
  | "CONNECTOR_VAULT_KEY_INVALID"
  | "CONNECTOR_SECRET_INVALID"
  | "CONNECTOR_SECRET_ENVELOPE_INVALID"
  | "CONNECTOR_SECRET_DECRYPT_FAILED";

export class ConnectorVaultError extends Error {
  readonly code: ConnectorVaultErrorCode;

  constructor(code: ConnectorVaultErrorCode) {
    super(code);
    this.name = "ConnectorVaultError";
    this.code = code;
  }
}

export interface EncryptedConnectorSecret {
  readonly algorithm: typeof CONNECTOR_SECRET_ALGORITHM;
  readonly keyVersion: typeof CONNECTOR_SECRET_KEY_VERSION;
  readonly iv: string;
  readonly ciphertext: string;
  readonly tag: string;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function decodeCanonicalBase64(value: unknown): Buffer | null {
  if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    return null;
  }
  const decoded = Buffer.from(value, "base64");
  return decoded.length > 0 && decoded.toString("base64") === value ? decoded : null;
}

function deploymentKey(): Buffer {
  const configured = process.env[CONNECTOR_VAULT_KEY_ENV]?.trim();
  if (!configured) {
    throw new ConnectorVaultError("CONNECTOR_VAULT_KEY_REQUIRED");
  }

  const encoded = configured.startsWith("hex:") || configured.startsWith("base64:")
    ? configured.slice(configured.indexOf(":") + 1)
    : configured;
  const key = configured.startsWith("hex:") || (!configured.startsWith("base64:") && /^[0-9a-f]{64}$/iu.test(encoded))
    ? /^[0-9a-f]{64}$/iu.test(encoded)
      ? Buffer.from(encoded, "hex")
      : null
    : decodeCanonicalBase64(encoded);

  if (!key || key.length !== AES_KEY_BYTES) {
    throw new ConnectorVaultError("CONNECTOR_VAULT_KEY_INVALID");
  }
  return key;
}

function assertAssociatedData(associatedData: string): void {
  if (
    typeof associatedData !== "string" ||
    Buffer.byteLength(associatedData, "utf8") < 1 ||
    Buffer.byteLength(associatedData, "utf8") > ASSOCIATED_DATA_MAX_BYTES ||
    associatedData.includes("\0")
  ) {
    throw new ConnectorVaultError("CONNECTOR_SECRET_INVALID");
  }
}

function assertSecret(secret: string): void {
  if (
    typeof secret !== "string" ||
    Buffer.byteLength(secret, "utf8") < 1 ||
    Buffer.byteLength(secret, "utf8") > CONNECTOR_SECRET_MAX_BYTES ||
    secret.includes("\0")
  ) {
    throw new ConnectorVaultError("CONNECTOR_SECRET_INVALID");
  }
}

/** Fail closed when the deployment has not supplied a 256-bit vault key. */
export function assertConnectorVaultConfigured(): void {
  const key = deploymentKey();
  key.fill(0);
}

/**
 * Seal a provider secret. The returned envelope contains no plaintext and is safe for the
 * connection ledger; this module deliberately exposes no plaintext readback operation.
 */
export function encryptConnectorSecret(
  secret: string,
  associatedData: string,
): EncryptedConnectorSecret {
  assertSecret(secret);
  assertAssociatedData(associatedData);

  const key = deploymentKey();
  const iv = randomBytes(GCM_IV_BYTES);
  try {
    const cipher = createCipheriv(CONNECTOR_SECRET_ALGORITHM, key, iv);
    cipher.setAAD(Buffer.from(associatedData, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    if (tag.length !== GCM_TAG_BYTES) {
      throw new ConnectorVaultError("CONNECTOR_SECRET_ENVELOPE_INVALID");
    }
    return {
      algorithm: CONNECTOR_SECRET_ALGORITHM,
      keyVersion: CONNECTOR_SECRET_KEY_VERSION,
      iv: iv.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: tag.toString("base64"),
    };
  } finally {
    key.fill(0);
  }
}

/**
 * Server-only provider execution boundary. The plaintext returned here must remain in the
 * authenticated server execution path; this function is intentionally not re-exported by the
 * connector hub index and is never used by client modules or connection summaries.
 */
export function decryptConnectorSecret(
  envelope: unknown,
  associatedData: string,
): string {
  assertAssociatedData(associatedData);
  if (!isEncryptedConnectorSecret(envelope)) {
    throw new ConnectorVaultError("CONNECTOR_SECRET_ENVELOPE_INVALID");
  }

  const key = deploymentKey();
  let plaintext: Buffer | null = null;
  try {
    const iv = decodeCanonicalBase64(envelope.iv);
    const ciphertext = decodeCanonicalBase64(envelope.ciphertext);
    const tag = decodeCanonicalBase64(envelope.tag);
    if (!iv || !ciphertext || !tag) {
      throw new ConnectorVaultError("CONNECTOR_SECRET_ENVELOPE_INVALID");
    }

    const decipher = createDecipheriv(CONNECTOR_SECRET_ALGORITHM, key, iv);
    decipher.setAAD(Buffer.from(associatedData, "utf8"));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (
      plaintext.length < 1
      || plaintext.length > CONNECTOR_SECRET_MAX_BYTES
      || plaintext.includes(0)
    ) {
      throw new ConnectorVaultError("CONNECTOR_SECRET_DECRYPT_FAILED");
    }
    const decoded = plaintext.toString("utf8");
    if (!Buffer.from(decoded, "utf8").equals(plaintext)) {
      throw new ConnectorVaultError("CONNECTOR_SECRET_DECRYPT_FAILED");
    }
    return decoded;
  } catch (error) {
    if (error instanceof ConnectorVaultError) {
      throw error;
    }
    // Do not expose OpenSSL errors, envelope material, AAD, or key details across this boundary.
    throw new ConnectorVaultError("CONNECTOR_SECRET_DECRYPT_FAILED");
  } finally {
    plaintext?.fill(0);
    key.fill(0);
  }
}

/** Validate only the encrypted envelope shape; never decrypt or return a secret. */
export function isEncryptedConnectorSecret(value: unknown): value is EncryptedConnectorSecret {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ["algorithm", "keyVersion", "iv", "ciphertext", "tag"])) return false;
  if (record.algorithm !== CONNECTOR_SECRET_ALGORITHM || record.keyVersion !== CONNECTOR_SECRET_KEY_VERSION) {
    return false;
  }
  const iv = decodeCanonicalBase64(record.iv);
  const ciphertext = decodeCanonicalBase64(record.ciphertext);
  const tag = decodeCanonicalBase64(record.tag);
  return iv?.length === GCM_IV_BYTES
    && ciphertext !== null
    && ciphertext.length > 0
    && ciphertext.length <= CONNECTOR_SECRET_MAX_BYTES
    && tag?.length === GCM_TAG_BYTES;
}
