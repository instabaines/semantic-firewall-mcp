// Shared request/response contract for semantic inspection.
export function createInspectionRequest({ passport, toolCall }) {
  return {
    userIntent: passport.summary,
    originalPrompt: passport.prompt,
    tool: toolCall,
    allowedScopes: passport.tool_scopes,
    resources: passport.resource_indicators,
  };
}

export const INSPECTION_RESPONSE_KEYS = [
  "violation",
  "confidence",
  "reason",
  "latencyMs",
];

