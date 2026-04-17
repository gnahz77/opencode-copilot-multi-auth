# AGENTS.md

## Repo shape
- This repo is a single-package OpenCode plugin. `package.json` points `main` and `exports` to `./dist/index.js`.
- Source lives under `src/`; `src/index.ts` is the source entrypoint and `dist/` is the published runtime output.
- Root `index.mjs` is only a compatibility re-export from `./dist/index.js`; do not treat it as the implementation source.
- Do not assume a workspace or multi-package layout from `bun.lock`; this repo's authoritative package metadata is `package.json`.

## Source-of-truth files
- Use these first before making changes: `README.md`, `package.json`, `tsconfig.json`, `src/index.ts`, `script/publish.ts`, `.github/workflows/publish.yml`, `opencode.json`.
- Prefer executable truth over prose when they differ.

## Local development
- Build first with `npm run build` before local testing.
- For unpublished local testing, load the plugin by file path, pointing OpenCode at `file:///absolute/path/to/dist/index.js` as shown in `README.md`.
- Important: the README documents that some OpenCode builds may skip loading a local plugin if the file path contains `opencode-copilot-auth`. Do not use a local path containing that substring when testing plugin loading.

## Architecture notes
- `src/index.ts` wires the plugin hooks and re-exports helper utilities; most behavior is split by responsibility into `src/auth.ts`, `src/models.ts`, `src/pool.ts`, `src/routing.ts`, `src/utils.ts`, `src/errors.ts`, and `src/types.ts`.
- If you are changing auth, model metadata, pool routing, or request behavior, inspect the corresponding `src/` module first instead of editing `dist/` or the thin root re-export.
- Published artifacts are generated into `dist/`; do not hand-edit generated files as a source of truth.

## Commands and release flow
- Verified local build command: `npm run build`.
- There are no lint, test, or typecheck scripts beyond the TypeScript build; use `npm run build` as the focused verification step unless you add new tooling.
- Local release helper: `./script/publish.ts`.
- `script/publish.ts` is a Bun script (`#!/usr/bin/env bun`) and performs external side effects in order: `npm version --no-git-tag-version`, `npm run build`, `git add package.json dist`, `git commit`, `git push`, then `gh workflow run publish.yml`.
- Treat `script/publish.ts` as publish automation, not a safe local verification step.

## CI publish path
- `.github/workflows/publish.yml` is manually triggered with `workflow_dispatch`.
- CI publishes on Node `24` using `npm install`, then `npm run build`, then `npm publish --access public`.
- CI publish requires `NODE_AUTH_TOKEN` from `secrets.NPM_TOKEN` and sets `NPM_CONFIG_PROVENANCE=false`.

## Verified quirks
- `script/publish.ts` requires Bun, but the package build/publish path itself is npm + TypeScript.
- `bun.lock` and `package-lock.json` both exist; do not infer package identity or runtime wiring from the lockfiles.
- `bun.lock` still names the workspace `opencode-anthropic-auth`; do not treat that lockfile name as current package identity.
- `opencode.json` allows most bash commands but still marks broad `git *` usage as ask-by-default; only the explicitly whitelisted read-only git commands are auto-allowed.
