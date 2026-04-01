import sharp from "sharp";

import {
  getEnrollmentIdentity,
  isEnrollmentStoreConfigured,
  upsertEnrollmentIdentityPayload,
} from "./enrollment-store";
import { stringifyMessage } from "./protocol";
import type {
  PythonAdminResultMessage,
  ClientFrameSubmitMessage,
  ClientSignalMessage,
  IdentityMetadataPayload,
  IdentitySyncStatus,
  PythonAdminIdentityFile,
  PythonAdminMessage,
  PythonAutoEnrollmentEvent,
  PythonFrameProcessMessage,
  PythonFrameResultMessage,
  PythonServiceReadyMessage,
  ServerEnrollmentSyncMessage,
  ServerToClientMessage,
} from "./protocol";

type Sender = (message: ServerToClientMessage) => void;

interface SessionState {
  inFlightFrameId: number | null;
  queuedFrame: PythonFrameProcessMessage | null;
  send: Sender;
}

interface CachedFrame {
  data: string;
  height: number;
  width: number;
}

interface PendingUnknownTrack {
  createdIdentity?: IdentityMetadataPayload;
  firstSeenMs: number;
  hits: number;
  lastSeenMs: number;
}

interface PythonStatus {
  connected: boolean;
  detail: string;
  ready: PythonServiceReadyMessage | null;
  reconnecting: boolean;
}

interface PendingAdminRequest {
  payload: PythonAdminMessage;
  resolve: (result: {
    changed: boolean;
    enrollment?: PythonServiceReadyMessage["enrollment"];
    ok: boolean;
  }) => void;
  sent: boolean;
  timeoutId: ReturnType<typeof setTimeout>;
}

const DISCONNECTED_STATUS: PythonStatus = {
  connected: false,
  detail: "Waiting for Python inference service",
  ready: null,
  reconnecting: false,
};

const AUTO_ENROLL_DUPLICATE_GUARD = 0.4;
const AUTO_ENROLL_MAX_TRACK_STALENESS_MS = 4000;
const AUTO_ENROLL_MIN_HITS = 6;
const AUTO_ENROLL_MIN_MS = 1500;
const MAX_CACHED_FRAMES_PER_SESSION = 4;

const normalizePythonWebSocketUrl = (url: string): string => {
  if (url.startsWith("ws://") || url.startsWith("wss://")) {
    return url;
  }
  if (url.startsWith("http://")) {
    return `ws://${url.slice("http://".length)}`;
  }
  if (url.startsWith("https://")) {
    return `wss://${url.slice("https://".length)}`;
  }
  return url;
};

export class PythonBridge {
  private autoIdentityCounter = 0;
  private readonly cachedFrames = new Map<string, Map<number, CachedFrame>>();
  private readonly identitySyncStates = new Map<
    string,
    { error?: string; status: IdentitySyncStatus }
  >();
  private readonly pendingAdminRequests: PendingAdminRequest[] = [];
  private readonly pendingUnknownTracks = new Map<
    string,
    PendingUnknownTrack
  >();
  private readonly pythonUrl: string;
  private readonly sessions = new Map<string, SessionState>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private status: PythonStatus = DISCONNECTED_STATUS;
  private upstream: WebSocket | null = null;

  constructor(pythonUrl: string) {
    this.pythonUrl = normalizePythonWebSocketUrl(pythonUrl);
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
    this.cachedFrames.delete(sessionId);
    for (const trackKey of this.pendingUnknownTracks.keys()) {
      if (trackKey.startsWith(`${sessionId}:`)) {
        this.pendingUnknownTracks.delete(trackKey);
      }
    }
    if (
      this.sessions.size === 0 &&
      this.pendingAdminRequests.length === 0 &&
      this.upstream?.readyState === WebSocket.OPEN
    ) {
      this.upstream.close(1000, "No active Bun sessions");
    }
  }

  getStatus(): PythonStatus {
    return this.status;
  }

  sendAdminMessage(payload: PythonAdminMessage): Promise<{
    changed: boolean;
    enrollment?: PythonServiceReadyMessage["enrollment"];
    ok: boolean;
  }> {
    const { promise, resolve } = Promise.withResolvers<{
      changed: boolean;
      enrollment?: PythonServiceReadyMessage["enrollment"];
      ok: boolean;
    }>();
    const request: PendingAdminRequest = {
      payload,
      resolve,
      sent: false,
      timeoutId: setTimeout(() => {
        this.resolvePendingAdminRequest(request, {
          changed: false,
          ok: false,
        });
      }, 5000),
    };

    this.pendingAdminRequests.push(request);
    this.ensureConnection();
    this.flushAdminRequests();
    return promise;
  }

