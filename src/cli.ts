#!/usr/bin/env node
/** gadget-client-trim CLI — apply / --check / --report / --dry-run / --watch. */
import { existsSync, readFileSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { ComputeOptions, MemberKind, TrimPlan } from "./core.js";
import { findClient, loadConfig, type TrimConfig } from "./config.js";
import {
  displayPath,
  resolveTargets,
  runTargets,
  type ResolvedTarget,
  type TargetResult,
} from "./targets.js";

type Mode = "apply" | "check" | "report" | "dry-run" | "watch";

interface CliArgs {
  mode: Mode;
  configPath?: string;
  clientDir?: string;
  scan?: string[];
  out?: string;
  keep?: string[];
  forceTrim?: string[];
  kinds?: MemberKind[];
  deleteFiles?: boolean;
  pruneTypes?: boolean;
  cwd: string;
}

function parseArgs(argv: string[]): CliArgs | { help: true } | { version: true } {
  const args: CliArgs = { mode: "apply", cwd: process.cwd() };
  const list = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "-h": case "--help": return { help: true };
      case "-v": case "--version": return { version: true };
      case "--check": args.mode = "check"; break;
      case "--report": args.mode = "report"; break;
      case "--dry-run": args.mode = "dry-run"; break;
      case "--watch": args.mode = "watch"; break;
      case "--config": args.configPath = next(); break;
      case "--client-dir": args.clientDir = next(); break;
      case "--cwd": args.cwd = next(); break;
      case "--scan": args.scan = list(next()); break;
      case "--out": args.out = next(); break;
      case "--keep": args.keep = list(next()); break;
      case "--force-trim": args.forceTrim = list(next()); break;
      case "--kinds": args.kinds = list(next()) as MemberKind[]; break;
      case "--no-delete": args.deleteFiles = false; break;
      case "--no-prune-types": args.pruneTypes = false; break;
      default:
        process.stderr.write(`Unknown argument: ${a}\n`);
        return { help: true };
    }
  }
  return args;
}

const HELP = `gadget-client-trim — shrink a generated Gadget API client by removing unused models.

Usage:
  gadget-client-trim [options]            Apply the trim (default).
  gadget-client-trim --report             Print the plan, change nothing.
  gadget-client-trim --dry-run            Alias for --report.
  gadget-client-trim --check              Exit non-zero if the client is not already trimmed
                                          or its codegen shape is unrecognized (CI gate).
  gadget-client-trim --watch              Re-apply whenever the client is regenerated.

The Gadget client is found automatically by walking up from the current directory (./.gadget/client or
node_modules/@gadget-client/*). You only configure which folders to scan for api.<model> usage — that
is what decides which models/actions are kept vs. removed.

Several frontends can each get their own trim with \`targets\` in the config: one trims the generated
client in place, the others write trimmed copies (\`out\`) that their frontend imports instead.

Options:
  --scan <a,b,c>        Folders to scan for api.<member> usage (default: web,extensions,shared).
  --out <dir>           Write a trimmed copy here instead of trimming the client in place.
  --keep <a,b>          Extra members to always keep.
  --force-trim <a,b>    Remove these even if used (never overrides session/currentSession).
  --kinds <a,b>         Member kinds to trim (default: all): model,namespace,globalAction,computedView.
  --no-delete           Strip references but keep model files on disk.
  --no-prune-types      Do not edit Client.d.ts.
  --config <path>       Config file (default: gadget-trim.config.{json,js,mjs} or package.json#gadgetTrim).
  -h, --help            Show this help.
  -v, --version         Show version.

  --scan or --out run that one trim and ignore the config's \`targets\`; the other options apply to
  every target.

Advanced:
  --client-dir <path>   Override client auto-detection (unusual monorepo layouts).
  --cwd <path>          Directory to start searching from (default: process.cwd()).

The package only trims a client that already exists on disk; generating it (e.g. \`ggt pull\`/\`dev\`)
and any auth/secrets are your responsibility.
`;

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

interface Setup {
  clientDir: string;
  appRoot: string;
  targets: ResolvedTarget[];
}

async function buildSetup(args: CliArgs): Promise<Setup | null> {
  // The package locates `.gadget` itself by walking up from the cwd; the user does not configure it.
  // `--client-dir` exists only as an advanced override (e.g. unusual monorepo layouts).
  let clientDir: string;
  let appRoot: string;
  if (args.clientDir) {
    clientDir = resolve(args.cwd, args.clientDir);
    appRoot = args.cwd;
  } else {
    const found = findClient(args.cwd);
    if (!found) {
      process.stderr.write(
        "error: could not find a generated Gadget client (looked for .gadget/client and " +
          "node_modules/@gadget-client/* up from the current directory). " +
          "Generate it first (e.g. `ggt pull`), or pass --client-dir.\n",
      );
      return null;
    }
    clientDir = found.clientDir;
    appRoot = found.appRoot;
  }

  // Config + scan folders are resolved relative to the detected app root.
  const fileConfig: TrimConfig = await loadConfig(appRoot, args.configPath);
  const overrides: ComputeOptions = {
    keep: args.keep,
    forceTrim: args.forceTrim,
    kinds: args.kinds,
    deleteFiles: args.deleteFiles,
    pruneTypes: args.pruneTypes,
  };
  // --scan / --out name one trim on the command line; the config's targets then do not apply.
  const config: TrimConfig =
    args.scan || args.out
      ? { ...fileConfig, targets: undefined, scan: args.scan ?? fileConfig.scan, out: args.out }
      : fileConfig;

  try {
    return { clientDir, appRoot, targets: resolveTargets(config, appRoot, clientDir, overrides) };
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return null;
  }
}

