/**
 * Trimmed copies of the generated client, and the pristine snapshot they are made from.
 *
 * A copy target (`out`) must be cut from the client as Gadget generated it. When another target trims
 * the generated client in place, a later run would otherwise copy an already-trimmed client and
 * silently lose members only the copy's code uses. So the generated client is snapshotted while it is
 * still pristine, and the hash of what the in-place trim wrote is recorded: while the client on disk
 * still has that hash, copies come from the snapshot; any other hash means it was regenerated.
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveLayout } from "./core.js";

/** Written into every copy, so a later run can tell whether it is current. */
export const COPY_STAMP = ".gadget-client-trim.json";

export interface CopyStamp {
  /** Hash of the pristine client the copy was cut from. */
  sourceHash: string;
  /** Hash of the target's trim settings. */
  configHash: string;
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * Hash of a client's entry files (ESM + CJS `Client.js` and the `Client.d.ts` files): the files a
 * trim edits, and the ones Gadget rewrites on every regeneration.
 */
export function hashClient(clientDir: string): string {
  const layout = resolveLayout(clientDir);
  const files = [layout.esmClient, layout.cjsClient, ...layout.dtsClients].filter(
    (f): f is string => !!f,
  );
  return sha(files.map((f) => `${f.slice(clientDir.length)}\n${readFileSync(f, "utf8")}`).join("\0"));
}

/** Stable hash of a target's trim settings, so a changed scan or keep list re-cuts the copy. */
export function hashConfig(settings: unknown): string {
  const stable = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(stable)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v as object)
              .sort()
              .map((k) => [k, stable((v as Record<string, unknown>)[k])]),
          )
        : v;
  return sha(JSON.stringify(stable(settings)));
}

export function readStamp(outDir: string): CopyStamp | null {
  try {
    return JSON.parse(readFileSync(join(outDir, COPY_STAMP), "utf8")) as CopyStamp;
  } catch {
    return null;
  }
}

export function writeStamp(outDir: string, stamp: CopyStamp): void {
  writeFileSync(join(outDir, COPY_STAMP), JSON.stringify(stamp, null, 2) + "\n", "utf8");
}

/** Replace `dest` with a full copy of the client at `src`. */
export function copyClient(src: string, dest: string): void {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
  // A copy starts unstamped and owes nothing to the source's in-place trim.
  rmSync(join(dest, COPY_STAMP), { force: true });
  rmSync(join(dest, IN_PLACE_STATE), { force: true });
}

/** Where the pristine snapshot lives: a cache folder under the app's node_modules. */
export function cacheDir(appRoot: string): string {
  return join(appRoot, "node_modules", ".cache", "gadget-client-trim");
}

/** Left in the generated client by an in-place trim. */
export const IN_PLACE_STATE = ".gadget-client-trim-state.json";

export interface InPlaceState {
  /** Hash of the client files after the in-place trim wrote them. */
  trimmedHash: string;
  /** Hash of the client as generated, before the trim. */
  pristineHash: string;
  /** Members the in-place trim removed. */
  trimmed: string[];
}

export function readInPlaceState(clientDir: string): InPlaceState | null {
  try {
    return JSON.parse(readFileSync(join(clientDir, IN_PLACE_STATE), "utf8")) as InPlaceState;
  } catch {
    return null;
  }
}

/** Record what the in-place trim wrote, so the next run knows the generated client is ours. */
export function recordInPlaceTrim(clientDir: string, pristineHash: string, trimmed: string[]): void {
  const state: InPlaceState = { trimmedHash: hashClient(clientDir), pristineHash, trimmed };
  writeFileSync(join(clientDir, IN_PLACE_STATE), JSON.stringify(state, null, 2) + "\n", "utf8");
}

export interface Pristine {
  /** The directory holding the client as Gadget generated it. */
  dir: string;
  hash: string;
  /**
   * Members missing from `dir` because an earlier in-place trim removed them and no snapshot of the
   * generated client survives (its cache was cleared). Empty when `dir` really is pristine.
   */
  lost: string[];
}

/**
 * The pristine client copies are cut from. When nothing trims the generated client in place, that is
 * the generated client itself. Otherwise it is the snapshot, taken whenever the generated client is not
 * the one the last in-place trim wrote. With `write: false` (check/report) nothing is written.
 */
export function pristineClient(
  clientDir: string,
  appRoot: string,
  { inPlace, write }: { inPlace: boolean; write: boolean },
): Pristine {
  const current = hashClient(clientDir);
  if (!inPlace) return { dir: clientDir, hash: current, lost: [] };

  const snapshot = join(cacheDir(appRoot), "pristine-client");
  const state = readInPlaceState(clientDir);
  const ours = state != null && state.trimmedHash === current;
  if (ours) {
    if (existsSync(snapshot) && hashClient(snapshot) === state.pristineHash)
      return { dir: snapshot, hash: state.pristineHash, lost: [] };
    // Trimmed by us, and the snapshot is gone: only what the trim removed is missing.
    return { dir: clientDir, hash: state.pristineHash, lost: state.trimmed };
  }
  // Regenerated (or never trimmed): the generated client is pristine right now.
  if (write) {
    copyClient(clientDir, snapshot);
    return { dir: snapshot, hash: current, lost: [] };
  }
  return { dir: clientDir, hash: current, lost: [] };
}
