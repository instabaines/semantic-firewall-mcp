import { extractIntentToken, verifyIntentPassport } from "../protocol/contextual-passport.js";
import { verifyDpopProof } from "../protocol/sender-constrained.js";

function protectedResourceUrl(config) {
  return `http://127.0.0.1:${config.protectedPort}/mcp`;
}

export function verifyProtectedResourceRequest({ config, request }) {
  const accessToken = extractIntentToken(request);
  if (!accessToken) {
    throw new Error("Missing passport token");
  }

  const passport = verifyIntentPassport(accessToken, config, {
    audience: config.protectedResourceAudience,
  });

  if (passport.aud !== config.protectedResourceAudience) {
    throw new Error("Audience mismatch");
  }

  if (!passport.cnf?.jkt) {
    throw new Error("Missing sender constraint");
  }

  const proof = request.headers.dpop;
  if (!proof) {
    throw new Error("Missing DPoP proof");
  }

  verifyDpopProof({
    proof,
    accessToken,
    method: request.method,
    url: protectedResourceUrl(config),
    expectedThumbprint: passport.cnf.jkt,
  });

  return {
    passport,
    audience: config.protectedResourceAudience,
    senderConstraintThumbprint: passport.cnf.jkt,
    dpopVerified: true,
  };
}
