import { createHash } from "node:crypto";
import jwt from "jsonwebtoken";

export const PASSPORT_ALGORITHM = "ES256";

// Shared passport contract for any orchestrator or proxy implementation.
//
// The passport is signed with the orchestrator's private key (ES256) so that
// verifiers (proxy, protected server) hold only the public key and cannot mint
// passports themselves. The raw user prompt is not embedded: JWTs are signed,
// not encrypted, so only its SHA-256 digest travels for audit correlation.
export function issueIntentPassport({
  prompt,
  summary,
  rationale,
  intentType,
  toolScopes,
  resources,
  sessionId,
  scopeSource = "derived",
  config,
  ttlSeconds = config.passportTtlSeconds,
}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: sessionId,
    jti: crypto.randomUUID(),
    summary,
    rationale,
    intent_type: intentType,
    prompt_sha256: createHash("sha256").update(String(prompt || "")).digest("base64url"),
    tool_scopes: toolScopes,
    scope_source: scopeSource,
    resource_indicators: resources,
    passport_type: "contextual-passport",
    cnf: {
      jkt: config.senderConstraint.thumbprint,
    },
    iat: now,
    nbf: now,
    exp: now + ttlSeconds,
  };

  const token = jwt.sign(payload, config.passportSigner.privateKeyPem, {
    issuer: config.issuer,
    audience: config.protectedResourceAudience,
    algorithm: PASSPORT_ALGORITHM,
    header: { typ: "intent-passport+jwt", alg: PASSPORT_ALGORITHM },
  });

  return { token, payload };
}

export function verifyIntentPassport(token, config, overrides = {}) {
  const passport = jwt.verify(token, config.passportSigner.publicKeyPem, {
    issuer: config.issuer,
    audience: overrides.audience || config.protectedResourceAudience,
    algorithms: [PASSPORT_ALGORITHM],
  });

  if (passport.passport_type !== "contextual-passport") {
    throw new Error("Not a contextual passport");
  }

  return passport;
}

export function extractIntentToken(request) {
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length);
  }

  if (Array.isArray(request.body)) {
    return undefined;
  }

  return request.body?.meta?.intentPassport || request.body?.params?.meta?.intentPassport;
}
