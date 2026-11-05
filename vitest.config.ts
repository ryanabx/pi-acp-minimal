import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		testTimeout: 30_000,
		// Checks every ACP frame of every test against the protocol; see test/conformance/.
		setupFiles: ["test/conformance/setup.ts"],
	},
});
