import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  COPY_STAMP,
  IN_PLACE_STATE,
  analyze,
  hashClient,
  resolveTargets,
  runTargets,
  type TrimTarget,
} from "../dist/index.js";
import { hashConfig } from "../dist/copy.js";
import { buildRepo, writeClient } from "./fixture.js";

// Several trims of one generated client: the web app trims it in place, a size-limited frontend
// ("pos") imports a trimmed copy. The copy must be cut from the client as generated -- it needs
// members (beta, gizmo, actDrop) the web trim removes.

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const POS_USES = ["alpha", "beta", "gizmo", "actDrop"];

function buildApp(): { root: string; clientDir: string } {
  const root = buildRepo(dirs);
  mkdirSync(join(root, "pos"), { recursive: true });
  writeFileSync(
    join(root, "pos", "use.ts"),
    `api.alpha.findMany();\napi.beta.findOne();\napi.gizmo.spin();\napi.actDrop({});\n`,
  );
  return { root, clientDir: join(root, ".gadget", "client") };
}

const TWO_TARGETS: TrimTarget & { targets: TrimTarget[] } = {
  deleteFiles: true,
  targets: [
    { name: "web", scan: ["web"] },
    { name: "pos", out: ".pos-client", scan: ["pos"] },
  ],
};

function run(root: string, clientDir: string, mode: "apply" | "check" | "report", config = TWO_TARGETS) {
  return runTargets(resolveTargets(config, root, clientDir), { clientDir, appRoot: root, mode });
}

const esmOf = (clientDir: string) => readFileSync(join(clientDir, "dist-esm", "Client.js"), "utf8");
const has = (clientDir: string, member: string) =>
  new RegExp(`this\\.${member} =`).test(esmOf(clientDir));
const byName = <T extends { target: { name: string } }>(results: T[], name: string) =>
  results.find((r) => r.target.name === name)!;

describe("resolveTargets", () => {
  const root = "/app";
  const clientDir = "/app/.gadget/client";

  it("is the single in-place trim, scanning the defaults, without `targets`", () => {
    expect(resolveTargets({ keep: ["beta"] }, root, clientDir)).toEqual([
      {
        name: "in-place",
        outDir: null,
        scan: ["web", "extensions", "shared"],
        options: { keep: ["beta"] },
      },
    ]);
  });

  it("keeps a single config's own scan and out", () => {
    const [t] = resolveTargets({ scan: ["pos"], out: "copy" }, root, clientDir);
    expect(t).toMatchObject({ name: "copy", outDir: "/app/copy", scan: ["pos"] });
  });

  it("orders copies first, the in-place trim last", () => {
    const targets = resolveTargets(
      { targets: [{ scan: ["web"] }, { out: "a" }, { out: "b" }] },
      root,
      clientDir,
    );
    expect(targets.map((t) => t.outDir)).toEqual(["/app/a", "/app/b", null]);
  });

  it("gives each target the config's options, its own on top, and the CLI's over both", () => {
    const [copy, inPlace] = resolveTargets(
      {
        keep: ["gamma"],
        kinds: ["model"],
        scan: ["shared"],
        targets: [{ scan: ["web"], keep: ["beta"] }, { out: "pos" }],
      },
      root,
      clientDir,
      { kinds: ["namespace"], forceTrim: undefined },
    );
    expect(inPlace.options).toEqual({ keep: ["beta"], kinds: ["namespace"] });
    // No scan of its own: the config's top-level scan.
    expect(copy).toMatchObject({ scan: ["shared"], options: { keep: ["gamma"], kinds: ["namespace"] } });
  });

  it.each([
    [{ targets: [{ scan: ["a"] }, { scan: ["b"] }] }, /only one target may trim/],
    [{ targets: [{ out: "x" }, { out: "./x" }] }, /same `out`/],
    [{ targets: [{ out: ".gadget/client/copy" }] }, /must not be inside/],
    [{ targets: [{ out: ".gadget/client" }] }, /must not be inside/],
    [{ targets: [{ out: ".gadget" }] }, /must not contain/],
  ])("refuses %j", (config, error) => {
    expect(() => resolveTargets(config as never, root, clientDir)).toThrow(error);
  });
});

