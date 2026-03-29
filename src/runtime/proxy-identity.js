import fs from "node:fs";
import path from "node:path";
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";

const runtimeDir = path.join(process.cwd(), ".runtime");
const identityFile = path.join(runtimeDir, "proxy-identity.json");

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function canonicalJwkThumbprintInput(jwk) {
  return JSON.stringify({
    crv: jwk.crv,
    kty: jwk.kty,
    x: jwk.x,
    y: jwk.y,
  });
}

export function computeJwkThumbprint(jwk) {
  return createHash("sha256")
    .update(canonicalJwkThumbprintInput(jwk))
    .digest("base64url");
}

function buildIdentityRecord() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
    publicKeyEncoding: { format: "pem", type: "spki" },
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
  });

  const publicJwk = createPublicKey(publicKey).export({ format: "jwk" });
  const thumbprint = computeJwkThumbprint(publicJwk);

  return {
    publicKeyPem: publicKey,
    privateKeyPem: privateKey,
    publicJwk,
    thumbprint,
    generatedAt: new Date().toISOString(),
  };
}

export function loadProxyIdentity() {
  fs.mkdirSync(runtimeDir, { recursive: true });

  if (!fs.existsSync(identityFile)) {
    const record = buildIdentityRecord();
    fs.writeFileSync(identityFile, JSON.stringify(record, null, 2));
    return record;
  }

  return JSON.parse(fs.readFileSync(identityFile, "utf8"));
}

export function getProxyIdentityPath() {
  return identityFile;
}
