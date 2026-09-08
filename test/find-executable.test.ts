import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findOnPath } from "../src/pi/find-executable.js";

const windows = process.platform === "win32";
const sep = windows ? ";" : ":";

let root: string;
let bin: string;

beforeAll(() => {
	root = mkdtempSync(path.join(tmpdir(), "find-on-path-"));
	bin = path.join(root, "bin");
	mkdirSync(bin);
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

/** Write a file and, on POSIX, mark it executable so findOnPath accepts it. */
function writeExecutable(file: string): void {
	writeFileSync(file, "#!/bin/sh\n");
	if (!windows) chmodSync(file, 0o755);
}

describe("findOnPath", () => {
	it("returns the first matching executable on the path", () => {
		if (windows) return; // POSIX semantics only; Windows resolution is tested below
		const a = path.join(bin, "pi");
		const b = path.join(root, "other", "pi");
		mkdirSync(path.dirname(b));
		writeExecutable(a);
		writeExecutable(b);
		expect(findOnPath("pi", { PATH: `${bin}${sep}${path.dirname(b)}` })).toBe(a);
	});

	it("skips directories with the target name", () => {
		mkdirSync(path.join(bin, "pi-dir"));
		expect(findOnPath("pi-dir", { PATH: `${bin}${sep}/does/not/exist` })).toBeNull();
	});

	it("skips non-executable files on POSIX", () => {
		if (windows) return;
		const file = path.join(bin, "pi");
		writeFileSync(file, "not executable\n");
		chmodSync(file, 0o644);
		expect(findOnPath("pi", { PATH: bin })).toBeNull();
	});

	it("returns null when the name is not on the path", () => {
		expect(findOnPath("definitely-not-installed", { PATH: bin })).toBeNull();
	});

	describe("Windows name resolution", () => {
		it("prefers PATHEXT extensions over the extensionless POSIX shim", () => {
			const shim = path.join(bin, "pi");
			const cmd = path.join(bin, "pi.cmd");
			writeFileSync(shim, "#!/bin/sh\n");
			writeFileSync(cmd, "@echo off\n");
			// Windows filesystems are case-insensitive, so PATHEXT case never matters
			// in practice; match it here so the simulation also runs on POSIX hosts.
			const env = { PATH: bin, PATHEXT: ".com;.exe;.bat;.cmd" } as NodeJS.ProcessEnv;
			expect(findOnPath("pi", env, "win32")).toBe(cmd);
		});

		it("ignores the extensionless shim when no PATHEXT match exists", () => {
			const shim = path.join(bin, "pi");
			writeFileSync(shim, "#!/bin/sh\n");
			const env = { PATH: bin, PATHEXT: ".com;.exe" } as NodeJS.ProcessEnv;
			expect(findOnPath("pi", env, "win32")).toBeNull();
		});

		it("uses PATHEXT ordering to pick between candidates", () => {
			const exe = path.join(bin, "pi.exe");
			const cmd = path.join(bin, "pi.cmd");
			writeFileSync(exe, "MZ");
			writeFileSync(cmd, "@echo off\n");
			const env = { PATH: bin, PATHEXT: ".cmd;.exe" } as NodeJS.ProcessEnv;
			expect(findOnPath("pi", env, "win32")).toBe(cmd);
		});
	});

	it("handles empty path entries and an unset PATH", () => {
		if (windows) {
			// On Windows the bare shim is not matchable; use a PATHEXT name instead.
			writeFileSync(path.join(bin, "pi.cmd"), "@echo off\n");
			expect(findOnPath("pi", { PATH: `;;${bin};;` } as NodeJS.ProcessEnv)).toBe(path.join(bin, "pi.cmd"));
		} else {
			const file = path.join(bin, "pi");
			writeExecutable(file);
			// Empty entries must not resolve against the current directory.
			expect(findOnPath("pi", { PATH: `::${bin}:` })).toBe(file);
		}
		expect(findOnPath("pi", {})).toBeNull();
	});
});