describe("runTargets: apply", () => {
  it("trims the web client in place and writes a pos copy with what pos uses", () => {
    const { root, clientDir } = buildApp();
    const results = run(root, clientDir, "apply");
    const copy = join(root, ".pos-client");

    expect(byName(results, "web").status).toBe("trimmed");
    expect(byName(results, "pos").status).toBe("trimmed");
    // The web client lost what only pos uses; the copy has it.
    for (const m of ["beta", "gizmo", "actDrop"]) {
      expect(has(clientDir, m), m).toBe(false);
      expect(has(copy, m), m).toBe(true);
    }
    // The copy lost what only web uses; the web client has it.
    for (const m of ["eventGroup", "widget", "actKeep", "viewKeep"]) {
      expect(has(clientDir, m), m).toBe(true);
      expect(has(copy, m), m).toBe(false);
    }
    // Model and namespace files follow the edits.
    expect(existsSync(join(copy, "dist-esm", "models", "Beta.js"))).toBe(true);
    expect(existsSync(join(copy, "dist-esm", "namespaces", "widget.js"))).toBe(false);
    expect(existsSync(join(clientDir, "dist-esm", "models", "Beta.js"))).toBe(false);
    // Session models are always kept.
    expect(has(copy, "session")).toBe(true);
    expect(has(copy, "currentSession")).toBe(true);
  });

  it("stamps the copy, records the in-place trim, and keeps a pristine snapshot", () => {
    const { root, clientDir } = buildApp();
    const pristine = hashClient(clientDir);
    run(root, clientDir, "apply");

    const stamp = JSON.parse(readFileSync(join(root, ".pos-client", COPY_STAMP), "utf8"));
    expect(stamp.sourceHash).toBe(pristine);
    const state = JSON.parse(readFileSync(join(clientDir, IN_PLACE_STATE), "utf8"));
    expect(state).toEqual({
      trimmedHash: hashClient(clientDir),
      pristineHash: pristine,
      trimmed: ["actDrop", "beta", "event", "gamma", "gizmo", "viewDrop"],
    });
    const snapshot = join(root, "node_modules", ".cache", "gadget-client-trim", "pristine-client");
    expect(hashClient(snapshot)).toBe(pristine);
    // Neither marker file travels into the copy.
    expect(existsSync(join(root, ".pos-client", IN_PLACE_STATE))).toBe(false);
  });

  it("re-cuts nothing on a second run, and keeps the record of what was trimmed", () => {
    const { root, clientDir } = buildApp();
    run(root, clientDir, "apply");
    const stampFile = join(root, ".pos-client", COPY_STAMP);
    const written = statSync(stampFile).mtimeMs;
    const state = readFileSync(join(clientDir, IN_PLACE_STATE), "utf8");

    const again = run(root, clientDir, "apply");
    expect(again.map((r) => r.status)).toEqual(["clean", "clean"]);
    expect(statSync(stampFile).mtimeMs).toBe(written);
    expect(readFileSync(join(clientDir, IN_PLACE_STATE), "utf8")).toBe(state);
  });

  it("cuts the copy from the snapshot when the web trim already ran", () => {
    const { root, clientDir } = buildApp();
    run(root, clientDir, "apply");
    rmSync(join(root, ".pos-client"), { recursive: true });

    const results = run(root, clientDir, "apply");
    expect(byName(results, "pos").status).toBe("trimmed");
    for (const m of POS_USES) expect(has(join(root, ".pos-client"), m), m).toBe(true);
  });

  it("re-cuts the copy after Gadget regenerates the client", () => {
    const { root, clientDir } = buildApp();
    run(root, clientDir, "apply");
    // Regenerated: pristine again, with a change the copy must pick up.
    writeClient(root);
    const esm = join(clientDir, "dist-esm", "Client.js");
    writeFileSync(esm, readFileSync(esm, "utf8") + "// regenerated\n");

    const results = run(root, clientDir, "apply");
    expect(results.map((r) => r.status)).toEqual(["trimmed", "trimmed"]);
    expect(esmOf(join(root, ".pos-client"))).toMatch(/regenerated/);
    expect(has(join(root, ".pos-client"), "beta")).toBe(true);
  });

  it("re-cuts the copy when its settings change", () => {
    const { root, clientDir } = buildApp();
    run(root, clientDir, "apply");
    const keepWidget = {
      ...TWO_TARGETS,
      targets: [TWO_TARGETS.targets[0], { ...TWO_TARGETS.targets[1], keep: ["widget"] }],
    };
    const results = run(root, clientDir, "apply", keepWidget);
    expect(byName(results, "pos").status).toBe("trimmed");
    expect(has(join(root, ".pos-client"), "widget")).toBe(true);
  });

  it("refuses a copy that needs a member the web trim removed, when no snapshot survives", () => {
    const { root, clientDir } = buildApp();
    run(root, clientDir, "apply");
    rmSync(join(root, "node_modules"), { recursive: true });
    rmSync(join(root, ".pos-client"), { recursive: true });

    const results = run(root, clientDir, "apply");
    const pos = byName(results, "pos");
    expect(pos.status).toBe("lost-members");
    expect(pos.detail).toMatch(/needs actDrop, beta, gizmo/);
    expect(pos.detail).toMatch(/Regenerate the client/);
    // Nothing half-written.
    expect(existsSync(join(root, ".pos-client"))).toBe(false);
  });

  it("still cuts a copy that needs nothing the web trim removed, without a snapshot", () => {
    const { root, clientDir } = buildApp();
    writeFileSync(join(root, "pos", "use.ts"), `api.alpha.findMany();\n`);
    run(root, clientDir, "apply");
    rmSync(join(root, "node_modules"), { recursive: true });
    rmSync(join(root, ".pos-client"), { recursive: true });

    expect(byName(run(root, clientDir, "apply"), "pos").status).toBe("trimmed");
    expect(has(join(root, ".pos-client"), "alpha")).toBe(true);
  });

  it("leaves the generated client untouched with copies only", () => {
    const { root, clientDir } = buildApp();
    const before = hashClient(clientDir);
    run(root, clientDir, "apply", { targets: [{ out: ".pos-client", scan: ["pos"] }] });
    expect(hashClient(clientDir)).toBe(before);
    expect(existsSync(join(clientDir, IN_PLACE_STATE))).toBe(false);
    expect(existsSync(join(root, "node_modules", ".cache"))).toBe(false);
    expect(has(join(root, ".pos-client"), "beta")).toBe(true);
  });

  it("cuts several copies, each to its own scan", () => {
    const { root, clientDir } = buildApp();
    run(root, clientDir, "apply", {
      targets: [
        { out: "copies/web", scan: ["web"] },
        { out: "copies/pos", scan: ["pos"] },
      ],
    });
    expect(has(join(root, "copies/web"), "widget")).toBe(true);
    expect(has(join(root, "copies/web"), "gizmo")).toBe(false);
    expect(has(join(root, "copies/pos"), "gizmo")).toBe(true);
    expect(has(join(root, "copies/pos"), "widget")).toBe(false);
  });

  it("leaves each output exactly as a fresh single trim would", () => {
    const { root, clientDir } = buildApp();
    run(root, clientDir, "apply");
    const again = analyze({ clientDir: join(root, ".pos-client"), cwd: root, scan: ["pos"] }).plan;
    expect(again.edits).toEqual([]);
    expect(again.deletions).toEqual([]);
    const web = analyze({ clientDir, cwd: root, scan: ["web"] }).plan;
    expect(web.edits).toEqual([]);
  });
});

