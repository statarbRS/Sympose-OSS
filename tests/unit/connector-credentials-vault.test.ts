import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CONNECTOR_VAULT_KEY_ENV,
  ConnectorVaultError,
  decryptConnectorSecret,
  encryptConnectorSecret,
} from "@/server/services/connector-hub/credential-vault";

const KEY_A = Buffer.alloc(32, 0x11).toString("base64");
const KEY_B = Buffer.alloc(32, 0x22).toString("base64");
const ASSOCIATED_DATA = "sympose-connector-connection/v1:workspace-vault:airtable";
const SECRET = "synthetic-airtable-api-secret-for-vault-tests";
const DECRYPT_FAILED = "CONNECTOR_SECRET_DECRYPT_FAILED";

function expectVaultCode(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error("expected vault failure");
  } catch (error) {
    expect(error).toBeInstanceOf(ConnectorVaultError);
    expect(error).toMatchObject({ code, message: code });
  }
}

describe("connector credential vault", () => {
  let previousKey: string | undefined;

  beforeEach(() => {
    previousKey = process.env[CONNECTOR_VAULT_KEY_ENV];
    process.env[CONNECTOR_VAULT_KEY_ENV] = KEY_A;
  });

  afterEach(() => {
    if (previousKey === undefined) {
      delete process.env[CONNECTOR_VAULT_KEY_ENV];
    } else {
      process.env[CONNECTOR_VAULT_KEY_ENV] = previousKey;
    }
  });

  it("round-trips only through the server vault and never exposes plaintext in the envelope", () => {
    const envelope = encryptConnectorSecret(SECRET, ASSOCIATED_DATA);

    expect(JSON.stringify(envelope)).not.toContain(SECRET);
    expect(envelope.ciphertext).not.toBe(SECRET);
    expect(decryptConnectorSecret(envelope, ASSOCIATED_DATA)).toBe(SECRET);
  });

  it("fails closed for a tampered ciphertext and malformed envelope", () => {
    const envelope = encryptConnectorSecret(SECRET, ASSOCIATED_DATA);
    const ciphertext = Buffer.from(envelope.ciphertext, "base64");
    ciphertext[0] ^= 0x01;

    expectVaultCode(
      () => decryptConnectorSecret({ ...envelope, ciphertext: ciphertext.toString("base64") }, ASSOCIATED_DATA),
      DECRYPT_FAILED,
    );
    expectVaultCode(
      () => decryptConnectorSecret({ ...envelope, tag: "not-base64" }, ASSOCIATED_DATA),
      "CONNECTOR_SECRET_ENVELOPE_INVALID",
    );
  });

  it("rejects an associated-data mismatch with a fixed decryption code", () => {
    const envelope = encryptConnectorSecret(SECRET, ASSOCIATED_DATA);
    expectVaultCode(
      () => decryptConnectorSecret(envelope, `${ASSOCIATED_DATA}:wrong`),
      DECRYPT_FAILED,
    );
  });

  it("rejects a wrong deployment key without exposing crypto errors", () => {
    const envelope = encryptConnectorSecret(SECRET, ASSOCIATED_DATA);
    process.env[CONNECTOR_VAULT_KEY_ENV] = KEY_B;

    expectVaultCode(
      () => decryptConnectorSecret(envelope, ASSOCIATED_DATA),
      DECRYPT_FAILED,
    );
  });

  it("requires the deployment key for decryption", () => {
    const envelope = encryptConnectorSecret(SECRET, ASSOCIATED_DATA);
    delete process.env[CONNECTOR_VAULT_KEY_ENV];

    expectVaultCode(
      () => decryptConnectorSecret(envelope, ASSOCIATED_DATA),
      "CONNECTOR_VAULT_KEY_REQUIRED",
    );
  });
});
