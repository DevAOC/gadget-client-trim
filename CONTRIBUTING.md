# Contributing

Thanks for your interest in improving `gadget-client-trim`!

## Development

```sh
npm install
npm run build      # tsc -> dist/
npm test           # vitest (tests import the built dist/)
```

The package has **no runtime dependencies** — it uses only Node built-ins. Keep it that way.

## Layout

- `src/core.ts` — pure logic: model discovery, usage scanning, plan computation, line stripping.
  Functions here are string-in/string-out wherever possible so they're easy to test.
- `src/config.ts` — config file loading + client-directory resolution.
- `src/targets.ts` — several trims of one client (`targets`): resolution, ordering, and running them.
- `src/copy.ts` — trimmed copies: the pristine snapshot, copy stamps, and the in-place trim's record.
- `src/cli.ts` — argument parsing, the commands, and `--watch`.
- `test/` — vitest suites driven by synthetic fixtures (deliberately non-Gadget model names to keep
  discovery generic) plus on-disk apply/delete tests.

## How trimming stays safe

If you change anchor matching, preserve these invariants (and add tests):

1. **Fail-safe.** A model is only trimmed if every `expect: N` anchor matches exactly `N` lines in
   every target file. Unrecognized shapes are skipped with a warning, never partially edited.
2. **All-or-nothing.** A model is trimmed in ESM, CJS, and the `.d.ts` together, or not at all.
3. **Fail-open.** An incomplete usage scan keeps everything (only `forceTrim` is removed).
4. **Never trim `session` / `currentSession`.**
5. **Never edit the type graph** (`types.ts` / model `.d.ts` bodies) — only `Client.d.ts` fields.

## Adding support for a new Gadget codegen shape

Gadget may change the generated output. When that happens, `--check` will fail (good — it's the gate).
Add the new anchor variants in `core.ts` (`esmAnchors` / `cjsAnchors` / `dtsAnchors`), add a fixture
that reproduces the new shape, and verify both old and new shapes pass.

## Commits & PRs

- Keep changes focused; add or update tests for any behavior change.
- Run `npm run build && npm test` before opening a PR.
- Update `CHANGELOG.md` under **Unreleased**.

## Releasing

Releases are cut by CI (`.github/workflows/ci.yml`). Every pull request and push to `main` is built
and tested on Node 18, 20 and 22. On `main`, once the tests pass, the version in `package.json` is
published to npm if it is not there yet, then tagged `vX.Y.Z` with a GitHub release made from its
`CHANGELOG.md` section.

To release, in the pull request: bump `version` in `package.json` (and `package-lock.json`, via
`npm version <x.y.z> --no-git-tag-version`), and move the **Unreleased** notes under a dated
`## [x.y.z]` heading with its compare link. Merging it publishes. A merge without a version bump
publishes nothing.

Publishing uses npm trusted publishing (OIDC): no npm token lives in the repository. It is set up
once on npmjs.com under the package's **Trusted publisher** settings (GitHub Actions,
`DevAOC/gadget-client-trim`, workflow `ci.yml`).
