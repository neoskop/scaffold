# Contributing

What the CLI does and how it is used is in [README.md](README.md). This file covers the source
layout, the tests and the release process.

## Development


```bash
pnpm test        # vitest run
pnpm typecheck   # tsc --noEmit
pnpm build       # -> dist/
```

The tests create real git repos in temp directories and clone them over `file://`, so they
drive the same code as a real run. `GIT_ALLOW_PROTOCOL=file` in [test/setup.ts](test/setup.ts)
makes sure an accidental network access fails immediately instead of going out.

## Release

```bash
pnpm release:patch      # 0.1.0 -> 0.1.1
pnpm release:minor      # 0.1.0 -> 0.2.0
pnpm release:major      # 0.1.0 -> 1.0.0
pnpm release:next       # 0.1.0 -> 0.1.1-next.0, then -> 0.1.1-next.1
```

Behind this is `pnpm version <type>`, nothing more. A run raises `version` in
[package.json](package.json), commits exactly that one file with the new version as the commit
message and sets the annotated tag `v<version>`. Before that, `preversion` runs the tests — and
with them the build; afterwards `postversion` pushes branch and tag together to `origin` with
`git push --follow-tags origin HEAD`. For the cases `next` does not express there are also
`release:premajor`, `release:preminor` and `release:prepatch`; an exact version or a different
`--preid` goes directly through `pnpm version`.

It is the tag that publishes: [.github/workflows/publish.yml](.github/workflows/publish.yml)
runs on `v*`, **checks the tag against `package.json#version`**, requires the tag to be an
ancestor of `origin/main`, and then publishes to npm — prereleases under the dist-tag `next`,
everything else under `latest`. So `latest` is never moved by a prerelease, which is what counts
for `pnpm dlx @neoskop/scaffold@latest` in other people's CI. The workflow bumps and commits
nothing: it finds the version that the tag states.

There is no `--dry-run` here. `pnpm version <type> --dry-run` does accept the option, but bumps,
commits and tags anyway — it only takes effect in recursive mode. If you want to see the plan,
work it out yourself from `version` in [package.json](package.json).

In the devcontainer there is neither DNS nor an SSH agent. Bump, commit and tag still happen
there, only `postversion` fails at the push; it is caught up from the host with
`git push --follow-tags origin HEAD`.

No `pnpm change`: pnpm 11.20 does know `pnpm change` — change intents in changesets format under
`.changeset/` — and `pnpm version -r`, which redeems them. For this repo that does not carry its
weight. The package *is* the workspace root, and `pnpm version -r` does not bump it
(`0.1.0 → 0.1.0`) yet redeems the intents in the ledger anyway; in a real workspace the same call
aborts with `Cannot read properties of undefined`. On top of that, `-r` skips commit and tag
entirely — so the tag that `publish.yml` lives on would have to be created by hand regardless. A
single package needs no changeset ledger; the commit history is the changelog.

The npm side has to be set up once: trusted publishing (OIDC) can only be configured for an
existing package, so `0.1.0` has to be published by hand once. After that, register
`neoskop/scaffold` + `publish.yml` as a trusted publisher under Package Settings; the workflow
then needs no `NPM_TOKEN`.
