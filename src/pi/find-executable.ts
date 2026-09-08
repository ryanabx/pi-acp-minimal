import { statSync } from "node:fs";
import path from "node:path";

/** Node's default PATHEXT, used when the environment does not define one. */
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC";

/**
 * Find `name` on the `PATH` environment variable, parsing it directly instead
 * of shelling out to `which` or spawning a child process.
 *
 * On POSIX the bare name is matched and must carry the executable bit. On
 * Windows the name is matched against each `PATHEXT` extension (so an npm
 * global install resolves to `pi.cmd`, not the extensionless POSIX shim npm
 * places next to it).
 *
 * Returns the absolute path of the first matching executable file, or `null`
 * if no entry on the path yields one.
 */
export function findOnPath(
	name: string,
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): string | null {
	const pathEnv = env.PATH ?? env.Path;
	if (!pathEnv) return null;

	const isWindows = platform === "win32";
	const delimiter = isWindows ? ";" : ":";
	const extensions = isWindows ? (env.PATHEXT ?? DEFAULT_PATHEXT).split(";") : [null];

	for (const dir of pathEnv.split(delimiter)) {
		if (!dir) continue;
		for (const extension of extensions) {
			// On Windows, extensionless files (e.g. npm's POSIX sh shim) are not
			// executable by CreateProcess; only PATHEXT matches count.
			const candidate = path.join(dir, name + (extension ?? ""));
			let stats;
			try {
				stats = statSync(candidate);
			} catch {
				continue;
			}
			if (!stats.isFile()) continue;
			if (!isWindows && (stats.mode & 0o111) === 0) continue;
			return candidate;
		}
	}
	return null;
}
