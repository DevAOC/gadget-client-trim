/**
 * gadget-client-trim — core logic.
 *
 * Pure, side-effect-light functions for discovering the removable members of a generated Gadget client
 * (models, namespaces, global actions, computed views), deciding which are unused, and removing them
 * from the compiled client (`dist-esm` + `dist-cjs` `Client.js`) and the type declarations
 * (`Client.d.ts`).
 *
 * Only {@link readClientFiles} and {@link applyPlan} touch the filesystem; everything else operates on
 * strings so it is trivially testable.
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type MemberKind = "model" | "namespace" | "globalAction" | "computedView";

/**
 * A discovered, potentially-removable member of the client.
 * - `camel` is the api identifier (`api.<camel>`).
 * - `pascal` is the manager/namespace class base (models + namespaces only).
 * - `file` is the module file base under `models/` or `namespaces/` (models + namespaces only).
 */
export interface DiscoveredMember {
  camel: string;
  kind: MemberKind;
  pascal?: string;
  file?: string;
}

/** Back-compat alias: a discovered model. */
export interface DiscoveredModel {
  camel: string;
  pascal: string;
}

/** Locations of the generated client files we read/write, relative to `clientDir`. */
export interface ClientLayout {
  clientDir: string;
  esmClient: string | null;
  cjsClient: string | null;
  dtsClients: string[];
  esmModelsDir: string | null;
  cjsModelsDir: string | null;
  esmNamespacesDir: string | null;
  cjsNamespacesDir: string | null;
}

/** A single planned edit to one file. */
export interface FileEdit {
  file: string;
  removedLines: number[];
  before: string;
  after: string;
}

export interface TrimPlan {
  discovered: DiscoveredMember[];
  used: string[];
  keep: string[];
  trim: string[];
  edits: FileEdit[];
  /** Module files safe to delete (zero remaining references after edits). */
  deletions: string[];
  warnings: string[];
}

export interface ComputeOptions {
  /** Always kept regardless of usage (Gadget auth/session conventions). */
  alwaysKeep?: string[];
  /** Extra members to keep (allowlist). */
  keep?: string[];
  /** Members to remove even if used. Never overrides `alwaysKeep`. */
  forceTrim?: string[];
  /** When true (default), backing module files are deleted after stripping references. */
  deleteFiles?: boolean;
  /** When true (default), prune trimmed members from `Client.d.ts`. */
  pruneTypes?: boolean;
  /** Member kinds to consider for trimming. Default: all. */
  kinds?: MemberKind[];
}

export const DEFAULT_ALWAYS_KEEP = ["session", "currentSession"] as const;
const ALL_KINDS: MemberKind[] = ["model", "namespace", "globalAction", "computedView"];

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

// ---------------------------------------------------------------------------
// Filesystem discovery of the client layout
// ---------------------------------------------------------------------------

