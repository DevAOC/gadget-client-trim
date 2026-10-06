# Integration recipes

Copy-paste guidance for wiring `gadget-client-trim` into a project. These are **examples**, not code the
package runs for you. In every case: generate your client first (your own `ggt` / sync step), then trim,
then build. The package never runs `ggt` or reads any token.

## 1. Dev (watch)

Run the trim in watch mode next to your dev server so it re-applies after each regeneration:

```jsonc
// package.json
{
  "scripts": {
    "dev": "npm-run-all --parallel dev:server trim:watch",
    "dev:server": "react-router dev",        // or: shopify app dev / vite
    "trim:watch": "gadget-client-trim --watch"
  }
}
```

## 2. Build step (any bundler)

Trim immediately before the bundler reads the client. Do **not** rely on npm's `prebuild` hook — it does
not fire for the Shopify CLI or for pipelines that invoke the bundler directly.

```sh
gadget-client-trim && react-router build
```

## 3. Shopify UI extensions

Extensions are bundled by the Shopify CLI, which reads the same on-disk client. Trim before deploying:

```sh
ggt pull --app=<app> --env=<env>   # your step — materializes .gadget/client (needs your token)
yarn install
gadget-client-trim                 # trims the on-disk client
shopify app deploy
```

## 4. GitHub Actions — add to an existing workflow

Add two steps to a job that has **already** generated the client (after your `ggt`/sync step). Auth for
that step is yours to provide via your own secret — the trim itself needs nothing.

```yaml
- name: Trim unused models from the Gadget client
  run: npx gadget-client-trim

- name: Verify the client is trimmed (gate)
  run: npx gadget-client-trim --check
```

## 5. GitHub Actions — a standalone verification job

```yaml
name: Verify client trim
on: [pull_request]
jobs:
  trim-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      # --- your client-generation step goes here (e.g. ggt pull, using your own token) ---
      - run: npm ci
      - run: npx gadget-client-trim
      - run: npx gadget-client-trim --check
```
