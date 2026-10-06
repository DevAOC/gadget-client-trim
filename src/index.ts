/** Public programmatic API for gadget-client-trim. */
export {
  analyze,
  applyPlan,
  computePlan,
  discoverMembers,
  discoverModels,
  readClientFiles,
  resolveLayout,
  scanUsage,
  DEFAULT_ALWAYS_KEEP,
} from "./core.js";
export type {
  AnalyzeConfig,
  ApplyResult,
  ClientLayout,
  ComputeOptions,
  DiscoveredMember,
  DiscoveredModel,
  FileEdit,
  MemberKind,
  ScanResult,
  TrimPlan,
} from "./core.js";
export { loadConfig, findClient } from "./config.js";
export type { TrimConfig, ClientLocation } from "./config.js";
