import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { gitPatch } from "../src/map/git-patch.js";

/** Apply a unified patch's hunks to `oldText`, failing on any context mismatch. */
function applyPatch(oldText: string, patch: string): string {
	const oldLines = oldText.match(/[^\n]*\n|[^\n]+$/g) ?? [];
	const out: string[] = [];
	let cursor = 0;
	const lines = patch.split("\n");
	let i = lines.findIndex((line) => line.startsWith("@@"));
	while (i >= 0 && i < lines.length && lines[i]!.startsWith("@@")) {
		const [, oldStart, oldCount] = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@$/.exec(lines[i]!)!;
		const start = Number(oldCount) === 0 ? Number(oldStart) : Number(oldStart) - 1;
		while (cursor < start) out.push(oldLines[cursor++]!);
		i++;
		while (i < lines.length && /^[ +\-\\]/.test(lines[i]!)) {
			const line = lines[i]!;
			const next = lines[i + 1];
			const text = line.slice(1) + (next === "\\ No newline at end of file" ? "" : "\n");
			if (line.startsWith("\\")) {
				i++;
				continue;
			}
			if (line[0] !== "+") {
				expect(oldLines[cursor], `context at old line ${cursor + 1}`).toBe(text);
				cursor++;
			}
			if (line[0] !== "-") out.push(text);
			i++;
		}
	}
	while (cursor < oldLines.length) out.push(oldLines[cursor++]!);
	return out.join("");
}

/** The hunks `git diff --no-index` produces for the same change. */
function gitHunks(oldText: string, newText: string): string {
	const dir = mkdtempSync(path.join(tmpdir(), "git-patch-"));
	try {
		writeFileSync(path.join(dir, "old"), oldText);
		writeFileSync(path.join(dir, "new"), newText);
		let output = "";
		try {
			execFileSync("git", ["diff", "--no-index", "--no-color", "-U3", "old", "new"], { cwd: dir, encoding: "utf8" });
		} catch (error) {
			// git diff exits 1 when the files differ.
			output = (error as { stdout: string }).stdout;
		}
		// git appends the hunk's enclosing "function" line to each header; it is optional.
		return output.slice(output.indexOf("@@")).replace(/^(@@ [^@]+ @@).*$/gm, "$1");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const ourHunks = (patch: string | undefined) => patch?.slice(patch.indexOf("@@")) ?? "";
const lines = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}\n`).join("");

describe("gitPatch", () => {
	it("writes git's headers with the absolute path", () => {
		expect(gitPatch("/w/a.txt", "one\n", "two\n")).toBe(
			["diff --git /w/a.txt /w/a.txt", "--- /w/a.txt", "+++ /w/a.txt", "@@ -1 +1 @@", "-one", "+two", ""].join("\n"),
		);
	});

	it("marks a created file", () => {
		expect(gitPatch("/w/new.txt", null, "a\nb\n")).toBe(
			["diff --git /w/new.txt /w/new.txt", "new file mode 100644", "--- /dev/null", "+++ /w/new.txt", "@@ -0,0 +1,2 @@", "+a", "+b", ""].join(
				"\n",
			),
		);
	});

	it("quotes names the way git does", () => {
		expect(gitPatch('/w/sp ace"é.txt', "a\n", "b\n")?.split("\n").slice(0, 3)).toEqual([
			'diff --git "/w/sp ace\\"\\303\\251.txt" "/w/sp ace\\"\\303\\251.txt"',
			'--- "/w/sp ace\\"\\303\\251.txt"\t',
			'+++ "/w/sp ace\\"\\303\\251.txt"\t',
		]);
	});

	it("returns nothing when the text did not change", () => {
		expect(gitPatch("/w/a", "same\n", "same\n")).toBeUndefined();
	});

	it.each([
		["one line in the middle", lines(1, 20), lines(1, 9) + "changed\n" + lines(11, 20)],
		["two distant edits as two hunks", lines(1, 40), "first\n" + lines(2, 35) + "last\n" + lines(37, 40)],
		["nearby edits sharing a hunk", lines(1, 20), lines(1, 4) + "x\n" + lines(6, 9) + "y\n" + lines(11, 20)],
		["an insertion", lines(1, 10), lines(1, 5) + "new\n" + lines(6, 10)],
		["a deletion at the start", lines(1, 10), lines(3, 10)],
		["a missing final newline", "a\nb\nc", "a\nb\nd"],
		["a final newline added", "a\nb", "a\nb\n"],
	])("matches git diff for %s", (_name, before, after) => {
		expect(ourHunks(gitPatch("/w/f", before, after))).toBe(gitHunks(before, after));
	});

	it("still produces an exact patch when the edit is too large to minimise", () => {
		const before = Array.from({ length: 3000 }, (_, i) => `old ${i}\n`).join("");
		const after = "kept\n" + Array.from({ length: 3000 }, (_, i) => `new ${i}\n`).join("");
		expect(applyPatch(before, gitPatch("/w/f", before, after)!)).toBe(after);
	});

	it("produces patches that apply exactly, for random edits", () => {
		let seed = 42;
		const random = (n: number) => {
			seed = (seed * 1103515245 + 12345) % 2 ** 31;
			return seed % n;
		};
		const pick = () => ["a\n", "b\n", "c\n", "d\n", "e\n"][random(5)]!;
		for (let round = 0; round < 300; round++) {
			const before = Array.from({ length: random(30) }, pick).join("") + (random(4) === 0 ? "tail" : "");
			const after = Array.from({ length: random(30) }, pick).join("") + (random(4) === 0 ? "tail" : "");
			const patch = gitPatch("/w/f", before, after);
			if (before === after) {
				expect(patch).toBeUndefined();
				continue;
			}
			expect(applyPatch(before, patch!), `round ${round}`).toBe(after);
		}
	});
});
