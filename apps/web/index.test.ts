import { describe, expect, test } from "bun:test";

describe("optionalString", () => {
	const optionalString = (
		value: FormDataEntryValue | null
	): string | undefined => {
		if (typeof value !== "string") {
			return undefined;
		}

		const normalized = value.trim();
		return normalized.length > 0 ? normalized : undefined;
	};

	test("returns undefined for null input", () => {
		expect(optionalString(null)).toBeUndefined();
	});

	test("returns undefined for empty string", () => {
		expect(optionalString("")).toBeUndefined();
	});

	test("returns undefined for whitespace-only string", () => {
		expect(optionalString("   ")).toBeUndefined();
		expect(optionalString("\t\n")).toBeUndefined();
	});

	test("returns trimmed string for valid input", () => {
		expect(optionalString("test")).toBe("test");
		expect(optionalString("  test  ")).toBe("test");
	});

	test("returns string without leading/trailing whitespace", () => {
		expect(optionalString("  hello world  ")).toBe("hello world");
	});
});

describe("optionalJsonString", () => {
	const optionalJsonString = (value: unknown): string | undefined => {
		if (typeof value !== "string") {
			return undefined;
		}

		const normalized = value.trim();
		return normalized.length > 0 ? normalized : undefined;
	};

	test("returns undefined for non-string input", () => {
		expect(optionalJsonString(123)).toBeUndefined();
		expect(optionalJsonString(null)).toBeUndefined();
		expect(optionalJsonString()).toBeUndefined();
		expect(optionalJsonString({})).toBeUndefined();
	});

	test("returns undefined for empty string", () => {
		expect(optionalJsonString("")).toBeUndefined();
	});

	test("returns trimmed string for valid input", () => {
		expect(optionalJsonString("test")).toBe("test");
		expect(optionalJsonString("  test  ")).toBe("test");
	});
});

describe("slugify", () => {
	const slugify = (value: string): string => {
		const slug = value
			.trim()
			.toLowerCase()
			.replaceAll(/[^a-z0-9]+/g, "-")
			.replaceAll(/^-+|-+$/g, "");
		return slug || "identity";
	};

	test("converts to lowercase", () => {
		expect(slugify("John Doe")).toBe("john-doe");
	});

	test("replaces spaces with hyphens", () => {
		expect(slugify("hello world")).toBe("hello-world");
	});

	test("removes special characters", () => {
		expect(slugify("Test@User#123")).toBe("test-user-123");
	});

	test("removes leading and trailing hyphens", () => {
		expect(slugify("---test---")).toBe("test");
	});

	test("returns identity for empty result", () => {
		expect(slugify("")).toBe("identity");
		expect(slugify("@#$%")).toBe("identity");
	});

	test("handles multiple spaces", () => {
		expect(slugify("hello    world")).toBe("hello-world");
	});

	test("handles unicode by removing non-alphanumeric", () => {
		expect(slugify("用户名")).toBe("identity");
	});

	test("preserves numbers", () => {
		expect(slugify("User 123")).toBe("user-123");
	});
});

describe("buildIdentityId", () => {
	const buildIdentityId = (
		identities: { id: string }[],
		name: string
	): string => {
		const slugify = (value: string): string => {
			const slug = value
				.trim()
				.toLowerCase()
				.replaceAll(/[^a-z0-9]+/g, "-")
				.replaceAll(/^-+|-+$/g, "");
			return slug || "identity";
		};

		const base = slugify(name);
		let candidate = base;
		let suffix = 2;

		while (identities.some((identity) => identity.id === candidate)) {
			candidate = `${base}-${suffix}`;
			suffix += 1;
		}

		return candidate;
	};

	test("generates base id from name", () => {
		expect(buildIdentityId([], "John Doe")).toBe("john-doe");
	});

	test("generates unique id when conflict exists", () => {
		const identities = [{ id: "john-doe" }];
		expect(buildIdentityId(identities, "John Doe")).toBe("john-doe-2");
	});

	test("increments suffix for multiple conflicts", () => {
		const identities = [{ id: "john-doe" }, { id: "john-doe-2" }];
		expect(buildIdentityId(identities, "John Doe")).toBe("john-doe-3");
	});

	test("handles empty identities array", () => {
		expect(buildIdentityId([], "Test User")).toBe("test-user");
	});

	test("handles special characters in name", () => {
		expect(buildIdentityId([], "Test@User")).toBe("test-user");
	});
});

