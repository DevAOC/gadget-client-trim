import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  analyze,
  applyPlan,
  computePlan,
  discoverMembers,
  discoverModels,
  findClient,
  resolveLayout,
  scanUsage,
  type ClientLayout,
  type ScanResult,
} from "../dist/index.js";

// ---------------------------------------------------------------------------
// Fixture generation — deliberately NON-Gadget names to prove generic discovery.
// Models, namespaces, global actions, and computed views are all represented.
// ---------------------------------------------------------------------------

const MODELS = ["Alpha", "Beta", "Gamma", "Event", "EventGroup", "Session", "CurrentSession"];
const NAMESPACES = ["widget", "gizmo"]; // class = Cap+Namespace, file = camel
const GLOBALS = ["actKeep", "actDrop"];
const VIEWS = ["viewKeep", "viewDrop"];

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const lc = (p: string) => p[0].toLowerCase() + p.slice(1);
const NO_SELECTION = new Set(["CurrentSession"]); // mirrors Gadget's CurrentSession (no DefaultSelection)

function esmClient(): string {
  const L: string[] = [`import { buildGlobalAction, buildComputedView, buildInlineComputedView } from "./builder.js";`];
  for (const m of MODELS) L.push(`import { ${m}Manager } from "./models/${m}.js";`);
  for (const n of NAMESPACES) L.push(`import { ${cap(n)}Namespace } from "./namespaces/${n}.js";`);
  for (const m of MODELS) if (!NO_SELECTION.has(m)) L.push(`import { Default${m}Selection as Default${m}Selection2 } from "./models/${m}.js";`);
  L.push(`export class Client {`, `  constructor() {`, `    this.connection = {};`);
  for (const m of MODELS) L.push(`    this.${lc(m)} = new ${m}Manager(this.connection);`);
  for (const n of NAMESPACES) L.push(`    this.${n} = new ${cap(n)}Namespace(this);`);
  for (const g of GLOBALS) {
    if (g === "actKeep") L.push(`    /** Executes the ${g} global action. */`);
    L.push(`    this.${g} = buildGlobalAction(this, {`, `      type: "globalAction",`, `      functionName: "${g}",`, `      variables: { id: { required: false, type: "String" } }`, `    });`);
  }
  for (const v of VIEWS) {
    L.push(`    this.${v} = buildComputedView(this, {`, `      type: "computedView",`, `      functionName: "${v}"`, `    });`);
  }
  L.push(`    this.view = buildInlineComputedView(this, { type: "inline" });`);
  L.push(`    this.internal = {`);
  for (const m of MODELS) if (!NO_SELECTION.has(m)) L.push(`      ${lc(m)}: new InternalModelManager("${lc(m)}", this.connection, { "pluralApiIdentifier": "${lc(m)}s" }),`);
  L.push(`    };`, `  }`, `}`, `export {`);
  for (const m of MODELS) if (!NO_SELECTION.has(m)) L.push(`  Default${m}Selection2 as Default${m}Selection,`);
  L.push(`};`);
  return L.join("\n") + "\n";
}

function cjsClient(): string {
  const L: string[] = [`"use strict";`, `var import_builder = require("./builder.js");`, `var import_InternalModelManager = require("./connection/InternalModelManager.js");`];
  L.push(`__export(Client_exports, {`);
  for (const m of MODELS) if (!NO_SELECTION.has(m)) L.push(`  Default${m}Selection: () => import_${m}2.Default${m}Selection,`);
  L.push(`});`);
  for (const m of MODELS) {
    L.push(`var import_${m} = require("./models/${m}.js");`);
    if (!NO_SELECTION.has(m)) L.push(`var import_${m}2 = require("./models/${m}.js");`);
  }
  for (const n of NAMESPACES) L.push(`var import_${n} = require("./namespaces/${n}.js");`);
  L.push(`class Client {`, `  constructor() {`, `    this.connection = {};`);
  for (const m of MODELS) L.push(`    this.${lc(m)} = new import_${m}.${m}Manager(this.connection);`);
  for (const n of NAMESPACES) L.push(`    this.${n} = new import_${n}.${cap(n)}Namespace(this);`);
  for (const g of GLOBALS) {
    L.push(`    this.${g} = (0, import_builder.buildGlobalAction)(this, {`, `      type: "globalAction",`, `      functionName: "${g}"`, `    });`);
  }
  for (const v of VIEWS) {
    L.push(`    this.${v} = (0, import_builder.buildComputedView)(this, {`, `      functionName: "${v}"`, `    });`);
  }
  L.push(`    this.view = (0, import_builder.buildInlineComputedView)(this, {});`);
  L.push(`    this.internal = {`);
  for (const m of MODELS) if (!NO_SELECTION.has(m)) L.push(`      ${lc(m)}: new import_InternalModelManager.InternalModelManager("${lc(m)}", this.connection, {}),`);
  L.push(`    };`, `  }`, `}`, `0 && (module.exports = {`);
  for (const m of MODELS) if (!NO_SELECTION.has(m)) L.push(`  Default${m}Selection,`);
  L.push(`});`);
  return L.join("\n") + "\n";
}