function printPlan(plan: TrimPlan, indent = ""): void {
  const counts = new Map<string, number>();
  for (const d of plan.discovered) counts.set(d.kind, (counts.get(d.kind) ?? 0) + 1);
  const breakdown = [...counts.entries()].map(([k, n]) => `${n} ${k}`).join(", ");
  process.stdout.write(
    `${indent}discovered ${plan.discovered.length} members (${breakdown}) · keep ${plan.keep.length} · trim ${plan.trim.length}\n`,
  );
  if (plan.trim.length) process.stdout.write(`${indent}  trim:  ${plan.trim.join(", ")}\n`);
  process.stdout.write(`${indent}  keep:  ${plan.keep.join(", ")}\n`);
  for (const w of plan.warnings) process.stdout.write(`${indent}  warn:  ${w}\n`);
}

function label(setup: Setup, target: ResolvedTarget): string {
  const scan = `scan: ${target.scan.join(", ")}`;
  return target.outDir
    ? `${target.name} → ${displayPath(setup.appRoot, target.outDir)} (${scan})`
    : `${target.name} (${scan})`;
}

/** Print one run's results; returns the exit code. */
function report(setup: Setup, results: TargetResult[], mode: "apply" | "check" | "report"): number {
  const many = results.length > 1;
  let code = 0;
  for (const r of results) {
    const indent = many ? "  " : "";
    if (many) process.stdout.write(`[${label(setup, r.target)}]\n`);
    printPlan(r.plan, indent);
    switch (r.status) {
      case "unrecognized":
        process.stderr.write(
          `${indent}${mode === "check" ? "check failed" : "skipped"}: client codegen shape not recognized (see warnings).\n`,
        );
        if (mode === "check") code = 1;
        break;
      case "lost-members":
        process.stderr.write(`${indent}error: ${r.detail}\n`);
        code = 1;
        break;
      case "pending":
        process.stderr.write(`${indent}check failed: ${r.detail} — run the trim before this gate.\n`);
        code = 1;
        break;
      case "clean":
        process.stdout.write(
          mode === "check"
            ? `${indent}check passed: ${r.target.outDir ? "copy" : "client"} is trimmed and shape is recognized.\n`
            : `${indent}nothing to trim — already clean.\n`,
        );
        break;
      case "trimmed":
        process.stdout.write(
          `${indent}${r.target.outDir ? `wrote ${displayPath(setup.appRoot, r.target.outDir)}; ` : "applied: "}` +
            `edited ${r.filesWritten} file(s), deleted ${r.filesDeleted} file(s).\n`,
        );
        break;
      case "reported":
        break;
    }
  }
  return code;
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if ("help" in parsed) {
    process.stdout.write(HELP);
    return 0;
  }
  if ("version" in parsed) {
    process.stdout.write(`${readVersion()}\n`);
    return 0;
  }

  const setup = await buildSetup(parsed);
  if (!setup) return 2;

  if (parsed.mode === "watch") return runWatch(setup);

  const mode = parsed.mode === "dry-run" ? "report" : parsed.mode;
  return report(setup, runTargets(setup.targets, { ...setup, mode }), mode);
}

function runWatch(setup: Setup): number {
  const esm = join(setup.clientDir, "dist-esm", "Client.js");
  const sync = join(setup.clientDir, "..", "sync.json");
  let timer: NodeJS.Timeout | null = null;

  const run = () => {
    try {
      // Copies already cut from this client are left alone, so the trim's own writes settle at once.
      for (const r of runTargets(setup.targets, { ...setup, mode: "apply" })) {
        const where = r.target.outDir ? ` → ${displayPath(setup.appRoot, r.target.outDir)}` : "";
        if (r.status === "trimmed")
          process.stdout.write(
            `[gadget-client-trim] ${r.target.name}${where}: trimmed ${r.plan.trim.length} member(s); ` +
              `edited ${r.filesWritten}, deleted ${r.filesDeleted}.\n`,
          );
        else if (r.status === "lost-members" || r.status === "unrecognized")
          process.stderr.write(
            `[gadget-client-trim] ${r.target.name}${where}: ${r.detail ?? "client codegen shape not recognized"}\n`,
          );
      }
    } catch (err) {
      process.stderr.write(`[gadget-client-trim] watch error: ${(err as Error).message}\n`);
    }
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, 200);
  };

  run(); // initial pass
  for (const target of [esm, sync]) {
    if (existsSync(target)) {
      try {
        watch(target, schedule);
      } catch {
        /* file may be replaced atomically; watch the dir instead */
        watch(dirname(target), schedule);
      }
    }
  }
  process.stdout.write("[gadget-client-trim] watching for client regeneration… (Ctrl-C to stop)\n");
  return -1; // keep process alive
}

main().then((code) => {
  if (code >= 0) process.exit(code);
}).catch((err) => {
  process.stderr.write(`gadget-client-trim: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
