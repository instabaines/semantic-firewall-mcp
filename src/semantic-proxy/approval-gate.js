// Human approval queue used by the semantic proxy.
export class ApprovalStore {
  constructor({ timeoutMs, eventBus }) {
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.eventBus = eventBus;
  }

  create(record) {
    const id = crypto.randomUUID();
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    // A timeout is a denial, never an implicit approval.
    const timer = setTimeout(() => {
      this.pending.get(id)?.resolve({
        approved: false,
        approver: "timeout",
        decidedAt: new Date().toISOString(),
      });
    }, this.timeoutMs);

    const stored = {
      id,
      ...record,
      promise,
      resolve: (decision) => {
        clearTimeout(timer);
        this.pending.delete(id);
        this.eventBus?.publish("approval.resolved", { id, decision, tool: record.policyContext?.toolName });
        resolvePromise(decision);
      },
      reject: (error) => {
        clearTimeout(timer);
        this.pending.delete(id);
        rejectPromise(error);
      },
      createdAt: new Date().toISOString(),
    };

    this.pending.set(id, stored);
    this.eventBus?.publish("approval.created", {
      id,
      createdAt: stored.createdAt,
      inspector: record.inspector,
      policyContext: record.policyContext,
    });

    return this.pending.get(id);
  }

  list() {
    return [...this.pending.values()].map(({ resolve, reject, promise, ...rest }) => rest);
  }

  approve(id, approver) {
    const record = this.pending.get(id);
    if (!record) {
      return null;
    }

    record.resolve({
      approved: true,
      approver,
      decidedAt: new Date().toISOString(),
    });

    return true;
  }

  reject(id, approver) {
    const record = this.pending.get(id);
    if (!record) {
      return null;
    }

    record.resolve({
      approved: false,
      approver,
      decidedAt: new Date().toISOString(),
    });

    return true;
  }
}
