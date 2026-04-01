import type { Serve, ServerWebSocket } from "bun";

import {
  deleteEnrollmentIdentity,
  isEnrollmentStoreConfigured,
  listEnrollmentIdentities,
  upsertEnrollmentIdentity,
} from "./lib/enrollment-store";
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

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status });

const slugify = (value: string): string => {
  const slug = value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  return slug || "identity";
};

const buildIdentityId = (
  identities: { id: string }[],
  name: string
): string => {
  const base = slugify(name);
  let candidate = base;
  let suffix = 2;

  while (identities.some((identity) => identity.id === candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }

  return candidate;
};

const handleEnrollmentRequest = async (req: Request): Promise<Response> => {
  if (!isEnrollmentStoreConfigured()) {
    return json(
      {
        error: "Enrollment storage is not configured.",
      },
      503
    );
  }

  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/api/enrollment") {
    const identities = await listEnrollmentIdentities();
    return json({ identities });
  }

  if (req.method === "POST" && url.pathname === "/api/enrollment") {
    const form = await req.formData();
    const name = form.get("name");
    const role = form.get("role");
    const color = form.get("color");
    const files = form
      .getAll("files")
      .filter(
        (value): value is File => value instanceof File && value.size > 0
      );

    if (
      typeof name !== "string" ||
      typeof role !== "string" ||
      typeof color !== "string" ||
      files.length === 0
    ) {
      return json(
        { error: "name, role, color, and at least one file are required." },
        400
      );
    }

    const existingIdentities = await listEnrollmentIdentities();
    const id = buildIdentityId(existingIdentities, name);
    const identities = await upsertEnrollmentIdentity(
      {
        color,
        id,
        name,
        role,
      },
      files
    );
    return json({ identities });
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/enrollment/")) {
    const identityId = decodeURIComponent(
      url.pathname.replace("/api/enrollment/", "")
    );
    if (!identityId) {
      return json({ error: "identity id is required." }, 400);
    }

    const identities = await deleteEnrollmentIdentity(identityId);
    return json({ identities });
  }

  return json({ error: "Not found" }, 404);
};

const server = Bun.serve({
  async fetch(req, serverInstance) {
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

    if (url.pathname.startsWith("/api/enrollment")) {
      try {
        return await handleEnrollmentRequest(req);
      } catch (error) {
        return json(
          {
            error:
              error instanceof Error
                ? error.message
                : "Enrollment request failed.",
          },
          500
        );
      }
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
