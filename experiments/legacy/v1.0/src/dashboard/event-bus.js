import { EventEmitter } from "node:events";

class EventBus extends EventEmitter {
  constructor() {
    super();
    this.history = [];
  }

  publish(type, payload) {
    const event = {
      id: crypto.randomUUID(),
      type,
      payload,
      at: new Date().toISOString(),
    };
    this.history.push(event);
    if (this.history.length > 250) {
      this.history.shift();
    }
    this.emit("event", event);
    return event;
  }

  recent() {
    return [...this.history].reverse();
  }
}

export const eventBus = new EventBus();
