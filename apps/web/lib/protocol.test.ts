import { describe, expect, test } from "bun:test";
import { parseClientMessage, stringifyMessage, DEFAULT_SAMPLING } from './protocol';
import type { PythonAdminMessage, PythonFrameProcessMessage, ServerToClientMessage } from './protocol';

describe("parseClientMessage", () => {
	describe("client.hello", () => {
		test("parses client.hello without sessionId", () => {
			const raw = JSON.stringify({ type: "client.hello" });
			const result = parseClientMessage(raw);
			expect(result).toEqual({ type: "client.hello" });
		});

		test("parses client.hello with sessionId", () => {
			const raw = JSON.stringify({
				sessionId: "test-session-123",
				type: "client.hello",
			});
			const result = parseClientMessage(raw);
			expect(result).toEqual({
				sessionId: "test-session-123",
				type: "client.hello",
			});
		});

		test("parses client.hello from Buffer", () => {
			const raw = Buffer.from(JSON.stringify({ type: "client.hello" }));
			const result = parseClientMessage(raw);
			expect(result).toEqual({ type: "client.hello" });
		});
	});

	describe("signal", () => {
		test("parses signal with answer type", () => {
			const raw = JSON.stringify({
				payload: { sdp: "test-sdp" },
				sessionId: "session-1",
				signalType: "answer",
				type: "signal",
			});
			const result = parseClientMessage(raw);
			expect(result).toEqual({
				payload: { sdp: "test-sdp" },
				sessionId: "session-1",
				signalType: "answer",
				type: "signal",
			});
		});

		test("parses signal with offer type", () => {
			const raw = JSON.stringify({
				payload: { sdp: "offer-sdp" },
				sessionId: "session-2",
				signalType: "offer",
				type: "signal",
			});
			const result = parseClientMessage(raw);
			expect(result).toEqual({
				payload: { sdp: "offer-sdp" },
				sessionId: "session-2",
				signalType: "offer",
				type: "signal",
			});
		});

		test("parses signal with ice type", () => {
			const raw = JSON.stringify({
				payload: { candidate: "ice-candidate" },
				sessionId: "session-3",
				signalType: "ice",
				type: "signal",
			});
			const result = parseClientMessage(raw);
			expect(result).toEqual({
				payload: { candidate: "ice-candidate" },
				sessionId: "session-3",
				signalType: "ice",
				type: "signal",
			});
		});

		test("throws for invalid signalType", () => {
			const raw = JSON.stringify({
				payload: {},
				sessionId: "session-1",
				signalType: "invalid",
				type: "signal",
			});
			expect(() => parseClientMessage(raw)).toThrow(TypeError);
		});

		test("throws for missing sessionId in signal", () => {
			const raw = JSON.stringify({
				payload: {},
				signalType: "answer",
				type: "signal",
			});
			expect(() => parseClientMessage(raw)).toThrow(TypeError);
		});
	});

	describe("frame.submit", () => {
		test("parses valid frame.submit message", () => {
			const raw = JSON.stringify({
				capturedAt: 1_234_567_890,
				frameId: 1,
				image: {
					data: "base64imagedata",
					height: 720,
					mimeType: "image/jpeg",
					width: 1280,
				},
				sampleIntervalMs: 80,
				sessionId: "session-1",
				type: "frame.submit",
			});
			const result = parseClientMessage(raw);
			expect(result).toEqual({
				capturedAt: 1_234_567_890,
				frameId: 1,
				image: {
					data: "base64imagedata",
					height: 720,
					mimeType: "image/jpeg",
					width: 1280,
				},
				sampleIntervalMs: 80,
				sessionId: "session-1",
				type: "frame.submit",
			});
		});

		test("throws for invalid mimeType", () => {
			const raw = JSON.stringify({
				capturedAt: 1_234_567_890,
				frameId: 1,
				image: {
					data: "base64imagedata",
					height: 720,
					mimeType: "image/png",
					width: 1280,
				},
				sampleIntervalMs: 80,
				sessionId: "session-1",
				type: "frame.submit",
			});
			expect(() => parseClientMessage(raw)).toThrow(TypeError);
		});

		test("throws for missing image data", () => {
			const raw = JSON.stringify({
				capturedAt: 1_234_567_890,
				frameId: 1,
				image: {
					height: 720,
					mimeType: "image/jpeg",
					width: 1280,
				},
				sampleIntervalMs: 80,
				sessionId: "session-1",
				type: "frame.submit",
			});
			expect(() => parseClientMessage(raw)).toThrow(TypeError);
		});

		test("throws for missing sessionId", () => {
			const raw = JSON.stringify({
				capturedAt: 1_234_567_890,
				frameId: 1,
				image: {
					data: "base64imagedata",
					height: 720,
					mimeType: "image/jpeg",
					width: 1280,
				},
				sampleIntervalMs: 80,
				type: "frame.submit",
			});
			expect(() => parseClientMessage(raw)).toThrow(TypeError);
		});

		test("throws for non-number frameId", () => {
			const raw = JSON.stringify({
				capturedAt: 1_234_567_890,
				frameId: "not-a-number",
				image: {
					data: "base64imagedata",
					height: 720,
					mimeType: "image/jpeg",
					width: 1280,
				},
				sampleIntervalMs: 80,
				sessionId: "session-1",
				type: "frame.submit",
			});
			expect(() => parseClientMessage(raw)).toThrow(TypeError);
		});
	});

	describe("error cases", () => {
		test("throws for invalid JSON", () => {
			expect(() => parseClientMessage("not valid json")).toThrow();
		});

		test("throws for non-object payload", () => {
			expect(() => parseClientMessage(JSON.stringify("string"))).toThrow(
				TypeError
			);
		});

		test("throws for null payload", () => {
			expect(() => parseClientMessage(JSON.stringify(null))).toThrow(
				TypeError
			);
		});

		test("throws for missing type", () => {
			expect(() =>
				parseClientMessage(JSON.stringify({ sessionId: "test" }))
			).toThrow(TypeError);
		});

		test("throws for non-string type", () => {
			expect(() =>
				parseClientMessage(JSON.stringify({ type: 123 }))
			).toThrow(TypeError);
		});

		test("throws for unsupported message type", () => {
			expect(() =>
				parseClientMessage(JSON.stringify({ type: "unknown.type" }))
			).toThrow(TypeError);
		});
	});
});

