const approvalsEl = document.querySelector("#approvals");
const datasetsEl = document.querySelector("#datasets");
const reportsEl = document.querySelector("#reports");
const eventsEl = document.querySelector("#events");
const notificationsButton = document.querySelector("#enable-notifications");
const connectionStatusEl = document.querySelector("#connection-status");
const runtimeMetaEl = document.querySelector("#runtime-meta");
const securityAudienceEl = document.querySelector("#security-audience");
const securityThumbprintEl = document.querySelector("#security-thumbprint");
const securityModelBackedEl = document.querySelector("#security-model-backed");
const securityDpopVerifiedEl = document.querySelector("#security-dpop-verified");

let notificationsEnabled = false;
let eventStreamHealthy = false;
let lastRenderedStateHash = "";

const EVENT_META = {
  "intent.passport_issued": {
    title: "Passport Issued",
    chip: "Intent",
  },
  "proxy.tool_requested": {
    title: "Tool Request Intercepted",
    chip: "Proxy",
  },
  "approval.created": {
    title: "Human Approval Required",
    chip: "HITL",
  },
  "approval.resolved": {
    title: "Approval Decision Recorded",
    chip: "HITL",
  },
  "proxy.denied": {
    title: "Policy Enforcement Blocked Call",
    chip: "Denied",
  },
  "proxy.forwarded": {
    title: "Call Forwarded To MCP Server",
    chip: "Allowed",
  },
  "mcp.tool_executed": {
    title: "Protected Tool Executed",
    chip: "MCP",
  },
  "proxy.rpc_passthrough": {
    title: "Non-Tool RPC Passed Through",
    chip: "Proxy",
  },
  "resource.auth_verified": {
    title: "Protected Resource Verified DPoP",
    chip: "Auth",
  },
};

// Every value rendered into HTML can originate from agent-controlled tool
// arguments, so it is escaped. Unescaped rendering would let a tool argument
// script the approver's browser (for example, click "Approve").
function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function json(value) {
  return esc(JSON.stringify(value, null, 2));
}

function approverToken() {
  try {
    let token = sessionStorage.getItem("approverToken");
    if (!token) {
      token = window.prompt("Approver token (printed by the stack at startup):") || "";
      if (token) {
        sessionStorage.setItem("approverToken", token);
      }
    }
    return token;
  } catch {
    return window.prompt("Approver token (printed by the stack at startup):") || "";
  }
}

function setConnectionStatus(text, tone = "online") {
  connectionStatusEl.textContent = "";
  connectionStatusEl.classList.remove("offline", "polling");
  if (tone === "offline") {
    connectionStatusEl.classList.add("offline");
  }
  if (tone === "polling") {
    connectionStatusEl.classList.add("polling");
  }
  const dot = document.createElement("span");
  dot.className = "status-dot";
  connectionStatusEl.append(dot, document.createTextNode(` ${text}`));
}

function renderDatasets(datasets) {
  const safeDatasets = Array.isArray(datasets) ? datasets : [];
  datasetsEl.innerHTML = safeDatasets.map((dataset) => `
    <div class="item">
      <strong>${esc(dataset.name)}</strong>
      <div class="meta">${esc(dataset.id)} · ${esc(dataset.uri)}</div>
      <div class="meta">${esc(dataset.rowCount)} rows · $${esc(dataset.totalRevenue)} revenue</div>
    </div>
  `).join("") || `<div class="item"><div class="meta">No datasets loaded.</div></div>`;
}

function renderReports(reports) {
  const safeReports = Array.isArray(reports) ? reports : [];
  reportsEl.innerHTML = safeReports.length
    ? safeReports.map((report) => `
      <div class="item">
        <strong>${esc(report.datasetName)}</strong>
        <div class="meta">${esc(report.createdAt)}</div>
        <div>${esc(report.objective)}</div>
      </div>
    `).join("")
    : `<div class="item"><div class="meta">No reports yet.</div></div>`;
}

