import { stringifyMessage } from "./protocol";
import type {
  ClientFrameSubmitMessage,
  ClientSignalMessage,
  PythonFrameProcessMessage,
  PythonFrameResultMessage,
  PythonServiceReadyMessage,
  ServerToClientMessage,
} from "./protocol";

type Sender = (message: ServerToClientMessage) => void;

interface SessionState {
  inFlightFrameId: number | null;
  queuedFrame: PythonFrameProcessMessage | null;
  send: Sender;
}

interface PythonStatus {
  connected: boolean;
  detail: string;
  ready: PythonServiceReadyMessage | null;
  reconnecting: boolean;
}

const DISCONNECTED_STATUS: PythonStatus = {
  connected: false,
  detail: "Waiting for Python inference service",
  ready: null,
  reconnecting: false,
};

export class PythonBridge {
  private readonly pythonUrl: string;
  private readonly sessions = new Map<string, SessionState>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private status: PythonStatus = DISCONNECTED_STATUS;
  private upstream: WebSocket | null = null;

  constructor(pythonUrl: string) {
    this.pythonUrl = pythonUrl;
  }

  registerSession(sessionId: string, send: Sender): PythonStatus {
    this.sessions.set(sessionId, {
      inFlightFrameId: null,
      queuedFrame: null,
      send,
    });
    this.ensureConnection();
    return this.status;
  }

  unregisterSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    if (
      this.sessions.size === 0 &&
      this.upstream?.readyState === WebSocket.OPEN
    ) {
      this.upstream.close(1000, "No active Bun sessions");
    }
  }

  handleFrame(message: ClientFrameSubmitMessage): void {
    const session = this.sessions.get(message.sessionId);
    if (!session) {
      return;
    }

    session.queuedFrame = {
      capturedAt: message.capturedAt,
      frameId: message.frameId,
      image: message.image,
      sampleIntervalMs: message.sampleIntervalMs,
      sessionId: message.sessionId,
      type: "frame.process",
    };

    this.ensureConnection();
    this.flushSession(message.sessionId);
  }

  handleSignal(message: ClientSignalMessage): void {
    const session = this.sessions.get(message.sessionId);
    if (!session) {
      return;
    }

    session.send({
      signalType: message.signalType,
      type: "signal.ack",
    });
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === null) {
      return;
    }

    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private ensureConnection(): void {
    if (
      this.upstream &&
      (this.upstream.readyState === WebSocket.CONNECTING ||
        this.upstream.readyState === WebSocket.OPEN)
    ) {
      return;
    }

    this.clearReconnectTimer();
    this.setStatus({
      connected: false,
      detail: `Connecting to ${this.pythonUrl}`,
      ready: this.status.ready,
      reconnecting: true,
    });

    const upstream = new WebSocket(this.pythonUrl);
    this.upstream = upstream;

    upstream.addEventListener("close", () => {
      this.upstream = null;
      this.setStatus({
        connected: false,
        detail: "Python service disconnected. Reconnecting...",
        ready: this.status.ready,
        reconnecting: true,
      });
      this.scheduleReconnect();
    });

    upstream.addEventListener("error", () => {
      this.setStatus({
        connected: false,
        detail: "Python service connection error. Retrying...",
        ready: this.status.ready,
        reconnecting: true,
      });
    });

    upstream.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        return;
      }
      this.handlePythonMessage(event.data);
    });

    upstream.addEventListener("open", () => {
      this.setStatus({
        connected: true,
        detail: "Python service connected",
        ready: this.status.ready,
        reconnecting: false,
      });
      for (const sessionId of this.sessions.keys()) {
        this.flushSession(sessionId);
      }
    });
  }

  private flushSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (
      !session ||
      session.inFlightFrameId !== null ||
      session.queuedFrame === null
    ) {
      return;
    }

    if (this.upstream?.readyState !== WebSocket.OPEN) {
      return;
    }

    const frame = session.queuedFrame;
    session.inFlightFrameId = frame.frameId;
    session.queuedFrame = null;
    this.upstream.send(stringifyMessage(frame));
  }

  private handlePythonMessage(raw: string): void {
    const payload = JSON.parse(raw) as
      | PythonFrameResultMessage
      | PythonServiceReadyMessage;

    if (payload.type === "service.ready") {
      this.setStatus({
        connected: true,
        detail: "Python service ready",
        ready: payload,
        reconnecting: false,
      });
      return;
    }

    if (payload.type !== "frame.result") {
      return;
    }

    const session = this.sessions.get(payload.sessionId);
    if (!session) {
      return;
    }

    session.inFlightFrameId = null;
    session.send(payload);
    this.flushSession(payload.sessionId);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null || this.sessions.size === 0) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.sessions.size > 0) {
        this.ensureConnection();
      }
    }, 1000);
  }

  private setStatus(status: PythonStatus): void {
    this.status = status;
    const message: ServerToClientMessage = {
      connected: status.connected,
      detail: status.detail,
      ready: status.ready,
      reconnecting: status.reconnecting,
      type: "python.status",
    };

    for (const session of this.sessions.values()) {
      session.send(message);
    }
  }
}