function firstExisting(...candidates: string[]): string | null {
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

/** Resolve which generated files exist for a given client directory. */
export function resolveLayout(clientDir: string): ClientLayout {
  return {
    clientDir,
    esmClient: firstExisting(join(clientDir, "dist-esm", "Client.js")),
    cjsClient: firstExisting(join(clientDir, "dist-cjs", "Client.js")),
    dtsClients: [
      join(clientDir, "types-esm", "Client.d.ts"),
      join(clientDir, "types", "Client.d.ts"),
    ].filter((p) => existsSync(p)),
    esmModelsDir: firstExisting(join(clientDir, "dist-esm", "models")),
    cjsModelsDir: firstExisting(join(clientDir, "dist-cjs", "models")),
    esmNamespacesDir: firstExisting(join(clientDir, "dist-esm", "namespaces")),
    cjsNamespacesDir: firstExisting(join(clientDir, "dist-cjs", "namespaces")),
  };
}

// ---------------------------------------------------------------------------
// Generic member discovery (no hardcoded model/action list)
// ---------------------------------------------------------------------------

/**
 * Discover every removable member by parsing the ESM `Client.js` (all Gadget clients share this
 * deterministic codegen shape):
 *  - **model** — `this.x = new XManager(this.connection)` where `XManager` is imported from `./models/`.
 *  - **namespace** — `this.x = new XNamespace(this)` where `XNamespace` is imported from `./namespaces/`.
 *  - **globalAction** — `this.x = buildGlobalAction(this, { … })`.
 *  - **computedView** — `this.x = buildComputedView(this, { … })`.
 *
 * `buildInlineComputedView` (the generic `api.view`) and anything else are intentionally NOT members,
 * so they are never trimmed.
 */
export function discoverMembers(esmClientSource: string): DiscoveredMember[] {
  const modelFiles = new Map<string, string>(); // ManagerBase -> file base
  for (const m of esmClientSource.matchAll(
    /import\s*\{\s*(\w+)Manager\s*\}\s*from\s*["']\.\/models\/(\w+)\.js["']/g,
  )) {
    modelFiles.set(m[1], m[2]);
  }
  const namespaceFiles = new Map<string, string>(); // NamespaceClassBase -> file base
  for (const m of esmClientSource.matchAll(
    /import\s*\{\s*(\w+)Namespace\s*\}\s*from\s*["']\.\/namespaces\/(\w+)\.js["']/g,
  )) {
    namespaceFiles.set(m[1], m[2]);
  }

  const members: DiscoveredMember[] = [];
  const seen = new Set<string>();
  const add = (member: DiscoveredMember) => {
    if (seen.has(member.camel)) return;
    seen.add(member.camel);
    members.push(member);
  };

  for (const m of esmClientSource.matchAll(/this\.(\w+)\s*=\s*new\s+(\w+)Manager\(this\.connection\)/g)) {
    if (modelFiles.has(`${m[2]}`)) add({ camel: m[1], kind: "model", pascal: m[2], file: modelFiles.get(`${m[2]}`) });
  }
  for (const m of esmClientSource.matchAll(/this\.(\w+)\s*=\s*new\s+(\w+)Namespace\(this\)/g)) {
    const file = namespaceFiles.get(`${m[2]}`);
    if (file) add({ camel: m[1], kind: "namespace", pascal: m[2], file });
  }
  for (const m of esmClientSource.matchAll(/this\.(\w+)\s*=\s*buildGlobalAction\(this,/g)) {
    add({ camel: m[1], kind: "globalAction" });
  }
  for (const m of esmClientSource.matchAll(/this\.(\w+)\s*=\s*buildComputedView\(this,/g)) {
    add({ camel: m[1], kind: "computedView" });
  }
  return members;
}

/** Back-compat: discover only models. */
export function discoverModels(esmClientSource: string): DiscoveredModel[] {
  return discoverMembers(esmClientSource)
    .filter((m): m is DiscoveredMember & { pascal: string } => m.kind === "model" && !!m.pascal)
    .map((m) => ({ camel: m.camel, pascal: m.pascal }));
}

// ---------------------------------------------------------------------------
// Usage scanning of consumer source
// ---------------------------------------------------------------------------

export interface ScanResult {
  used: Set<string>;
  filesScanned: number;
  /** True if any file could not be read — callers should fail open. */
  incomplete: boolean;
  warnings: string[];
}

function walk(dir: string, ignore: RegExp[], out: string[], warnings: string[]): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    warnings.push(`could not read directory ${dir}: ${(err as Error).message}`);
    return;
  }
  for (const name of names) {
    const full = join(dir, name);
    if (ignore.some((re) => re.test(full))) continue;
    let isDir = false;
    let isFile = false;
    try {
      const st = statSync(full);
      isDir = st.isDirectory();
      isFile = st.isFile();
    } catch {
      continue;
    }
    if (isDir) walk(full, ignore, out, warnings);
    else if (isFile && SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext))) out.push(full);
  }
}

const USAGE_RE = /\bapi\.(?:internal\.)?([A-Za-z][A-Za-z0-9]*)/g;

/**
 * Scan source roots for `api.<member>` / `api.internal.<member>` references — this covers model usage,
 * namespaced action usage (`api.inventory.activate` → `inventory`), and global actions
 * (`api.writeToShopify` → `writeToShopify`). Returns the union of referenced identifiers.
 */
export function scanUsage(roots: string[], opts: { ignore?: RegExp[]; cwd?: string } = {}): ScanResult {
  const cwd = opts.cwd ?? process.cwd();
  const ignore = opts.ignore ?? [
    /[/\\]node_modules[/\\]/,
    /[/\\]dist[/\\]/,
    /[/\\]\.gadget[/\\]/,
    /\.map$/,
  ];
  const used = new Set<string>();
  const warnings: string[] = [];
  let incomplete = false;
  let filesScanned = 0;

  const files: string[] = [];
  for (const root of roots) {
    const abs = isAbsolute(root) ? root : join(cwd, root);
    if (!existsSync(abs)) {
      warnings.push(`scan root not found (skipped): ${root}`);
      continue;
    }
    if (statSync(abs).isDirectory()) walk(abs, ignore, files, warnings);
    else files.push(abs);
  }

  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      warnings.push(`could not read ${file}: ${(err as Error).message}`);
      incomplete = true;
      continue;
    }
    filesScanned++;
    for (const m of text.matchAll(USAGE_RE)) used.add(m[1]);
  }

  return { used, filesScanned, incomplete, warnings };
}

