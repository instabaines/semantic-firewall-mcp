// Shared request/response contract for semantic inspection.
// `history` is the session's recent calls and (truncated) results, as observed
// by the proxy; it lets the judge accept values derived from earlier results.
export function createInspectionRequest({ passport, toolCall, history = [] }) {
  return {
    userIntent: passport.summary,
    intentType: passport.intent_type,
    tool: toolCall,
    allowedScopes: passport.tool_scopes,
    resources: passport.resource_indicators,
    history,
  };
}

export const INSPECTION_RESPONSE_KEYS = [
  "violation",
  "confidence",
  "reason",
  "latencyMs",
];

// Validates an inspector verdict. Anything malformed is treated as a failure so
// the caller can fail closed rather than reading `undefined` as "no violation".
export function parseInspectionResponse(body) {
  if (!body || typeof body !== "object") {
    throw new Error("Inspector returned a non-object response");
  }
  if (typeof body.violation !== "boolean") {
    throw new Error("Inspector response is missing a boolean `violation`");
  }
  const confidence = Number(body.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("Inspector response has an invalid `confidence`");
  }
  return { ...body, confidence };
}
