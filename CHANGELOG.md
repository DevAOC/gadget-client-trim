# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/DevAOC/gadget-client-trim/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/DevAOC/gadget-client-trim/releases/tag/v0.1.0