describe("runTargets: check and report write nothing", () => {
  it("reports both outputs pending before the first trim", () => {
    const { root, clientDir } = buildApp();
    const results = run(root, clientDir, "check");
    expect(byName(results, "web")).toMatchObject({ status: "pending" });
    expect(byName(results, "pos")).toMatchObject({ status: "pending", detail: "the copy does not exist" });
    expect(existsSync(join(root, "node_modules"))).toBe(false);
    expect(existsSync(join(clientDir, IN_PLACE_STATE))).toBe(false);
  });

  it("passes once trimmed, and again after a check", () => {
    const { root, clientDir } = buildApp();
    run(root, clientDir, "apply");
    expect(run(root, clientDir, "check").map((r) => r.status)).toEqual(["clean", "clean"]);
    expect(run(root, clientDir, "check").map((r) => r.status)).toEqual(["clean", "clean"]);
  });

  it("passes a copy when the client was regenerated unchanged", () => {
    const { root, clientDir } = buildApp();
    run(root, clientDir, "apply");
    writeClient(root);
    // Same pristine client: the copy is still exactly what it would be cut as.
    expect(byName(run(root, clientDir, "check"), "pos").status).toBe("clean");
  });

  it("fails a copy left behind by a regeneration", () => {
    const { root, clientDir } = buildApp();
    run(root, clientDir, "apply");
    writeClient(root);
    const esm = join(clientDir, "dist-esm", "Client.js");
    writeFileSync(esm, readFileSync(esm, "utf8") + "// regenerated\n");
    const results = run(root, clientDir, "check");
    expect(byName(results, "pos")).toMatchObject({ status: "pending", detail: expect.stringMatching(/out of date/) });
    expect(byName(results, "web").status).toBe("pending");
  });

  it("fails a copy whose settings changed, or that was edited back", () => {
    const { root, clientDir } = buildApp();
    run(root, clientDir, "apply");
    const changed = {
      ...TWO_TARGETS,
      targets: [TWO_TARGETS.targets[0], { ...TWO_TARGETS.targets[1], scan: ["pos", "web"] }],
    };
    expect(byName(run(root, clientDir, "check", changed), "pos").detail).toMatch(/out of date/);

    // The copy restored to an untrimmed client, stamp and all.
    const copy = join(root, ".pos-client");
    const stamp = readFileSync(join(copy, COPY_STAMP), "utf8");
    rmSync(copy, { recursive: true });
    writeClient(join(root, "restored"));
    execFileSync("cp", ["-R", join(root, "restored", ".gadget", "client"), copy]);
    writeFileSync(join(copy, COPY_STAMP), stamp);
    expect(byName(run(root, clientDir, "check"), "pos").detail).toBe("the copy is not trimmed");
  });

  it("plans every target without writing", () => {
    const { root, clientDir } = buildApp();
    const before = hashClient(clientDir);
    const results = run(root, clientDir, "report");
    expect(results.map((r) => r.status)).toEqual(["reported", "reported"]);
    expect(byName(results, "pos").plan.trim).toEqual([
      "actKeep",
      "event",
      "eventGroup",
      "gamma",
      "viewDrop",
      "viewKeep",
      "widget",
    ]);
    expect(hashClient(clientDir)).toBe(before);
    expect(existsSync(join(root, ".pos-client"))).toBe(false);
  });
});

