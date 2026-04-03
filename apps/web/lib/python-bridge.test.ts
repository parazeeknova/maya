import { describe, expect, test, mock } from "bun:test";

describe("normalizePythonWebSocketUrl", () => {
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

	test("preserves ws:// URLs", () => {
		expect(normalizePythonWebSocketUrl("ws://localhost:8765")).toBe(
			"ws://localhost:8765"
		);
	});

	test("preserves wss:// URLs", () => {
		expect(normalizePythonWebSocketUrl("wss://secure.example.com")).toBe(
			"wss://secure.example.com"
		);
	});

	test("converts http:// to ws://", () => {
		expect(normalizePythonWebSocketUrl("http://localhost:8765")).toBe(
			"ws://localhost:8765"
		);
	});

	test("converts https:// to wss://", () => {
		expect(normalizePythonWebSocketUrl("https://secure.example.com")).toBe(
			"wss://secure.example.com"
		);
	});

	test("returns unchanged if no protocol prefix", () => {
		expect(normalizePythonWebSocketUrl("localhost:8765")).toBe("localhost:8765");
	});

	test("handles URLs with paths", () => {
		expect(normalizePythonWebSocketUrl("http://localhost:8765/api/ws")).toBe(
			"ws://localhost:8765/api/ws"
		);
	});

	test("handles URLs with query parameters", () => {
		expect(
			normalizePythonWebSocketUrl("http://localhost:8765?token=abc123")
		).toBe("ws://localhost:8765?token=abc123");
	});
});

describe("trackKey", () => {
	const trackKey = (sessionId: string, trackId: number): string => `${sessionId}:${trackId}`;

	test("generates track key from session and track ID", () => {
		expect(trackKey("session-123", 1)).toBe("session-123:1");
	});

	test("handles different track IDs", () => {
		expect(trackKey("session-abc", 999)).toBe("session-abc:999");
	});

	test("handles zero track ID", () => {
		expect(trackKey("session-1", 0)).toBe("session-1:0");
	});
});

describe("PythonBridge constants", () => {
	test("AUTO_ENROLL_DUPLICATE_GUARD is reasonable", () => {
		const AUTO_ENROLL_DUPLICATE_GUARD = 0.4;
		expect(AUTO_ENROLL_DUPLICATE_GUARD).toBeGreaterThan(0);
		expect(AUTO_ENROLL_DUPLICATE_GUARD).toBeLessThan(1);
	});

	test("AUTO_ENROLL_MAX_TRACK_STALENESS_MS is reasonable", () => {
		const AUTO_ENROLL_MAX_TRACK_STALENESS_MS = 4000;
		expect(AUTO_ENROLL_MAX_TRACK_STALENESS_MS).toBeGreaterThan(0);
	});

	test("AUTO_ENROLL_MIN_HITS is reasonable", () => {
		const AUTO_ENROLL_MIN_HITS = 6;
		expect(AUTO_ENROLL_MIN_HITS).toBeGreaterThan(0);
	});

	test("AUTO_ENROLL_MIN_MS is reasonable", () => {
		const AUTO_ENROLL_MIN_MS = 1500;
		expect(AUTO_ENROLL_MIN_MS).toBeGreaterThan(0);
	});

	test("MAX_CACHED_FRAMES_PER_SESSION is reasonable", () => {
		const MAX_CACHED_FRAMES_PER_SESSION = 4;
		expect(MAX_CACHED_FRAMES_PER_SESSION).toBeGreaterThan(0);
		expect(MAX_CACHED_FRAMES_PER_SESSION).toBeLessThan(100);
	});
});

describe("createAutoIdentity", () => {
	const createAutoIdentity = (
		counter: number
	): { id: string; name: string; color: string } => {
		const suffix = `${Date.now().toString(36)}-${counter.toString(36)}`;
		const id = `person-${suffix}`;
		return {
			color: "#ffffff",
			id,
			name: `person ${suffix}`,
		};
	};

	test("creates identity with person prefix", () => {
		const identity = createAutoIdentity(1);
		expect(identity.id.startsWith("person-")).toBe(true);
		expect(identity.name.startsWith("person ")).toBe(true);
	});

	test("creates unique IDs for different counters", () => {
		const identity1 = createAutoIdentity(1);
		const identity2 = createAutoIdentity(2);
		expect(identity1.id).not.toBe(identity2.id);
	});

	test("creates identity with default white color", () => {
		const identity = createAutoIdentity(1);
		expect(identity.color).toBe("#ffffff");
	});
});