function isAbsolute(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[/\\]/.test(p);
}

// ---------------------------------------------------------------------------
// Removal specs + matching (line anchors and balanced blocks)
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Word-ish boundary so `event` does not match `eventGroup`, `shopifyProduct` not `shopifyProductMedia`. */
function camelB(camel: string): string {
  return `(?<![A-Za-z0-9])${esc(camel)}(?![A-Za-z0-9])`;
}

type Removal =
  | { type: "line"; re: RegExp; expect: number | "any" }
  | { type: "block"; startRe: RegExp; includePrecedingComment?: boolean };

/**
 * Find the line index that ends a brace/paren-balanced declaration starting at `startIdx`. String- and
 * escape-aware so braces/semicolons inside string literals are ignored. Returns -1 if no balanced end
 * is found (the caller then skips the member — fail-safe).
 */
function findBlockEnd(lines: string[], startIdx: number, maxSpan = 400): number {
  let depth = 0;
  for (let i = startIdx; i < lines.length && i - startIdx < maxSpan; i++) {
    const line = lines[i];
    let str: string | null = null;
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (str) {
        if (ch === "\\") c++;
        else if (ch === str) str = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") str = ch;
      else if (ch === "{" || ch === "(") depth++;
      else if (ch === "}" || ch === ")") depth--;
      else if (ch === ";" && depth === 0) return i;
    }
  }
  return -1;
}

const COMMENT_LINE = /^\s*\/\*\*.*\*\/\s*$/;

interface MatchResult {
  ok: boolean;
  removeIdx: number[];
  detail: string;
}

/** Test a member's removals against a file's lines. `ok` only if every removal resolves as expected. */
function matchRemovals(lines: string[], removals: Removal[]): MatchResult {
  const removeIdx = new Set<number>();
  const details: string[] = [];
  let ok = true;

  for (const r of removals) {
    if (r.type === "line") {
      const hits = lines.flatMap((line, i) => (r.re.test(line) ? [i] : []));
      details.push(`${r.expect === "any" ? "any" : r.expect}≠${hits.length}`);
      if (r.expect !== "any" && hits.length !== r.expect) ok = false;
      for (const i of hits) removeIdx.add(i);
    } else {
      const starts = lines.flatMap((line, i) => (r.startRe.test(line) ? [i] : []));
      if (starts.length !== 1) {
        details.push(`block:1≠${starts.length}`);
        ok = false;
        continue;
      }
      const start = starts[0];
      const end = findBlockEnd(lines, start);
      if (end < 0) {
        details.push("block:unbalanced");
        ok = false;
        continue;
      }
      details.push("block:ok");
      let from = start;
      if (r.includePrecedingComment && start > 0 && COMMENT_LINE.test(lines[start - 1])) from = start - 1;
      for (let i = from; i <= end; i++) removeIdx.add(i);
    }
  }
  return { ok, removeIdx: [...removeIdx].sort((a, b) => a - b), detail: details.join(",") };
}

