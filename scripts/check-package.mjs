#!/usr/bin/env node
/**
 * Verify what a consumer actually receives.
 *
 * `npm pack` runs the real pipeline, so this checks the artifact rather than the
 * intent: that it carries the shrinkwrap, that every entry is pinned to an exact
 * version with an integrity hash, and that nothing beyond the allowlist ends up
 * in the runtime closure.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { ALLOWED_RUNTIME_PACKAGES } = await import("./allowed-runtime-packages.mjs");

const outDir = mkdtempSync(path.join(tmpdir(), "pi-acp-minimal-pack-"));
const failures = [];
const fail = (message) => failures.push(message);

try {
	const packed = execFileSync("npm", ["pack", "--pack-destination", outDir], { cwd: root, encoding: "utf8" })
		.trim()
		.split("\n")
		.at(-1);
	const tarball = path.join(outDir, packed);

	const entries = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).trim().split("\n");

	if (!entries.includes("package/npm-shrinkwrap.json")) {
		fail("npm-shrinkwrap.json is missing from the tarball; consumers would resolve transitive deps freely");
	}
	if (!entries.includes("package/dist/cli.js")) {
		fail("dist/cli.js is missing from the tarball; the bin would not run");
	}

	const shrinkwrap = JSON.parse(
		execFileSync("tar", ["-xzOf", tarball, "package/npm-shrinkwrap.json"], { encoding: "utf8" }),
	);

	// Dev entries are expected: installing from git builds the package, so npm
	// needs the devDependencies pinned too.
	const runtime = [];
	for (const [location, entry] of Object.entries(shrinkwrap.packages)) {
		if (!location) continue;
		const name = location.replace(/^(?:.*\/)?node_modules\//, "");
		if (!entry.version) fail(`${name} has no pinned version in the shrinkwrap`);
		if (!entry.integrity) fail(`${name} has no integrity hash in the shrinkwrap`);
		if (entry.dev) continue;

		runtime.push(name);
		if (!ALLOWED_RUNTIME_PACKAGES.has(name)) {
			fail(`${name} would be installed by consumers but is not allowlisted`);
		}
	}
	for (const name of ALLOWED_RUNTIME_PACKAGES) {
		if (!runtime.includes(name)) fail(`${name} is allowlisted but missing from the published shrinkwrap`);
	}

	if (failures.length === 0) {
		const pinned = runtime
			.map((name) => `${name}@${shrinkwrap.packages[`node_modules/${name}`].version}`)
			.join(", ");
		console.log(`Package check passed. Consumers install exactly: ${pinned}`);
	}
} finally {
	rmSync(outDir, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.error("Package check failed:");
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exit(1);
}
