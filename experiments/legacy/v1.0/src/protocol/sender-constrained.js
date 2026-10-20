import { createHash, createPublicKey } from "node:crypto";
import jwt from "jsonwebtoken";
import { computeJwkThumbprint } from "../runtime/proxy-identity.js";

function sha256base64url(value) {
  return createHash("sha256").update(value).digest("base64url");
}

export function createDpopProof({ config, accessToken, method, url }) {
  return jwt.sign(
    {
      htm: method.toUpperCase(),
      htu: url,
      ath: sha256base64url(accessToken),
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

export function verifyDpopProof({
  proof,
  accessToken,
  method,
  url,
  expectedThumbprint,
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
  if (Math.abs(now - Number(claims.iat || 0)) > 120) {
    throw new Error("DPoP proof expired");
  }

  if (claims.ath !== sha256base64url(accessToken)) {
    throw new Error("DPoP access-token hash mismatch");
  }

  const thumbprint = computeJwkThumbprint(decoded.header.jwk);
  if (thumbprint !== expectedThumbprint) {
    throw new Error("DPoP key thumbprint mismatch");
  }

  return {
    claims,
    thumbprint,
    publicJwk: decoded.header.jwk,
  };
}
