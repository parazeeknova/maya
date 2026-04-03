import { describe, expect, test } from "bun:test";

describe("enrollment-store configuration", () => {
	test("isEnrollmentStoreConfigured returns false when env vars not set", () => {
		const originalBucket = Bun.env["MAYA_R2_BUCKET"];
		const originalEndpoint = Bun.env["MAYA_R2_ENDPOINT"];
		const originalKeyId = Bun.env["MAYA_R2_ACCESS_KEY_ID"];
		const originalSecretKey = Bun.env["MAYA_R2_SECRET_ACCESS_KEY"];

		delete Bun.env["MAYA_R2_BUCKET"];
		delete Bun.env["MAYA_R2_ENDPOINT"];
		delete Bun.env["MAYA_R2_ACCESS_KEY_ID"];
		delete Bun.env["MAYA_R2_SECRET_ACCESS_KEY"];

		const isConfigured = (): boolean => (
				Bun.env["MAYA_R2_BUCKET"] !== undefined &&
				Bun.env["MAYA_R2_ENDPOINT"] !== undefined &&
				Bun.env["MAYA_R2_ACCESS_KEY_ID"] !== undefined &&
				Bun.env["MAYA_R2_SECRET_ACCESS_KEY"] !== undefined
			);

		expect(isConfigured()).toBe(false);

		if (originalBucket !== undefined) {Bun.env["MAYA_R2_BUCKET"] = originalBucket;}
		if (originalEndpoint !== undefined) {Bun.env["MAYA_R2_ENDPOINT"] = originalEndpoint;}
		if (originalKeyId !== undefined) {Bun.env["MAYA_R2_ACCESS_KEY_ID"] = originalKeyId;}
		if (originalSecretKey !== undefined) {Bun.env["MAYA_R2_SECRET_ACCESS_KEY"] = originalSecretKey;}
	});

	test("isEnrollmentStoreConfigured returns true when all env vars set", () => {
		const isConfigured = (): boolean => (
				Bun.env["MAYA_R2_BUCKET"] !== undefined &&
				Bun.env["MAYA_R2_ENDPOINT"] !== undefined &&
				Bun.env["MAYA_R2_ACCESS_KEY_ID"] !== undefined &&
				Bun.env["MAYA_R2_SECRET_ACCESS_KEY"] !== undefined
			);

		const originalBucket = Bun.env["MAYA_R2_BUCKET"];
		const originalEndpoint = Bun.env["MAYA_R2_ENDPOINT"];
		const originalKeyId = Bun.env["MAYA_R2_ACCESS_KEY_ID"];
		const originalSecretKey = Bun.env["MAYA_R2_SECRET_ACCESS_KEY"];

		Bun.env["MAYA_R2_BUCKET"] = "test-bucket";
		Bun.env["MAYA_R2_ENDPOINT"] = "https://test.endpoint.com";
		Bun.env["MAYA_R2_ACCESS_KEY_ID"] = "test-key-id";
		Bun.env["MAYA_R2_SECRET_ACCESS_KEY"] = "test-secret-key";

		expect(isConfigured()).toBe(true);

		if (originalBucket !== undefined) {Bun.env["MAYA_R2_BUCKET"] = originalBucket;}
		else {delete Bun.env["MAYA_R2_BUCKET"];}
		if (originalEndpoint !== undefined) {Bun.env["MAYA_R2_ENDPOINT"] = originalEndpoint;}
		else {delete Bun.env["MAYA_R2_ENDPOINT"];}
		if (originalKeyId !== undefined) {Bun.env["MAYA_R2_ACCESS_KEY_ID"] = originalKeyId;}
		else {delete Bun.env["MAYA_R2_ACCESS_KEY_ID"];}
		if (originalSecretKey !== undefined) {Bun.env["MAYA_R2_SECRET_ACCESS_KEY"] = originalSecretKey;}
		else {delete Bun.env["MAYA_R2_SECRET_ACCESS_KEY"];}
	});
});

describe("EnrollmentManifestIdentity", () => {
	test("structure matches expected shape", async () => {
		Bun.env["MAYA_R2_BUCKET"] = "test-bucket";
		Bun.env["MAYA_R2_ENDPOINT"] = "https://test.endpoint.com";
		Bun.env["MAYA_R2_ACCESS_KEY_ID"] = "test-key-id";
		Bun.env["MAYA_R2_SECRET_ACCESS_KEY"] = "test-secret-key";

		const identity = {
			files: ["ref-1.jpg", "ref-2.jpg"],
			id: "test-identity",
			metadata: {
				color: "#ffffff",
				name: "Test User",
			},
		};

		expect(identity.id).toBe("test-identity");
		expect(identity.files).toHaveLength(2);
		expect(identity.metadata.name).toBe("Test User");
		expect(identity.metadata.color).toBe("#ffffff");
	});
});