describe("hashConfig", () => {
  it("ignores key order but not values", () => {
    expect(hashConfig({ a: 1, b: [1, 2] })).toBe(hashConfig({ b: [1, 2], a: 1 }));
    expect(hashConfig({ a: 1, b: [1, 2] })).not.toBe(hashConfig({ a: 1, b: [2, 1] }));
  });
});

describe("CLI with targets", () => {
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const exec = (cwd: string, args: string[] = []) => {
    try {
      return { code: 0, out: execFileSync("node", [cli, ...args], { cwd, encoding: "utf8", stdio: "pipe" }) };
    } catch (err) {
      const e = err as { status: number; stdout: string; stderr: string };
      return { code: e.status, out: e.stdout + e.stderr };
    }
  };
  const withConfig = (root: string, config: unknown) =>
    writeFileSync(join(root, "gadget-trim.config.json"), JSON.stringify(config));

  it("applies every target, then passes --check", () => {
    const { root } = buildApp();
    withConfig(root, TWO_TARGETS);
    const applied = exec(root);
    expect(applied.code).toBe(0);
    expect(applied.out).toMatch(/\[pos → \.pos-client \(scan: pos\)\]/);
    expect(applied.out).toMatch(/wrote \.pos-client; edited/);
    expect(applied.out).toMatch(/\[web \(scan: web\)\]/);
    expect(exec(root, ["--check"])).toMatchObject({ code: 0 });
  });

  it("fails --check before the trim", () => {
    const { root } = buildApp();
    withConfig(root, TWO_TARGETS);
    const checked = exec(root, ["--check"]);
    expect(checked.code).toBe(1);
    expect(checked.out).toMatch(/check failed: the copy does not exist/);
  });

  it("runs one copy from --out and --scan, ignoring the config's targets", () => {
    const { root, clientDir } = buildApp();
    withConfig(root, TWO_TARGETS);
    const before = hashClient(clientDir);
    expect(exec(root, ["--out", "solo", "--scan", "pos"]).code).toBe(0);
    expect(has(join(root, "solo"), "beta")).toBe(true);
    expect(hashClient(clientDir)).toBe(before);
    expect(existsSync(join(root, ".pos-client"))).toBe(false);
  });

  it("exits 2 on an invalid config", () => {
    const { root } = buildApp();
    withConfig(root, { targets: [{ scan: ["a"] }, { scan: ["b"] }] });
    const result = exec(root);
    expect(result.code).toBe(2);
    expect(result.out).toMatch(/only one target may trim/);
  });

  it("exits 1 and names the members when a copy lost them", () => {
    const { root, clientDir } = buildApp();
    withConfig(root, TWO_TARGETS);
    exec(root);
    rmSync(join(root, "node_modules"), { recursive: true });
    rmSync(join(root, ".pos-client"), { recursive: true });
    const result = exec(root);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/needs actDrop, beta, gizmo/);
    expect(existsSync(join(clientDir, IN_PLACE_STATE))).toBe(true);
  });
});
