export const POLICY_EVENT_TYPES = {
  PASSPORT_ISSUED: "intent.passport_issued",
  TOOL_REQUESTED: "proxy.tool_requested",
  RPC_PASSTHROUGH: "proxy.rpc_passthrough",
  DENIED: "proxy.denied",
  FORWARDED: "proxy.forwarded",
  APPROVAL_CREATED: "approval.created",
  APPROVAL_RESOLVED: "approval.resolved",
  TOOL_EXECUTED: "mcp.tool_executed",
};

export function createPolicyEvent(type, payload) {
  return {
    type,
    payload,
  };
}