function dtsClient(): string {
  const L: string[] = [];
  for (const m of MODELS) L.push(`import { ${m}Manager } from "./models/${m}.js";`);
  for (const n of NAMESPACES) L.push(`import { ${cap(n)}Namespace } from "./namespaces/${n}.js";`);
  for (const m of MODELS) if (!NO_SELECTION.has(m)) L.push(`export { Default${m}Selection, type ${m}Record } from "./models/${m}.js";`);
  L.push(`export type InternalModelManagers = {`);
  for (const m of MODELS) if (!NO_SELECTION.has(m)) L.push(`    ${lc(m)}: InternalModelManager;`);
  L.push(`};`, `export declare class Client {`);
  for (const m of MODELS) L.push(`    ${lc(m)}!: ${m}Manager;`);
  for (const n of NAMESPACES) L.push(`    ${n}!: ${cap(n)}Namespace;`);
  // global actions: actKeep multi-line object (with same-line doc comment), actDrop single-line arrow
  L.push(`    /** Executes the actKeep global action. */ actKeep: {`, `        (variables?: { id?: string | null } | null): Promise<any>;`, `        type: 'globalAction';`, `    };`);
  L.push(`    /** @deprecated */ actDrop: (...args: any[]) => never;`);
  // computed views: viewKeep multi-line generic, viewDrop single-line
  L.push(`    /** Executes the viewKeep computed view. */ viewKeep: ViewFunctionWithVariables<{`, `        id?: string | null;`, `    }, Promise<unknown>>;`);
  L.push(`    viewDrop: ViewFunctionWithVariables<{}, Promise<unknown>>;`);
  L.push(`    view: InlineViewFunction;`, `    internal!: InternalModelManagers;`, `}`);
  return L.join("\n") + "\n";
}

function fakeLayout(): ClientLayout {
  return {
    clientDir: "/fake",
    esmClient: "/fake/dist-esm/Client.js",
    cjsClient: "/fake/dist-cjs/Client.js",
    dtsClients: ["/fake/types-esm/Client.d.ts"],
    esmModelsDir: null,
    cjsModelsDir: null,
    esmNamespacesDir: null,
    cjsNamespacesDir: null,
  };
}

function scan(used: string[], incomplete = false): ScanResult {
  return { used: new Set(used), filesScanned: 1, incomplete, warnings: [] };
}

function makeFiles() {
  return {
    esm: esmClient(),
    cjs: cjsClient(),
    dts: [{ file: "/fake/types-esm/Client.d.ts", text: dtsClient() }],
  };
}

const USED = ["alpha", "eventGroup", "widget", "actKeep", "viewKeep"];
const opts = { deleteFiles: false, pruneTypes: true };

// ---------------------------------------------------------------------------

describe("discovery", () => {
  it("discoverModels finds only models", () => {
    expect(discoverModels(esmClient()).map((m) => m.camel).sort()).toEqual(
      ["alpha", "beta", "currentSession", "event", "eventGroup", "gamma", "session"].sort(),
    );
  });

  it("discoverMembers classifies models, namespaces, global actions, computed views", () => {
    const byKind = (k: string) => discoverMembers(esmClient()).filter((m) => m.kind === k).map((m) => m.camel).sort();
    expect(byKind("namespace")).toEqual(["gizmo", "widget"]);
    expect(byKind("globalAction")).toEqual(["actDrop", "actKeep"]);
    expect(byKind("computedView")).toEqual(["viewDrop", "viewKeep"]);
    // the generic `view` (buildInlineComputedView) is NOT a member and is never trimmed
    expect(discoverMembers(esmClient()).find((m) => m.camel === "view")).toBeUndefined();
  });
});

