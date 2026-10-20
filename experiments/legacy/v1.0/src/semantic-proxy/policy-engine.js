const HIGH_RISK_KEYWORDS = [
  "delete",
  "drop",
  "destroy",
  "truncate",
  "shutdown",
  "exfiltrate",
  "export_secrets",
  "wipe",
  "export_customer_emails",
];

// Shared policy helpers used by the Semantic Proxy.
export function checkToolScope(passport, toolName) {
  return Array.isArray(passport.tool_scopes) && passport.tool_scopes.includes(toolName);
}

export function isHighRiskTool(toolName) {
  const normalized = String(toolName || "").toLowerCase();
  return HIGH_RISK_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

export function buildPolicyContext(passport, toolCall) {
  return {
    userIntent: passport.summary,
    intentType: passport.intent_type,
    originalPrompt: passport.prompt,
    toolName: toolCall.name,
    toolArgs: toolCall.arguments,
    allowedScopes: passport.tool_scopes,
    resources: passport.resource_indicators,
  };
}

export function extractTargetResources(toolCall) {
  const args = toolCall.arguments || {};
  const resources = [];

  if (args.resourceUri) {
    resources.push(args.resourceUri);
  }

  if (args.datasetId) {
    resources.push(`demo://datasets/${args.datasetId}`);
  }

  if (args.reportId) {
    resources.push(`demo://reports/${args.reportId}`);
  }

  return resources;
}

export function checkResourceBinding(passport, toolCall) {
  const allowed = Array.isArray(passport.resource_indicators) ? passport.resource_indicators : [];
  const targets = extractTargetResources(toolCall);

  if (targets.length === 0 || allowed.length === 0) {
    return true;
  }

  return targets.every((target) => allowed.includes(target));
}
