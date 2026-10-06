#!/usr/bin/env node
/** gadget-client-trim CLI — apply / --check / --report / --dry-run / --watch. */
import { existsSync, readFileSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { analyze, applyPlan, type AnalyzeConfig, type MemberKind, type TrimPlan } from "./core.js";
import { findClient, loadConfig, type TrimConfig } from "./config.js";

type Mode = "apply" | "check" | "report" | "dry-run" | "watch";

interface CliArgs {
  mode: Mode;
  configPath?: string;
  clientDir?: string;
  scan?: string[];
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

Options:
  --scan <a,b,c>        Folders to scan for api.<member> usage (default: web,extensions,shared).
  --keep <a,b>          Extra members to always keep.
  --force-trim <a,b>    Remove these even if used (never overrides session/currentSession).
  --kinds <a,b>         Member kinds to trim (default: all): model,namespace,globalAction,computedView.
  --no-delete           Strip references but keep model files on disk.
  --no-prune-types      Do not edit Client.d.ts.
  --config <path>       Config file (default: gadget-trim.config.{json,js,mjs} or package.json#gadgetTrim).
  -h, --help            Show this help.
  -v, --version         Show version.

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

async function buildConfig(args: CliArgs): Promise<AnalyzeConfig | null> {
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

  return {
    clientDir,
    cwd: appRoot, // scan folders resolve relative to the detected app root
    scan: args.scan ?? fileConfig.scan,
    keep: args.keep ?? fileConfig.keep,
    forceTrim: args.forceTrim ?? fileConfig.forceTrim,
    kinds: args.kinds ?? fileConfig.kinds,
    deleteFiles: args.deleteFiles ?? fileConfig.deleteFiles,
    pruneTypes: args.pruneTypes ?? fileConfig.pruneTypes,
    alwaysKeep: fileConfig.alwaysKeep,
  };
}

function printPlan(plan: TrimPlan): void {
  const counts = new Map<string, number>();
  for (const d of plan.discovered) counts.set(d.kind, (counts.get(d.kind) ?? 0) + 1);
  const breakdown = [...counts.entries()].map(([k, n]) => `${n} ${k}`).join(", ");
  process.stdout.write(
    `discovered ${plan.discovered.length} members (${breakdown}) · keep ${plan.keep.length} · trim ${plan.trim.length}\n`,
  );
  if (plan.trim.length) process.stdout.write(`  trim:  ${plan.trim.join(", ")}\n`);
  process.stdout.write(`  keep:  ${plan.keep.join(", ")}\n`);
  for (const w of plan.warnings) process.stdout.write(`  warn:  ${w}\n`);
}

function hasShapeWarning(plan: TrimPlan): boolean {
  return plan.warnings.some((w) => w.includes("unexpected anchor shape"));
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

  const config = await buildConfig(parsed);
  if (!config) return 2;

  if (parsed.mode === "watch") {
    return runWatch(config);
  }

  const { plan } = analyze(config);

  if (parsed.mode === "report" || parsed.mode === "dry-run") {
    printPlan(plan);
    return 0;
  }

  if (parsed.mode === "check") {
    printPlan(plan);
    const pending = plan.edits.length > 0 || plan.deletions.length > 0;
    if (hasShapeWarning(plan)) {
      process.stderr.write("check failed: client codegen shape not recognized (see warnings).\n");
      return 1;
    }
    if (pending) {
      process.stderr.write(
        "check failed: client is not trimmed — run the trim before this gate.\n",
      );
      return 1;
    }
    process.stdout.write("check passed: client is trimmed and shape is recognized.\n");
    return 0;
  }

  // apply
  if (plan.edits.length === 0 && plan.deletions.length === 0) {
    printPlan(plan);
    process.stdout.write("nothing to trim — already clean.\n");
    return 0;
  }
  const result = applyPlan(plan);
  printPlan(plan);
  process.stdout.write(
    `applied: edited ${result.filesWritten.length} file(s), deleted ${result.filesDeleted.length} file(s).\n`,
  );
  return 0;
}

function runWatch(config: AnalyzeConfig): number {
  const esm = join(config.clientDir, "dist-esm", "Client.js");
  const sync = join(config.clientDir, "..", "sync.json");
  let timer: NodeJS.Timeout | null = null;

  const run = () => {
    try {
      const { plan } = analyze(config);
      if (plan.edits.length || plan.deletions.length) {
        const result = applyPlan(plan);
        process.stdout.write(
          `[gadget-client-trim] trimmed ${plan.trim.length} model(s); ` +
            `edited ${result.filesWritten.length}, deleted ${result.filesDeleted.length}.\n`,
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