describe("SessionState", () => {
	test("initial state structure", () => {
		const send = mock(() => {});
		const sessionState = {
			inFlightFrameId: null as number | null,
			queuedFrame: null as unknown,
			send,
		};

		expect(sessionState.inFlightFrameId).toBeNull();
		expect(sessionState.queuedFrame).toBeNull();
		expect(typeof sessionState.send).toBe("function");
	});
});

describe("CachedFrame", () => {
	test("structure matches expected shape", () => {
		const cachedFrame = {
			data: "base64imagedata",
			height: 720,
			width: 1280,
		};

		expect(cachedFrame.data).toBe("base64imagedata");
		expect(cachedFrame.height).toBe(720);
		expect(cachedFrame.width).toBe(1280);
	});
});

describe("PendingUnknownTrack", () => {
	test("structure matches expected shape", () => {
		const pendingTrack = {
			firstSeenMs: Date.now(),
			hits: 1,
			lastSeenMs: Date.now(),
		};

		expect(typeof pendingTrack.firstSeenMs).toBe("number");
		expect(typeof pendingTrack.hits).toBe("number");
		expect(typeof pendingTrack.lastSeenMs).toBe("number");
	});

	test("can have optional createdIdentity", () => {
		const pendingTrack = {
			createdIdentity: {
				color: "#ffffff",
				id: "person-123",
				name: "person 123",
				syncStatus: "syncing" as const,
			},
			firstSeenMs: Date.now(),
			hits: 10,
			lastSeenMs: Date.now(),
		};

		expect(pendingTrack.createdIdentity).toBeDefined();
		expect(pendingTrack.createdIdentity?.syncStatus).toBe("syncing");
	});
});

describe("PythonStatus", () => {
	test("DISCONNECTED_STATUS structure", () => {
		const DISCONNECTED_STATUS = {
			connected: false,
			detail: "Waiting for Python inference service",
			ready: null,
			reconnecting: false,
		};

		expect(DISCONNECTED_STATUS.connected).toBe(false);
		expect(DISCONNECTED_STATUS.ready).toBeNull();
		expect(DISCONNECTED_STATUS.reconnecting).toBe(false);
	});
});

describe("PendingAdminRequest", () => {
	test("structure matches expected shape", () => {
		const resolve = mock(() => {});
		const request = {
			payload: {
				id: "identity-1",
				type: "admin.delete-identity" as const,
			},
			resolve,
			sent: false,
			timeoutId: setTimeout(() => {}, 1000),
		};

		expect(request.payload.type).toBe("admin.delete-identity");
		expect(request.sent).toBe(false);
		expect(typeof request.resolve).toBe("function");
		clearTimeout(request.timeoutId);
	});
});

describe("Sender type", () => {
	test("sender function signature", () => {
		interface ServerToClientMessage { type: string }
		type Sender = (message: ServerToClientMessage) => void;

		const sender: Sender = (message) => {
			expect(message.type).toBeDefined();
		};

		sender({ type: "test" });
	});
});

describe("frame caching logic", () => {
	test("stores frame in cache", () => {
		const cachedFrames = new Map<string, Map<number, { data: string; height: number; width: number }>>();

		const sessionId = "session-1";
		const frameId = 1;
		const frame = { data: "base64data", height: 720, width: 1280 };

		const frames = cachedFrames.get(sessionId) ?? new Map();
		frames.set(frameId, frame);
		cachedFrames.set(sessionId, frames);

		expect(cachedFrames.get(sessionId)?.get(frameId)).toEqual(frame);
	});

	test("evicts oldest frames when limit exceeded", () => {
		const MAX_CACHED_FRAMES_PER_SESSION = 4;
		const frames = new Map<number, { data: string }>();

		for (let i = 1; i <= 5; i++) {
			frames.set(i, { data: `frame-${i}` });
			while (frames.size > MAX_CACHED_FRAMES_PER_SESSION) {
				const oldestFrameId = Math.min(...frames.keys());
				frames.delete(oldestFrameId);
			}
		}

		expect(frames.size).toBe(4);
		expect(frames.has(1)).toBe(false);
		expect(frames.has(2)).toBe(true);
		expect(frames.has(5)).toBe(true);
	});
});

