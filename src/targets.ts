/**
 * Several trims of one generated client: one in place, plus trimmed copies (`out`), each scanning
 * its own source folders. A web app and a size-limited frontend (say, POS extensions) can then each
 * ship only what they call, from the single client Gadget generates.
 */
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { analyze, applyPlan, scanUsage, type ComputeOptions, type TrimPlan } from "./core.js";
import {
  copyClient,
  hashClient,
  hashConfig,
  pristineClient,
  readInPlaceState,
  readStamp,
  recordInPlaceTrim,
  writeStamp,
} from "./copy.js";

/** One trim: in place when `out` is absent, otherwise a trimmed copy written to `out`. */
export interface TrimTarget extends ComputeOptions {
  /** Label for output. Default: `out`, or "in-place". */
  name?: string;
  /** Folders to scan for `api.<member>` usage. Default: `["web", "extensions", "shared"]`. */
  scan?: string[];
  /**
   * Write a trimmed copy of the client here (relative to the app root) instead of trimming the
   * generated client in place. Import the copy from the frontend it is for.
   */
  out?: string;
}

export interface ResolvedTarget {
  name: string;
  /** Absolute copy directory, or null for the in-place trim. */
  outDir: string | null;
  scan: string[];
  options: ComputeOptions;
}

const DEFAULT_SCAN = ["web", "extensions", "shared"];
const OPTION_KEYS = ["alwaysKeep", "keep", "forceTrim", "deleteFiles", "pruneTypes", "kinds"] as const;

function optionsOf(source: ComputeOptions): ComputeOptions {
  const out: ComputeOptions = {};
  for (const key of OPTION_KEYS) if (source[key] !== undefined) (out as Record<string, unknown>)[key] = source[key];
  return out;
}

/**
 * The targets to run. `targets` in the config lists them; each inherits the config's top-level options
 * (keep, kinds, …) and may override them. Without `targets`, the config itself is the one target, as
 * before. `overrides` (from the CLI) apply on top of every target.
 */
export function resolveTargets(
  config: TrimTarget & { targets?: TrimTarget[] },
  appRoot: string,
  clientDir: string,
  overrides: ComputeOptions = {},
): ResolvedTarget[] {
  const shared = optionsOf(config);
  const list = config.targets?.length ? config.targets : [config];
  const resolved = list.map((target): ResolvedTarget => {
    const outDir = target.out ? resolve(appRoot, target.out) : null;
    return {
      name: target.name ?? target.out ?? "in-place",
      outDir,
      scan: target.scan ?? (config.targets?.length ? (config.scan ?? DEFAULT_SCAN) : DEFAULT_SCAN),
      options: { ...shared, ...optionsOf(target), ...optionsOf(overrides) },
    };
  });

  const inPlace = resolved.filter((t) => !t.outDir);
  if (inPlace.length > 1)
    throw new Error("only one target may trim the generated client in place (give the others an `out`)");
  const outs = resolved.map((t) => t.outDir).filter((d): d is string => !!d);
  if (new Set(outs).size !== outs.length) throw new Error("two targets write to the same `out`");
  for (const out of outs) {
    const rel = relative(clientDir, out);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)))
      throw new Error(`\`out\` must not be inside the generated client: ${out}`);
    const back = relative(out, clientDir);
    if (!back.startsWith("..") && !isAbsolute(back))
      throw new Error(`\`out\` must not contain the generated client: ${out}`);
  }
  // Copies are cut first, from the pristine client; the in-place trim runs last.
  return [...resolved.filter((t) => t.outDir), ...inPlace];
}

export type TargetStatus =
  /** apply: edits were written (or a copy was cut). */
  | "trimmed"
  /** apply/check: nothing to do, the output is current. */
  | "clean"
  /** check: the output is missing, stale, or not trimmed. */
  | "pending"
  /** the client's codegen shape was not recognized; nothing was changed. */
  | "unrecognized"
  /** a copy needs members an earlier in-place trim removed, and no pristine snapshot survives. */
  | "lost-members"
  /** report: plan printed, nothing written. */
  | "reported";

export interface TargetResult {
  target: ResolvedTarget;
  status: TargetStatus;
  plan: TrimPlan;
  /** Why a check failed, or which members a copy could not get. */
  detail?: string;
  filesWritten: number;
  filesDeleted: number;
}

const isShapeWarning = (w: string) => w.includes("unexpected anchor shape");

/**
 * Run every target against the generated client at `clientDir`.
 *
 * - `apply` writes: copies are re-cut only when their stamp is out of date, then trimmed; the in-place
 *   target trims the generated client and records what it wrote.
 * - `check` writes nothing and reports each output that is missing, stale or untrimmed.
 * - `report` writes nothing and returns each target's plan.
 */