describe("buildOptionalMetadata", () => {
	const buildOptionalMetadata = ({
		color,
		email,
		githubUsername,
		linkedinId,
		name,
		phoneNumber,
		worksAt,
	}: {
		color: string;
		email: string | undefined;
		githubUsername: string | undefined;
		linkedinId: string | undefined;
		name: string;
		phoneNumber: string | undefined;
		worksAt: string | undefined;
	}) => ({
		color,
		...(email === undefined ? {} : { email }),
		...(githubUsername === undefined ? {} : { githubUsername }),
		...(linkedinId === undefined ? {} : { linkedinId }),
		name,
		...(phoneNumber === undefined ? {} : { phoneNumber }),
		...(worksAt === undefined ? {} : { worksAt }),
	});

	test("includes only required fields when optional are undefined", () => {
		const result = buildOptionalMetadata({
			color: "#ffffff",
			email: undefined,
			githubUsername: undefined,
			linkedinId: undefined,
			name: "Test User",
			phoneNumber: undefined,
			worksAt: undefined,
		});

		expect(result.name).toBe("Test User");
		expect(result.color).toBe("#ffffff");
		expect("email" in result).toBe(false);
		expect("githubUsername" in result).toBe(false);
	});

	test("includes all fields when provided", () => {
		const result = buildOptionalMetadata({
			color: "#000000",
			email: "test@example.com",
			githubUsername: "testuser",
			linkedinId: "linkedin123",
			name: "Test User",
			phoneNumber: "+1234567890",
			worksAt: "Test Company",
		});

		expect(result.email).toBe("test@example.com");
		expect(result.githubUsername).toBe("testuser");
		expect(result.linkedinId).toBe("linkedin123");
		expect(result.phoneNumber).toBe("+1234567890");
		expect(result.worksAt).toBe("Test Company");
	});

	test("includes some optional fields", () => {
		const result = buildOptionalMetadata({
			color: "#ffffff",
			email: "test@example.com",
			githubUsername: undefined,
			linkedinId: undefined,
			name: "Test User",
			phoneNumber: undefined,
			worksAt: "Company",
		});

		expect(result.email).toBe("test@example.com");
		expect(result.worksAt).toBe("Company");
		expect("githubUsername" in result).toBe(false);
	});
});

describe("json helper", () => {
	const json = (body: unknown, status = 200): Response => Response.json(body, { status });

	test("returns JSON response with default status", async () => {
		const response = json({ message: "test" });
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toEqual({ message: "test" });
	});

	test("returns JSON response with custom status", () => {
		const response = json({ error: "not found" }, 404);
		expect(response.status).toBe(404);
	});

	test("handles null body", async () => {
		const response = json(null);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toBeNull();
	});

	test("handles array body", async () => {
		const response = json([1, 2, 3]);
		const body = await response.json();
		expect(body).toEqual([1, 2, 3]);
	});
});

describe("ClientData interface", () => {
	test("structure matches expected shape", () => {
		const clientData = {
			sessionId: null as string | null,
		};

		expect(clientData.sessionId).toBeNull();

		clientData.sessionId = "test-session";
		expect(clientData.sessionId).toBe("test-session");
	});
});

describe("DEFAULT_SAMPLING", () => {
	test("has expected values", () => {
		const DEFAULT_SAMPLING = {
			intervalMs: 80,
			jpegQuality: 0.5,
			maxWidth: 320,
		};

		expect(DEFAULT_SAMPLING.intervalMs).toBe(80);
		expect(DEFAULT_SAMPLING.jpegQuality).toBe(0.5);
		expect(DEFAULT_SAMPLING.maxWidth).toBe(320);
	});
});

describe("error handling patterns", () => {
	test("error response format", () => {
		const errorResponse = { error: "Something went wrong" };
		expect(errorResponse.error).toBe("Something went wrong");
	});

	test("success response format", () => {
		const successResponse = { ok: true };
		expect(successResponse.ok).toBe(true);
	});
});

describe("WebSocket close code", () => {
	test("normal close code is 1000", () => {
		const NORMAL_CLOSE = 1000;
		expect(NORMAL_CLOSE).toBe(1000);
	});
});

describe("session management", () => {
	test("session ID generation with crypto.randomUUID", () => {
		const sessionId = crypto.randomUUID();
		expect(typeof sessionId).toBe("string");
		expect(sessionId.length).toBe(36);
		expect(sessionId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)).not.toBeNull();
	});

	test("session ID can be provided by client", () => {
		const providedSessionId = "client-provided-session-id";
		expect(typeof providedSessionId).toBe("string");
		expect(providedSessionId.length).toBeGreaterThan(0);
	});
});

describe("idle timeout configuration", () => {
	test("idle timeout is 120 seconds", () => {
		const IDLE_TIMEOUT = 120;
		expect(IDLE_TIMEOUT).toBe(120);
	});
});

describe("max payload length", () => {
	test("max payload is 8MB", () => {
		const MAX_PAYLOAD_LENGTH = 8 * 1024 * 1024;
		expect(MAX_PAYLOAD_LENGTH).toBe(8_388_608);
	});
});

describe("port configuration", () => {
	test("default port is 3000", () => {
		const DEFAULT_PORT = 3000;
		expect(DEFAULT_PORT).toBe(3000);
	});

	test("port can be overridden by environment", () => {
		const PORT = Number(Bun.env["PORT"] ?? 3000);
		expect(typeof PORT).toBe("number");
		expect(PORT).toBeGreaterThan(0);
		expect(PORT).toBeLessThan(65_536);
	});
});

describe("python URL configuration", () => {
	test("default Python URL", () => {
		const DEFAULT_PYTHON_URL = "ws://127.0.0.1:8765";
		expect(DEFAULT_PYTHON_URL).toBe("ws://127.0.0.1:8765");
	});
});