function removeLines(source: string, idx: Set<number>): string {
  if (!idx.size) return source;
  return source
    .split("\n")
    .filter((_, i) => !idx.has(i))
    .join("\n");
}

// ---------------------------------------------------------------------------
// Per-kind removal specs
// ---------------------------------------------------------------------------

function esmRemovals(m: DiscoveredMember, source: string): Removal[] {
  const { camel, pascal, kind } = m;
  if (kind === "model") {
    const p = pascal!;
    return [
      { type: "line", re: new RegExp(`^\\s*import\\s*\\{\\s*${esc(p)}Manager\\s*\\}\\s*from\\s*["']\\./models/${esc(p)}\\.js["'];?\\s*$`), expect: 1 },
      { type: "line", re: new RegExp(`^\\s*import\\s*\\{\\s*Default${esc(p)}Selection\\s+as\\s+Default${esc(p)}Selection2\\s*\\}\\s*from\\s*["']\\./models/${esc(p)}\\.js["'];?\\s*$`), expect: 1 },
      { type: "line", re: new RegExp(`^\\s*this\\.${camelB(camel)}\\s*=\\s*new\\s+${esc(p)}Manager\\(this\\.connection\\);?\\s*$`), expect: 1 },
      { type: "line", re: new RegExp(`^\\s*${camelB(camel)}:\\s*new\\s+(?:\\w+\\.)?InternalModelManager\\(["']${esc(camel)}["'],`), expect: 1 },
      { type: "line", re: new RegExp(`^\\s*Default${esc(p)}Selection2 as Default${esc(p)}Selection,?\\s*$`), expect: 1 },
    ];
  }
  if (kind === "namespace") {
    const p = pascal!;
    const file = m.file!;
    return [
      { type: "line", re: new RegExp(`^\\s*import\\s*\\{\\s*${esc(p)}Namespace\\s*\\}\\s*from\\s*["']\\./namespaces/${esc(file)}\\.js["'];?\\s*$`), expect: 1 },
      { type: "line", re: new RegExp(`^\\s*this\\.${camelB(camel)}\\s*=\\s*new\\s+${esc(p)}Namespace\\(this\\);?\\s*$`), expect: 1 },
    ];
  }
  // globalAction / computedView — inline multi-line block
  const builder = kind === "globalAction" ? "buildGlobalAction" : "buildComputedView";
  void source;
  return [
    { type: "block", startRe: new RegExp(`^\\s*this\\.${camelB(camel)}\\s*=\\s*${builder}\\(this,`), includePrecedingComment: true },
  ];
}