describe("stringifyMessage", () => {
	test("stringifies PythonAdminMessage", () => {
		const message: PythonAdminMessage = {
			id: "identity-1",
			type: "admin.delete-identity",
		};
		const result = stringifyMessage(message);
		expect(JSON.parse(result)).toEqual(message);
	});

	test("stringifies PythonFrameProcessMessage", () => {
		const message: PythonFrameProcessMessage = {
			capturedAt: 1_234_567_890,
			frameId: 1,
			image: {
				data: "base64data",
				height: 720,
				mimeType: "image/jpeg",
				width: 1280,
			},
			sampleIntervalMs: 80,
			sessionId: "session-1",
			type: "frame.process",
		};
		const result = stringifyMessage(message);
		expect(JSON.parse(result)).toEqual(message);
	});

	test("stringifies ServerToClientMessage", () => {
		const message: ServerToClientMessage = {
			sampling: {
				intervalMs: 80,
				jpegQuality: 0.5,
				maxWidth: 320,
			},
			sessionId: "session-1",
			type: "session.ready",
		};
		const result = stringifyMessage(message);
		expect(JSON.parse(result)).toEqual(message);
	});

	test("stringifies PythonAdminUpsertIdentityMessage", () => {
		const message: PythonAdminMessage = {
			files: [
				{
					data: "base64filedata",
					name: "ref-1.jpg",
				},
			],
			id: "identity-1",
			metadata: {
				color: "#ffffff",
				name: "Test User",
			},
			type: "admin.upsert-identity",
		};
		const result = stringifyMessage(message);
		expect(JSON.parse(result)).toEqual(message);
	});

	test("stringifies ServerErrorMessage", () => {
		const message: ServerToClientMessage = {
			message: "Test error message",
			type: "error",
		};
		const result = stringifyMessage(message);
		expect(JSON.parse(result)).toEqual(message);
	});

	test("stringifies ServerEnrollmentSyncMessage", () => {
		const message: ServerToClientMessage = {
			identityId: "identity-1",
			status: "syncing",
			type: "enrollment.sync",
		};
		const result = stringifyMessage(message);
		expect(JSON.parse(result)).toEqual(message);
	});

	test("stringifies ServerEnrollmentSyncMessage with error", () => {
		const message: ServerToClientMessage = {
			error: "Sync failed",
			identityId: "identity-1",
			status: "error",
			type: "enrollment.sync",
		};
		const result = stringifyMessage(message);
		expect(JSON.parse(result)).toEqual(message);
	});

	test("stringifies PythonFrameResultMessage", () => {
		const message: ServerToClientMessage = {
			capturedAt: 1_234_567_890,
			faces: [
				{
					bbox: { height: 50, width: 50, x: 100, y: 100 },
					confidence: 0.95,
					identity: null,
					isUnknown: true,
					trackId: 1,
				},
			],
			frameId: 1,
			indexVersion: 1,
			latencyMs: 50,
			providers: ["test-provider"],
			sampleIntervalMs: 80,
			sessionId: "session-1",
			sourceSize: { height: 720, width: 1280 },
			type: "frame.result",
		};
		const result = stringifyMessage(message);
		expect(JSON.parse(result)).toEqual(message);
	});
});

