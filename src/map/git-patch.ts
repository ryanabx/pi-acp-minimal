/**
 * Git-style unified diffs, for ACP v2's `git_patch` diff content.
 *
 * ACP v2 diffs cannot carry a file's old and new text; they name the changed
 * paths and may add a patch, which agents SHOULD provide. Kept dependency-free:
 * a line diff (Myers) over the changed middle of the file, with a budget on
 * the edit distance beyond which the middle is replaced as one block. That
 * patch is still exact, only not minimal.
 */

const CONTEXT_LINES = 3;
/** Edit distance (changed lines) beyond which the diff stops looking for a minimal script. */
const MAX_EDIT_DISTANCE = 2000;
const NO_NEWLINE_MARKER = "\\ No newline at end of file";

type Op = { kind: " " | "-" | "+"; line: string };

interface Hunk {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	lines: string[];
}

/**
 * The git patch for a change of `filePath` from `oldText` (`null` for a file
 * that did not exist) to `newText`, or `undefined` when nothing changed.
 *
 * Header paths are the native absolute path, quoted the way git quotes names,
 * without git's `a/` and `b/` prefixes: once unquoted they equal the path the
 * diff's `changes` entry names, which is what Zed's own adapter sends.
 */
export function gitPatch(filePath: string, oldText: string | null, newText: string): string | undefined {
	if (oldText === newText) return undefined;
	const hunks = buildHunks(diffLines(oldText === null ? [] : textLines(oldText), textLines(newText)));
	if (hunks.length === 0) return undefined;

	const name = quoteGitPath(filePath);
	// git ends a ---/+++ name that contains a space with a tab, for GNU patch.
	const tab = filePath.includes(" ") ? "\t" : "";
	return [
		`diff --git ${name} ${name}`,
		...(oldText === null ? ["new file mode 100644"] : []),
		`--- ${oldText === null ? "/dev/null" : `${name}${tab}`}`,
		`+++ ${name}${tab}`,
		...hunks.flatMap((hunk) => [
			`@@ -${hunkRange(hunk.oldStart, hunk.oldLines)} +${hunkRange(hunk.newStart, hunk.newLines)} @@`,
			...hunk.lines,
		]),
		"",
	].join("\n");
}

