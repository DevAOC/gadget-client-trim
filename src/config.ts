/** Configuration loading + client-directory resolution. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ComputeOptions } from "./core.js";

export interface TrimConfig extends ComputeOptions {
  /**
   * Folders to scan for `api.<model>` usage — this is how the tool decides which models/actions to
   * keep vs. remove. Paths are resolved relative to the detected app root. Default:
   * `["web", "extensions", "shared"]`.
   */
  scan?: string[];
}

const CONFIG_FILES = ["gadget-trim.config.json", "gadget-trim.config.js", "gadget-trim.config.mjs"];

/** Load config from a config file or `package.json#gadgetTrim`. Returns `{}` if none found. */
export async function loadConfig(cwd = process.cwd(), explicitPath?: string): Promise<TrimConfig> {
  if (explicitPath) {
    const abs = isAbsolute(explicitPath) ? explicitPath : join(cwd, explicitPath);
    return readConfigFile(abs);
  }
  for (const name of CONFIG_FILES) {
    const abs = join(cwd, name);
    if (existsSync(abs)) return readConfigFile(abs);
  }
  // Fall back to package.json#gadgetTrim
  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (pkg.gadgetTrim && typeof pkg.gadgetTrim === "object") return pkg.gadgetTrim as TrimConfig;
    } catch {
      /* ignore malformed package.json */
    }
  }
  return {};
}

async function readConfigFile(abs: string): Promise<TrimConfig> {
  if (abs.endsWith(".json")) {
    return JSON.parse(readFileSync(abs, "utf8")) as TrimConfig;
  }
  const mod = (await import(pathToFileURL(abs).href)) as { default?: TrimConfig } & TrimConfig;
  return (mod.default ?? mod) as TrimConfig;
}

export interface ClientLocation {
  /** The generated client root (contains dist-esm/, dist-cjs/, types/). */
  clientDir: string;
  /** The app root that contains it (`.gadget`'s parent, or the dir holding node_modules). Scan base. */
  appRoot: string;
}

function isClientDir(dir: string): boolean {
  return existsSync(join(dir, "dist-esm", "Client.js"));
}

function firstGadgetClientPackage(scopeDir: string): string | null {
  if (!existsSync(scopeDir)) return null;
  for (const name of readdirSync(scopeDir)) {
    const candidate = join(scopeDir, name);
    if (isClientDir(candidate)) return candidate;
  }
  return null;
}

/**
 * Locate the generated Gadget client automatically by walking up from `cwd` — the user never has to
 * configure where `.gadget` lives. At each level we look for `./.gadget/client` and then for a
 * `node_modules/@gadget-client/<app>` package. Returns the client dir plus the app root that holds it
 * (used as the base for resolving `scan` folders), or `null` if no client is found.
 */
export function findClient(cwd: string): ClientLocation | null {
  let dir = resolve(cwd);
  for (;;) {
    const gadget = join(dir, ".gadget", "client");
    if (isClientDir(gadget)) return { clientDir: gadget, appRoot: dir };

    const fromNodeModules = firstGadgetClientPackage(join(dir, "node_modules", "@gadget-client"));
    if (fromNodeModules) return { clientDir: fromNodeModules, appRoot: dir };

    const parent = dirname(dir);
    if (parent === dir) return null; // reached filesystem root
    dir = parent;
  }
}
