import fs from "node:fs";
import path from "node:path";
import { createHash, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";

const runtimeDir = path.join(process.cwd(), ".runtime");

function canonicalJwkThumbprintInput(jwk) {
  return JSON.stringify({
    crv: jwk.crv,
    kty: jwk.kty,
    x: jwk.x,
    y: jwk.y,
  });
}

// RFC 7638 thumbprint for EC P-256 keys.
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

function readOrCreate(fileName, create) {
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const file = path.join(runtimeDir, fileName);

  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }

  const record = create();
  fs.writeFileSync(file, JSON.stringify(record, null, 2), { mode: 0o600 });
  return record;
}

// Loads (or creates) a named ES256 key pair under .runtime/.
// In a real deployment each component would hold only its own private key
// and receive peers' public keys out of band.
export function loadIdentity(name) {
  return readOrCreate(`${name}.json`, buildIdentityRecord);
}

// Proxy key used for DPoP-style sender-constrained proofs.
export function loadProxyIdentity() {
  return loadIdentity("proxy-identity");
}

// Orchestrator key used to sign Contextual Passports.
export function loadPassportSigner() {
  return loadIdentity("orchestrator-signing");
}

// Random bearer secrets for the orchestrator client (the trusted user front end)
// and the human approver. The agent process must not be given either.
export function loadRuntimeSecrets() {
  return readOrCreate("secrets.json", () => ({
    orchestratorClientToken: randomBytes(24).toString("base64url"),
    approverToken: randomBytes(24).toString("base64url"),
    generatedAt: new Date().toISOString(),
  }));
}

export function getProxyIdentityPath() {
  return path.join(runtimeDir, "proxy-identity.json");
}
