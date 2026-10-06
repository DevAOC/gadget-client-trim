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
