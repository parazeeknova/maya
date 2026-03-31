export type SignalType = "answer" | "ice" | "offer";

export interface ClientHelloMessage {
  sessionId?: string;
  type: "client.hello";
}

export interface ClientSignalMessage {
  payload: unknown;
  sessionId: string;
  signalType: SignalType;
  type: "signal";
}

export interface ClientFrameSubmitMessage {
  capturedAt: number;
  frameId: number;
  image: {
    data: string;
    height: number;
    mimeType: "image/jpeg";
    width: number;
  };
  sampleIntervalMs: number;
  sessionId: string;
  type: "frame.submit";
}

export type ClientToServerMessage =
  | ClientFrameSubmitMessage
  | ClientHelloMessage
  | ClientSignalMessage;

export interface PythonFrameProcessMessage {
  capturedAt: number;
  frameId: number;
  image: {
    data: string;
    height: number;
    mimeType: "image/jpeg";
    width: number;
  };
  sampleIntervalMs: number;
  sessionId: string;
  type: "frame.process";
}

export interface PythonServiceReadyMessage {
  detectorSize: {
    height: number;
    width: number;
  };
  enrollment: {
    directory: string;
    identities: number;
    version: number;
    warnings: string[];
  };
  matchThreshold: number;
  providers: string[];
  trackingEnabled: boolean;
  type: "service.ready";
}

export interface PythonFrameResultMessage {
  capturedAt: number;
  faces: {
    bbox: {
      height: number;
      width: number;
      x: number;
      y: number;
    };
    confidence: number;
    identity: {
      color: string;
      id: string;
      name: string;
      role: string;
    } | null;
    isUnknown: boolean;
    trackId: number | null;
  }[];
  frameId: number;
  indexVersion: number;
  latencyMs: number;
  providers: string[];
  sampleIntervalMs: number;
  sessionId: string;
  sourceSize: {
    height: number;
    width: number;
  };
  type: "frame.result";
}

export interface ServerSessionReadyMessage {
  sampling: {
    intervalMs: number;
    jpegQuality: number;
    maxWidth: number;
  };
  sessionId: string;
  type: "session.ready";
}

export interface ServerPythonStatusMessage {
  connected: boolean;
  detail: string;
  ready: PythonServiceReadyMessage | null;
  reconnecting: boolean;
  type: "python.status";
}

export interface ServerSignalAckMessage {
  signalType: SignalType;
  type: "signal.ack";
}

export interface ServerErrorMessage {
  message: string;
  type: "error";
}

export type ServerToClientMessage =
  | PythonFrameResultMessage
  | ServerErrorMessage
  | ServerPythonStatusMessage
  | ServerSessionReadyMessage
  | ServerSignalAckMessage;

export const DEFAULT_SAMPLING = {
  intervalMs: 120,
  jpegQuality: 0.68,
  maxWidth: 640,
} as const;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isSignalType = (value: unknown): value is SignalType =>
  value === "answer" || value === "ice" || value === "offer";

const parseFrameImage = (value: unknown): ClientFrameSubmitMessage["image"] => {
  if (!isObject(value)) {
    throw new TypeError("Invalid frame image payload.");
  }

  const { data } = value;
  const { height } = value;
  const { mimeType } = value;
  const { width } = value;

  if (
    typeof data !== "string" ||
    typeof height !== "number" ||
    mimeType !== "image/jpeg" ||
    typeof width !== "number"
  ) {
    throw new TypeError("Invalid frame image payload.");
  }

  return {
    data,
    height,
    mimeType,
    width,
  };
};

export const parseClientMessage = (
  raw: string | Buffer
): ClientToServerMessage => {
  const text = typeof raw === "string" ? raw : raw.toString("utf8");
  const payload = JSON.parse(text) as unknown;
  if (!isObject(payload) || typeof payload["type"] !== "string") {
    throw new TypeError("Invalid message payload.");
  }

  switch (payload["type"]) {
    case "client.hello": {
      return typeof payload["sessionId"] === "string"
        ? {
            sessionId: payload["sessionId"],
            type: "client.hello",
          }
        : {
            type: "client.hello",
          };
    }
    case "signal": {
      const { sessionId } = payload;
      const { signalType } = payload;
      if (typeof sessionId !== "string" || !isSignalType(signalType)) {
        throw new TypeError("Invalid signal payload.");
      }

      return {
        payload: payload["payload"],
        sessionId,
        signalType,
        type: "signal",
      };
    }
    case "frame.submit": {
      const { capturedAt } = payload;
      const { frameId } = payload;
      const image = parseFrameImage(payload["image"]);
      const { sampleIntervalMs } = payload;
      const { sessionId } = payload;

      if (
        typeof capturedAt !== "number" ||
        typeof frameId !== "number" ||
        typeof sampleIntervalMs !== "number" ||
        typeof sessionId !== "string"
      ) {
        throw new TypeError("Invalid frame payload.");
      }

      return {
        capturedAt,
        frameId,
        image,
        sampleIntervalMs,
        sessionId,
        type: "frame.submit",
      };
    }
    default: {
      throw new TypeError(`Unsupported message type: ${payload["type"]}`);
    }
  }
};

export const stringifyMessage = (
  message: PythonFrameProcessMessage | ServerToClientMessage
) => JSON.stringify(message);
