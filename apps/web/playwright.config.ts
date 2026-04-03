import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	forbidOnly: !!process.env["CI"],
	fullyParallel: true,
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
	reporter: "html",
	retries: process.env["CI"] ? 2 : 0,
	testDir: "./e2e",
	testMatch: /.*\.e2e\.ts/,
	use: {
		baseURL: "http://localhost:3000",
		trace: "on-first-retry",
	},

	webServer: {
		command: "bun run dev",
		reuseExistingServer: !process.env["CI"],
		timeout: 120 * 1000,
		url: "http://localhost:3000/health",
	},

	workers: process.env["CI"] ? 1 : 4,
});
