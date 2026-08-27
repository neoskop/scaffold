# @neoskop/scaffold

Installs files from a git repo into a project — and keeps them up to date without
overwriting project-local changes. On every update each file is merged three-way
(`git merge-file`) against the state that was installed last time.

No runtime dependencies: `node:*` plus `git` on the host.

## Installing

In the project root:

```bash
pnpm dlx @neoskop/scaffold@latest init <repo>
```

If a hand-copied version of what the template brings along already exists:

```bash
pnpm dlx @neoskop/scaffold@latest init <repo> --adopt
```

`--adopt` leaves every existing file untouched and only writes the state. The differences
show up on the next `update` as an ordinary merge instead of getting lost.

## The repo spec

| Spec | Meaning |
| --- | --- |
| `org/repo` | GitHub over SSH (`git@github.com:org/repo.git`), default branch |
| `org/repo/feature/x` | GitHub, branch `feature/x` (everything after the second `/` is the branch) |
| `org/repo@v1.2.0` | GitHub, tag |
| `org/repo#a1b2c3d` | GitHub, commit |
| `git@host:org/repo.git` | any SSH remote |
| `https://host/org/repo.git` | any HTTPS remote |
| `./path/to/repo` | local git repo |

The last three forms take `#<ref>` for pinning — `git@host:o/r.git#v1.2.0`. Only the GitHub
shorthand treats `/`, `@` and `#` as separators.

A local path is also the way without a network: `init ./my-template` needs no remote.

## Updating

```bash
pnpm dlx @neoskop/scaffold@latest update                    # all scaffolds
pnpm dlx @neoskop/scaffold@latest update devcontainer       # just one
pnpm dlx @neoskop/scaffold@latest update --ref v1.3.0       # to a different state
pnpm dlx @neoskop/scaffold@latest update --check            # write nothing, only report
```

Per file:

| Case | Result |
| --- | --- |
| unchanged locally | pulled through (`updated`) |
| local change elsewhere in the file | merged (`merged`), both changes survive |
| local change in the same place | conflict markers in the file, exit code 1 (`conflict`) |
| already at the new state | `unchanged` |
| deleted locally | restored (`restored`) |
| deleted upstream, unchanged locally against the base | deleted (`removed`), empty directories cleaned up |
| deleted upstream, changed locally | left in place (`kept`) and owned by the project from now on |
| excluded by the `exclude` hook | not installed (`excluded`), see [Excluding files](#excluding-files) |
| binary file, both sides changed | `conflict` — there is nothing to merge |

**Nothing is overwritten silently.** Conflicts are resolved like a git merge conflict
(`<<<<<<<` / `|||||||` / `=======` / `>>>>>>>`, with `--diff3` including the base hunk).

Exit codes: `0` fine · `1` out of date under `--check`, or unresolved conflicts · `2` error.

## Building a template repo

```
template/                 copied 1:1 into the target project
  .devcontainer/…           → <project>/.devcontainer/…
  .pnpmfile.mjs             → <project>/.pnpmfile.mjs
scaffold.hooks.mjs        optional, see below
README.md                 what the scaffold does
```

`template/` is an image of what should end up in the target project — no mapping, no
placeholders, no variable substitution. The executable bit comes from the repo: whatever `git`
records as `100755` lands as `0755`. Git cannot track empty directories; if you need one, put
a `.gitkeep` in it.

Symlinks and anything else that is not a regular file are skipped and reported.

## Hooks

Copying covers nearly everything. What it does not cover: entries in files that belong to the
*project* and not to the scaffold — a line in `.gitignore`, a server in `.mcp.json`. A
`scaffold.hooks.mjs` in the root of the template repo (not in `template/`) can take care of
that. Plain ESM, named exports, all optional:

| Export | When |
| --- | --- |
| `preInit` | before the first write. If it throws, nothing is installed (exit 2) |
| `postInit` | after the installation |
| `preUpdate` / `postUpdate` | the same for `update` |
| `preSync` / `postSync` | immediately around writing the files — for `init` **and** for `update` |
| `exclude` | which files do not belong in this project |

That makes the order the same for both commands:

```
init:     preInit    → preSync → [write files] → postSync → postInit
update:   preUpdate  → preSync → [write files] → postSync → postUpdate
```

`preSync`/`postSync` are the place for everything that runs the same way in both cases —
otherwise the same function would have to be exported twice, once for `init` and once for
`update`. A `pre*` hook that throws aborts before anything has been written (exit 2); a
`post*` hook that throws does so after the files are in place — that is reported and ends in
exit 1, the scaffold stays registered and is repairable with an `update`.

```js
export function postInit(ctx) {
    ctx.log('added', '.gitignore', 'required by the template');
    if (!ctx.check) writeFileSync(join(ctx.cwd, '.gitignore'), 'node_modules\n');
}
```

A hook may be `async`; it is awaited. Its return value is ignored — the exception is `exclude`,
which is asked for one.

### The context

Every hook gets exactly one argument, and it is the same object for all of them. Plain data,
because it crosses into the template's own code.

| Field | |
| --- | --- |
| `ctx.cwd` | absolute path of the target project — the root that everything is written into |
| `ctx.templateDir` | absolute path of `template/` in the checkout, i.e. the files about to be installed |
| `ctx.repoDir` | absolute path of the checkout root — where `scaffold.hooks.mjs` itself lies. Anything the template ships *beside* `template/` is reachable from here |
| `ctx.name` | the key under `scaffolds` in `/.scaffold.json`. Not the repo: one template can be installed twice under two names, and a hook that writes a marker has to tell them apart |
| `ctx.ref` | what was asked for, as `{ kind, value }` — `kind` is `default`, `branch`, `tag`, `commit` or `rev`; `value` is empty for `default` |
| `ctx.commit` | the full SHA that `ref` resolved to. This is what gets recorded and what the next merge base will be |
| `ctx.previousCommit` | the SHA being moved away from, or `null` on `init`. The pair is the whole diff a migration needs |
| `ctx.check` | `true` under `--check`. Report, write nothing |
| `ctx.files` | the paths this scaffold owns, relative to `ctx.cwd`. See below |
| `ctx.log` | `log(kind, path, detail?)` — adds a line to the report |

`ctx.files` is filled in at different points, because the hooks run at different points:

| In | Contains |
| --- | --- |
| `preInit` / `preUpdate` / `preSync` | empty — nothing has been decided yet |
| `exclude` | every path `template/` would install: the set the hook is picking from |
| `postSync` / `postInit` / `postUpdate` | what the scaffold now owns — installed and not excluded, so a file dropped upstream or excluded away is gone from it |

`ctx.log(kind, path, detail?)` adds a line to the report. **The kind is not decoration:**
`added`, `restored`, `updated`, `merged`, `removed` and `conflict` are what `--check` builds
its exit code from; `unchanged`, `kept`, `excluded` and `warn` are the quiet ones and count for
nothing. A hook that only prints strings lets CI go green while the files it manages are out of
date.

Two rules for every hook:

1. **Idempotent.** `--check` calls the same code and counts what it reports. A hook that
   reports a change on every run keeps CI permanently red.
2. **No writes when `ctx.check` is set.** That is the dry run.

The CLI installs nothing for hooks and never calls a package manager — `node:` builtins,
nothing else. If you need dependency work, do it yourself in a `post*` hook; the CLI has no
install phase and has never run one.

### Excluding files

Some files belong only in some projects: `.pnpmfile.mjs` is only read by pnpm, in an npm
project it would be a file that looks like it does something. `exclude` answers that — it is
asked once, before the first write:

```js
export function exclude(ctx) {
    // ctx.files: every path template/ brings along
    return isPnpm(ctx.cwd) ? [] : ['.pnpmfile.mjs'];
}
```

What is returned are the paths that should **not** be installed. A hook can therefore only
shrink a template, never extend it; a path that `template/` does not contain is an error and
aborts the run (the hooks file and `template/` come from the same commit — an unknown path
there is a typo and not a property of the target project).

An array is just the most convenient form; what is required is an iterable. `function*` and
`async function*` are equally valid — with several conditions often the more readable variant,
because each one stands on its own:

```js
export function* exclude(ctx) {
    if (!isPnpm(ctx.cwd)) yield '.pnpmfile.mjs';
    if (!hasTypeScript(ctx.cwd)) yield 'tsconfig.base.json';
}
```

If the answer changes later — the project switches from pnpm to npm — the same rule applies to
the already installed file as to one that was deleted upstream: unchanged against the merge
base it is removed (`removed`), changed locally it is left in place (`kept`) and belongs to the
project from then on.

On top of that comes a **third rule**, in addition to the two above: `exclude` must be **free
of side effects** and always give the same answer for a given repository. It writes nothing —
not even without `ctx.check`.

What it excluded is recorded in `/.scaffold.json` under `excluded`. That is the reason it is
there: **with `--no-hooks` nobody asks**, and without that entry CI would report every excluded
file as missing on every run. With `--no-hooks` the answer recorded last time is reused
unchanged — with `init --no-hooks` there is none yet, so everything is installed.

### Security model

**`scaffold.hooks.mjs` is foreign code that runs in this process, on the host, without a
sandbox, with the rights of the person running it.** `scaffold init org/repo` is exactly as
dangerous as `curl … | sh` from the operators of that repo. 

It follows that:

- Only run scaffolds from repos you would give commit rights to.
- Pin to a tag or commit for anything automated. The resolved commit is recorded in
  `/.scaffold.json` and is therefore visible in review.
- **Set `--no-hooks` in CI.** Hooks also run under `--check` (they get `ctx.check: true`),
  because otherwise `--check` could not see what they manage — so a `--check` job without
  `--no-hooks` executes foreign code on the runner. What `exclude` decided stays visible
  nonetheless: it is in `/.scaffold.json` and is read from there instead of being asked again.
- Do not run as root.

The clone itself is locked down: no git hooks, no template directory, no submodules, no
symlinks, no terminal prompt, only `https`/`ssh`/`file` as transport, and refs that start with
`-` or contain `ext::` are rejected before they reach an argv. `git` is never started through a
shell.

## `/.scaffold.json`

```jsonc
{
    "scaffolds": {
        "devcontainer": {
            "repo": "neoskop/devcontainer",
            "ref": { "kind": "tag", "value": "v0.1.0" },   // wanted
            "commit": "888bfbf…",                           // installed, and the merge base
            "excluded": [".pnpmfile.mjs"]                   // absent when nothing is excluded
        }
    }
}
```

`ref` versus `commit` is the important distinction: `update --check` resolves `ref` afresh and
compares it against `commit`, so that "there is a new tag, but the files are not here yet" is
detectable at all.

**No file list.** Which paths a scaffold owns is deliberately not recorded here: that is the
template at `commit`, minus `excluded`. So exactly the merge base that `update` fetches anyway
and without which it writes nothing. A second, committed and hand-editable copy of the same
list could only end up disagreeing with the tree it came from.

That also answers the question "was this file ever part of the template at all?" — it is in the
base tree. Whether a file that disappeared upstream may then be *deleted* is decided by the
same base: only what is still identical to it is removed — everything else has been touched by
someone and is left in place, unclaimed from then on.

`excluded` is the only entry here that is a *cached answer* rather than a decision: what the
template's `exclude` hook excluded. It is recorded because `--no-hooks` does not ask the hook —
see [Excluding files](#excluding-files) — and because it is the part of the base tree that
never landed in this project. If a template excludes nothing, the key is absent entirely.

Several scaffolds per project are the normal case — `--name` assigns the key. Two scaffolds
that claim the same file are rejected instead of overwriting each other on every update. What
the *other* scaffolds own is determined the same way: from the template at the commit their own
entry names. A project with one scaffold fetches nothing for this; with several it costs one
checkout per additional scaffold. If that scaffold's remote is unreachable, the report says so
and skips the overlap check against it instead of guessing. An excluded file does not count:
what this project never gets anyway cannot be contested either.

## Where the merge base comes from

The template at the commit recorded in `commit`. Not stored in the project, but extracted to
`~/.cache/neoskop-scaffold/<repo>/<commit>/` — a committed copy would be input to a merge
algorithm sitting in the middle of the working tree, which a formatter or a search-and-replace
would silently rewrite.

Because a commit is immutable, the base is permanently available offline after the first fetch.
If nothing has moved, the freshly fetched tree is the base itself and there is no second round
trip.

If the base cannot be obtained, `update` aborts with exit code 2 and writes nothing. Writing
only the safe files would not work: that would require recording the new commit, and the *next*
merge would then run against a state that was never on disk.

| | |
| --- | --- |
| `update --base <dir>` | a local checkout of the template repo as the base |
| `NEOSKOP_SCAFFOLD_NO_FETCH=1` | fetch nothing; the cache is still used |
| `NEOSKOP_SCAFFOLD_CACHE_DIR` | where to cache |
| `NEOSKOP_SCAFFOLD_NO_HOOKS=1` | same as `--no-hooks` |

## In CI

```yaml
- run: pnpm dlx @neoskop/scaffold@latest update --check --no-hooks
```

Exit code 1 if a scaffold is out of date or unresolved conflict markers are in the repo. The
check fetches the template repo and therefore needs egress to the host — **over HTTPS**: an SSH
spec does not work from a container behind a CONNECT proxy.

If the remote is unreachable, `--check` reports that as *unknown* and not as "out of date".

## Contributing

Source layout, tests and the release process are in [CONTRIBUTE.md](CONTRIBUTE.md).
