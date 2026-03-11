/**
 * Transport abstraction for webview ↔ backend communication.
 *
 * In VS Code: wraps acquireVsCodeApi() postMessage.
 * In PWA mode: will use WebSocket (implemented in Phase 3).
 *
 * Environment is auto-detected: if acquireVsCodeApi exists, we're in VS Code.
 */

import type { WebviewMessage } from "./types";

export interface Transport {
  postMessage(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

// ── VS Code Transport ───────────────────────────────────────────────

class VsCodeTransport implements Transport {
  private api: ReturnType<typeof window.acquireVsCodeApi>;

  constructor() {
    this.api = window.acquireVsCodeApi();
  }

  postMessage(message: WebviewMessage): void {
    this.api.postMessage(message);
  }

  getState(): unknown {
    return this.api.getState();
  }

  setState(state: unknown): void {
    this.api.setState(state);
  }
}

// ── PWA Transport (WebSocket to pwa/server.ts) ──────────────────────

class PwaTransport implements Transport {
  private ws: WebSocket | null = null;
  private queue: WebviewMessage[] = [];

  constructor() {
    this.connect();
  }

  private connect(): void {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    this.ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    this.ws.onopen = () => {
      // Flush queued messages
      for (const msg of this.queue) {
        this.ws!.send(JSON.stringify(msg));
      }
      this.queue = [];
    };

    this.ws.onmessage = (event) => {
      // Dispatch as window message (same as VS Code webview does)
      const data = JSON.parse(event.data);
      window.dispatchEvent(new MessageEvent("message", { data }));
    };

    this.ws.onclose = () => {
      // Reconnect after 2 seconds
      setTimeout(() => this.connect(), 2000);
    };
  }

  postMessage(message: WebviewMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      this.queue.push(message);
    }
  }

  getState(): unknown {
    const raw = localStorage.getItem("beads-webview-state");
    return raw ? JSON.parse(raw) : undefined;
  }

  setState(state: unknown): void {
    localStorage.setItem("beads-webview-state", JSON.stringify(state));
  }
}

// ── Factory ─────────────────────────────────────────────────────────

function isVsCode(): boolean {
  return typeof window !== "undefined" && typeof window.acquireVsCodeApi === "function";
}

let _transport: Transport | null = null;

export function getTransport(): Transport {
  if (!_transport) {
    _transport = isVsCode() ? new VsCodeTransport() : new PwaTransport();
  }
  return _transport;
}

/** Convenience: the singleton transport instance. */
export const transport = /* @__PURE__ */ (() => {
  // Lazy init — deferred until first access so module can load in any environment
  let instance: Transport | null = null;
  return new Proxy({} as Transport, {
    get(_target, prop: keyof Transport) {
      if (!instance) instance = getTransport();
      const val = instance[prop];
      return typeof val === "function" ? val.bind(instance) : val;
    },
  });
})();