function cjsRemovals(m: DiscoveredMember, source: string): Removal[] {
  const { camel, pascal, kind } = m;
  if (kind === "model") {
    const p = pascal!;
    const reqCount = [...source.matchAll(new RegExp(`var\\s+\\w+\\s*=\\s*require\\(["']\\./models/${esc(p)}\\.js["']\\);`, "g"))].length;
    return [
      { type: "line", re: new RegExp(`^\\s*var\\s+\\w+\\s*=\\s*require\\(["']\\./models/${esc(p)}\\.js["']\\);?\\s*$`), expect: reqCount || "any" },
      { type: "line", re: new RegExp(`^\\s*this\\.${camelB(camel)}\\s*=\\s*new\\s+\\w+\\.${esc(p)}Manager\\(this\\.connection\\);?\\s*$`), expect: 1 },
      { type: "line", re: new RegExp(`^\\s*${camelB(camel)}:\\s*new\\s+(?:\\w+\\.)?InternalModelManager\\(["']${esc(camel)}["'],`), expect: 1 },
      { type: "line", re: new RegExp(`^\\s*Default${esc(p)}Selection:\\s*\\(\\)\\s*=>\\s*\\w+\\.Default${esc(p)}Selection,?\\s*$`), expect: 1 },
      { type: "line", re: new RegExp(`^\\s*Default${esc(p)}Selection,?\\s*$`), expect: 1 },
    ];
  }
  if (kind === "namespace") {
    const p = pascal!;
    const file = m.file!;
    const reqCount = [...source.matchAll(new RegExp(`var\\s+\\w+\\s*=\\s*require\\(["']\\./namespaces/${esc(file)}\\.js["']\\);`, "g"))].length;
    return [
      { type: "line", re: new RegExp(`^\\s*var\\s+\\w+\\s*=\\s*require\\(["']\\./namespaces/${esc(file)}\\.js["']\\);?\\s*$`), expect: reqCount || "any" },
      { type: "line", re: new RegExp(`^\\s*this\\.${camelB(camel)}\\s*=\\s*new\\s+\\w+\\.${esc(p)}Namespace\\(this\\);?\\s*$`), expect: 1 },
    ];
  }
  const builder = kind === "globalAction" ? "buildGlobalAction" : "buildComputedView";
  return [
    {
      type: "block",
      // esbuild emits `(0, import_builder.buildGlobalAction)(this, {` or a plain call.
      startRe: new RegExp(`^\\s*this\\.${camelB(camel)}\\s*=\\s*(?:\\(0,\\s*\\w+\\.${builder}\\)|${builder})\\(this,`),
      includePrecedingComment: true,
    },
  ];
}

/**
 * d.ts pruning. For models + namespaces we remove the manager/namespace import and the class field so
 * `api.<member>` becomes a compile error (record/selection re-exports for models are intentionally
 * kept). For global actions / computed views we remove the (possibly multi-line) field declaration.
 */
function dtsRemovals(m: DiscoveredMember): Removal[] {
  const { camel, pascal, kind } = m;
  if (kind === "model") {
    const p = pascal!;
    return [
      { type: "line", re: new RegExp(`^\\s*import\\s*\\{\\s*${esc(p)}Manager\\s*\\}\\s*from\\s*["']\\./models/${esc(p)}\\.js["'];?\\s*$`), expect: "any" },
      { type: "line", re: new RegExp(`${camelB(camel)}!:\\s*${esc(p)}Manager;`), expect: 1 },
      { type: "line", re: new RegExp(`${camelB(camel)}:\\s*InternalModelManager;`), expect: 1 },
    ];
  }
  if (kind === "namespace") {
    const p = pascal!;
    const file = m.file!;
    return [
      { type: "line", re: new RegExp(`^\\s*import\\s*\\{\\s*${esc(p)}Namespace\\s*\\}\\s*from\\s*["']\\./namespaces/${esc(file)}\\.js["'];?\\s*$`), expect: "any" },
      { type: "line", re: new RegExp(`${camelB(camel)}!:\\s*${esc(p)}Namespace;`), expect: 1 },
    ];
  }
  // globalAction / computedView — a class-field declaration that may span multiple lines and may carry
  // a leading `/** … */` doc comment on the same line.
  return [{ type: "block", startRe: new RegExp(`${camelB(camel)}:\\s`) }];
}

// ---------------------------------------------------------------------------
// Plan computation
// ---------------------------------------------------------------------------