/** The lines of a text, each keeping its line break; the last may have none. */
function textLines(text: string): string[] {
	return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** A line edit script from `a` to `b`. */
function diffLines(a: string[], b: string[]): Op[] {
	// An edit usually touches a small part of a large file: diff only the middle.
	const common = Math.min(a.length, b.length);
	let prefix = 0;
	while (prefix < common && a[prefix] === b[prefix]) prefix++;
	let suffix = 0;
	while (suffix < common - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;

	const oldMiddle = a.slice(prefix, a.length - suffix);
	const newMiddle = b.slice(prefix, b.length - suffix);
	const middle = myers(oldMiddle, newMiddle, MAX_EDIT_DISTANCE) ?? [
		...oldMiddle.map((line): Op => ({ kind: "-", line })),
		...newMiddle.map((line): Op => ({ kind: "+", line })),
	];
	return [
		...a.slice(0, prefix).map((line): Op => ({ kind: " ", line })),
		...middle,
		...a.slice(a.length - suffix).map((line): Op => ({ kind: " ", line })),
	];
}

/**
 * Myers' O(ND) shortest edit script, or `undefined` once the edit distance
 * passes `maxD`. Each step keeps only the diagonals it can reach, so memory is
 * O(D²) rather than O(D·(N+M)).
 */
function myers(a: string[], b: string[], maxD: number): Op[] | undefined {
	const n = a.length;
	const m = b.length;
	const trace: Int32Array[] = [];
	// `v[k + d]` is the furthest x reached on diagonal k after d edits.
	const furthest = (v: Int32Array, d: number, k: number) => v[k + d]!;

	for (let d = 0; d <= Math.min(maxD, n + m); d++) {
		const previous = trace[d - 1];
		const v = new Int32Array(2 * d + 1);
		for (let k = -d; k <= d; k += 2) {
			let x: number;
			if (!previous) x = 0;
			else if (k === -d || (k !== d && furthest(previous, d - 1, k - 1) < furthest(previous, d - 1, k + 1))) {
				x = furthest(previous, d - 1, k + 1);
			} else {
				x = furthest(previous, d - 1, k - 1) + 1;
			}
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x++;
				y++;
			}
			v[k + d] = x;
			if (x >= n && y >= m) {
				trace.push(v);
				return backtrack(a, b, trace);
			}
		}
		trace.push(v);
	}
	return undefined;
}

function backtrack(a: string[], b: string[], trace: Int32Array[]): Op[] {
	const ops: Op[] = [];
	let x = a.length;
	let y = b.length;
	for (let d = trace.length - 1; d > 0; d--) {
		const previous = trace[d - 1]!;
		const at = (k: number) => previous[k + d - 1]!;
		const k = x - y;
		const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
		const previousK = down ? k + 1 : k - 1;
		const previousX = at(previousK);
		const previousY = previousX - previousK;
		while (x > previousX + (down ? 0 : 1) && y > previousY + (down ? 1 : 0)) {
			ops.push({ kind: " ", line: a[x - 1]! });
			x--;
			y--;
		}
		if (down) {
			ops.push({ kind: "+", line: b[y - 1]! });
			y--;
		} else {
			ops.push({ kind: "-", line: a[x - 1]! });
			x--;
		}
	}
	while (x > 0 && y > 0) {
		ops.push({ kind: " ", line: a[x - 1]! });
		x--;
		y--;
	}
	return ops.reverse();
}

/** Group an edit script into hunks with {@link CONTEXT_LINES} lines of context. */
function buildHunks(ops: Op[]): Hunk[] {
	const changes = ops.flatMap((op, index) => (op.kind === " " ? [] : [index]));
	if (changes.length === 0) return [];

	// Line numbers before each op, 1-based.
	const oldNumber: number[] = [];
	const newNumber: number[] = [];
	let oldLine = 1;
	let newLine = 1;
	for (const op of ops) {
		oldNumber.push(oldLine);
		newNumber.push(newLine);
		if (op.kind !== "+") oldLine++;
		if (op.kind !== "-") newLine++;
	}

	const hunks: Hunk[] = [];
	let groupStart = changes[0]!;
	let groupEnd = groupStart;
	const flush = () => {
		const from = Math.max(0, groupStart - CONTEXT_LINES);
		const to = Math.min(ops.length - 1, groupEnd + CONTEXT_LINES);
		const slice = ops.slice(from, to + 1);
		hunks.push({
			oldStart: oldNumber[from]!,
			oldLines: slice.filter((op) => op.kind !== "+").length,
			newStart: newNumber[from]!,
			newLines: slice.filter((op) => op.kind !== "-").length,
			lines: slice.flatMap((op) =>
				op.line.endsWith("\n") ? [`${op.kind}${op.line.slice(0, -1)}`] : [`${op.kind}${op.line}`, NO_NEWLINE_MARKER],
			),
		});
	};
	for (const index of changes.slice(1)) {
		// Changes whose contexts would touch or overlap share a hunk.
		if (index - groupEnd - 1 <= 2 * CONTEXT_LINES) {
			groupEnd = index;
		} else {
			flush();
			groupStart = index;
			groupEnd = index;
		}
	}
	flush();
	return hunks;
}

/** A hunk range; a side with no lines names the line before the change. */
function hunkRange(start: number, count: number): string {
	if (count === 0) return `${Math.max(0, start - 1)},0`;
	return count === 1 ? String(start) : `${start},${count}`;
}

const GIT_PATH_ESCAPES: Record<number, string> = {
	0x07: "a",
	0x08: "b",
	0x09: "t",
	0x0a: "n",
	0x0b: "v",
	0x0c: "f",
	0x0d: "r",
	0x22: '"',
	0x5c: "\\",
};

/**
 * Quote a path like git does with the default `core.quotePath`: a double
 * quote, a backslash, a control byte or a non-ASCII byte puts the whole name
 * in double quotes, with C or three-digit octal escapes for those bytes.
 */
function quoteGitPath(name: string): string {
	let quoted = "";
	let needsQuotes = false;
	for (const byte of Buffer.from(name, "utf8")) {
		const escape = GIT_PATH_ESCAPES[byte];
		if (escape !== undefined) {
			quoted += `\\${escape}`;
			needsQuotes = true;
		} else if (byte < 0x20 || byte >= 0x7f) {
			quoted += `\\${byte.toString(8).padStart(3, "0")}`;
			needsQuotes = true;
		} else {
			quoted += String.fromCharCode(byte);
		}
	}
	return needsQuotes ? `"${quoted}"` : name;
}