export function runTargets(
  targets: ResolvedTarget[],
  { clientDir, appRoot, mode }: { clientDir: string; appRoot: string; mode: "apply" | "check" | "report" },
): TargetResult[] {
  const inPlace = targets.some((t) => !t.outDir);
  const pristine = pristineClient(clientDir, appRoot, { inPlace, write: mode === "apply" });
  const results: TargetResult[] = [];

  for (const target of targets) {
    const settings = { scan: target.scan, ...target.options };
    const analyzeIn = (dir: string) =>
      analyze({ clientDir: dir, cwd: appRoot, scan: target.scan, ...target.options }).plan;

    if (!target.outDir) {
      // In place, as a single-target run always worked.
      const plan = analyzeIn(clientDir);
      const pending = plan.edits.length > 0 || plan.deletions.length > 0;
      if (plan.warnings.some(isShapeWarning)) {
        results.push({ target, status: "unrecognized", plan, filesWritten: 0, filesDeleted: 0 });
        continue;
      }
      if (mode === "report") {
        results.push({ target, status: "reported", plan, filesWritten: 0, filesDeleted: 0 });
      } else if (mode === "check") {
        results.push({
          target,
          status: pending ? "pending" : "clean",
          plan,
          detail: pending ? "the generated client is not trimmed" : undefined,
          filesWritten: 0,
          filesDeleted: 0,
        });
      } else {
        const before = readInPlaceState(clientDir);
        const ours = before != null && before.trimmedHash === hashClient(clientDir);
        const applied = pending ? applyPlan(plan) : { filesWritten: [], filesDeleted: [] };
        // Every member the generated client no longer has: this run's, plus an earlier run's when
        // the client is still the one that run wrote (a re-run finds nothing left to trim).
        if (pending || !ours)
          recordInPlaceTrim(clientDir, pristine.hash, [
            ...new Set([...(ours ? before.trimmed : []), ...plan.trim]),
          ]);
        results.push({
          target,
          status: pending ? "trimmed" : "clean",
          plan,
          filesWritten: applied.filesWritten.length,
          filesDeleted: applied.filesDeleted.length,
        });
      }
      continue;
    }

    // A copy: planned against the pristine client it is cut from.
    const plan = analyzeIn(pristine.dir);
    // From the scan itself: `plan.used` only lists members the (trimmed) source still has.
    const lost = pristine.lost.length
      ? [...scanUsage(target.scan, { cwd: appRoot }).used]
          .filter((m) => pristine.lost.includes(m))
          .sort()
      : [];
    if (lost.length) {
      results.push({
        target,
        status: "lost-members",
        plan,
        detail:
          `needs ${lost.join(", ")}, which an earlier in-place trim removed from the generated client, ` +
          "and no pristine snapshot of it survives. Regenerate the client (e.g. `ggt pull`) and run again.",
        filesWritten: 0,
        filesDeleted: 0,
      });
      continue;
    }
    if (plan.warnings.some(isShapeWarning)) {
      results.push({ target, status: "unrecognized", plan, filesWritten: 0, filesDeleted: 0 });
      continue;
    }

    const wanted = { sourceHash: pristine.hash, configHash: hashConfig(settings) };
    const stamp = existsSync(target.outDir) ? readStamp(target.outDir) : null;
    const current =
      stamp != null && stamp.sourceHash === wanted.sourceHash && stamp.configHash === wanted.configHash;

    if (mode === "report") {
      results.push({ target, status: "reported", plan, filesWritten: 0, filesDeleted: 0 });
    } else if (mode === "check") {
      let detail: string | undefined;
      if (!existsSync(target.outDir)) detail = "the copy does not exist";
      else if (!current) detail = "the copy is out of date with the generated client or its settings";
      else {
        const inCopy = analyzeIn(target.outDir);
        if (inCopy.edits.length || inCopy.deletions.length) detail = "the copy is not trimmed";
      }
      results.push({
        target,
        status: detail ? "pending" : "clean",
        plan,
        detail,
        filesWritten: 0,
        filesDeleted: 0,
      });
    } else if (current) {
      results.push({ target, status: "clean", plan, filesWritten: 0, filesDeleted: 0 });
    } else {
      copyClient(pristine.dir, target.outDir);
      // Re-planned against the copy, whose file paths are the ones to write.
      const applied = applyPlan(analyzeIn(target.outDir));
      writeStamp(target.outDir, wanted);
      results.push({
        target,
        status: "trimmed",
        plan,
        filesWritten: applied.filesWritten.length,
        filesDeleted: applied.filesDeleted.length,
      });
    }
  }
  return results;
}

/** Paths for messages, relative to the app root when inside it. */
export function displayPath(appRoot: string, path: string): string {
  const rel = relative(appRoot, path);
  return rel && !rel.startsWith("..") ? rel : join(path);
}
