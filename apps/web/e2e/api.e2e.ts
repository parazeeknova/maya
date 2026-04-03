import { expect, test } from "@playwright/test";

test.describe("Health endpoint", () => {
	test("returns ok status", async ({ request }) => {
		const response = await request.get("/health");
		expect(response.ok()).toBeTruthy();

		const body = await response.json();
		expect(body.ok).toBe(true);
		expect(body.pythonUrl).toBeDefined();
	});
});

test.describe("Static assets", () => {
	test("serves client.js", async ({ request }) => {
		const response = await request.get("/client.js");
		expect(response.ok()).toBeTruthy();
		expect(response.headers()["content-type"]).toContain("javascript");
	});

	test("serves favicon", async ({ request }) => {
		const response = await request.get("/favicon.ico");
		expect(response.ok()).toBeTruthy();
	});

	test("serves favicon.svg", async ({ request }) => {
		const response = await request.get("/favicon.svg");
		expect(response.ok()).toBeTruthy();
	});

	test("serves maya.svg", async ({ request }) => {
		const response = await request.get("/maya.svg");
		expect(response.ok()).toBeTruthy();
	});

	test("serves styles.css", async ({ request }) => {
		const response = await request.get("/styles.css");
		expect(response.ok()).toBeTruthy();
		expect(response.headers()["content-type"]).toContain("text/css");
	});
});

test.describe("Index page", () => {
	test("serves index.html for root path", async ({ page }) => {
		await page.goto("/");
		expect(await page.content()).toContain("html");
	});

	test("serves index.html for unknown paths", async ({ request }) => {
		const response = await request.get("/some/unknown/path");
		expect(response.ok()).toBeTruthy();
	});
});

test.describe("CORS and headers", () => {
	test("response has correct content-type for JSON", async ({ request }) => {
		const response = await request.get("/health");
		expect(response.headers()["content-type"]).toContain("application/json");
	});
});
