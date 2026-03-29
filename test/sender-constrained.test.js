import { describe, expect, it } from "vitest";
import { config as baseConfig } from "../src/runtime/config.js";
import { issueIntentPassport } from "../src/protocol/contextual-passport.js";
import { createDpopProof } from "../src/protocol/sender-constrained.js";
import { verifyProtectedResourceRequest } from "../src/protected-resource/auth.js";

const config = {
  ...baseConfig,
  protectedPort: 5991,
  protectedResourceAudience: "mcp-server-sales-production",
  passportTtlSeconds: 300,
};

function issuePassport(overrides = {}) {
  return issueIntentPassport({
    prompt: "Generate a revenue report for sales-q1.",
    summary: "Generate a revenue report for sales-q1.",
    rationale: "test",
    intentType: "report",
    toolScopes: ["generate_report"],
    resources: ["demo://datasets/sales-q1"],
    sessionId: overrides.sessionId || "test-session",
    config: {
      ...config,
      ...(overrides.config || {}),
    },
  }).token;
}

function requestWithProof(token, proof) {
  return {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      ...(proof ? { dpop: proof } : {}),
    },
  };
}

describe("sender-constrained passports", () => {
  it("accepts a valid audience-bound token with a matching DPoP proof", () => {
    const token = issuePassport();
    const proof = createDpopProof({
      config,
      accessToken: token,
      method: "POST",
      url: `http://127.0.0.1:${config.protectedPort}/mcp`,
    });

    const authContext = verifyProtectedResourceRequest({
      config,
      request: requestWithProof(token, proof),
    });

    expect(authContext.passport.cnf.jkt).toBe(config.senderConstraint.thumbprint);
    expect(authContext.passport.aud).toBe(config.protectedResourceAudience);
    expect(authContext.dpopVerified).toBe(true);
  });

  it("rejects a token with the wrong audience", () => {
    const token = issuePassport({
      config: {
        ...config,
        protectedResourceAudience: "mcp-server-evil",
      },
    });
    const proof = createDpopProof({
      config,
      accessToken: token,
      method: "POST",
      url: `http://127.0.0.1:${config.protectedPort}/mcp`,
    });

    expect(() =>
      verifyProtectedResourceRequest({
        config,
        request: requestWithProof(token, proof),
      }),
    ).toThrow();
  });

  it("rejects a request with no DPoP proof", () => {
    const token = issuePassport();

    expect(() =>
      verifyProtectedResourceRequest({
        config,
        request: requestWithProof(token),
      }),
    ).toThrow("Missing DPoP proof");
  });

  it("rejects a DPoP proof signed for a different access token", () => {
    const token = issuePassport();
    const wrongToken = issuePassport({ sessionId: "different-session" });
    const proof = createDpopProof({
      config,
      accessToken: wrongToken,
      method: "POST",
      url: `http://127.0.0.1:${config.protectedPort}/mcp`,
    });

    expect(() =>
      verifyProtectedResourceRequest({
        config,
        request: requestWithProof(token, proof),
      }),
    ).toThrow("DPoP access-token hash mismatch");
  });
});