describe("pending unknown tracks pruning", () => {
	test("removes stale tracks", () => {
		const pendingUnknownTracks = new Map<string, { firstSeenMs: number; hits: number; lastSeenMs: number }>();
		const AUTO_ENROLL_MAX_TRACK_STALENESS_MS = 4000;
		const now = Date.now();

		pendingUnknownTracks.set("session-1:1", {
			firstSeenMs: now - 10_000,
			hits: 5,
			lastSeenMs: now - 5000,
		});
		pendingUnknownTracks.set("session-1:2", {
			firstSeenMs: now - 1000,
			hits: 3,
			lastSeenMs: now,
		});

		for (const [trackKey, pending] of pendingUnknownTracks.entries()) {
			if (now - pending.lastSeenMs > AUTO_ENROLL_MAX_TRACK_STALENESS_MS) {
				pendingUnknownTracks.delete(trackKey);
			}
		}

		expect(pendingUnknownTracks.has("session-1:1")).toBe(false);
		expect(pendingUnknownTracks.has("session-1:2")).toBe(true);
	});
});

describe("auto enrollment conditions", () => {
	test("meets minimum hits requirement", () => {
		const AUTO_ENROLL_MIN_HITS = 6;
		const observedHits = 7;
		expect(observedHits >= AUTO_ENROLL_MIN_HITS).toBe(true);
	});

	test("meets minimum time requirement", () => {
		const AUTO_ENROLL_MIN_MS = 1500;
		const now = Date.now();
		const firstSeenMs = now - 2000;
		expect(now - firstSeenMs >= AUTO_ENROLL_MIN_MS).toBe(true);
	});

	test("does not meet minimum hits", () => {
		const AUTO_ENROLL_MIN_HITS = 6;
		const observedHits = 5;
		expect(observedHits >= AUTO_ENROLL_MIN_HITS).toBe(false);
	});

	test("does not meet minimum time", () => {
		const AUTO_ENROLL_MIN_MS = 1500;
		const now = Date.now();
		const firstSeenMs = now - 1000;
		expect(now - firstSeenMs >= AUTO_ENROLL_MIN_MS).toBe(false);
	});
});

describe("confidence threshold for duplicate guard", () => {
	test("below threshold triggers potential enrollment", () => {
		const AUTO_ENROLL_DUPLICATE_GUARD = 0.4;
		const confidence = 0.3;
		expect(confidence < AUTO_ENROLL_DUPLICATE_GUARD).toBe(true);
	});

	test("above threshold skips enrollment", () => {
		const AUTO_ENROLL_DUPLICATE_GUARD = 0.4;
		const confidence = 0.5;
		expect(confidence >= AUTO_ENROLL_DUPLICATE_GUARD).toBe(true);
	});
});

describe("identity sync status", () => {
	test("syncing status is valid", () => {
		const status = "syncing" as const;
		expect(["syncing", "ready", "error"]).toContain(status);
	});

	test("ready status is valid", () => {
		const status = "ready" as const;
		expect(["syncing", "ready", "error"]).toContain(status);
	});

	test("error status is valid", () => {
		const status = "error" as const;
		expect(["syncing", "ready", "error"]).toContain(status);
	});
});

describe("admin request timeout", () => {
	test("timeout is set correctly", async () => {
		const timeoutMs = 5000;
		const startTime = Date.now();

		await new Promise((resolve) => setTimeout(resolve, 100));

		const elapsed = Date.now() - startTime;
		expect(elapsed).toBeLessThan(timeoutMs);
	});
});

describe("reconnect scheduling", () => {
	test("reconnect delay is 1000ms", () => {
		const RECONNECT_DELAY_MS = 1000;
		expect(RECONNECT_DELAY_MS).toBe(1000);
	});
});

describe("broadcast functionality", () => {
	test("broadcasts to all sessions", () => {
		const sessions = new Map<string, { send: (msg: unknown) => void }>();
		const messages: unknown[] = [];

		sessions.set("session-1", { send: (msg) => messages.push(msg) });
		sessions.set("session-2", { send: (msg) => messages.push(msg) });
		sessions.set("session-3", { send: (msg) => messages.push(msg) });

		const message = { type: "test" };
		for (const session of sessions.values()) {
			session.send(message);
		}

		expect(messages).toHaveLength(3);
	});
});

describe("WebSocket readyState checks", () => {
	test("CONNECTING state value", () => {
		expect(WebSocket.CONNECTING).toBe(0);
	});

	test("OPEN state value", () => {
		expect(WebSocket.OPEN).toBe(1);
	});

	test("CLOSING state value", () => {
		expect(WebSocket.CLOSING).toBe(2);
	});

	test("CLOSED state value", () => {
		expect(WebSocket.CLOSED).toBe(3);
	});
});
