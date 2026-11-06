# Releasing

Releases are automatic. To ship a new version:

1. Bump `version` in `package.json` (`npm version patch|minor|major --no-git-tag-version`, or edit it by hand).
2. Merge to `main`.

That's it. The **Publish** workflow notices the new version, and — if that exact version isn't on npm yet — builds, tests, type-checks and smoke-tests, runs `npm publish --provenance`, then tags `vX.Y.Z` and creates a GitHub Release with auto-generated notes. If the version is already published, it does nothing, so merging unrelated `package.json` edits is safe.

- **Pre-releases** (`1.0.0-beta.1`) publish under the `next` dist-tag and are marked as pre-releases on GitHub; everything else goes to `latest`.
- **Re-running:** Actions → Publish → *Run workflow* retries a failed publish without a new commit.
- **One-time setup:** an `NPM_TOKEN` repository secret (npm automation or granular token with publish rights).
- **Before bumping:** run `npm run build` and commit the refreshed `playground/reqkit.mjs` — a test fails if the committed bundle is stale.

If a publish fails halfway (published to npm but no GitHub Release, say), re-run the workflow: each step checks what already exists and skips it.
