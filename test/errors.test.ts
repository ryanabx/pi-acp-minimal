import { describe, expect, it } from "vitest";
import { providerError } from "../src/acp/errors.js";

describe("providerError", () => {
	it.each([
		"401 Unauthorized",
		"Authentication failed",
		"invalid_api_key",
		"Missing API key",
		"expired token",
	])("reports a rejected credential as auth_required: %s", (text) => {
		const error = providerError(text);
		expect(error.code).toBe(-32000);
		expect(error.message).toBe(text);
	});

	it.each(["429 rate limit", "503 unavailable", "403 model not allowed", "Connection error."])(
		"keeps other provider failures as internal errors: %s",
		(text) => {
			const error = providerError(text);
			expect(error.code).toBe(-32603);
			expect(error.message).toBe(text);
		},
	);
});