describe("DEFAULT_SAMPLING", () => {
	test("has correct default values", () => {
		expect(DEFAULT_SAMPLING).toEqual({
			intervalMs: 80,
			jpegQuality: 0.5,
			maxWidth: 320,
		});
	});

	test("values are constant", () => {
		expect(DEFAULT_SAMPLING.intervalMs).toBe(80);
		expect(DEFAULT_SAMPLING.jpegQuality).toBe(0.5);
		expect(DEFAULT_SAMPLING.maxWidth).toBe(320);
	});
});

describe("type safety", () => {
	test("parseClientMessage returns correct union type", () => {
		const helloResult = parseClientMessage(
			JSON.stringify({ type: "client.hello" })
		);
		expect(helloResult.type).toBe("client.hello");

		const signalResult = parseClientMessage(
			JSON.stringify({
				payload: {},
				sessionId: "s1",
				signalType: "answer",
				type: "signal",
			})
		);
		expect(signalResult.type).toBe("signal");

		const frameResult = parseClientMessage(
			JSON.stringify({
				capturedAt: 1,
				frameId: 1,
				image: {
					data: "d",
					height: 1,
					mimeType: "image/jpeg",
					width: 1,
				},
				sampleIntervalMs: 80,
				sessionId: "s1",
				type: "frame.submit",
			})
		);
		expect(frameResult.type).toBe("frame.submit");
	});
});

describe("edge cases", () => {
	test("handles empty string payload", () => {
		expect(() => parseClientMessage("")).toThrow();
	});

	test("handles deeply nested payload in signal", () => {
		const deepPayload = {
			level1: {
				level2: {
					level3: {
						value: "deep",
					},
				},
			},
		};
		const raw = JSON.stringify({
			payload: deepPayload,
			sessionId: "session-1",
			signalType: "answer",
			type: "signal",
		});
		const result = parseClientMessage(raw);
		if (result.type === "signal") {
			expect(result.payload).toEqual(deepPayload);
		}
	});

	test("handles special characters in sessionId", () => {
		const raw = JSON.stringify({
			sessionId: "session-with-special-chars-!@#$%^&*()",
			type: "client.hello",
		});
		const result = parseClientMessage(raw);
		expect(result).toEqual({
			sessionId: "session-with-special-chars-!@#$%^&*()",
			type: "client.hello",
		});
	});

	test("handles unicode in identity metadata when stringifying", () => {
		const message: ServerToClientMessage = {
			capturedAt: 1_234_567_890,
			faces: [
				{
					bbox: { height: 100, width: 100, x: 0, y: 0 },
					confidence: 0.9,
					identity: {
						color: "#ffffff",
						id: "user-1",
						name: "用户名",
					},
					isUnknown: false,
					trackId: 1,
				},
			],
			frameId: 1,
			indexVersion: 1,
			latencyMs: 50,
			providers: [],
			sampleIntervalMs: 80,
			sessionId: "session-1",
			sourceSize: { height: 720, width: 1280 },
			type: "frame.result",
		};
		const result = stringifyMessage(message);
		const parsed = JSON.parse(result);
		expect(parsed.faces[0].identity.name).toBe("用户名");
	});

	test("handles very large frameId", () => {
		const raw = JSON.stringify({
			capturedAt: 1_234_567_890,
			frameId: Number.MAX_SAFE_INTEGER,
			image: {
				data: "base64",
				height: 1,
				mimeType: "image/jpeg",
				width: 1,
			},
			sampleIntervalMs: 80,
			sessionId: "session-1",
			type: "frame.submit",
		});
		const result = parseClientMessage(raw);
		if (result.type === "frame.submit") {
			expect(result.frameId).toBe(Number.MAX_SAFE_INTEGER);
		}
	});

	test("handles negative frameId", () => {
		const raw = JSON.stringify({
			capturedAt: 1_234_567_890,
			frameId: -1,
			image: {
				data: "base64",
				height: 1,
				mimeType: "image/jpeg",
				width: 1,
			},
			sampleIntervalMs: 80,
			sessionId: "session-1",
			type: "frame.submit",
		});
		const result = parseClientMessage(raw);
		if (result.type === "frame.submit") {
			expect(result.frameId).toBe(-1);
		}
	});

	test("handles zero dimensions in image", () => {
		const raw = JSON.stringify({
			capturedAt: 1_234_567_890,
			frameId: 1,
			image: {
				data: "base64",
				height: 0,
				mimeType: "image/jpeg",
				width: 0,
			},
			sampleIntervalMs: 80,
			sessionId: "session-1",
			type: "frame.submit",
		});
		const result = parseClientMessage(raw);
		if (result.type === "frame.submit") {
			expect(result.image.height).toBe(0);
			expect(result.image.width).toBe(0);
		}
	});
});
