import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Fixture generation — deliberately NON-Gadget names to prove generic discovery.
// Models, namespaces, global actions, and computed views are all represented.
// ---------------------------------------------------------------------------

export const MODELS = ["Alpha", "Beta", "Gamma", "Event", "EventGroup", "Session", "CurrentSession"];
export const NAMESPACES = ["widget", "gizmo"]; // class = Cap+Namespace, file = camel
const GLOBALS = ["actKeep", "actDrop"];
const VIEWS = ["viewKeep", "viewDrop"];

export const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const lc = (p: string) => p[0].toLowerCase() + p.slice(1);
const NO_SELECTION = new Set(["CurrentSession"]); // mirrors Gadget's CurrentSession (no DefaultSelection)

export function esmClient(): string {
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

export function cjsClient(): string {
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

export function dtsClient(): string {
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

/** Write a fresh generated client into `<root>/.gadget/client`. */
export function writeClient(root: string): string {
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
  return client;
}

/** A temp app with a generated client and a `web/` that uses alpha, eventGroup, widget, actKeep, viewKeep. */
export function buildRepo(dirs: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "gct-"));
  dirs.push(root);
  writeClient(root);
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
