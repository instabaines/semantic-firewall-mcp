// Shared policy helpers used by the Semantic Proxy.

// Per-tool policy metadata. `resourceArgs` declares which arguments name a
// protected resource and how to turn them into a resource indicator URI.
// Tools absent from this registry are never forwarded.
export const TOOL_POLICY = {
  list_datasets: { resourceArgs: {}, highRisk: false },
  list_reports: { resourceArgs: {}, highRisk: false },
  get_dataset_overview: { resourceArgs: { datasetId: datasetUri }, highRisk: false },
  read_dataset_rows: { resourceArgs: { datasetId: datasetUri }, highRisk: false },
  generate_report: { resourceArgs: { datasetId: datasetUri }, highRisk: false },
  export_customer_emails: { resourceArgs: { datasetId: datasetUri }, highRisk: true },
  delete_dataset: { resourceArgs: { datasetId: datasetUri }, highRisk: true },
};

// MCP methods that carry no tool side effects and may pass after passport
// verification. Everything not listed here (and not handled explicitly) is denied.
export const PASSTHROUGH_METHODS = new Set([
  "initialize",
  "ping",
  "tools/list",
  "resources/list",
  "resources/templates/list",
  "prompts/list",
]);

const URI_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

function datasetUri(value) {
  return `demo://datasets/${value}`;
}

export function isKnownTool(toolName) {
  return Object.hasOwn(TOOL_POLICY, String(toolName));
}

export function checkToolScope(passport, toolName) {
  return isKnownTool(toolName)
    && Array.isArray(passport.tool_scopes)
    && passport.tool_scopes.includes(toolName);
}

export function isHighRiskTool(toolName) {
  return Boolean(TOOL_POLICY[toolName]?.highRisk);
}

export function buildPolicyContext(passport, toolCall) {
  return {
    userIntent: passport.summary,
    intentType: passport.intent_type,
    toolName: toolCall.name,
    toolArgs: toolCall.arguments,
    allowedScopes: passport.tool_scopes,
    resources: passport.resource_indicators,
  };
}

function collectUris(value, out) {
  if (typeof value === "string") {
    if (URI_PATTERN.test(value.trim())) {
      out.push(value.trim());
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectUris(item, out));
    return;
  }
  if (value && typeof value === "object") {
    Object.values(value).forEach((item) => collectUris(item, out));
  }
}

// Declared resource arguments plus any URI-shaped value anywhere in the arguments,
// so a resource cannot be smuggled in under an undeclared argument name.
export function extractTargetResources(toolCall) {
  const args = toolCall.arguments || {};
  const declared = TOOL_POLICY[toolCall.name]?.resourceArgs || {};
  const resources = [];

  for (const [argName, toUri] of Object.entries(declared)) {
    if (args[argName] !== undefined) {
      resources.push(toUri(String(args[argName])));
    }
  }

  collectUris(args, resources);
  return [...new Set(resources)];
}

// Fails closed: a call that targets a resource is denied when the passport binds
// no resources at all.
export function checkResourceBinding(passport, toolCall) {
  const allowed = Array.isArray(passport.resource_indicators) ? passport.resource_indicators : [];
  const targets = extractTargetResources(toolCall);

  if (targets.length === 0) {
    return true;
  }

  return targets.every((target) => allowed.includes(target));
}

export function checkResourceReadBinding(passport, uri) {
  const allowed = Array.isArray(passport.resource_indicators) ? passport.resource_indicators : [];
  return typeof uri === "string" && allowed.includes(uri);
}