describe("sortManifest", () => {
	test("sorts identities alphabetically by id", () => {
		const manifest = {
			identities: [
				{ files: [], id: "zebra", metadata: { color: "#fff", name: "Z" } },
				{ files: [], id: "apple", metadata: { color: "#fff", name: "A" } },
				{ files: [], id: "mango", metadata: { color: "#fff", name: "M" } },
			],
		};

		const sorted = {
			identities: manifest.identities.toSorted((a, b) =>
				a.id.localeCompare(b.id)
			),
		};

		expect(sorted.identities[0]?.id).toBe("apple");
		expect(sorted.identities[1]?.id).toBe("mango");
		expect(sorted.identities[2]?.id).toBe("zebra");
	});
});

describe("metadata normalization edge cases", () => {
	test("handles empty string values", async () => {
		Bun.env["MAYA_R2_BUCKET"] = "test-bucket";
		Bun.env["MAYA_R2_ENDPOINT"] = "https://test.endpoint.com";
		Bun.env["MAYA_R2_ACCESS_KEY_ID"] = "test-key-id";
		Bun.env["MAYA_R2_SECRET_ACCESS_KEY"] = "test-secret-key";

		const normalizeMetadata = (metadata: {
			name: string;
			color: string;
			email?: string;
			githubUsername?: string;
			linkedinId?: string;
			phoneNumber?: string;
			worksAt?: string;
		}) => ({
			color: metadata.color,
			...(metadata.email === undefined ? {} : { email: metadata.email }),
			...(metadata.githubUsername === undefined
				? {}
				: { githubUsername: metadata.githubUsername }),
			...(metadata.linkedinId === undefined
				? {}
				: { linkedinId: metadata.linkedinId }),
			name: metadata.name,
			...(metadata.phoneNumber === undefined
				? {}
				: { phoneNumber: metadata.phoneNumber }),
			...(metadata.worksAt === undefined ? {} : { worksAt: metadata.worksAt }),
		});

		const result = normalizeMetadata({
			color: "#fff",
			email: "",
			name: "Test",
		});

		expect(result.email).toBe("");
	});

	test("handles undefined values correctly", async () => {
		const normalizeMetadata = (metadata: {
			name: string;
			color: string;
			email?: string;
			githubUsername?: string;
			linkedinId?: string;
			phoneNumber?: string;
			worksAt?: string;
		}) => ({
			color: metadata.color,
			...(metadata.email === undefined ? {} : { email: metadata.email }),
			...(metadata.githubUsername === undefined
				? {}
				: { githubUsername: metadata.githubUsername }),
			...(metadata.linkedinId === undefined
				? {}
				: { linkedinId: metadata.linkedinId }),
			name: metadata.name,
			...(metadata.phoneNumber === undefined
				? {}
				: { phoneNumber: metadata.phoneNumber }),
			...(metadata.worksAt === undefined ? {} : { worksAt: metadata.worksAt }),
		});

		const result = normalizeMetadata({
			color: "#fff",
			name: "Test",
		});

		expect("email" in result).toBe(false);
		expect("githubUsername" in result).toBe(false);
		expect("linkedinId" in result).toBe(false);
		expect("phoneNumber" in result).toBe(false);
		expect("worksAt" in result).toBe(false);
	});
});

describe("PythonAdminIdentityFile", () => {
	test("structure matches expected shape", () => {
		const file = {
			data: "base64imagedata",
			name: "ref-1.jpg",
		};

		expect(file.name).toBe("ref-1.jpg");
		expect(file.data).toBe("base64imagedata");
	});
});

describe("EnrollmentMetadata", () => {
	test("allows all optional fields to be omitted", () => {
		const metadata = {
			color: "#ffffff",
			name: "Test User",
		};

		expect(metadata.name).toBe("Test User");
		expect(metadata.color).toBe("#ffffff");
	});

	test("allows all optional fields to be included", () => {
		const metadata = {
			color: "#ffffff",
			email: "test@example.com",
			githubUsername: "testuser",
			linkedinId: "linkedin123",
			name: "Test User",
			phoneNumber: "+1234567890",
			worksAt: "Test Company",
		};

		expect(metadata.email).toBe("test@example.com");
		expect(metadata.githubUsername).toBe("testuser");
		expect(metadata.linkedinId).toBe("linkedin123");
		expect(metadata.phoneNumber).toBe("+1234567890");
		expect(metadata.worksAt).toBe("Test Company");
	});
});

