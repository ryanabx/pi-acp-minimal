#!/usr/bin/env node
/**
 * Guard the dependency surface.
 *
 * npm's threat model is that any package in the tree can run code on install and
 * ship code into the process. This adapter keeps that surface deliberately tiny,
 * and this check fails the build if it grows without someone noticing:
 *
 *   1. Every direct dependency is pinned to an exact version, so a range cannot
 *      silently pull a fresh publish.
 *   2. The runtime closure matches an explicit allowlist, so a new transitive
 *      package has to be added here on purpose.
 *   3. No runtime package declares an install lifecycle script.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ALLOWED_RUNTIME_PACKAGES } from "./allowed-runtime-packages.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");


/** Lifecycle scripts npm will run during an install. */
const INSTALL_HOOKS = ["preinstall", "install", "postinstall", "prepare", "preprepare", "postprepare"];

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const failures = [];
const fail = (message) => failures.push(message);

// --- 1. direct dependencies are exact ---------------------------------------
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
	for (const [name, range] of Object.entries(pkg[field] ?? {})) {
		if (!EXACT_VERSION.test(range)) {
			fail(`${field}.${name} is "${range}"; pin it to an exact version`);
		}
	}
}

// --- 2. runtime closure matches the allowlist -------------------------------
const lock = JSON.parse(readFileSync(path.join(root, "npm-shrinkwrap.json"), "utf8"));
const runtime = new Map();
for (const [location, entry] of Object.entries(lock.packages)) {
	if (!location || entry.dev || entry.devOptional) continue;
	const name = location.replace(/^(?:.*\/)?node_modules\//, "");
	runtime.set(name, entry.version);
}

for (const name of runtime.keys()) {
	if (!ALLOWED_RUNTIME_PACKAGES.has(name)) {
		fail(`${name} is in the runtime tree but not in ALLOWED_RUNTIME_PACKAGES (scripts/allowed-runtime-packages.mjs)`);
	}
}
for (const name of ALLOWED_RUNTIME_PACKAGES) {
	if (!runtime.has(name)) {
		fail(`${name} is allowlisted but no longer in the runtime tree; remove it from ALLOWED_RUNTIME_PACKAGES`);
	}
}

// --- 3. no install hooks at runtime -----------------------------------------
let scanned = 0;
for (const name of runtime.keys()) {
	const manifestPath = path.join(root, "node_modules", name, "package.json");
	if (!existsSync(manifestPath)) continue;
	scanned++;
	const scripts = JSON.parse(readFileSync(manifestPath, "utf8")).scripts ?? {};
	const hooks = INSTALL_HOOKS.filter((hook) => scripts[hook]);
	if (hooks.length > 0) {
		fail(`${name} declares install lifecycle script(s): ${hooks.join(", ")}`);
	}
}
if (scanned < runtime.size) {
	console.warn(`note: only ${scanned}/${runtime.size} runtime packages installed; run npm ci for a full scan`);
}

// --- report ------------------------------------------------------------------
if (failures.length > 0) {
	console.error("Dependency check failed:");
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exit(1);
}

const summary = [...runtime].map(([name, version]) => `${name}@${version}`).join(", ");
console.log(`Dependency check passed. Runtime closure (${runtime.size}): ${summary}`);
