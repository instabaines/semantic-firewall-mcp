import jwt from "jsonwebtoken";

// Shared passport contract for any orchestrator or proxy implementation.
export function issueIntentPassport({
  prompt,
  summary,
  rationale,
  intentType,
  toolScopes,
  resources,
  sessionId,
  config,
  ttlSeconds = 900,
}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: sessionId,
    summary,
    rationale,
    intent_type: intentType,
    prompt,
    tool_scopes: toolScopes,
    resource_indicators: resources,
    passport_type: "contextual-passport",
    iat: now,
    nbf: now,
    exp: now + ttlSeconds,
  };

  const token = jwt.sign(payload, config.jwtSecret, {
    issuer: config.issuer,
    audience: config.audience,
    algorithm: "HS256",
  });

  return { token, payload };
}

export function verifyIntentPassport(token, config) {
  return jwt.verify(token, config.jwtSecret, {
    issuer: config.issuer,
    audience: config.audience,
    algorithms: ["HS256"],
  });
}

export function extractIntentToken(request) {
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length);
  }

  return request.body?.meta?.intentPassport || request.body?.params?.meta?.intentPassport;
}
