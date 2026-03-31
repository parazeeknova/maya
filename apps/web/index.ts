import type { Serve, ServerWebSocket } from "bun";

import {
  DEFAULT_SAMPLING,
  parseClientMessage,
  stringifyMessage,
} from "./lib/protocol";
import type { ServerToClientMessage } from "./lib/protocol";
import { PythonBridge } from "./lib/python-bridge";

interface ClientData {
  sessionId: string | null;
}

const publicDir = new URL("public/", import.meta.url);
const pythonUrl = Bun.env["MAYA_SERVE_URL"] ?? "ws://127.0.0.1:8765";
const bridge = new PythonBridge(pythonUrl);

const asset = (pathname: string): Response =>
  new Response(Bun.file(new URL(pathname, publicDir)));

const send = (
  ws: ServerWebSocket<ClientData>,
  message: ServerToClientMessage
): void => {
  ws.send(stringifyMessage(message));
};

const server = Bun.serve({
  fetch(req, serverInstance) {
    const url = new URL(req.url);

    if (url.pathname === "/ws/client") {
      const upgraded = serverInstance.upgrade(req, {
        data: {
          sessionId: null,
        },
      });

      if (upgraded) {
        return;
      }

      return new Response("WebSocket upgrade failed.", { status: 500 });
    }

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        pythonUrl,
      });
    }

    if (url.pathname === "/client.js") {
      return asset("client.js");
    }

    if (url.pathname === "/styles.css") {
      return asset("styles.css");
    }

    return asset("index.html");
  },
  port: Number(Bun.env["PORT"] ?? 3000),
  websocket: {
    close(ws) {
      if (ws.data.sessionId !== null) {
        bridge.unregisterSession(ws.data.sessionId);
      }
    },
    data: {} as ClientData,
    idleTimeout: 120,
    maxPayloadLength: 8 * 1024 * 1024,
    message(ws, raw) {
      try {
        const message = parseClientMessage(raw);
        if (message.type === "client.hello") {
          const sessionId = message.sessionId ?? crypto.randomUUID();
          ws.data.sessionId = sessionId;
          const status = bridge.registerSession(sessionId, (payload) => {
            send(ws, payload);
          });

          send(ws, {
            sampling: DEFAULT_SAMPLING,
            sessionId,
            type: "session.ready",
          });
          send(ws, {
            connected: status.connected,
            detail: status.detail,
            ready: status.ready,
            reconnecting: status.reconnecting,
            type: "python.status",
          });
          return;
        }

        const { sessionId } = ws.data;
        if (sessionId === null || sessionId !== message.sessionId) {
          send(ws, {
            message: "Session mismatch. Refresh the page and reconnect.",
            type: "error",
          });
          return;
        }

        if (message.type === "signal") {
          bridge.handleSignal(message);
          return;
        }

        bridge.handleFrame(message);
      } catch (error) {
        send(ws, {
          message:
            error instanceof Error ? error.message : "Unknown server error",
          type: "error",
        });
      }
    },
    perMessageDeflate: true,
  },
} satisfies Serve.Options<ClientData>);

console.log(
  `Maya web listening on http://${server.hostname}:${server.port} ` +
    `with Python bridge ${pythonUrl}`
);

let shuttingDown = false;

const shutdown = async (signal: string) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  console.log(`Maya web shutting down on ${signal}`);
  bridge.close();
  await server.stop(true);
  process.exit(0);
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}
