import { posix, win32 } from "node:path";

export type ProjectPathErrorCode =
  | "empty"
  | "whitespace"
  | "absolute"
  | "traversal"
  | "backslash"
  | "nul"
  | "control"
  | "duplicate-separator"
  | "markdown-extension"
  | "root-path";

export class ProjectPathError extends Error {
  readonly code: ProjectPathErrorCode;
  readonly value: string;

  constructor(code: ProjectPathErrorCode, value: string, message: string) {
    super(message);
    this.name = "ProjectPathError";
    this.code = code;
    this.value = value;
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function looksLikeAbsolutePath(value: string): boolean {
  return value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(value);
}

export interface ValidatedProjectRelativePath {
  /** Exact spelling retained for settings, reads, source IDs, and sections. */
  exact: string;
  /** NFC + case-folded comparison key; never used to rewrite `exact`. */
  collisionKey: string;
}

/**
 * Validate a path stored in Project Lens settings or sent to a host.
 *
 * Project-relative paths deliberately use `/` on every host. Rejecting
 * backslashes and dot segments prevents one spelling from being interpreted
 * differently by the server and a connected Windows or POSIX host. Unicode
 * normalization and case folding are returned only as a collision key; the
 * exact requested spelling remains authoritative.
 */
export function validateProjectRelativePath(
  value: string,
  options: { markdown?: boolean } = {},
): ValidatedProjectRelativePath {
  if (typeof value !== "string" || value.length === 0) {
    throw new ProjectPathError("empty", value, "Project-relative path must not be empty");
  }
  if (value !== value.trim()) {
    throw new ProjectPathError(
      "whitespace",
      value,
      "Project-relative path must not have leading or trailing whitespace",
    );
  }
  if (value.includes("\0")) {
    throw new ProjectPathError("nul", value, "Project-relative path must not contain NUL");
  }
  if (hasControlCharacter(value)) {
    throw new ProjectPathError(
      "control",
      value,
      "Project-relative path must not contain control characters",
    );
  }
  if (looksLikeAbsolutePath(value)) {
    throw new ProjectPathError(
      "absolute",
      value,
      `Path is not project-relative: ${value}`,
    );
  }
  if (value.includes("\\")) {
    throw new ProjectPathError(
      "backslash",
      value,
      "Project-relative paths must use '/' separators",
    );
  }

  const unicodeNormalized = value.normalize("NFC");
  const segments = unicodeNormalized.split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new ProjectPathError(
      "traversal",
      value,
      `Path escapes the project root: ${value}`,
    );
  }
  if (segments.some((segment) => segment === "" || segment === ".")) {
    throw new ProjectPathError(
      "duplicate-separator",
      value,
      `Path contains an empty or '.' segment: ${value}`,
    );
  }

  const normalized = segments.join("/");
  if (options.markdown && !normalized.toLowerCase().endsWith(".md")) {
    throw new ProjectPathError(
      "markdown-extension",
      value,
      `Configured document must end in .md: ${value}`,
    );
  }
  return { exact: value, collisionKey: normalized.toLowerCase() };
}

/** Compatibility-shaped helper whose result intentionally preserves spelling. */
export function normalizeProjectRelativePath(
  value: string,
  options: { markdown?: boolean } = {},
): string {
  return validateProjectRelativePath(value, options).exact;
}

/**
 * Return the conservative spelling-collision key used before a host
 * canonical path identity is available. NFC keeps equivalent Unicode
 * spellings together; case folding only detects a possible collision and
 * must never be used to rewrite the path that is sent to the host.
 */
export function projectPathCollisionKey(value: string): string {
  return validateProjectRelativePath(value).collisionKey;
}

function hostPathModule(rootPath: string): typeof posix | typeof win32 {
  // `win32.isAbsolute('/workspace')` is also true, but a leading slash is a
  // normal POSIX root when BB runs on Linux. Drive and UNC roots identify the
  // Windows spelling unambiguously.
  return /^[A-Za-z]:[\\/]/.test(rootPath) || rootPath.startsWith("\\\\") ? win32 : posix;
}

function assertAbsoluteRoot(rootPath: string): void {
  if (
    typeof rootPath !== "string" ||
    rootPath.length === 0 ||
    (!posix.isAbsolute(rootPath) && !win32.isAbsolute(rootPath))
  ) {
    throw new ProjectPathError(
      "root-path",
      rootPath,
      `Workspace root must be an absolute host path: ${rootPath}`,
    );
  }
}

export function normalizeHostRoot(rootPath: string): string {
  assertAbsoluteRoot(rootPath);
  return hostPathModule(rootPath).resolve(rootPath);
}

/**
 * Resolve a validated project-relative path lexically under a host root.
 *
 * The returned path is suitable for `bb.sdk.files.read({ rootPath })`.
 * Lexical checking handles traversal; the SDK/host root confinement remains
 * the authority for symlink resolution on the connected machine.
 */
export function resolveWithinRoot(rootPath: string, relativePath: string): string {
  const relative = validateProjectRelativePath(relativePath).exact;
  const root = normalizeHostRoot(rootPath);
  const pathModule = hostPathModule(root);
  const candidate = pathModule.resolve(root, relative);
  const distance = pathModule.relative(root, candidate);
  if (
    distance === ".." ||
    distance.startsWith(`..${pathModule.sep}`) ||
    pathModule.isAbsolute(distance)
  ) {
    throw new ProjectPathError(
      "traversal",
      relativePath,
      `Path escapes the workspace root: ${relativePath}`,
    );
  }
  return candidate;
}

/** Check a host-returned path without assuming the server's operating system. */
export function isWithinRoot(rootPath: string, candidatePath: string): boolean {
  try {
    const pathModule = hostPathModule(rootPath);
    const root = normalizeHostRoot(rootPath);
    const candidate = pathModule.resolve(candidatePath);
    const distance = pathModule.relative(root, candidate);
    return (
      distance === "" ||
      (distance !== ".." &&
        !distance.startsWith(`..${pathModule.sep}`) &&
        !pathModule.isAbsolute(distance))
    );
  } catch {
    return false;
  }
}