async function decideApproval(id, approved) {
  const response = await fetch(`/approvals/${encodeURIComponent(id)}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-approver-token": approverToken() },
    body: JSON.stringify({ approved, approver: "dashboard-user" }),
  });
  if (response.status === 401) {
    try {
      sessionStorage.removeItem("approverToken");
    } catch {}
    window.alert("Approver token rejected.");
  }
}

function renderApprovals(approvals) {
  const safeApprovals = Array.isArray(approvals) ? approvals : [];
  approvalsEl.innerHTML = safeApprovals.length
    ? safeApprovals.map((approval) => `
      <div class="item">
        <strong>${esc(approval.policyContext.toolName)}</strong>
        <div class="meta">${esc(approval.createdAt)}</div>
        <div>${esc(approval.policyContext.userIntent)}</div>
        <div class="meta">Reason: ${esc(approval.inspector.reason)}</div>
        <pre>${json(approval.policyContext.toolArgs)}</pre>
        <div class="button-row">
          <button class="button secondary" data-approve="${esc(approval.id)}">Approve</button>
          <button class="button danger" data-deny="${esc(approval.id)}">Deny</button>
        </div>
      </div>
    `).join("")
    : `<div class="item"><div class="meta">No approvals waiting.</div></div>`;

  approvalsEl.querySelectorAll("[data-approve]").forEach((button) => {
    button.addEventListener("click", () => decideApproval(button.dataset.approve, true));
  });
  approvalsEl.querySelectorAll("[data-deny]").forEach((button) => {
    button.addEventListener("click", () => decideApproval(button.dataset.deny, false));
  });
}

function renderEvent(event) {
  const meta = EVENT_META[event.type] || {
    title: event.type,
    chip: "Event",
  };
  const danger = ["proxy.denied", "approval.created"].includes(event.type);
  const ok = ["proxy.forwarded", "approval.resolved", "mcp.tool_executed", "intent.passport_issued"].includes(event.type);
  const div = document.createElement("div");
  div.className = `event ${danger ? "danger" : ""} ${ok ? "ok" : ""}`;
  div.innerHTML = `
    <div class="event-label">
      <span class="event-title">${esc(meta.title)}</span>
      <span class="event-chip">${esc(meta.chip)}</span>
    </div>
    <div class="meta">${esc(event.at)}</div>
    <pre>${json(event.payload)}</pre>
  `;
  eventsEl.prepend(div);
}

function renderRuntime(runtime) {
  if (!runtime) {
    runtimeMetaEl.textContent = "No runtime file";
    return;
  }
  runtimeMetaEl.textContent = `Proxy ${runtime.proxyPort} · Orch ${runtime.orchestratorPort} · PID ${runtime.pid}`;
}

function renderBooleanStatus(element, value) {
  element.classList.remove("ok", "danger", "muted");
  if (value === true) {
    element.textContent = "Yes";
    element.classList.add("ok");
    return;
  }
  if (value === false) {
    element.textContent = "No";
    element.classList.add("danger");
    return;
  }
  element.textContent = "Unknown";
  element.classList.add("muted");
}

function renderSecurity(security, runtime) {
  const audience = security?.currentAudience || runtime?.protectedResourceAudience || "Unknown";
  const thumbprint = security?.senderConstraintThumbprint || runtime?.senderConstraintThumbprint || "Unknown";

  securityAudienceEl.textContent = audience;
  securityThumbprintEl.textContent = thumbprint;
  renderBooleanStatus(securityModelBackedEl, security?.lastRequestModelBacked ?? null);
  renderBooleanStatus(securityDpopVerifiedEl, security?.lastRequestDpopVerified ?? null);
}

async function loadState() {
  const response = await fetch("/api/state", { cache: "no-store" });
  const state = await response.json();
  const snapshot = JSON.stringify(state);
  if (snapshot === lastRenderedStateHash) {
    return state;
  }
  lastRenderedStateHash = snapshot;
  renderApprovals(state.pendingApprovals || []);
  renderDatasets(state.datasets || []);
  renderReports(state.reports || []);
  renderRuntime(state.runtime);
  renderSecurity(state.security, state.runtime);
  eventsEl.innerHTML = "";
  [...(state.recentEvents || [])].reverse().forEach(renderEvent);
  return state;
}

notificationsButton.addEventListener("click", async () => {
  if (!("Notification" in window)) {
    notificationsButton.textContent = "Notifications Unsupported";
    return;
  }
  const result = await Notification.requestPermission();
  notificationsEnabled = result === "granted";
});

function connectEvents() {
  const source = new EventSource("/events");
  source.onopen = () => {
    eventStreamHealthy = true;
    setConnectionStatus("Live event stream connected");
  };
  source.onerror = () => {
    eventStreamHealthy = false;
    setConnectionStatus("Event stream unavailable, polling state", "polling");
  };
  source.onmessage = async (message) => {
    const event = JSON.parse(message.data);
    renderEvent(event);
    if (event.type === "approval.created") {
      await loadState();
      if (notificationsEnabled && "Notification" in window) {
        new Notification("Approval required", {
          body: `${event.payload.policyContext.toolName} is waiting for human approval.`,
        });
      }
    }
    if (["approval.resolved", "proxy.forwarded", "proxy.denied", "mcp.tool_executed", "intent.passport_issued"].includes(event.type)) {
      await loadState();
    }
  };
}

async function boot() {
  try {
    await loadState();
    setConnectionStatus("Dashboard state loaded");
  } catch (error) {
    console.error(error);
    setConnectionStatus("Initial state load failed", "offline");
  }

  connectEvents();

  setInterval(async () => {
    try {
      await loadState();
      if (!eventStreamHealthy) {
        setConnectionStatus("Polling dashboard state", "polling");
      }
    } catch (error) {
      console.error(error);
      setConnectionStatus("Dashboard refresh failed", "offline");
    }
  }, 2000);
}

boot();
