import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
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
import { buildRepo, cjsClient, dtsClient, esmClient } from "./fixture.js";

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

  const buildFixtureRepo = () => buildRepo(dirs);

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