describe("computePlan across all member kinds", () => {
  it("trims unused models, namespaces, global actions and computed views", () => {
    const plan = computePlan(fakeLayout(), makeFiles(), scan(USED), opts);
    expect(plan.trim).toEqual(["actDrop", "beta", "event", "gamma", "gizmo", "viewDrop"]);
    expect(plan.keep).toEqual(["actKeep", "alpha", "currentSession", "eventGroup", "session", "viewKeep", "widget"].sort());
    expect(plan.warnings).toEqual([]);
  });

  it("removes namespace import + ctor and a global-action / computed-view block from ESM", () => {
    const esm = computePlan(fakeLayout(), makeFiles(), scan(USED), opts).edits.find((e) => e.file.endsWith("dist-esm/Client.js"))!.after;
    // trimmed namespace
    expect(esm).not.toMatch(/GizmoNamespace/);
    expect(esm).not.toMatch(/namespaces\/gizmo\.js/);
    // trimmed global action block fully removed
    expect(esm).not.toMatch(/functionName: "actDrop"/);
    expect(esm).not.toMatch(/this\.actDrop =/);
    // trimmed computed view block removed
    expect(esm).not.toMatch(/functionName: "viewDrop"/);
    // kept members intact
    expect(esm).toMatch(/this\.widget = new WidgetNamespace\(this\)/);
    expect(esm).toMatch(/functionName: "actKeep"/);
    expect(esm).toMatch(/this\.view = buildInlineComputedView/);
  });

  it("prunes namespace + global-action + computed-view declarations from d.ts (multi-line blocks)", () => {
    const dts = computePlan(fakeLayout(), makeFiles(), scan(USED), opts).edits.find((e) => e.file.endsWith("Client.d.ts"))!.after;
    expect(dts).not.toMatch(/gizmo!: GizmoNamespace;/);
    expect(dts).not.toMatch(/actDrop:/);
    expect(dts).not.toMatch(/viewDrop:/);
    // kept declarations remain
    expect(dts).toMatch(/widget!: WidgetNamespace;/);
    expect(dts).toMatch(/actKeep: \{/);
    expect(dts).toMatch(/view: InlineViewFunction;/);
  });

  it("respects camelCase word boundaries (trimming `event` keeps `eventGroup`)", () => {
    const plan = computePlan(fakeLayout(), makeFiles(), scan(["alpha", "widget", "actKeep", "viewKeep", "eventGroup"]), opts);
    expect(plan.trim).toContain("event");
    expect(plan.trim).not.toContain("eventGroup");
  });

  it("is idempotent — re-running on trimmed output yields no changes", () => {
    const p1 = computePlan(fakeLayout(), makeFiles(), scan(USED), opts);
    const esm = p1.edits.find((e) => e.file.endsWith("dist-esm/Client.js"))!.after;
    const cjs = p1.edits.find((e) => e.file.endsWith("dist-cjs/Client.js"))!.after;
    const dts = p1.edits.find((e) => e.file.endsWith("Client.d.ts"))!.after;
    const p2 = computePlan(fakeLayout(), { esm, cjs, dts: [{ file: "/fake/types-esm/Client.d.ts", text: dts }] }, scan(USED), opts);
    expect(p2.trim).toEqual([]);
    expect(p2.edits).toEqual([]);
  });

  it("--kinds restricts trimming (model-only leaves namespaces/actions alone)", () => {
    const plan = computePlan(fakeLayout(), makeFiles(), scan(USED), { ...opts, kinds: ["model"] });
    expect(plan.trim).toEqual(["beta", "event", "gamma"]);
  });

  it("fails open when the usage scan is incomplete (trims only forceTrim)", () => {
    const plan = computePlan(fakeLayout(), makeFiles(), scan([], true), { ...opts, forceTrim: ["beta", "gizmo"] });
    expect(plan.trim.sort()).toEqual(["beta", "gizmo"]);
    expect(plan.warnings.join(" ")).toMatch(/incomplete/);
  });

  it("never trims always-keep, even via forceTrim", () => {
    const plan = computePlan(fakeLayout(), makeFiles(), scan(USED), { ...opts, forceTrim: ["session", "currentSession"] });
    expect(plan.trim).not.toContain("session");
    expect(plan.trim).not.toContain("currentSession");
  });

  it("fail-safe: skips a member whose anchors don't match, still trims the others", () => {
    const files = makeFiles();
    files.esm = files.esm.replace('new InternalModelManager("beta"', 'new BrokenManager("beta"');
    const plan = computePlan(fakeLayout(), files, scan(USED), opts);
    expect(plan.trim).not.toContain("beta");
    expect(plan.trim).toContain("gamma");
    expect(plan.warnings.join(" ")).toMatch(/skipped "beta".*unexpected shape/);
  });

  it("all-or-nothing across files: a CJS-only block mismatch prevents ESM edits too", () => {
    const files = makeFiles();
    // break the closing of actDrop's CJS block so it can't be balanced
    files.cjs = files.cjs.replace(`    this.actDrop = (0, import_builder.buildGlobalAction)(this, {`, `    this.actDrop = somethingElse({`);
    const plan = computePlan(fakeLayout(), files, scan(USED), opts);
    expect(plan.trim).not.toContain("actDrop");
    const esm = plan.edits.find((e) => e.file.endsWith("dist-esm/Client.js"))!.after;
    expect(esm).toMatch(/functionName: "actDrop"/); // ESM left intact
  });
});

describe("filesystem: scan + analyze + applyPlan", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  function buildFixtureRepo(): string {
    const root = mkdtempSync(join(tmpdir(), "gct-"));
    dirs.push(root);
    const client = join(root, ".gadget", "client");
    for (const sub of ["dist-esm/models", "dist-esm/namespaces", "dist-cjs/models", "dist-cjs/namespaces", "types-esm"]) {
      mkdirSync(join(client, sub), { recursive: true });
    }
    writeFileSync(join(client, "dist-esm", "Client.js"), esmClient());
    writeFileSync(join(client, "dist-cjs", "Client.js"), cjsClient());
    writeFileSync(join(client, "types-esm", "Client.d.ts"), dtsClient());
    for (const m of MODELS) {
      writeFileSync(join(client, "dist-esm", "models", `${m}.js`), `export class ${m}Manager {}\n`);
      writeFileSync(join(client, "dist-cjs", "models", `${m}.js`), `exports.${m}Manager = class {};\n`);
    }
    for (const n of NAMESPACES) {
      writeFileSync(join(client, "dist-esm", "namespaces", `${n}.js`), `export class ${cap(n)}Namespace {}\n`);
      writeFileSync(join(client, "dist-cjs", "namespaces", `${n}.js`), `exports.${cap(n)}Namespace = class {};\n`);
    }
    mkdirSync(join(root, "web"), { recursive: true });
    writeFileSync(
      join(root, "web", "use.ts"),
      `import { api } from "./api";\n` +
        `api.alpha.findMany();\n` +
        `api.internal.eventGroup.findOne();\n` +
        `api.widget.doThing();\n` +
        `api.actKeep({ id: "1" });\n` +
        `api.viewKeep({});\n`,
    );
    return root;
  }

  it("scans api.<member> usage (models, namespaces, global actions, views)", () => {
    const r = scanUsage(["web"], { cwd: buildFixtureRepo() });
    for (const u of USED) expect(r.used.has(u)).toBe(true);
    expect(r.incomplete).toBe(false);
  });

  it("applies edits + deletes orphaned model AND namespace files; second run is a no-op", () => {
    const root = buildFixtureRepo();
    const clientDir = join(root, ".gadget", "client");
    const { plan } = analyze({ clientDir, scan: ["web"], cwd: root });
    expect(plan.trim).toEqual(["actDrop", "beta", "event", "gamma", "gizmo", "viewDrop"]);

    applyPlan(plan);
    // model + namespace files deleted; kept ones remain
    expect(existsSync(join(clientDir, "dist-esm", "models", "Beta.js"))).toBe(false);
    expect(existsSync(join(clientDir, "dist-esm", "namespaces", "gizmo.js"))).toBe(false);
    expect(existsSync(join(clientDir, "dist-cjs", "namespaces", "gizmo.js"))).toBe(false);
    expect(existsSync(join(clientDir, "dist-esm", "models", "Alpha.js"))).toBe(true);
    expect(existsSync(join(clientDir, "dist-esm", "namespaces", "widget.js"))).toBe(true);

    const esm = readFileSync(join(clientDir, "dist-esm", "Client.js"), "utf8");
    expect(esm).not.toMatch(/namespaces\/gizmo\.js/);
    expect(esm).not.toMatch(/functionName: "actDrop"/);
    expect(esm).toMatch(/namespaces\/widget\.js/);

    const second = analyze({ clientDir, scan: ["web"], cwd: root });
    expect(second.plan.trim).toEqual([]);
    expect(second.plan.edits).toEqual([]);
  });

  it("findClient auto-detects .gadget by walking up from a subdirectory", () => {
    const root = buildFixtureRepo();
    expect(findClient(join(root, "web"))?.appRoot).toBe(root);
    expect(findClient(join(root, "web"))?.clientDir).toBe(join(root, ".gadget", "client"));
  });

  it("findClient returns null when no client exists above the cwd", () => {
    const empty = mkdtempSync(join(tmpdir(), "gct-empty-"));
    dirs.push(empty);
    expect(findClient(empty)).toBeNull();
  });

  it("resolveLayout finds standard client files incl. namespace dirs", () => {
    const layout = resolveLayout(join(buildFixtureRepo(), ".gadget", "client"));
    expect(layout.esmClient).toBeTruthy();
    expect(layout.esmNamespacesDir).toBeTruthy();
    expect(layout.dtsClients.length).toBe(1);
  });
});
