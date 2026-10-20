import { createHash, createPublicKey } from "node:crypto";
import jwt from "jsonwebtoken";
import { computeJwkThumbprint } from "../runtime/proxy-identity.js";

function sha256base64url(value) {
  return createHash("sha256").update(value).digest("base64url");
}

// `bdh` binds the proof to the exact request body. Standard DPoP binds method,
// URL and token only; without the body hash, a proof observed on the
// proxy-server link can be used first with a different in-scope call, skipping
// inspection and approval (found by the Tamarin model, formal/).
export function createDpopProof({ config, accessToken, method, url, body }) {
  return jwt.sign(
    {
      htm: method.toUpperCase(),
      htu: url,
      ath: sha256base64url(accessToken),
      bdh: sha256base64url(body ?? ""),
      jti: crypto.randomUUID(),
      iat: Math.floor(Date.now() / 1000),
    },
    config.senderConstraint.privateKeyPem,
    {
      algorithm: "ES256",
      header: {
        typ: "dpop+jwt",
        alg: "ES256",
        jwk: config.senderConstraint.publicJwk,
      },
    },
  );
}

const DPOP_MAX_AGE_SECONDS = 120;

// Remembers proof identifiers for the acceptance window so a captured proof
// cannot be replayed. In-memory: a multi-instance deployment needs a shared store.
export class DpopReplayCache {
  constructor({ windowSeconds = DPOP_MAX_AGE_SECONDS * 2 } = {}) {
    this.windowMs = windowSeconds * 1000;
    this.seen = new Map();
  }

  checkAndRemember(jti) {
    const now = Date.now();
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt <= now) {
        this.seen.delete(key);
      }
    }
    if (this.seen.has(jti)) {
      return false;
    }
    this.seen.set(jti, now + this.windowMs);
    return true;
  }
}

export function verifyDpopProof({
  proof,
  accessToken,
  method,
  url,
  expectedThumbprint,
  replayCache,
  body,
}) {
  const decoded = jwt.decode(proof, { complete: true });
  if (!decoded?.header?.jwk) {
    throw new Error("Missing DPoP JWK");
  }

  const publicKey = createPublicKey({
    key: decoded.header.jwk,
    format: "jwk",
  });

  const claims = jwt.verify(proof, publicKey, {
    algorithms: ["ES256"],
  });

  if (decoded.header.typ !== "dpop+jwt") {
    throw new Error("Invalid DPoP typ");
  }

  if (claims.htm !== method.toUpperCase()) {
    throw new Error("DPoP method mismatch");
  }

  if (claims.htu !== url) {
    throw new Error("DPoP URL mismatch");
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(claims.iat || 0)) > DPOP_MAX_AGE_SECONDS) {
    throw new Error("DPoP proof expired");
  }

  if (claims.ath !== sha256base64url(accessToken)) {
    throw new Error("DPoP access-token hash mismatch");
  }

  if (typeof claims.bdh !== "string" || claims.bdh !== sha256base64url(body ?? "")) {
    throw new Error("DPoP body hash mismatch");
  }

  const thumbprint = computeJwkThumbprint(decoded.header.jwk);
  if (thumbprint !== expectedThumbprint) {
    throw new Error("DPoP key thumbprint mismatch");
  }

  if (replayCache) {
    if (typeof claims.jti !== "string" || !claims.jti) {
      throw new Error("DPoP proof missing jti");
    }
    if (!replayCache.checkAndRemember(claims.jti)) {
      throw new Error("DPoP proof replayed");
    }
  }

  return {
    claims,
    thumbprint,
    publicJwk: decoded.header.jwk,
  };
}