/** Compute the trim plan from already-loaded file contents. Pure — performs no I/O except existence checks for deletions. */
export function computePlan(
  layout: ClientLayout,
  files: { esm: string | null; cjs: string | null; dts: { file: string; text: string }[] },
  scan: ScanResult,
  options: ComputeOptions,
): TrimPlan {
  const warnings: string[] = [...scan.warnings];
  const alwaysKeep = new Set(options.alwaysKeep ?? DEFAULT_ALWAYS_KEEP);
  const configKeep = new Set(options.keep ?? []);
  const forceTrim = new Set(options.forceTrim ?? []);
  const kinds = new Set(options.kinds ?? ALL_KINDS);

  if (!files.esm) {
    warnings.push("no dist-esm/Client.js found — nothing to do");
    return { discovered: [], used: [...scan.used], keep: [], trim: [], edits: [], deletions: [], warnings };
  }

  const discovered = discoverMembers(files.esm);
  const byCamel = new Map(discovered.map((d) => [d.camel, d]));

  for (const c of forceTrim) {
    if (alwaysKeep.has(c)) warnings.push(`forceTrim "${c}" ignored — it is in alwaysKeep`);
    else if (!byCamel.has(c)) warnings.push(`forceTrim "${c}" is not a known member`);
  }

  // keep = alwaysKeep ∪ configKeep ∪ (used ∩ discovered), minus forceTrim (never alwaysKeep)
  const keep = new Set<string>();
  for (const c of alwaysKeep) if (byCamel.has(c)) keep.add(c);
  for (const c of configKeep) if (byCamel.has(c)) keep.add(c);
  for (const c of scan.used) if (byCamel.has(c)) keep.add(c);
  for (const c of forceTrim) if (!alwaysKeep.has(c)) keep.delete(c);

  // Members eligible for trimming, restricted to the configured kinds.
  const candidates = discovered.filter((d) => kinds.has(d.kind));

  let trimMembers: DiscoveredMember[];
  if (scan.incomplete) {
    warnings.push("usage scan was incomplete — failing open (only forceTrim members will be removed)");
    trimMembers = candidates.filter((d) => forceTrim.has(d.camel) && !alwaysKeep.has(d.camel));
  } else {
    trimMembers = candidates.filter((d) => !keep.has(d.camel));
  }

  // Build the set of editable targets with their per-kind removal generators.
  interface Target {
    file: string;
    lines: string[];
    removalsFor: (m: DiscoveredMember) => Removal[];
  }
  const targets: Target[] = [];
  if (layout.esmClient && files.esm != null) {
    const esm = files.esm;
    targets.push({ file: layout.esmClient, lines: esm.split("\n"), removalsFor: (m) => esmRemovals(m, esm) });
  }
  if (layout.cjsClient && files.cjs != null) {
    const cjs = files.cjs;
    targets.push({ file: layout.cjsClient, lines: cjs.split("\n"), removalsFor: (m) => cjsRemovals(m, cjs) });
  }
  if (options.pruneTypes !== false) {
    for (const d of files.dts) {
      targets.push({ file: d.file, lines: d.text.split("\n"), removalsFor: dtsRemovals });
    }
  }

  const removalByFile = new Map<string, Set<number>>();
  for (const t of targets) removalByFile.set(t.file, new Set<number>());

  // A member is trimmed only if it can be cleanly removed from EVERY target (all-or-nothing).
  const strippable: DiscoveredMember[] = [];
  for (const member of trimMembers) {
    const matches = targets.map((t) => ({ t, res: matchRemovals(t.lines, t.removalsFor(member)) }));
    const bad = matches.filter((m) => !m.res.ok);
    if (bad.length) {
      for (const b of bad) {
        warnings.push(`${b.t.file}: skipped "${member.camel}" (${member.kind}) — unexpected shape [${b.res.detail}]`);
      }
      continue;
    }
    strippable.push(member);
    for (const m of matches) {
      const set = removalByFile.get(m.t.file)!;
      for (const i of m.res.removeIdx) set.add(i);
    }
  }

  const edits: FileEdit[] = [];
  const newText = new Map<string, string>();
  for (const t of targets) {
    const idx = removalByFile.get(t.file)!;
    const before = t.lines.join("\n");
    const after = removeLines(before, idx);
    newText.set(t.file, after);
    if (after !== before) edits.push({ file: t.file, removedLines: [...idx].sort((a, b) => a - b), before, after });
  }

  // Deletions: backing module files for fully-stripped models/namespaces with zero remaining references.
  const deletions: string[] = [];
  if (options.deleteFiles !== false) {
    for (const member of strippable) {
      if (member.kind !== "model" && member.kind !== "namespace") continue;
      const subdir = member.kind === "model" ? "models" : "namespaces";
      const dirs = member.kind === "model"
        ? [layout.esmModelsDir, layout.cjsModelsDir]
        : [layout.esmNamespacesDir, layout.cjsNamespacesDir];
      const fileBase = member.kind === "model" ? member.pascal! : member.file!;
      const ref = new RegExp(`${subdir}/${esc(fileBase)}\\.js`);
      const esmTxt = layout.esmClient ? newText.get(layout.esmClient) : undefined;
      const cjsTxt = layout.cjsClient ? newText.get(layout.cjsClient) : undefined;
      if ((esmTxt && ref.test(esmTxt)) || (cjsTxt && ref.test(cjsTxt))) {
        warnings.push(`not deleting "${fileBase}" (${member.kind}) files — references still present`);
        continue;
      }
      for (const dir of dirs) {
        if (!dir) continue;
        for (const suffix of [".js", ".js.map"]) {
          const f = join(dir, `${fileBase}${suffix}`);
          if (existsSync(f)) deletions.push(f);
        }
      }
    }
  }

  return {
    discovered,
    used: [...scan.used].filter((c) => byCamel.has(c)).sort(),
    keep: [...keep].sort(),
    trim: strippable.map((m) => m.camel).sort(),
    edits,
    deletions,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// I/O: read the client files, and apply a plan
// ---------------------------------------------------------------------------

/** Read the generated client files needed to compute and apply a plan. */
export function readClientFiles(layout: ClientLayout): {
  esm: string | null;
  cjs: string | null;
  dts: { file: string; text: string }[];
} {
  const read = (f: string | null): string | null => (f ? readFileSync(f, "utf8") : null);
  return {
    esm: read(layout.esmClient),
    cjs: read(layout.cjsClient),
    dts: layout.dtsClients.map((file) => ({ file, text: readFileSync(file, "utf8") })),
  };
}

export interface ApplyResult {
  filesWritten: string[];
  filesDeleted: string[];
}

/** Write the edits and delete the orphaned module files described by a plan. */
export function applyPlan(plan: TrimPlan): ApplyResult {
  const filesWritten: string[] = [];
  for (const edit of plan.edits) {
    writeFileSync(edit.file, edit.after, "utf8");
    filesWritten.push(edit.file);
  }
  const filesDeleted: string[] = [];
  for (const f of plan.deletions) {
    rmSync(f, { force: true });
    filesDeleted.push(f);
  }
  return { filesWritten, filesDeleted };
}

export interface AnalyzeConfig extends ComputeOptions {
  clientDir: string;
  scan?: string[];
  ignore?: RegExp[];
  cwd?: string;
}

/** High-level: resolve layout, scan usage, read files, and compute the plan. No writes. */
export function analyze(config: AnalyzeConfig): { layout: ClientLayout; plan: TrimPlan } {
  const layout = resolveLayout(config.clientDir);
  const scan = scanUsage(config.scan ?? ["web", "extensions", "shared"], {
    ignore: config.ignore,
    cwd: config.cwd,
  });
  const files = readClientFiles(layout);
  const plan = computePlan(layout, files, scan, config);
  return { layout, plan };
}
