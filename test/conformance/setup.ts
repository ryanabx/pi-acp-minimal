import { afterEach, expect } from "vitest";
import { TestClient } from "../harness.js";
import { describeViolations } from "./monitor.js";

/**
 * Every test that drives the adapter is also an ACP conformance test: after
 * each one, any frame either side sent that broke ACP (v1, or v2 for a
 * client that negotiated it) fails it.
 */
afterEach(() => {
	const clients = [...TestClient.instances];
	TestClient.instances.clear();
	for (const client of clients) client.conformance.finish();
	const violations = clients.flatMap((client) => client.conformance.violations);
	expect(violations, `ACP conformance violations:\n${describeViolations(violations)}`).toEqual([]);
});
