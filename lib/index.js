import { accessSync, constants, createReadStream, existsSync, realpathSync, watch } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, parse, relative, resolve, win32 } from "node:path";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { WebSocketServer } from "ws";
//#region src/shared/protocol.ts
/**
* Wire vocabulary shared by the host and client halves of the workbench.
* Framework-free: importable from Node routes, browser code, and tests alike.
*/
/** npm package name; the cordis loader mounts rows by this name. */
const WORKBENCH_PACKAGE_NAME = "zdsh-workbench";
/** Every HTTP route and WebSocket upgrade this plugin owns lives under it. */
const WORKBENCH_ROUTE_PREFIX = "/workbench";
/**
* Plugin version. MUST equal the package.json "version"; the manifest
* client spec guards that two-way sync.
*/
const WORKBENCH_VERSION = "0.1.0-beta.1";
/**
* Build the liveness-probe answer.
* @returns the ping result with ok, plugin, and version fields.
*/
function pingResult() {
	return {
		ok: true,
		plugin: WORKBENCH_PACKAGE_NAME,
		version: WORKBENCH_VERSION
	};
}
//#endregion
//#region src/shared/protocol-envelope.ts
/**
* Wrap a value into the success envelope.
* @param value - the payload to carry.
* @returns the `{ ok: true, value }` envelope.
*/
function envelopeOk(value) {
	return {
		ok: true,
		value
	};
}
/**
* Wrap an error into the failure envelope.
* @param code - the stable machine-readable error code.
* @param message - the human-readable error message.
* @returns the `{ ok: false, error }` envelope.
*/
function envelopeFail(code, message) {
	return {
		ok: false,
		error: {
			code,
			message
		}
	};
}
//#endregion
//#region src/path-guard.ts
/**
* Workspace path guard: the security boundary every filesystem operation
* passes through. Rules, in the order an attacker would try to break them:
*
* 1. The request names an absolute path; relative input is refused outright.
* 2. The resolved path must stay inside the workspace root — including the
*    win32 cross-drive trap where `path.relative` returns an ABSOLUTE path
*    instead of a `..`-prefixed one, which silently defeats naive
*    `!rel.startsWith('..')` containment checks.
* 3. Symbolic links must not smuggle the operation out: every EXISTING entry
*    between the target and the root is checked, and any link whose realpath
*    leaves the workspace fails the call.
* 4. Every check runs against the CURRENT filesystem at call time — results
*    are never cached across operations.
*/
/**
* Resolve the authoritative workspace root once per session cwd value.
* @param cwd - the working directory to realpath.
* @returns the realpathed workspace root; throws when the cwd does not exist.
*/
async function resolveWorkspaceRoot(cwd) {
	return realpath(cwd);
}
function escapesRoot(root, target) {
	const rel = relative(root, target);
	if (isAbsolute(rel)) return true;
	if (rel === "" || rel === ".") return false;
	return rel.startsWith("..") || parse(rel).root !== "";
}
function outside(message) {
	return {
		allowed: false,
		code: "outside-workspace",
		message
	};
}
/**
* Judge one absolute candidate path against the workspace root. Purely
* lexical; callers layer filesystem-aware checks (below) on top.
* @param root - the authoritative workspace root (already realpathed for full checks).
* @param requestedPath - the absolute candidate path to judge.
* @returns the allowed target or a refused verdict.
*/
function judgeInsideWorkspace(root, requestedPath) {
	if (typeof requestedPath !== "string" || requestedPath.length === 0) return {
		allowed: false,
		code: "bad-request",
		message: "path is required"
	};
	if (!isAbsolute(requestedPath)) return {
		allowed: false,
		code: "bad-request",
		message: "path must be absolute"
	};
	const target = resolve(requestedPath);
	if (escapesRoot(root, target)) return outside("path escapes the workspace");
	return {
		allowed: true,
		root,
		target
	};
}
/**
* Full pre-flight for read/write/delete/rename targets. `root` MUST be the
* already-realpathed workspace root (see resolveWorkspaceRoot).
*
* Checks every existing entry from the target up to (and including) the
* root: any symbolic link along that chain resolving outside fails. The walk
* deliberately STOPS at the root — ancestry above the workspace belongs to
* the deployment, not the request.
* @param root - the already-realpathed workspace root (see resolveWorkspaceRoot).
* @param requestedPath - the absolute candidate path to pre-flight.
* @returns the allowed target or a refused verdict.
*/
async function ensureRealPathInside(root, requestedPath) {
	const judged = judgeInsideWorkspace(root, requestedPath);
	if (!judged.allowed) return judged;
	let cursor = judged.target;
	for (;;) {
		try {
			if ((await lstat(cursor)).isSymbolicLink()) {
				if (escapesRoot(root, await realpath(cursor))) return outside("symlink resolves outside the workspace");
			}
		} catch {}
		if (cursor === root) break;
		const parent = resolve(cursor, "..");
		if (parent === cursor) break;
		cursor = parent;
	}
	let anchor = judged.target;
	for (;;) try {
		if (escapesRoot(root, await realpath(anchor))) return outside("path resolves outside the workspace");
		break;
	} catch {
		if (anchor === root) break;
		const parent = resolve(anchor, "..");
		if (parent === anchor) break;
		anchor = parent;
	}
	return judged;
}
//#endregion
//#region src/system-probe.ts
/**
* Platform binary-lookup probe resolution (TC-B4-H1 face 7; per the FB1
* adjudication note this is defense-in-depth hardening, not a blocking fix —
* wording discipline: no overstatement).
*
* The lookup probes in git-runner / pty-registry were historically spawned by
* bare name (`where.exe` / `which`). On win32, CreateProcess searches the
* application directory and the parent-process CWD BEFORE System32 for a
* bare-named executable, and the `spawnSync` `cwd` option only sets the child
* working directory — it does not take part in executable lookup. A planted
* `where.exe` in the host CWD (typical: the server started inside an
* untrusted clone/download directory) would therefore run before the real
* system binary. This module resolves the probe itself to an absolute path:
* every candidate passes non-empty + isAbsolute + existsSync, and when all
* candidates are missing the resolution fails closed (never a bare-name
* fallback).
*
* Boundary (honest scope): this hardens the "probe itself is planted" window.
* CWD planting of the LOOKED-UP target (git/pwsh/…) is guarded by the
* existing "probe cwd pinned to SystemRoot" leg (REVIEW-PC1 discriminative
* probe: the load-bearing wall) — the two faces are orthogonal and neither
* replaces the other. POSIX execvp does not search the CWD (unless PATH
* contains `.`), so the bare-name probe risk is win32-specific; the POSIX
* side is absolutized in the same shape (removing the PATH-shaped `which`
* dependency ambiguity).
* @module
*/
/**
* Key-shape polymorphism for the Windows root env keys (WS1 deviation-1
* measured posture: under Git Bash/MSYS hosts Object.keys(process.env) is
* all-upper; node's env access on win32 is case-insensitive [REVIEW-WS1
* suggestion-1 corrected posture], so the first key always hits and the
* polymorphic loop is harmless redundancy; windir/WINDIR is the real
* fallback leg — a different variable).
*/
const WINDOWS_ROOT_KEYS = [
	"SystemRoot",
	"SYSTEMROOT",
	"windir",
	"WINDIR"
];
/** Last-resort candidate when every env key is missing/unusable: the fixed system dir (existsSync-checked; missing ⇒ fail closed). */
const WINDOWS_LAST_RESORT = "C:\\Windows\\System32\\where.exe";
/** Conventional POSIX `which` locations (same shape: existsSync per candidate, fail closed when all are missing). */
const POSIX_WHICH_CANDIDATES = [
	"/usr/bin/which",
	"/bin/which",
	"/usr/local/bin/which"
];
/**
* Resolve this platform's binary-lookup probe to an absolute path.
*
* Candidate construction and existence checks run OUTSIDE any try (task-card
* "构造 try 外": join/existsSync do not throw, and a construction defect must
* never be laundered into "not found" by a caller's catch).
* @returns the absolute probe path, or `null` when every candidate is missing
*   (fail-closed: callers refuse resolution / fall through to their documented
*   fallbacks, never re-entering a bare-name spawn).
*/
function resolveLookupProbe() {
	if (process.platform === "win32") {
		for (const key of WINDOWS_ROOT_KEYS) {
			const root = process.env[key]?.trim();
			if (root === void 0 || root === "") continue;
			if (!win32.isAbsolute(root)) continue;
			const candidate = win32.join(root, "System32", "where.exe");
			if (existsSync(candidate)) return candidate;
		}
		return existsSync(WINDOWS_LAST_RESORT) ? WINDOWS_LAST_RESORT : null;
	}
	for (const candidate of POSIX_WHICH_CANDIDATES) if (existsSync(candidate)) return candidate;
	return null;
}
//#endregion
//#region src/git-runner.ts
/**
* Git execution seam. Hard rules:
* - argv arrays only, never a shell string;
* - every path argument passes the workspace guard first;
* - the runner NEVER sets or amends identity (no user.name/email anywhere);
*   commits use whatever identity the repository itself carries;
* - network operations (fetch/pull/push) live behind `confirm: true` and
*   otherwise answer with a read-only preview instead of acting.
*/
/**
* Platform default: `where.exe <name>` on Windows (a protected system binary
* whose PATH is pinned under SystemRoot), `which <name>` on POSIX. The probe
* itself is spawned by ABSOLUTE path (TC-B4-H1 face 7, FB1-family
* defense-in-depth hardening): a bare `where.exe`/`which` spawn would let a
* same-named binary planted in the host CWD run before the system one on
* win32 (CreateProcess searches the app dir and CWD before System32, and the
* `cwd` option below does not take part in executable lookup). Probe
* resolution fails closed — no candidate on disk means no spawn at all, never
* a bare-name fallback.
* @param name - the executable name to resolve.
* @returns the first absolute path found, or null when resolution fails.
*/
function defaultBinaryResolver(name) {
	const probe = resolveLookupProbe();
	if (probe === null) return null;
	try {
		if (process.platform === "win32") {
			const result = spawnSync(probe, [name], {
				encoding: "utf8",
				cwd: process.env.SystemRoot ?? process.env.WINDIR ?? void 0
			});
			if (result.status === 0) {
				const resolved = firstLine(result.stdout);
				if (resolved !== null && win32.isAbsolute(resolved)) return resolved;
			}
			return null;
		}
		const result = spawnSync(probe, [name], { encoding: "utf8" });
		if (result.status === 0) return firstLine(result.stdout);
		return null;
	} catch {
		return null;
	}
}
function firstLine(stdout) {
	for (const line of stdout.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed !== "") return trimmed;
	}
	return null;
}
/**
* How long a resolved binary stays cached before the PATH lookup runs again.
* Bounded so a binary installed/replaced at the same PATH slot is picked up
* without paying for a probe on every call.
*/
const BINARY_CACHE_TTL_MS = 6e4;
/**
* Per-name cache so the PATH lookup runs at most once per TTL window. The
* cache also drops wholesale when PATH changes, because every previously
* resolved location may have moved.
*/
const binaryCache = /* @__PURE__ */ new Map();
let currentResolver = defaultBinaryResolver;
let lastPathValue = process.env.PATH;
/**
* Resolve an executable name through the active resolver with caching.
* @param name - the executable name to resolve.
* @returns the resolved absolute path, or null when unresolvable.
*/
function resolveBinary(name) {
	const now = Date.now();
	const pathNow = process.env.PATH;
	if (pathNow !== lastPathValue) {
		binaryCache.clear();
		lastPathValue = pathNow;
	}
	const cached = binaryCache.get(name);
	if (cached !== void 0 && now - cached.storedAt < BINARY_CACHE_TTL_MS) return cached.value;
	const resolved = currentResolver(name);
	binaryCache.set(name, {
		value: resolved,
		storedAt: now
	});
	return resolved;
}
const DEFAULT_TIMEOUT_MS = 3e4;
/** Timeout granted to network operations (fetch/pull/push). */
const NETWORK_TIMEOUT_MS = 12e4;
const MAX_OUTPUT_BYTES = 8388608;
/**
* Run one git command with argv only and a sanitized environment.
* @param rootReal - the realpathed repository root used as the process cwd.
* @param args - the git argv (validated by callers; never a shell string).
* @param options - optional timeout and output byte cap overrides.
* @returns the exit code plus captured stdout and stderr.
*/
async function runGit(rootReal, args, options = {}) {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
	return new Promise((resolve) => {
		const gitPath = resolveBinary("git");
		if (gitPath === null) {
			resolve({
				code: -1,
				stdout: "",
				stderr: "git: could not resolve the git executable on PATH"
			});
			return;
		}
		const child = spawn(gitPath, args, {
			cwd: rootReal,
			shell: false,
			windowsHide: true,
			env: {
				PATH: process.env.PATH ?? "",
				SystemRoot: process.env.SystemRoot ?? "",
				HOME: process.env.HOME ?? process.env.UserProfile ?? "",
				LC_ALL: "C",
				GIT_TERMINAL_PROMPT: "0",
				GIT_CONFIG_NOSYSTEM: "1"
			}
		});
		let stdout = Buffer.alloc(0);
		let stderr = Buffer.alloc(0);
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, timeoutMs);
		if (typeof timer.unref === "function") timer.unref();
		child.stdout.on("data", (chunk) => {
			if (stdout.byteLength < maxBytes) stdout = Buffer.concat([stdout, chunk]);
		});
		child.stderr.on("data", (chunk) => {
			if (stderr.byteLength < maxBytes) stderr = Buffer.concat([stderr, chunk]);
		});
		child.on("error", (cause) => {
			clearTimeout(timer);
			resolve({
				code: -1,
				stdout: "",
				stderr: cause.message
			});
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({
				code: timedOut ? -2 : code ?? -1,
				stdout: stdout.toString("utf8"),
				stderr: timedOut ? "git timed out" : stderr.toString("utf8")
			});
		});
	});
}
/**
* Guard one repo-relative-or-absolute path against the workspace root.
* @param rootCache - shared workspace-root cache used to resolve the cwd.
* @param cwd - the working directory whose root anchors the guard.
* @param value - the path to guard (repo-relative or absolute).
* @returns the real root and repo-relative path, or null when the path escapes.
*/
async function guardRepoPath(rootCache, cwd, value) {
	if (typeof cwd !== "string" || cwd === "" || typeof value !== "string" || value === "") return null;
	const rootReal = await rootCache.rootOf(cwd);
	if (typeof rootReal !== "string") return null;
	const verdict = await ensureRealPathInside(rootReal, value);
	if (!verdict.allowed) return null;
	return {
		rootReal,
		repoPath: verdict.target.startsWith(rootReal) ? verdict.target.slice(rootReal.length).replace(/^[\\/]/, "") : value
	};
}
const STATUS_ARGS = [
	"status",
	"--porcelain=v1",
	"-b",
	"--untracked-files=normal"
];
const BRANCHES_ARGS = [
	"branch",
	"--all",
	"--format=%(refname:short)%09%(objectname:short)"
];
/**
* Run `git status --porcelain` with branch tracking.
* @param rootReal - the realpathed repository root.
* @returns the git run result.
*/
async function opStatus(rootReal) {
	return runGit(rootReal, [...STATUS_ARGS]);
}
/**
* Run `git remote -v`.
* @param rootReal - the realpathed repository root.
* @returns the git run result.
*/
async function opRemotes(rootReal) {
	return runGit(rootReal, ["remote", "-v"]);
}
/**
* Run `git branch --all` with short ref names.
* @param rootReal - the realpathed repository root.
* @returns the git run result.
*/
async function opBranches(rootReal) {
	return runGit(rootReal, [...BRANCHES_ARGS]);
}
/**
* Run a formatted `git log` limited to `limit` commits.
* @param rootReal - the realpathed repository root.
* @param limit - the maximum number of commits to request.
* @returns the git run result.
*/
async function opLog(rootReal, limit) {
	return runGit(rootReal, [
		"log",
		"-n",
		String(limit),
		"--date-order",
		"--pretty=format:%h%x1f%an%x1f%at%x1f%s"
	]);
}
/**
* Run `git diff --no-color`, optionally scoped to one repo path.
* @param rootReal - the realpathed repository root.
* @param repoPath - optional repo-relative path to scope the diff.
* @returns the git run result.
*/
async function opDiff(rootReal, repoPath) {
	return runGit(rootReal, repoPath === void 0 ? ["diff", "--no-color"] : [
		"diff",
		"--no-color",
		"--",
		repoPath
	]);
}
/**
* Run `git diff --cached --no-color`, optionally scoped to one repo path.
* @param rootReal - the realpathed repository root.
* @param repoPath - optional repo-relative path to scope the diff.
* @returns the git run result.
*/
async function opDiffCached(rootReal, repoPath) {
	return runGit(rootReal, repoPath === void 0 ? [
		"diff",
		"--cached",
		"--no-color"
	] : [
		"diff",
		"--cached",
		"--no-color",
		"--",
		repoPath
	]);
}
/**
* Stage paths with `git add --`.
* @param rootReal - the realpathed repository root.
* @param repoPaths - the validated repo-relative paths to stage.
* @returns the git run result.
*/
async function opStage(rootReal, repoPaths) {
	return runGit(rootReal, [
		"add",
		"--",
		...repoPaths
	]);
}
/**
* Unstage paths with `git reset HEAD --`.
* @param rootReal - the realpathed repository root.
* @param repoPaths - the validated repo-relative paths to unstage.
* @returns the git run result.
*/
async function opUnstage(rootReal, repoPaths) {
	return runGit(rootReal, [
		"reset",
		"HEAD",
		"--",
		...repoPaths
	]);
}
/**
* Commit with `git commit -m`.
* @param rootReal - the realpathed repository root.
* @param message - the validated commit message.
* @returns the git run result.
*/
async function opCommit(rootReal, message) {
	return runGit(rootReal, [
		"commit",
		"-m",
		message
	]);
}
/**
* Run one network operation with the network timeout.
* @param rootReal - the realpathed repository root.
* @param action - the network operation to run.
* @param remote - the validated remote name.
* @returns the git run result.
*/
async function opNetwork(rootReal, action, remote) {
	return runGit(rootReal, [action, ...action === "push" ? [remote] : action === "pull" ? ["--ff-only", remote] : [remote, "--prune"]], { timeoutMs: NETWORK_TIMEOUT_MS });
}
//#endregion
//#region src/git-routes.ts
/**
* Git route handlers behind `/workbench/api/git.*`. All process work is
* delegated to named operations in git-runner.ts (fixed argument prefixes,
* validated values, no shell, no identity writes). Network operations run
* only with explicit confirmation; without it they answer a read-only
* preview so the client can show what WOULD happen.
*/
function asObject$1(payload) {
	return typeof payload === "object" && payload !== null ? payload : {};
}
function fail$1(code, stderr) {
	return {
		ok: false,
		error: {
			code,
			message: stderr.trim() || "git command failed"
		}
	};
}
function failResult(result) {
	return fail$1(result.code === 128 ? "not-a-repository" : "git-error", result.stderr);
}
async function requireRoot(rootCache, cwd, rootAllowed) {
	if (typeof cwd !== "string" || cwd === "") return envelopeFail("bad-request", "cwd is required");
	const rootReal = await rootCache.rootOf(cwd);
	if (typeof rootReal !== "string") return envelopeFail("bad-request", "cwd is not an existing directory");
	if (rootAllowed !== void 0 && !rootAllowed(rootReal)) return envelopeFail("outside-workspace", "cwd is outside the deployment workspace clamp");
	const inside = await ensureRealPathInside(rootReal, cwd);
	if (!inside.allowed) return envelopeFail(inside.code, inside.message);
	return { rootReal };
}
async function sanitizeRepoPath(rootReal, value) {
	if (value === "") return null;
	const verdict = await ensureRealPathInside(rootReal, rootReal.replace(/[\\/]+$/, "") + "/" + value.replace(/^[\\/]/, ""));
	return verdict.allowed ? verdict.target.slice(rootReal.length + 1).replace(/^[\\/]/, "") : null;
}
async function guardAllPaths(rootCache, payload, rootAllowed) {
	const raw = payload.paths;
	const paths = Array.isArray(raw) ? raw.filter((entry) => typeof entry === "string") : [];
	if (paths.length === 0) return envelopeFail("bad-request", "paths array is required");
	const rootReal0 = await requireRoot(rootCache, payload.cwd, rootAllowed);
	if (!("rootReal" in rootReal0)) return rootReal0;
	const repoPaths = [];
	for (const path of paths) {
		const verdict = await guardRepoPath(rootCache, payload.cwd, path);
		if (verdict === null) return envelopeFail("outside-workspace", "a path escapes the workspace");
		repoPaths.push(verdict.repoPath);
	}
	return {
		rootReal: rootReal0.rootReal,
		repoPaths
	};
}
/**
* Build the `/workbench/api/git.*` handler map. All process work is delegated
* to named operations in git-runner.ts.
* @param deps - root cache plus optional deployment clamp.
* @returns the route method → handler map (all handlers return envelope values).
*/
function createGitHandlers(deps) {
	const handlers = /* @__PURE__ */ new Map();
	const rootCache = deps.rootCache;
	const rootAllowed = deps.rootAllowed;
	handlers.set("git.status", async (raw) => {
		const payload = asObject$1(raw);
		const root = await requireRoot(rootCache, payload.cwd, rootAllowed);
		if (!("rootReal" in root)) return root;
		const result = await opStatus(root.rootReal);
		if (result.code !== 0) return failResult(result);
		const lines = result.stdout.split("\n").filter((line) => line !== "");
		let branch = "";
		let ahead = 0;
		let behind = 0;
		const entries = [];
		for (const line of lines) {
			if (line.startsWith("## ")) {
				const body = line.slice(3);
				const bracketIndex = body.indexOf("[");
				branch = (bracketIndex === -1 ? body : body.slice(0, bracketIndex)).replace(/\.\.\..*$/, "").trim();
				const trackPart = bracketIndex === -1 ? "" : body.slice(bracketIndex);
				const aheadMatch = /ahead (\d+)/.exec(trackPart);
				const behindMatch = /behind (\d+)/.exec(trackPart);
				ahead = aheadMatch !== null ? Number(aheadMatch[1]) : 0;
				behind = behindMatch !== null ? Number(behindMatch[1]) : 0;
				continue;
			}
			entries.push({
				path: line.slice(3),
				x: line.charAt(0),
				y: line.charAt(1),
				untracked: line.charAt(0) === "?" && line.charAt(1) === "?"
			});
		}
		return envelopeOk({
			branch,
			ahead,
			behind,
			entries
		});
	});
	handlers.set("git.diff", async (raw) => {
		const payload = asObject$1(raw);
		const root = await requireRoot(rootCache, payload.cwd, rootAllowed);
		if (!("rootReal" in root)) return root;
		const repoPath = typeof payload.path === "string" && payload.path !== "" ? await sanitizeRepoPath(root.rootReal, payload.path) : void 0;
		if (repoPath === null) return envelopeFail("outside-workspace", "path escapes the workspace");
		const result = await opDiff(root.rootReal, repoPath);
		if (result.code !== 0) return failResult(result);
		return envelopeOk(result.stdout);
	});
	handlers.set("git.diffCached", async (raw) => {
		const payload = asObject$1(raw);
		const root = await requireRoot(rootCache, payload.cwd, rootAllowed);
		if (!("rootReal" in root)) return root;
		const repoPath = typeof payload.path === "string" && payload.path !== "" ? await sanitizeRepoPath(root.rootReal, payload.path) : void 0;
		if (repoPath === null) return envelopeFail("outside-workspace", "path escapes the workspace");
		const result = await opDiffCached(root.rootReal, repoPath);
		if (result.code !== 0) return failResult(result);
		return envelopeOk(result.stdout);
	});
	handlers.set("git.log", async (raw) => {
		const payload = asObject$1(raw);
		const root = await requireRoot(rootCache, payload.cwd, rootAllowed);
		if (!("rootReal" in root)) return root;
		const limit = typeof payload.limit === "number" && payload.limit > 0 ? Math.min(Math.floor(payload.limit), 200) : 50;
		const result = await opLog(root.rootReal, limit);
		if (result.code !== 0) return failResult(result);
		return envelopeOk(result.stdout.split("\n").filter((line) => line !== "").map((line) => {
			const [hash, author, at, subject] = line.split("");
			return {
				hash: hash ?? "",
				author: author ?? "",
				at: Number(at ?? 0),
				subject: subject ?? ""
			};
		}));
	});
	handlers.set("git.branches", async (raw) => {
		const payload = asObject$1(raw);
		const root = await requireRoot(rootCache, payload.cwd, rootAllowed);
		if (!("rootReal" in root)) return root;
		const result = await opBranches(root.rootReal);
		if (result.code !== 0) return failResult(result);
		const branches = result.stdout.split("\n").filter((line) => line !== "").map((line) => {
			const [name, short] = line.split("	");
			return {
				name: name?.trim() ?? "",
				hash: short?.trim() ?? ""
			};
		});
		return envelopeOk({
			branches,
			current: branches.find((branch) => !branch.name.startsWith("remotes/"))?.name ?? ""
		});
	});
	handlers.set("git.stage", async (raw) => {
		const payload = asObject$1(raw);
		const guarded = await guardAllPaths(rootCache, payload, rootAllowed);
		if (!("rootReal" in guarded)) return guarded;
		const result = await opStage(guarded.rootReal, guarded.repoPaths);
		if (result.code !== 0) return failResult(result);
		return envelopeOk({ staged: guarded.repoPaths.length });
	});
	handlers.set("git.unstage", async (raw) => {
		const payload = asObject$1(raw);
		const guarded = await guardAllPaths(rootCache, payload, rootAllowed);
		if (!("rootReal" in guarded)) return guarded;
		const result = await opUnstage(guarded.rootReal, guarded.repoPaths);
		if (result.code !== 0) return failResult(result);
		return envelopeOk({ unstaged: guarded.repoPaths.length });
	});
	handlers.set("git.commit", async (raw) => {
		const payload = asObject$1(raw);
		const message = typeof payload.message === "string" ? payload.message.trim() : "";
		if (message === "") return envelopeFail("bad-request", "commit message is required");
		const root = await requireRoot(rootCache, payload.cwd, rootAllowed);
		if (!("rootReal" in root)) return root;
		const result = await opCommit(root.rootReal, message);
		if (result.code !== 0) return failResult(result);
		return envelopeOk({ committed: true });
	});
	const networkAction = (action) => {
		handlers.set(`git.${action}`, async (raw) => {
			const payload = asObject$1(raw);
			const remoteRaw = typeof payload.remote === "string" && payload.remote !== "" ? payload.remote : "origin";
			if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remoteRaw)) return envelopeFail("bad-request", "remote name has an unsupported shape");
			const root = await requireRoot(rootCache, payload.cwd, rootAllowed);
			if (!("rootReal" in root)) return root;
			if (payload.confirm !== true) {
				const remotes = await opRemotes(root.rootReal);
				const branchLine = (await opStatus(root.rootReal)).stdout.split("\n").find((line) => line.startsWith("## ")) ?? "";
				return envelopeOk({
					requiresConfirmation: true,
					action,
					remote: remoteRaw,
					remotes: remotes.stdout,
					tracking: branchLine.slice(3),
					timeoutMs: NETWORK_TIMEOUT_MS
				});
			}
			const result = await opNetwork(root.rootReal, action, remoteRaw);
			if (result.code !== 0) return fail$1(action === "push" ? "push-rejected" : "git-network-error", result.stderr || result.stdout);
			return envelopeOk({
				done: true,
				output: result.stdout + result.stderr
			});
		});
	};
	networkAction("fetch");
	networkAction("pull");
	networkAction("push");
	return handlers;
}
//#endregion
//#region src/fs-routes.ts
/**
* Filesystem route handlers behind `/workbench/api/fs.*`. Every handler
* follows the same discipline: validate the request shape, re-derive the
* workspace root from the request's `cwd`, run the path guard against the
* CURRENT filesystem, and only then touch disk. Client assertions about
* containment are never trusted.
*/
const READ_LIMIT_MAX = 8388608;
const SEARCH_DEPTH_MAX = 12;
const BINARY_EXTS = /* @__PURE__ */ new Set([
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"bmp",
	"ico",
	"avif",
	"pdf",
	"zip",
	"gz",
	"tar",
	"wasm",
	"exe",
	"dll",
	"mp3",
	"mp4",
	"webm",
	"woff",
	"woff2",
	"ttf",
	"otf",
	"class",
	"pyc",
	"so",
	"bin"
]);
/** Bounded cache of workspace cwd → realpathed root, recomputed on overflow. */
var RootCache = class {
	capacity;
	map = /* @__PURE__ */ new Map();
	constructor(capacity = 32) {
		this.capacity = capacity;
	}
	/**
	* Resolve (and cache) the realpathed workspace root for one cwd.
	* @param cwd - the working directory whose root to resolve.
	* @returns the real root path, or a failure marker when the cwd does not exist.
	*/
	async rootOf(cwd) {
		const cached = this.map.get(cwd);
		if (cached !== void 0) return cached;
		try {
			const real = await resolveWorkspaceRoot(cwd);
			if (this.map.size >= this.capacity) {
				const oldest = this.map.keys().next().value;
				if (typeof oldest === "string") this.map.delete(oldest);
			}
			this.map.set(cwd, real);
			return real;
		} catch {
			return { failed: true };
		}
	}
};
function asObject(payload) {
	return typeof payload === "object" && payload !== null ? payload : {};
}
function requireString(value, field) {
	if (typeof value !== "string" || value.length === 0) return envelopeFail("bad-request", `${field} is required`);
	return value;
}
function extOf(path) {
	const dot = path.lastIndexOf(".");
	const base = path.lastIndexOf("/");
	const slash = path.lastIndexOf("\\");
	return dot > Math.max(base, slash) ? path.slice(dot + 1).toLowerCase() : "";
}
async function guardPath(config, rootCache, cwd, pathValue, field) {
	const cwdCheck = requireString(cwd, "cwd");
	if (typeof cwdCheck !== "string") return cwdCheck;
	const pathCheck = requireString(pathValue, field);
	if (typeof pathCheck !== "string") return pathCheck;
	const root = await rootCache.rootOf(cwdCheck);
	if (typeof root !== "string") return envelopeFail("bad-request", "cwd is not an existing directory");
	if (config.rootAllowed !== void 0 && !config.rootAllowed(root)) return envelopeFail("outside-workspace", "cwd is outside the deployment workspace clamp");
	const verdict = await ensureRealPathInside(root, pathCheck);
	if (!verdict.allowed) return envelopeFail(verdict.code, verdict.message);
	return {
		cwdReal: root,
		target: verdict.target
	};
}
async function readHead(path, bytes) {
	const handle = await import("node:fs/promises").then((fs) => fs.open(path, "r"));
	try {
		const buffer = Buffer.alloc(bytes);
		const read = await handle.read(buffer, 0, bytes, 0);
		return buffer.subarray(0, read.bytesRead);
	} finally {
		await handle.close();
	}
}
function truncateUtf8(buffer, maxBytes) {
	let end = Math.min(buffer.byteLength, maxBytes);
	const truncatedFullFile = buffer.byteLength > maxBytes;
	if (truncatedFullFile) while (end > 0 && ((buffer[end] ?? 0) & 192) === 128) end -= 1;
	return {
		text: buffer.subarray(0, end).toString("utf8"),
		truncated: truncatedFullFile,
		size: buffer.byteLength
	};
}
/**
* Build the `/workbench/api/fs.*` handler map for the given root cache and config.
* @param rootCache - shared workspace-root cache used to resolve request cwds.
* @param config - deployment limits and clamps for the handlers.
* @returns the route method → handler map (all handlers return envelope values).
*/
function createFsHandlers(rootCache, config) {
	const handlers = /* @__PURE__ */ new Map();
	handlers.set("fs.tree", async (raw) => {
		const payload = asObject(raw);
		const guarded = await guardPath(config, rootCache, payload.cwd, payload.path, "path");
		if (!("target" in guarded)) return guarded;
		try {
			const dirents = await readdir(guarded.target, { withFileTypes: true });
			const entries = [];
			let truncated = false;
			for (const dirent of dirents) {
				if (entries.length >= config.listLimit) {
					truncated = true;
					break;
				}
				const entryPath = join(guarded.target, dirent.name);
				let broken = false;
				let isDir = dirent.isDirectory();
				if (dirent.isSymbolicLink()) try {
					isDir = (await stat(entryPath)).isDirectory();
				} catch {
					broken = true;
					isDir = false;
				}
				entries.push({
					name: dirent.name,
					path: entryPath,
					isDir,
					isSymlink: dirent.isSymbolicLink(),
					broken
				});
			}
			entries.sort((a, b) => {
				if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
				return a.name.localeCompare(b.name);
			});
			return envelopeOk({
				path: guarded.target,
				entries,
				truncated
			});
		} catch (cause) {
			return envelopeFail("not-found", cause instanceof Error ? cause.message : String(cause));
		}
	});
	handlers.set("fs.read", async (raw) => {
		const payload = asObject(raw);
		const guarded = await guardPath(config, rootCache, payload.cwd, payload.path, "path");
		if (!("target" in guarded)) return guarded;
		const requestedMax = typeof payload.maxBytes === "number" && Number.isFinite(payload.maxBytes) ? Math.max(1, Math.floor(payload.maxBytes)) : config.readLimitBytes;
		const maxBytes = Math.min(requestedMax, READ_LIMIT_MAX);
		try {
			const stats = await stat(guarded.target);
			if (stats.isDirectory()) return envelopeFail("bad-request", "path is a directory");
			const head = await readHead(guarded.target, 4096);
			if (BINARY_EXTS.has(extOf(guarded.target)) || head.includes(0)) return envelopeOk({
				kind: "binary",
				size: stats.size,
				truncated: stats.size > head.byteLength,
				headBase64: head.toString("base64")
			});
			const sliced = truncateUtf8(await readFile(guarded.target), maxBytes);
			return envelopeOk({
				kind: "text",
				content: sliced.text,
				truncated: sliced.truncated,
				size: sliced.size
			});
		} catch (cause) {
			return envelopeFail("not-found", cause instanceof Error ? cause.message : String(cause));
		}
	});
	handlers.set("fs.write", async (raw) => {
		const payload = asObject(raw);
		const guarded = await guardPath(config, rootCache, payload.cwd, payload.path, "path");
		if (!("target" in guarded)) return guarded;
		if (typeof payload.content !== "string") return envelopeFail("bad-request", "content must be a string");
		try {
			const parent = dirname(guarded.target);
			const parentVerdict = await ensureRealPathInside(guarded.cwdReal, parent);
			if (!parentVerdict.allowed) return envelopeFail(parentVerdict.code, parentVerdict.message);
			await mkdir(parent, { recursive: true });
			if ((await stat(guarded.target).catch(() => void 0))?.isDirectory()) return envelopeFail("bad-request", "target is a directory");
			const tmp = `${guarded.target}.zdsh-tmp-${Date.now()}-${randomBytes(4).toString("hex")}`;
			await writeFile2(tmp, Buffer.from(payload.content, "utf8"));
			try {
				await rename(tmp, guarded.target);
			} catch (renameError) {
				await rm(tmp, { force: true }).catch(() => {});
				throw renameError;
			}
			return envelopeOk({
				saved: true,
				size: (await stat(guarded.target)).size
			});
		} catch (cause) {
			return envelopeFail("io-error", cause instanceof Error ? cause.message : String(cause));
		}
	});
	handlers.set("fs.mkdir", async (raw) => {
		const payload = asObject(raw);
		const guarded = await guardPath(config, rootCache, payload.cwd, payload.path, "path");
		if (!("target" in guarded)) return guarded;
		try {
			await mkdir(guarded.target, { recursive: payload.recursive !== false });
			return envelopeOk({ created: true });
		} catch (cause) {
			return envelopeFail("io-error", cause instanceof Error ? cause.message : String(cause));
		}
	});
	handlers.set("fs.rename", async (raw) => {
		const payload = asObject(raw);
		const fromGuarded = await guardPath(config, rootCache, payload.cwd, payload.from, "from");
		if (!("target" in fromGuarded)) return fromGuarded;
		const toGuarded = await guardPath(config, rootCache, payload.cwd, payload.to, "to");
		if (!("target" in toGuarded)) return toGuarded;
		try {
			if ((await stat(toGuarded.target).catch(() => void 0))?.isDirectory()) return envelopeFail("bad-request", "destination is a directory");
			await rename(fromGuarded.target, toGuarded.target);
			return envelopeOk({ moved: true });
		} catch (cause) {
			return envelopeFail(cause.code === "EXDEV" ? "cross-device" : "io-error", cause instanceof Error ? cause.message : String(cause));
		}
	});
	handlers.set("fs.delete", async (raw) => {
		const payload = asObject(raw);
		const guarded = await guardPath(config, rootCache, payload.cwd, payload.path, "path");
		if (!("target" in guarded)) return guarded;
		try {
			if ((await stat(guarded.target)).isDirectory() && payload.recursive !== true) return envelopeFail("is-directory", "refusing to delete a directory without recursive");
			await rm(guarded.target, { recursive: payload.recursive === true });
			return envelopeOk({ deleted: true });
		} catch (cause) {
			return envelopeFail("not-found", cause instanceof Error ? cause.message : String(cause));
		}
	});
	handlers.set("fs.search", async (raw) => {
		const payload = asObject(raw);
		const cwdCheck = requireString(payload.cwd, "cwd");
		if (typeof cwdCheck !== "string") return cwdCheck;
		const query = typeof payload.query === "string" ? payload.query.trim().toLowerCase() : "";
		if (query === "") return envelopeFail("bad-request", "query is required");
		const root = await rootCache.rootOf(cwdCheck);
		if (typeof root !== "string") return envelopeFail("bad-request", "cwd is not an existing directory");
		if (config.rootAllowed !== void 0 && !config.rootAllowed(root)) return envelopeFail("outside-workspace", "cwd is outside the deployment workspace clamp");
		const startVerdict = await ensureRealPathInside(root, typeof payload.root === "string" && payload.root !== "" ? payload.root : root);
		if (!startVerdict.allowed) return envelopeFail(startVerdict.code, startVerdict.message);
		const limit = typeof payload.limit === "number" && payload.limit > 0 ? Math.min(Math.floor(payload.limit), config.searchLimit) : config.searchLimit;
		const needle = query.toLowerCase();
		const matches = [];
		let truncated = false;
		let nextDepth = [{
			dir: startVerdict.target,
			depth: 0
		}];
		while (nextDepth.length > 0 && !truncated) {
			const currentDepth = nextDepth;
			nextDepth = [];
			for (const { dir, depth } of currentDepth) {
				if (matches.length >= limit) {
					truncated = true;
					break;
				}
				let dirents;
				try {
					dirents = await readdir(dir, { withFileTypes: true });
				} catch {
					continue;
				}
				for (const dirent of dirents) {
					if (matches.length >= limit) {
						truncated = true;
						break;
					}
					const nameLower = dirent.name.toLowerCase();
					const childPath = join(dir, dirent.name);
					const skipBranch = dirent.isDirectory() && (dirent.name.startsWith(".") || nameLower === "node_modules");
					if (nameLower.includes(needle)) matches.push({
						path: childPath,
						isDir: dirent.isDirectory()
					});
					if (dirent.isDirectory() && !skipBranch && depth < SEARCH_DEPTH_MAX) nextDepth.push({
						dir: childPath,
						depth: depth + 1
					});
				}
			}
		}
		return envelopeOk({
			matches,
			truncated
		});
	});
	return handlers;
}
async function writeFile2(path, data) {
	await (await import("node:fs/promises")).writeFile(path, data);
}
/**
* Body reader shared by the router; enforces the configured byte cap.
* @param req - the incoming request whose body to drain.
* @param capBytes - hard byte cap; exceeding it throws 'body-too-large'.
* @returns the concatenated request body.
*/
async function readBody(req, capBytes) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		const piece = chunk;
		total += piece.byteLength;
		if (total > capBytes) throw new Error("body-too-large");
		chunks.push(piece);
	}
	return Buffer.concat(chunks);
}
//#endregion
//#region src/shared/task-protocol.ts
/** Canonical task statuses in display order. */
const TASK_STATUSES = [
	"todo",
	"doing",
	"done"
];
//#endregion
//#region src/task-ledger.ts
/**
* Host-authoritative task ledger. One JSON document, one monotonic
* revision, atomic tmp+rename persistence with corrupt-file quarantine
* (a damaged ledger is preserved for inspection and replaced by a fresh
* empty one — fail visible, never fail the boot).
*/
const TITLE_MAX = 200;
function defaultFilePath() {
	const branchHome = process.env.DSH_BRANCH_HOME;
	if (branchHome !== void 0 && branchHome.trim().length > 0) return join(resolve(branchHome), "workbench", "tasks.json");
	const dshHome = process.env.DSH_HOME;
	if (dshHome !== void 0 && dshHome.trim().length > 0) return join(resolve(dshHome), "zdsh", "workbench", "tasks.json");
	const home = process.env.HOME ?? process.env.UserProfile ?? ".";
	return join(home, ".zdsh-workbench", "tasks.json");
}
function isStatus(value) {
	return typeof value === "string" && TASK_STATUSES.includes(value);
}
/** Host-authoritative task ledger with atomic persistence and revision bumps. */
var TaskLedger = class {
	snapshot = {
		revision: 0,
		tasks: []
	};
	listeners = /* @__PURE__ */ new Set();
	filePath;
	constructor(options = {}) {
		this.filePath = options.filePath ?? defaultFilePath();
	}
	/**
	* Subscribe to revision-change pings.
	* @param listener - callback invoked with the tasks frame after every commit.
	* @returns a disposer that removes the listener.
	*/
	subscribe(listener) {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	/**
	* Current ledger snapshot.
	* @returns the in-memory snapshot (revision plus tasks).
	*/
	getSnapshot() {
		return this.snapshot;
	}
	/** Load at boot; missing file is a fresh start, corrupt file quarantines. */
	async init() {
		let raw = null;
		try {
			raw = await readFile(this.filePath, "utf8");
		} catch {
			raw = null;
		}
		if (raw !== null) {
			try {
				const parsed = JSON.parse(raw);
				if (typeof parsed.revision === "number" && parsed.revision >= 0 && Array.isArray(parsed.tasks) && parsed.tasks.every((task) => typeof task.id === "string" && typeof task.title === "string" && isStatus(task.status))) {
					this.snapshot = {
						revision: parsed.revision,
						tasks: parsed.tasks
					};
					return;
				}
			} catch {}
			await this.quarantine();
		}
		await this.persist();
	}
	async quarantine() {
		const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
		const target = `${this.filePath}.corrupt-${stamp}-${randomBytes(2).toString("hex")}`;
		await rename(this.filePath, target).catch(() => {});
	}
	async persist() {
		await mkdir(dirname(this.filePath), { recursive: true }).catch(() => {});
		const tmp = join(dirname(this.filePath), `${basenameSafe(this.filePath)}.tmp-${randomBytes(4).toString("hex")}`);
		await writeFile(tmp, JSON.stringify(this.snapshot));
		await rename(tmp, this.filePath);
		await rm(tmp, { force: true }).catch(() => {});
	}
	async commit(mutate) {
		const tasks = mutate();
		this.snapshot = {
			revision: this.snapshot.revision + 1,
			tasks
		};
		try {
			await this.persist();
		} catch (cause) {
			this.snapshot = { ...this.snapshot };
			return envelopeFail("persistence-failed", cause instanceof Error ? cause.message : String(cause));
		}
		for (const listener of this.listeners) listener({
			domain: "tasks",
			revision: this.snapshot.revision
		});
		return envelopeOk(this.snapshot);
	}
	/**
	* Current ledger snapshot as the envelope answer.
	* @returns the ok envelope carrying the snapshot.
	*/
	list() {
		return envelopeOk(this.snapshot);
	}
	/**
	* Create a task from the RPC payload.
	* @param payload - the create request (title required, status optional).
	* @returns the ok envelope with the new snapshot, or a failure envelope.
	*/
	create(payload) {
		const request = payload;
		const title = typeof request.title === "string" ? request.title.trim() : "";
		if (title === "") return Promise.resolve(envelopeFail("bad-request", "title is required"));
		if (title.length > TITLE_MAX) return Promise.resolve(envelopeFail("bad-request", `title exceeds ${String(TITLE_MAX)} characters`));
		const status = isStatus(request.status) ? request.status : "todo";
		return this.commit(() => [...this.snapshot.tasks, {
			id: `t-${Date.now()}-${randomBytes(3).toString("hex")}`,
			title,
			status,
			createdAt: Date.now(),
			updatedAt: Date.now()
		}]);
	}
	/**
	* Update a task from the RPC payload.
	* @param payload - the update request (id required, fields optional).
	* @returns the ok envelope with the new snapshot, or a failure envelope.
	*/
	update(payload) {
		const request = payload;
		const id = typeof request.id === "string" ? request.id : "";
		if (this.snapshot.tasks.find((task) => task.id === id) === void 0) return Promise.resolve(envelopeFail("not-found", "no such task"));
		if (request.status !== void 0 && !isStatus(request.status)) return Promise.resolve(envelopeFail("bad-request", "invalid status"));
		const title = typeof request.title === "string" ? request.title.trim() : void 0;
		return this.commit(() => this.snapshot.tasks.map((task) => task.id !== id ? task : {
			...task,
			title: title !== void 0 && title !== "" ? title.slice(0, TITLE_MAX) : task.title,
			status: isStatus(request.status) ? request.status : task.status,
			updatedAt: Date.now()
		}));
	}
	/**
	* Delete a task from the RPC payload.
	* @param payload - the delete request (id required).
	* @returns the ok envelope with the new snapshot, or a failure envelope.
	*/
	remove(payload) {
		const request = payload;
		const id = typeof request.id === "string" ? request.id : "";
		if (!this.snapshot.tasks.some((task) => task.id === id)) return Promise.resolve(envelopeFail("not-found", "no such task"));
		return this.commit(() => this.snapshot.tasks.filter((task) => task.id !== id));
	}
};
function basenameSafe(path) {
	const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return index === -1 ? path : path.slice(index + 1);
}
//#endregion
//#region src/trust.ts
const LOOPBACK_HOSTNAMES = /* @__PURE__ */ new Set([
	"localhost",
	"127.0.0.1",
	"[::1]",
	"::1"
]);
/** Parse one authority string into its hostname/port parts, or undefined when unparsable. */
function parseAuthority(authority) {
	try {
		const parsed = new URL(`http://${authority}`);
		const httpsPort = new URL(`https://${authority}`).port;
		return {
			hostname: parsed.hostname,
			explicitPort: parsed.port !== "" || httpsPort !== ""
		};
	} catch {
		return;
	}
}
/** Canonical `hostname` or `hostname:port` form of a configured entry. */
function canonicalAuthority(entry) {
	const parts = parseAuthority(entry);
	if (parts === void 0) return void 0;
	return parts.explicitPort ? normalizeWithPort(entry) : parts.hostname;
}
function normalizeWithPort(entry) {
	const parsed = new URL(`http://${entry}`);
	return `${parsed.hostname}:${parsed.port}`;
}
/**
* Validate one configured trusted-hosts entry at load time: it must be a
* bare `host[:port]` authority that survives canonical parsing unchanged
* (case aside). Paths, user info, whitespace, dangling or zero-padded ports,
* and non-canonical host spellings are refused loudly instead of silently
* narrowing (or broadening) the grant until some request 403s.
* @param entry - the configured `host[:port]` authority to validate.
*/
function assertTrustedAuthorityEntry(entry) {
	const canonical = canonicalAuthority(entry);
	if (canonical !== void 0 && canonical === entry.toLowerCase()) return;
	throw new Error(`workbench: trustedHosts entry ${JSON.stringify(entry)} is not a bare host[:port] authority`);
}
/**
* Decide whether a request may proceed from its headers alone. The Host
* header binds the decision: loopback hostnames pass regardless of port;
* anything else must match one configured authority in exact canonical form.
* @param headers - the request headers whose Host value binds the decision.
* @param trustedEntries - the deployment-configured trusted authorities.
* @returns true when the request host is loopback or in the trusted set.
*/
function isTrustedRequestHost(headers, trustedEntries) {
	const host = headers.host;
	if (typeof host !== "string" || host.length === 0) return false;
	const parts = parseAuthority(host);
	if (parts === void 0) return false;
	if (LOOPBACK_HOSTNAMES.has(parts.hostname)) return true;
	if (trustedEntries.length === 0) return false;
	const requested = canonicalAuthority(host);
	if (requested === void 0) return false;
	return trustedEntries.some((entry) => canonicalAuthority(entry) === requested);
}
//#endregion
//#region src/media-route.ts
/**
* Media byte route `/workbench/file`: streams workspace files to the
* browser for image/pdf/video-style previews and downloads. Same fence,
* same guard, same caps as the JSON API — the only difference is that the
* payload is raw bytes with a conservative content type.
*/
const MEDIA_LIMIT_BYTES = 209715200;
const CONTENT_TYPES = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
	ico: "image/x-icon",
	svg: "image/svg+xml",
	avif: "image/avif",
	pdf: "application/pdf",
	mp4: "video/mp4",
	webm: "video/webm",
	txt: "text/plain; charset=utf-8",
	md: "text/plain; charset=utf-8"
};
/**
* Create the media byte handler for `/workbench/file`. Same fence, guard, and
* caps as the JSON API; the payload is raw bytes with a conservative content type.
* @param rootCache - shared workspace-root cache used to resolve request cwds.
* @param trustedHosts - deployment-configured host authorities allowed past the Host fence.
* @param rootAllowed - optional deployment clamp on resolved workspace roots.
* @returns the HTTP handler streaming the guarded file, or an error status.
*/
function createMediaHandler(rootCache, trustedHosts, rootAllowed) {
	return async function handle(req, res) {
		if (!isTrustedRequestHost(req.headers, trustedHosts)) {
			res.writeHead(403, { "content-type": "text/plain" });
			res.end("forbidden");
			return;
		}
		const url = new URL(req.url ?? "/", "http://workbench.invalid");
		const cwd = url.searchParams.get("cwd") ?? "";
		const requested = url.searchParams.get("path") ?? "";
		const download = url.searchParams.get("download") === "1";
		const rootReal = typeof cwd === "string" && cwd !== "" ? await rootCache.rootOf(cwd) : void 0;
		if (typeof rootReal !== "string" || requested === "") {
			res.writeHead(400, { "content-type": "text/plain" });
			res.end("bad request");
			return;
		}
		if (rootAllowed !== void 0 && !rootAllowed(rootReal)) {
			res.writeHead(403, { "content-type": "text/plain" });
			res.end("outside workspace clamp");
			return;
		}
		const verdict = await ensureRealPathInside(rootReal, requested);
		if (!verdict.allowed) {
			res.writeHead(403, { "content-type": "text/plain" });
			res.end("outside workspace");
			return;
		}
		let size;
		try {
			const stats = await stat(verdict.target);
			if (!stats.isFile()) {
				res.writeHead(400, { "content-type": "text/plain" });
				res.end("not a file");
				return;
			}
			size = stats.size;
		} catch {
			res.writeHead(404, { "content-type": "text/plain" });
			res.end("not found");
			return;
		}
		if (size > MEDIA_LIMIT_BYTES) {
			res.writeHead(413, { "content-type": "text/plain" });
			res.end("file too large");
			return;
		}
		const ext = verdict.target.slice(verdict.target.lastIndexOf(".") + 1).toLowerCase();
		const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";
		res.writeHead(200, {
			"content-type": contentType,
			"content-length": String(size),
			"x-content-type-options": "nosniff",
			"content-security-policy": "default-src 'none'; sandbox",
			...download ? { "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileNameOf(verdict.target))}` } : {}
		});
		const stream = createReadStream(verdict.target);
		stream.on("error", () => {
			req.destroy();
		});
		stream.pipe(res);
	};
}
function fileNameOf(path) {
	const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return index === -1 ? path : path.slice(index + 1);
}
//#endregion
//#region src/fs-watch.ts
/**
* Filesystem watcher manager: one fs.watch per active root, events debounced
* into batches, reference-counted so the last subscriber leaving schedules
* teardown, and an LRU cap on concurrently open watchers.
*
* `recursive` is supported natively on win32/darwin; on linux the initial
* recursive watch throws, so that root degrades to a shallow watch of the
* top level only (clients keep manual refresh as the fallback path).
*/
function defaultWatchFactory(root, onChange) {
	return watch(root, { recursive: true }, (_event, filename) => {
		onChange("modify", typeof filename === "string" ? filename : null);
	});
}
/** Reference-counted debouncing watcher manager; the last subscriber leaving schedules teardown. */
var FsWatcherManager = class {
	roots = /* @__PURE__ */ new Map();
	listeners = /* @__PURE__ */ new Set();
	debounceMs;
	maxRoots;
	idleCloseMs;
	factory;
	constructor(options = {}) {
		this.debounceMs = options.debounceMs ?? 150;
		this.maxRoots = options.maxRoots ?? 16;
		this.idleCloseMs = options.idleCloseMs ?? 3e4;
		this.factory = options.watchFactory ?? defaultWatchFactory;
	}
	/**
	* Subscribe to relayed watcher frames.
	* @param listener - callback invoked for every fs batch and foreign-domain frame.
	* @returns a disposer that removes the listener and schedules idle sweeps.
	*/
	subscribe(listener) {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
			this.scheduleIdleSweeps();
		};
	}
	/**
	* Subscribe one consumer connection to a set of roots.
	* @param roots - the root paths to watch (empty/invalid entries are skipped).
	* @returns a disposer that releases one reference on each added root.
	*/
	addRoots(roots) {
		const added = [];
		for (const root of roots) {
			if (typeof root !== "string" || root === "") continue;
			this.ensureRoot(root);
			const entry = this.roots.get(root);
			if (entry !== void 0) {
				entry.refcount += 1;
				added.push(root);
			}
		}
		return () => {
			for (const root of added) {
				const entry = this.roots.get(root);
				if (entry === void 0) continue;
				entry.refcount = Math.max(0, entry.refcount - 1);
				if (entry.refcount === 0) {
					if (entry.idleTimer !== void 0) clearTimeout(entry.idleTimer);
					entry.idleTimer = setTimeout(() => {
						if (this.roots.get(root)?.refcount === 0) this.closeRoot(root);
					}, this.idleCloseMs);
					if (typeof entry.idleTimer.unref === "function") entry.idleTimer.unref();
				}
			}
		};
	}
	/**
	* Relay a foreign-domain frame (e.g. tasks revision pings) to all SSE clients.
	* @param frame - the frame to relay; domain is preserved verbatim.
	*/
	broadcast(frame) {
		for (const listener of this.listeners) listener(frame);
	}
	/**
	* Number of roots currently under watch.
	* @returns the count of live root entries.
	*/
	activeRootCount() {
		return this.roots.size;
	}
	/**
	* Whether a root degraded to a shallow watch (recursive unsupported).
	* @param root - the root path to query.
	* @returns true when the root's watcher is degraded or unknown.
	*/
	isDegraded(root) {
		return this.roots.get(root)?.degraded ?? false;
	}
	/** Force-flush pending debounce batches; test-only entry point. */
	flushForTests() {
		for (const entry of this.roots.values()) if (entry.debounceTimer !== void 0) {
			clearTimeout(entry.debounceTimer);
			entry.emitBatch();
		}
	}
	ensureRoot(root) {
		if (this.roots.has(root)) return;
		while (this.roots.size >= this.maxRoots) {
			const oldest = this.roots.keys().next().value;
			if (oldest === void 0) break;
			this.closeRoot(oldest);
		}
		const entry = {
			handle: { close: () => {} },
			degraded: false,
			refcount: 0,
			pending: /* @__PURE__ */ new Map(),
			emitBatch: () => {
				this.emitBatch(entry, root);
			}
		};
		try {
			entry.handle = this.factory(root, (kind, filename) => {
				if (filename === null) return;
				const changePath = join(root, filename);
				entry.pending.set(changePath, {
					kind,
					path: changePath,
					isDir: false
				});
				if (entry.debounceTimer === void 0) {
					entry.debounceTimer = setTimeout(() => {
						entry.debounceTimer = void 0;
						entry.emitBatch();
					}, this.debounceMs);
					if (typeof entry.debounceTimer.unref === "function") entry.debounceTimer.unref();
				}
			});
		} catch {
			entry.degraded = true;
		}
		this.roots.set(root, entry);
	}
	emitBatch(entry, root) {
		if (entry.pending.size === 0) return;
		const changes = [...entry.pending.values()];
		entry.pending.clear();
		const frame = {
			domain: "fs",
			changes
		};
		for (const listener of this.listeners) listener(frame);
	}
	closeRoot(root) {
		const entry = this.roots.get(root);
		if (entry === void 0) return;
		if (entry.debounceTimer !== void 0) clearTimeout(entry.debounceTimer);
		if (entry.idleTimer !== void 0) clearTimeout(entry.idleTimer);
		try {
			entry.handle.close();
		} catch {}
		this.roots.delete(root);
	}
	scheduleIdleSweeps() {}
};
//#endregion
//#region src/pty-registry.ts
/**
* PTY registry: owns terminal processes keyed by `sessionId:termId`, with a
* per-session quota, a replay ring buffer per terminal, and a reconnect
* grace period before an orphaned process is killed.
*
* Security posture: the executable is NEVER taken from request data. It is
* resolved once from deployment configuration / platform defaults and then
* validated against a strict shape (absolute path or bare known-shell name)
* before any process creation. Request payloads only ever supply cwd, size,
* and stdin bytes.
*
* Transport-agnostic by design: callbacks + buffers, so the WebSocket route
* stays thin and unit tests run without sockets or native modules.
*/
const WINDOWS_SHELL_BASENAMES = /* @__PURE__ */ new Set([
	"pwsh.exe",
	"powershell.exe",
	"cmd.exe"
]);
/** First non-empty line from a command's stdout, or null. */
function firstOutputLine(stdout) {
	for (const line of stdout.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.length > 0) return trimmed;
	}
	return null;
}
/**
* Validate a resolved shell before it may reach any spawn seam: on Windows
* only the known shell basenames pass — including absolute paths, whose final
* segment must still be a known shell (an absolute `C:\Tools\evil.exe` is not
* a shell just because it is absolute). Elsewhere the value must be an
* absolute, existing, executable path. Returns null when unusable.
* @param resolution - the resolved shell to validate.
* @returns the validated resolution, or null when unusable.
*/
function validateShellResolution(resolution) {
	const file = resolution.file.trim();
	if (file === "") return null;
	if (process.platform === "win32") {
		if (!WINDOWS_SHELL_BASENAMES.has(win32.basename(file).toLowerCase())) return null;
		return {
			file,
			args: resolution.args
		};
	}
	if (!file.startsWith("/")) return null;
	try {
		accessSync(file, constants.X_OK);
	} catch {
		return null;
	}
	return {
		file,
		args: resolution.args
	};
}
function defaultSpawner(request) {
	let term;
	import("node-pty").then((pty) => {
		term = pty.spawn(request.file, request.args, {
			name: "xterm-256color",
			cols: request.cols,
			rows: request.rows,
			...request.cwd === void 0 ? {} : { cwd: request.cwd },
			env: process.env
		});
		term.onData((data) => {
			request.onData(Buffer.from(data, "utf8"));
		});
		term.onExit(({ exitCode }) => {
			request.onExit(exitCode);
		});
	}).catch(() => {});
	if (term === void 0) return {
		pid: -1,
		write: () => {},
		resize: () => {},
		kill: () => {}
	};
	const bound = term;
	return {
		pid: bound.pid,
		write: (data) => {
			bound.write(data);
		},
		resize: (cols, rows) => {
			bound.resize(cols, rows);
		},
		kill: () => {
			bound.kill();
		}
	};
}
/**
* Windows-first probe: configured override → pwsh 7 → inbox PowerShell → ComSpec.
* @returns the resolved shell file plus argument prefix.
*/
function resolveShell() {
	if (process.platform === "win32") {
		const configured = process.env.DSH_WORKBENCH_SHELL?.trim();
		if (configured !== void 0 && configured !== "") return {
			file: configured,
			args: ["-NoLogo"]
		};
		const probe = resolveLookupProbe();
		if (probe !== null) try {
			for (const candidate of ["pwsh.exe", "powershell.exe"]) {
				const whereResult = spawnSync(probe, [candidate], {
					encoding: "utf8",
					cwd: process.env.SystemRoot ?? process.env.WINDIR ?? void 0
				});
				if (whereResult.status === 0) {
					const resolved = firstOutputLine(whereResult.stdout);
					if (resolved !== null && win32.isAbsolute(resolved)) return {
						file: resolved,
						args: ["-NoLogo"]
					};
				}
			}
		} catch {}
		const comspec = process.env.ComSpec?.trim();
		if (comspec !== void 0 && comspec !== "" && win32.isAbsolute(comspec)) return {
			file: comspec,
			args: []
		};
		return {
			file: "cmd.exe",
			args: []
		};
	}
	return {
		file: process.env.SHELL ?? "/bin/bash",
		args: ["-l"]
	};
}
/** Owns terminal processes per session: quota, replay buffers, and reconnect grace. */
var PtyRegistry = class PtyRegistry {
	terminals = /* @__PURE__ */ new Map();
	sessionCounts = /* @__PURE__ */ new Map();
	termsPerSession;
	replayBufferBytesLimit;
	graceMs;
	constructor(dependencies = {}) {
		this.termsPerSession = dependencies.terminalsPerSession ?? 3;
		this.replayBufferBytesLimit = dependencies.replayBufferBytes ?? 262144;
		this.graceMs = dependencies.reconnectGraceMs ?? 3e4;
		this.spawnerFn = dependencies.spawner ?? defaultSpawner;
		this.shellResolverFn = dependencies.shellResolver ?? resolveShell;
	}
	spawnerFn;
	shellResolverFn;
	/**
	* Composite key for one terminal record.
	* @param sessionId - the owning session id.
	* @param termId - the terminal id within the session.
	* @returns the `${sessionId}:${termId}` map key.
	*/
	static key(sessionId, termId) {
		return `${sessionId}:${termId}`;
	}
	/**
	* Live terminal count for one session.
	* @param sessionId - the session to count.
	* @returns the number of currently held terminals.
	*/
	countFor(sessionId) {
		return this.sessionCounts.get(sessionId) ?? 0;
	}
	/**
	* Open or reattach. Reattach cancels any pending grace-period kill and
	* answers with the replay buffer so scrollback survives the round trip.
	* @param sessionId - the owning session id.
	* @param termId - the terminal id within the session.
	* @param events - the event sinks to wire to the terminal.
	* @param options - optional spawn geometry (cwd, cols, rows).
	* @returns the attach result, or an error code plus message.
	*/
	open(sessionId, termId, events, options) {
		const key = PtyRegistry.key(sessionId, termId);
		const existing = this.terminals.get(key);
		if (existing !== void 0 && existing.process !== null) {
			if (existing.graceTimer !== void 0) {
				clearTimeout(existing.graceTimer);
				existing.graceTimer = void 0;
			}
			existing.attached = true;
			existing.events = events;
			return {
				pid: existing.process.pid,
				shell: this.shellLabel,
				replayBase64: existing.buffer.toString("base64")
			};
		}
		const currentCount = this.countFor(sessionId);
		if (currentCount >= this.termsPerSession) return {
			error: "quota-exceeded",
			message: `session already holds ${currentCount} terminals`
		};
		const resolution = this.shellResolutionValidated;
		if (resolution === null) return {
			error: "shell-unresolved",
			message: "没有可用的受支持 shell（检查 DSH_WORKBENCH_SHELL 配置）"
		};
		const record = {
			process: null,
			buffer: Buffer.alloc(0),
			attached: true,
			events
		};
		let spawned = null;
		try {
			spawned = this.spawnerFn({
				file: resolution.file,
				args: resolution.args,
				...options?.cwd === void 0 ? {} : { cwd: options.cwd },
				cols: options?.cols ?? 80,
				rows: options?.rows ?? 24,
				onData: (chunk) => {
					record.buffer = Buffer.concat([record.buffer, chunk]);
					if (record.buffer.byteLength > this.replayBufferBytesLimit) record.buffer = record.buffer.subarray(record.buffer.byteLength - this.replayBufferBytesLimit);
					record.events?.onData(chunk.toString("base64"));
				},
				onExit: (exitCode) => {
					record.events?.onExit(exitCode);
					this.disposeRecord(sessionId, termId, record);
					this.terminals.delete(key);
				}
			});
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			const code = /Cannot find module|node-pty/.test(message) ? "pty-unavailable" : "spawn-failed";
			return {
				error: code,
				message: code === "pty-unavailable" ? "node-pty 原生模块不可用：在插件目录执行 pnpm approve-builds 后重启 DSH" : message
			};
		}
		record.process = spawned;
		this.terminals.set(key, record);
		this.sessionCounts.set(sessionId, currentCount + 1);
		return {
			pid: spawned.pid,
			shell: this.shellLabel,
			replayBase64: record.buffer.toString("base64")
		};
	}
	/**
	* Driver/test entry: push output through the live replay+stream path.
	* @param sessionId - the owning session id.
	* @param termId - the terminal id within the session.
	* @param chunk - the output bytes to push (string is utf8-encoded).
	*/
	feedData(sessionId, termId, chunk) {
		const record = this.terminals.get(PtyRegistry.key(sessionId, termId));
		if (record === void 0) return;
		const piece = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
		record.buffer = Buffer.concat([record.buffer, piece]);
		if (record.buffer.byteLength > this.replayBufferBytesLimit) record.buffer = record.buffer.subarray(record.buffer.byteLength - this.replayBufferBytesLimit);
		record.events?.onData(piece.toString("base64"));
	}
	/**
	* Driver/test entry: run the process-exit cleanup path.
	* @param sessionId - the owning session id.
	* @param termId - the terminal id within the session.
	* @param exitCode - the exit code to report.
	*/
	feedExit(sessionId, termId, exitCode) {
		const key = PtyRegistry.key(sessionId, termId);
		const record = this.terminals.get(key);
		if (record === void 0) return;
		record.events?.onExit(exitCode);
		this.disposeRecord(sessionId, termId, record);
		this.terminals.delete(key);
	}
	/**
	* Write stdin bytes into a live, attached terminal.
	* @param sessionId - the owning session id.
	* @param termId - the terminal id within the session.
	* @param data - the input text to write.
	* @returns true when the write reached a live terminal.
	*/
	input(sessionId, termId, data) {
		const record = this.terminals.get(PtyRegistry.key(sessionId, termId));
		if (record?.process === null || record === void 0 || !record.attached) return false;
		record.process.write(data);
		return true;
	}
	/**
	* Resize a live terminal's viewport.
	* @param sessionId - the owning session id.
	* @param termId - the terminal id within the session.
	* @param cols - the column count (minimum 2).
	* @param rows - the row count (minimum 1).
	* @returns true when the resize reached a live process.
	*/
	resize(sessionId, termId, cols, rows) {
		const record = this.terminals.get(PtyRegistry.key(sessionId, termId));
		if (record === void 0 || record.process === null) return false;
		record.process.resize(Math.max(2, Math.floor(cols)), Math.max(1, Math.floor(rows)));
		return true;
	}
	/**
	* Socket dropped for ONE terminal: mark detached and start the countdown.
	* @param sessionId - the owning session id.
	* @param termId - the terminal id within the session.
	*/
	detach(sessionId, termId) {
		const record = this.terminals.get(PtyRegistry.key(sessionId, termId));
		if (record === void 0 || !record.attached) return;
		record.attached = false;
		if (record.graceTimer === void 0 && record.process !== null) {
			record.graceTimer = setTimeout(() => {
				record.process?.kill();
			}, this.graceMs);
			if (typeof record.graceTimer.unref === "function") record.graceTimer.unref();
		}
	}
	/** Socket dropped entirely: every live terminal enters its grace period. */
	detachAll() {
		for (const [key] of this.terminals) {
			const [sessionId, termId] = [sessionPart(key), termPart(key)];
			this.detach(sessionId, termId);
		}
	}
	/**
	* Reattach path clears the countdown for exactly one terminal.
	* @param sessionId - the owning session id.
	* @param termId - the terminal id within the session.
	*/
	cancelGrace(sessionId, termId) {
		const record = this.terminals.get(PtyRegistry.key(sessionId, termId));
		if (record?.graceTimer === void 0) return;
		clearTimeout(record.graceTimer);
		record.graceTimer = void 0;
	}
	/**
	* Close one terminal immediately, killing the process and releasing quota.
	* @param sessionId - the owning session id.
	* @param termId - the terminal id within the session.
	* @returns true when a terminal was found and closed.
	*/
	close(sessionId, termId) {
		const key = PtyRegistry.key(sessionId, termId);
		const record = this.terminals.get(key);
		if (record === void 0) return false;
		record.process?.kill();
		this.disposeRecord(sessionId, termId, record);
		this.terminals.delete(key);
		return true;
	}
	/** Kill every held terminal and clear all records (teardown path). */
	disposeAll() {
		for (const [key, record] of [...this.terminals.entries()]) {
			record.process?.kill();
			this.disposeRecord(sessionPart(key), termPart(key), record);
			this.terminals.delete(key);
		}
	}
	get shellLabel() {
		return this.shellResolutionValidated?.file ?? "";
	}
	get shellResolutionValidated() {
		return validateShellResolution(this.shellResolverFn());
	}
	disposeRecord(sessionId, termId, record) {
		if (record.graceTimer !== void 0) clearTimeout(record.graceTimer);
		const remaining = this.countFor(sessionId) - 1;
		if (remaining <= 0) this.sessionCounts.delete(sessionId);
		else this.sessionCounts.set(sessionId, remaining);
		record.process = null;
	}
};
function sessionPart(key) {
	const index = key.indexOf(":");
	return index === -1 ? key : key.slice(0, index);
}
function termPart(key) {
	const index = key.indexOf(":");
	return index === -1 ? "" : key.slice(index + 1);
}
//#endregion
//#region src/terminal-route.ts
/**
* Terminal WebSocket route: thin glue between `/workbench/ws/terminal`
* frames and the PTY registry. Message semantics live in
* `createTerminalMessenger` (unit-tested); the socket layer here only
* parses, dispatches, and cleans up on disconnect.
*/
/**
* Pure message handler: one client message in, zero or more server messages
* out (plus side effects on the registry). Synchronous because `open`
* resolves its lazy native-module load inside the spawner seam.
* @param registry - the PTY registry the messenger dispatches into.
* @returns a handle object with one `handle(socket, raw)` dispatch entry.
*/
function createTerminalMessenger(registry) {
	const send = (socket, message) => {
		if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
	};
	return { handle(socket, raw) {
		let parsed;
		try {
			parsed = JSON.parse(String(raw));
		} catch {
			send(socket, {
				t: "error",
				code: "bad-frame",
				message: "frame is not valid JSON"
			});
			return;
		}
		const { sessionId, termId } = parsed;
		if (typeof sessionId !== "string" || typeof termId !== "string") {
			send(socket, {
				t: "error",
				code: "bad-frame",
				message: "sessionId and termId are required"
			});
			return;
		}
		switch (parsed.t) {
			case "open": {
				const result = registry.open(sessionId, termId, {
					onData: (base64Chunk) => {
						send(socket, {
							t: "data",
							sessionId,
							termId,
							dataBase64: base64Chunk
						});
					},
					onExit: (exitCode) => {
						send(socket, {
							t: "exit",
							sessionId,
							termId,
							exitCode
						});
					}
				}, {
					...typeof parsed.cwd === "string" ? { cwd: parsed.cwd } : {},
					cols: 80,
					rows: 24
				});
				if ("error" in result) {
					send(socket, {
						t: "error",
						sessionId,
						termId,
						code: result.error,
						message: result.message
					});
					return;
				}
				registry.cancelGrace(sessionId, termId);
				send(socket, {
					t: "attached",
					sessionId,
					termId,
					pid: result.pid,
					shell: result.shell,
					replayBase64: result.replayBase64
				});
				return;
			}
			case "input": {
				const data = parsed.data;
				if (!registry.input(sessionId, termId, typeof data === "string" ? data : "")) send(socket, {
					t: "error",
					sessionId,
					termId,
					code: "not-attached",
					message: "no live terminal for this id"
				});
				return;
			}
			case "resize": {
				const cols = Number(parsed.cols);
				const rows = Number(parsed.rows);
				if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
					send(socket, {
						t: "error",
						sessionId,
						termId,
						code: "bad-frame",
						message: "resize needs numeric cols/rows"
					});
					return;
				}
				registry.resize(sessionId, termId, cols, rows);
				return;
			}
			case "close":
				registry.close(sessionId, termId);
				return;
			default: send(socket, {
				t: "error",
				sessionId,
				termId,
				code: "bad-frame",
				message: "unknown message type"
			});
		}
	} };
}
/**
* Attach the terminal route to an upgraded socket.
* @param registry - the PTY registry backing the socket.
* @param req - the upgrade request.
* @param socket - the upgraded duplex socket.
* @param head - buffered bytes following the upgrade handshake.
* @param options - toggle for detaching all terminals on close.
*/
function acceptTerminalSocket(registry, req, socket, head, options = {}) {
	new WebSocketServer({ noServer: true }).handleUpgrade(req, socket, head, (ws) => {
		const messenger = createTerminalMessenger(registry);
		ws.on("message", (raw) => {
			messenger.handle(ws, raw);
		});
		if (options.detachOnClose !== false) ws.on("close", () => {
			registry.detachAll();
		});
	});
}
//#endregion
//#region src/vendor/dsh-compat/guard.ts
/**
* Default client-side logger backed by `console`.
* @returns A {@link CompatLogger} delegating to `console.warn`/`console.info`.
*/
function consoleCompatLogger() {
	return {
		warn(message, ...args) {
			console.warn(message, ...args);
		},
		info(message, ...args) {
			console.info(message, ...args);
		}
	};
}
/** Process-level audit roster keyed by feature id (module-private; read via {@link getCompatRoster}). */
const compatRoster = /* @__PURE__ */ new Map();
/**
* Feature registration guard: call before a feature registers itself. Every
* `deps` and `check` must pass for `enabled` to be `true`; on the first
* failure the remaining checks are skipped (short-circuit), a warning is
* logged, and `enabled` is `false`. Never throws; a throwing `run` counts as
* a failure with reason `threw:<message>`. Callers must skip registration
* when `enabled` is `false` without affecting other features.
*
* @param featureId - Feature identifier (e.g. 'dsh-model-slots'), also the roster key.
* @param options - Registration options (`deps`/`check`/`logPrefix`/`logger`).
* @returns The verdict with `enabled`/`reason`/`failures`.
*/
async function guardFeature(featureId, options) {
	const logger = options.logger ?? consoleCompatLogger();
	const logPrefix = options.logPrefix ?? featureId;
	const failures = [];
	let reason = "ok";
	let enabled = true;
	const runCheck = async (check) => {
		try {
			return await check.run();
		} catch (error) {
			return `threw:${error instanceof Error ? error.message : String(error)}`;
		}
	};
	const runPhase = async (phase) => {
		for (const check of phase ?? []) {
			const result = await runCheck(check);
			if (result !== null) {
				failures.push(check.name);
				reason = result;
				return false;
			}
		}
		return true;
	};
	if (!await runPhase(options.deps) || !await runPhase(options.check)) enabled = false;
	compatRoster.set(featureId, {
		enabled,
		reason,
		checkedAt: (/* @__PURE__ */ new Date()).toISOString()
	});
	if (!enabled) try {
		logger.warn(`[compat] ${logPrefix} disabled: ${failures.join("; ")}`);
	} catch {}
	return {
		enabled,
		reason,
		failures
	};
}
//#endregion
//#region src/compat.ts
/**
* Compatibility guard for the workbench dock (T4 bare-process settle).
*
* Probes the core dependency symbols before the workbench registers itself,
* so a partially-loaded or upstream-drifted host degrades gracefully instead
* of throwing during registration. Low-conflict design per COMPAT-DESIGN
* §4.3: only the presence of core symbols is checked, never their internals.
*
* @module zdsh-workbench (compat guard; dsh-compat vendored)
*/
/**
* Run the workbench compatibility guard.
*
* Verifies that the workbench's peer symbols are importable and callable;
* when any probe fails the verdict is `false` and the workbench must skip
* registration. Never throws — every probe failure (including a throwing
* import) is turned into a disabled verdict by the underlying guard.
*
* @param logger - Optional logger (see {@link import('@deepseek-ai/dsh-compat').CompatLogger});
*   defaults to a `console`-backed logger.
* @returns A promise resolving to `true` when the feature may register.
*/
async function guardWorkbench(logger = consoleCompatLogger()) {
	return (await guardFeature("dsh-workbench", {
		deps: [{
			name: "cordis:Service",
			run: async () => {
				try {
					const { Service } = await import("@deepseek-ai/cordis");
					return typeof Service === "function" ? null : "Service not a function";
				} catch {
					return "cannot import cordis Service";
				}
			}
		}],
		logger
	})).enabled;
}
//#endregion
//#region src/index.ts
/** Services required from the host composition. */
const inject = ["webServer"];
const DEFAULTS = {
	readLimitBytes: 524288,
	writeBodyLimitBytes: 134217728,
	listLimit: 1e3,
	searchLimit: 200,
	watchDebounceMs: 150
};
function respondJson(res, status, body) {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}
function fail(code, message) {
	return {
		ok: false,
		error: {
			code,
			message
		}
	};
}
async function apply(ctx, options) {
	if (!await guardWorkbench(ctx.logger)) {
		ctx.logger.warn("workbench: skipped registration (compat guard disabled the dock)");
		return;
	}
	const trustedHosts = options?.trustedHosts ?? [];
	for (const entry of trustedHosts) assertTrustedAuthorityEntry(entry);
	const readLimitBytes = options?.readLimitBytes ?? DEFAULTS.readLimitBytes;
	const bodyCap = options?.writeBodyLimitBytes ?? DEFAULTS.writeBodyLimitBytes;
	const watchers = new FsWatcherManager({ debounceMs: options?.watchDebounceMs ?? DEFAULTS.watchDebounceMs });
	const ptyRegistry = new PtyRegistry({
		...options?.terminalsPerSession === void 0 ? {} : { terminalsPerSession: options.terminalsPerSession },
		...options?.reconnectGraceMs === void 0 ? {} : { reconnectGraceMs: options.reconnectGraceMs }
	});
	const rootCache = new RootCache();
	const allowedRealRoots = [];
	for (const candidate of options?.allowedRoots ?? []) try {
		allowedRealRoots.push(realpathSync(candidate));
	} catch {
		throw new Error(`workbench: allowedRoots entry is not an existing directory: ${candidate}`);
	}
	const rootAllowed = (rootReal) => allowedRealRoots.length === 0 || allowedRealRoots.some((allowed) => rootReal === allowed || rootReal.startsWith(allowed + (allowed.includes("\\") ? "\\" : "/")));
	const handlers = createFsHandlers(rootCache, {
		readLimitBytes,
		listLimit: options?.listLimit ?? DEFAULTS.listLimit,
		searchLimit: options?.searchLimit ?? DEFAULTS.searchLimit,
		rootAllowed
	});
	const gitHandlers = createGitHandlers({
		rootCache,
		rootAllowed
	});
	const taskLedger = new TaskLedger();
	const tasksReady = taskLedger.init().catch(() => {});
	const taskHandlers = {
		"tasks.list": () => taskLedger.list(),
		"tasks.create": (payload) => taskLedger.create(payload),
		"tasks.update": (payload) => taskLedger.update(payload),
		"tasks.delete": (payload) => taskLedger.remove(payload)
	};
	taskLedger.subscribe((frame) => {
		watchers.broadcast(frame);
	});
	const dispatch = async (method, payload) => {
		if (method === "ping") return envelopeValue(pingResult());
		await tasksReady;
		const handler = handlers.get(method) ?? gitHandlers.get(method) ?? taskHandlers[method];
		if (handler === void 0) return fail("no-route", `unknown workbench method ${method}`);
		return handler(payload);
	};
	function envelopeValue(value) {
		return {
			ok: true,
			value
		};
	}
	const apiRoute = {
		kind: "prefix",
		path: `${WORKBENCH_ROUTE_PREFIX}/api/`,
		handler: async (req, res) => {
			if (!isTrustedRequestHost(req.headers, trustedHosts)) {
				respondJson(res, 403, fail("untrusted-host", "host header failed the trust fence"));
				return;
			}
			const url = new URL(req.url ?? "/", "http://workbench.invalid");
			const method = decodeURIComponent(url.pathname.slice(`${WORKBENCH_ROUTE_PREFIX}/api/`.length));
			let payload = {};
			try {
				if (req.method === "POST") {
					const body = await readBody(req, bodyCap);
					payload = body.byteLength === 0 ? {} : JSON.parse(body.toString("utf8"));
				} else {
					const raw = url.searchParams.get("payload");
					payload = raw === null ? {} : JSON.parse(raw);
				}
			} catch (cause) {
				const message = cause instanceof Error && cause.message === "body-too-large" ? "request body exceeds the configured cap" : "request body is not valid JSON";
				respondJson(res, 200, fail(cause instanceof Error && cause.message === "body-too-large" ? "too-large" : "bad-request", message));
				return;
			}
			try {
				respondJson(res, 200, await dispatch(method, payload));
			} catch (cause) {
				respondJson(res, 200, fail("handler-crash", cause instanceof Error ? cause.message : String(cause)));
			}
		}
	};
	const eventsRoute = {
		kind: "exact",
		path: `${WORKBENCH_ROUTE_PREFIX}/events`,
		handler: async (req, res) => {
			if (!isTrustedRequestHost(req.headers, trustedHosts)) {
				respondJson(res, 403, fail("untrusted-host", "host header failed the trust fence"));
				return;
			}
			const url = new URL(req.url ?? "/", "http://workbench.invalid");
			let roots;
			try {
				roots = JSON.parse(url.searchParams.get("roots") ?? "[]");
			} catch {
				roots = null;
			}
			if (!Array.isArray(roots)) {
				res.destroy();
				return;
			}
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive"
			});
			const unsubscribe = watchers.subscribe((frame) => {
				try {
					res.write(`data: ${JSON.stringify(frame)}\n\n`);
				} catch {
					req.destroy();
				}
			});
			const candidateRoots = [];
			for (const root of roots) {
				if (typeof root !== "string" || root === "") continue;
				const real = await rootCache.rootOf(root);
				if (typeof real !== "string") continue;
				if (!rootAllowed(real)) continue;
				candidateRoots.push(real);
			}
			const addDisposer = watchers.addRoots(candidateRoots);
			const heartbeat = setInterval(() => {
				try {
					res.write(": heartbeat\n\n");
				} catch {
					req.destroy();
				}
			}, 25e3);
			if (typeof heartbeat.unref === "function") heartbeat.unref();
			req.on("close", () => {
				clearInterval(heartbeat);
				unsubscribe();
				addDisposer();
			});
		}
	};
	ctx.effect(() => ctx.webServer.register(apiRoute), "workbench: /workbench/api routes");
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: `${WORKBENCH_ROUTE_PREFIX}/file`,
		handler: createMediaHandler(rootCache, trustedHosts, rootAllowed)
	}), "workbench: /workbench/file media route");
	ctx.effect(() => ctx.webServer.register(eventsRoute), "workbench: /workbench/events sse");
	ctx.effect(() => ctx.webServer.registerUpgrade({
		path: `${WORKBENCH_ROUTE_PREFIX}/ws/terminal`,
		handler: (req, socket, head) => {
			if (!isTrustedRequestHost(req.headers, trustedHosts)) {
				socket.destroy();
				return;
			}
			acceptTerminalSocket(ptyRegistry, req, socket, head);
		}
	}), "workbench: terminal ws upgrade");
}
//#endregion
export { apply, inject };