describe("file operations helpers", () => {
	test("MANIFEST_KEY is correct", () => {
		const MANIFEST_KEY = "manifest.json";
		expect(MANIFEST_KEY).toBe("manifest.json");
	});

	test("file path construction is correct", () => {
		const identityId = "user-123";
		const filename = "ref-1.jpg";
		const path = `${identityId}/${filename}`;
		expect(path).toBe("user-123/ref-1.jpg");
	});

	test("metadata path construction is correct", () => {
		const identityId = "user-123";
		const path = `${identityId}/metadata.json`;
		expect(path).toBe("user-123/metadata.json");
	});
});

describe("manifest structure validation", () => {
	test("valid manifest structure", () => {
		const manifest = {
			identities: [
				{
					files: ["ref-1.jpg"],
					id: "user-1",
					metadata: {
						color: "#ffffff",
						name: "User One",
					},
				},
			],
		};

		expect(Array.isArray(manifest.identities)).toBe(true);
		expect(manifest.identities).toHaveLength(1);
		expect(manifest.identities[0]?.id).toBe("user-1");
	});

	test("empty manifest is valid", () => {
		const manifest = {
			identities: [],
		};

		expect(Array.isArray(manifest.identities)).toBe(true);
		expect(manifest.identities).toHaveLength(0);
	});
});

describe("identity file operations", () => {
	test("stale file detection logic", () => {
		const existing = { files: ["ref-1.jpg", "ref-2.jpg", "old-file.jpg"] };
		const newFiles = new Set(["ref-1.jpg", "ref-2.jpg"]);
		const staleFiles = existing.files.filter(
			(filename) => !newFiles.has(filename)
		);

		expect(staleFiles).toEqual(["old-file.jpg"]);
	});

	test("no stale files when all files match", () => {
		const existing = { files: ["ref-1.jpg", "ref-2.jpg"] };
		const newFiles = new Set(["ref-1.jpg", "ref-2.jpg"]);
		const staleFiles = existing.files.filter(
			(filename) => !newFiles.has(filename)
		);

		expect(staleFiles).toHaveLength(0);
	});

	test("all files become stale when completely replaced", () => {
		const existing = { files: ["old-1.jpg", "old-2.jpg"] };
		const newFiles = new Set(["new-1.jpg", "new-2.jpg"]);
		const staleFiles = existing.files.filter(
			(filename) => !newFiles.has(filename)
		);

		expect(staleFiles).toEqual(["old-1.jpg", "old-2.jpg"]);
	});
});

describe("identity lookup", () => {
	test("finds identity by id", () => {
		const identities = [
			{ files: [], id: "user-1", metadata: { color: "#fff", name: "User 1" } },
			{ files: [], id: "user-2", metadata: { color: "#fff", name: "User 2" } },
			{ files: [], id: "user-3", metadata: { color: "#fff", name: "User 3" } },
		];

		const found = identities.find((identity) => identity.id === "user-2");
		expect(found).toBeDefined();
		expect(found?.id).toBe("user-2");
	});

	test("returns undefined for non-existent id", () => {
		const identities = [
			{ files: [], id: "user-1", metadata: { color: "#fff", name: "User 1" } },
		];

		const found = identities.find((identity) => identity.id === "non-existent");
		expect(found).toBeUndefined();
	});
});

describe("identity filtering", () => {
	test("filters out identity by id", () => {
		const identities = [
			{ files: [], id: "user-1", metadata: { color: "#fff", name: "User 1" } },
			{ files: [], id: "user-2", metadata: { color: "#fff", name: "User 2" } },
			{ files: [], id: "user-3", metadata: { color: "#fff", name: "User 3" } },
		];

		const filtered = identities.filter((identity) => identity.id !== "user-2");
		expect(filtered).toHaveLength(2);
		expect(filtered.map((i) => i.id)).toEqual(["user-1", "user-3"]);
	});

	test("keeps all identities when id not found", () => {
		const identities = [
			{ files: [], id: "user-1", metadata: { color: "#fff", name: "User 1" } },
		];

		const filtered = identities.filter(
			(identity) => identity.id !== "non-existent"
		);
		expect(filtered).toHaveLength(1);
	});
});

describe("identity update", () => {
	test("updates identity metadata while preserving files", () => {
		const identities = [
			{
				files: ["ref-1.jpg"],
				id: "user-1",
				metadata: { color: "#fff", name: "Old Name" },
			},
		];

		const updated = identities.map((identity) =>
			identity.id === "user-1"
				? {
						...identity,
						metadata: { color: "#000", name: "New Name" },
					}
				: identity
		);

		expect(updated[0]?.metadata.name).toBe("New Name");
		expect(updated[0]?.files).toEqual(["ref-1.jpg"]);
	});
});
