# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-10-22

### Added

- `targets`: several trims of one generated client, each scanning its own folders. At most one trims
  the client in place; the others write trimmed copies (`out`) for frontends with tighter limits.
  Targets inherit the top-level options and may override them.
- `--out <dir>`: write a trimmed copy instead of trimming in place.
- Copies are cut from a pristine snapshot of the generated client (in `node_modules/.cache`), so they
  never lose members an in-place trim removed. Without a snapshot, a copy that needs such a member
  fails with the members named instead of being written incomplete.
- Copies are stamped with their source and settings: re-runs and `--watch` leave current copies alone,
  and `--check` fails copies that are missing, stale or untrimmed.
- Programmatic API: `resolveTargets`, `runTargets`, `hashClient`, `pristineClient`.

## [0.1.0] - 2026-10-06

### Added

- Initial implementation: CLI to trim unused members from a generated Gadget API client.
- Generic discovery by parsing the client (no hardcoded list) of four member kinds: **models,
  namespaces, global actions, and computed views**. The generic `api.view` and `session`/`currentSession`
  are always kept.
- Strips ESM + CJS `Client.js` references (line anchors for models/namespaces; string-aware,
  brace-balanced block removal for global actions / computed views), deletes orphaned model and
  namespace modules, and prunes `Client.d.ts` declarations. Model record/selection type re-exports are
  preserved.
- Usage scanning of `api.<member>` / `api.internal.<member>` across configurable source dirs (covers
  model, namespace, and global-action usage). Auto-detects the client by walking up to `.gadget/client`.
- `--kinds` to restrict which member kinds are trimmed.
- `--report` / `--dry-run`, `--check` (CI gate), and `--watch` modes.
- Fail-open (incomplete scans keep everything), fail-safe (unrecognized codegen is skipped), and
  all-or-nothing trimming across ESM/CJS/d.ts.
- Programmatic API (`analyze`, `computePlan`, `applyPlan`, `discoverModels`, `scanUsage`, …).

[Unreleased]: https://github.com/DevAOC/gadget-client-trim/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/DevAOC/gadget-client-trim/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/DevAOC/gadget-client-trim/releases/tag/v0.1.0