  close(): void {
    this.clearReconnectTimer();
    while (this.pendingAdminRequests.length > 0) {
      const [request] = this.pendingAdminRequests;
      if (request === undefined) {
        break;
      }
      this.resolvePendingAdminRequest(request, {
        changed: false,
        ok: false,
      });
    }
    if (
      this.upstream &&
      (this.upstream.readyState === WebSocket.CONNECTING ||
        this.upstream.readyState === WebSocket.OPEN)
    ) {
      this.upstream.close(1000, "Bun server shutting down");
    }
    this.upstream = null;
  }

  handleFrame(message: ClientFrameSubmitMessage): void {
    const session = this.sessions.get(message.sessionId);
    if (!session) {
      return;
    }

    this.storeFrame(message);

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
      for (const request of this.pendingAdminRequests) {
        request.sent = false;
      }
      this.setStatus({
        connected: false,
        detail: "Python service disconnected. Reconnecting...",
        ready: this.status.ready,
        reconnecting: true,
      });
      this.scheduleReconnect();
    });

    upstream.addEventListener("error", () => {
      for (const request of this.pendingAdminRequests) {
        request.sent = false;
      }
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
      void this.handlePythonMessage(event.data);
    });

    upstream.addEventListener("open", () => {
      this.setStatus({
        connected: true,
        detail: "Python service connected",
        ready: this.status.ready,
        reconnecting: false,
      });
      this.flushAdminRequests();
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
      | PythonAdminResultMessage
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

    if (payload.type === "admin.result") {
      const [request] = this.pendingAdminRequests;
      if (request === undefined) {
        return;
      }

      this.resolvePendingAdminRequest(request, {
        changed: payload.changed,
        enrollment: payload.enrollment,
        ok: payload.status === "ok",
      });
      this.flushAdminRequests();
      return;
    }

    if (payload.type !== "frame.result") {
      return;
    }

    this.prunePendingUnknownTracks(Date.now());
    this.handleAutoEnrollments(payload);

    const session = this.sessions.get(payload.sessionId);
    if (!session) {
      return;
    }

    this.applySyncStatesToFrame(payload);
    session.inFlightFrameId = null;
    session.send(payload);
    this.flushSession(payload.sessionId);
  }

  private applySyncStatesToFrame(payload: PythonFrameResultMessage): void {
    for (const face of payload.faces) {
      if (face.trackId !== null) {
        const pending = this.pendingUnknownTracks.get(
          PythonBridge.trackKey(payload.sessionId, face.trackId)
        );
        if (
          face.identity === null &&
          pending?.createdIdentity !== undefined &&
          pending.createdIdentity.syncStatus !== "error"
        ) {
          face.identity = pending.createdIdentity;
          face.isUnknown = false;
        }
      }

      if (face.identity === null) {
        continue;
      }

      const syncState = this.identitySyncStates.get(face.identity.id);
      if (syncState === undefined) {
        continue;
      }

      face.identity = {
        ...face.identity,
        syncStatus: syncState.status,
      };
    }
  }

  private handleAutoEnrollments(payload: PythonFrameResultMessage): void {
    for (const face of payload.faces) {
      if (face.trackId === null) {
        continue;
      }

      const trackKey = PythonBridge.trackKey(payload.sessionId, face.trackId);
      if (face.identity !== null && !face.isUnknown) {
        this.pendingUnknownTracks.delete(trackKey);
        continue;
      }

      if (!face.isUnknown || face.confidence >= AUTO_ENROLL_DUPLICATE_GUARD) {
        this.pendingUnknownTracks.delete(trackKey);
        continue;
      }

      const now = Date.now();
      const pending = this.pendingUnknownTracks.get(trackKey);
      if (pending?.createdIdentity !== undefined) {
        pending.lastSeenMs = now;
        continue;
      }

      const nextPending: PendingUnknownTrack = {
        firstSeenMs: pending?.firstSeenMs ?? now,
        hits: (pending?.hits ?? 0) + 1,
        lastSeenMs: now,
      };
      this.pendingUnknownTracks.set(trackKey, nextPending);
      const observedHits = Math.max(nextPending.hits, face.trackAgeFrames ?? 0);

      if (
        observedHits < AUTO_ENROLL_MIN_HITS ||
        now - nextPending.firstSeenMs < AUTO_ENROLL_MIN_MS
      ) {
        continue;
      }

      const identity = this.createAutoIdentity();
      nextPending.createdIdentity = {
        ...identity,
        syncStatus: "syncing",
      };
      this.setIdentitySyncStatus(identity.id, "syncing");

      face.identity = nextPending.createdIdentity;
      face.isUnknown = false;
      void this.persistAutoEnrollment(
        payload.sessionId,
        payload.frameId,
        face.bbox,
        identity
      );
    }
  }

  private storeFrame(message: ClientFrameSubmitMessage): void {
    const frames =
      this.cachedFrames.get(message.sessionId) ??
      new Map<number, CachedFrame>();
    frames.set(message.frameId, {
      data: message.image.data,
      height: message.image.height,
      width: message.image.width,
    });
    while (frames.size > MAX_CACHED_FRAMES_PER_SESSION) {
      const oldestFrameId = Math.min(...frames.keys());
      frames.delete(oldestFrameId);
    }
    this.cachedFrames.set(message.sessionId, frames);
  }

  private prunePendingUnknownTracks(now: number): void {
    for (const [trackKey, pending] of this.pendingUnknownTracks.entries()) {
      if (now - pending.lastSeenMs > AUTO_ENROLL_MAX_TRACK_STALENESS_MS) {
        this.pendingUnknownTracks.delete(trackKey);
      }
    }
  }

  private static trackKey(sessionId: string, trackId: number): string {
    return `${sessionId}:${trackId}`;
  }

  private createAutoIdentity(): Omit<IdentityMetadataPayload, "syncStatus"> {
    this.autoIdentityCounter += 1;
    const suffix = `${Date.now().toString(36)}-${this.autoIdentityCounter.toString(36)}`;
    const id = `person-${suffix}`;
    return {
      color: "#ffffff",
      id,
      name: `person ${suffix}`,
    };
  }

  private async persistAutoEnrollment(
    sessionId: string,
    frameId: number,
    bbox: PythonAutoEnrollmentEvent["bbox"],
    identity: Omit<IdentityMetadataPayload, "syncStatus">
  ): Promise<void> {
    try {
      if (!isEnrollmentStoreConfigured()) {
        throw new Error("Enrollment storage is not configured.");
      }

      const existingIdentity = await getEnrollmentIdentity(identity.id);
      if (existingIdentity !== undefined) {
        this.setIdentitySyncStatus(identity.id, "ready");
        return;
      }

      const file = await this.cropEnrollmentImage(sessionId, frameId, bbox);
      await upsertEnrollmentIdentityPayload(identity, [file]);
      const reload = await this.sendAdminMessage({
        files: [file],
        id: identity.id,
        metadata: identity,
        type: "admin.upsert-identity",
      });
      this.setIdentitySyncStatus(
        identity.id,
        reload.ok ? "ready" : "error",
        reload.ok ? undefined : "Python enrollment sync failed."
      );
    } catch (error) {
      this.setIdentitySyncStatus(
        identity.id,
        "error",
        error instanceof Error ? error.message : "Auto enrollment failed."
      );
    }
  }

  private async cropEnrollmentImage(
    sessionId: string,
    frameId: number,
    bbox: PythonAutoEnrollmentEvent["bbox"]
  ): Promise<PythonAdminIdentityFile> {
    const frame = this.cachedFrames.get(sessionId)?.get(frameId);
    if (frame === undefined) {
      throw new Error("Auto enrollment frame cache missed.");
    }

    const paddingX = Math.round(bbox.width * 0.18);
    const paddingY = Math.round(bbox.height * 0.22);
    const left = Math.max(0, Math.floor(bbox.x - paddingX));
    const top = Math.max(0, Math.floor(bbox.y - paddingY));
    const width = Math.min(
      frame.width - left,
      Math.ceil(bbox.width + paddingX * 2)
    );
    const height = Math.min(
      frame.height - top,
      Math.ceil(bbox.height + paddingY * 2)
    );
    if (width <= 0 || height <= 0) {
      throw new Error("Auto enrollment crop was empty.");
    }

    const cropped = await sharp(Buffer.from(frame.data, "base64"))
      .extract({
        height,
        left,
        top,
        width,
      })
      .jpeg({
        mozjpeg: true,
        quality: 88,
      })
      .toBuffer();

    return {
      data: cropped.toString("base64"),
      name: "ref-auto-1.jpg",
    };
  }

  private setIdentitySyncStatus(
    identityId: string,
    status: IdentitySyncStatus,
    error?: string
  ): void {
    this.identitySyncStates.set(identityId, {
      ...(error === undefined ? {} : { error }),
      status,
    });

    const message: ServerEnrollmentSyncMessage = {
      ...(error === undefined ? {} : { error }),
      identityId,
      status,
      type: "enrollment.sync",
    };
    this.broadcast(message);
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

    this.broadcast(message);
  }

  private flushAdminRequests(): void {
    const [request] = this.pendingAdminRequests;
    if (
      request === undefined ||
      request.sent ||
      this.upstream?.readyState !== WebSocket.OPEN
    ) {
      return;
    }

    request.sent = true;
    this.upstream.send(stringifyMessage(request.payload));
  }

  private resolvePendingAdminRequest(
    request: PendingAdminRequest,
    result: {
      changed: boolean;
      enrollment?: PythonServiceReadyMessage["enrollment"];
      ok: boolean;
    }
  ): void {
    const requestIndex = this.pendingAdminRequests.indexOf(request);
    if (requestIndex === -1) {
      return;
    }

    this.pendingAdminRequests.splice(requestIndex, 1);
    clearTimeout(request.timeoutId);
    request.resolve(result);
  }

  private broadcast(message: ServerToClientMessage): void {
    for (const session of this.sessions.values()) {
      session.send(message);
    }
  }
}
