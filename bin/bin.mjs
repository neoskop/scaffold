#!/usr/bin/env node
//
// @neoskop/scaffold — install and update project scaffolds from a git repository.
//
// Design notes:
//   * A scaffold is the `template/` directory of some git repository, laid out exactly as it
//     should appear in the target project. Nothing is bundled here; the CLI and the payload
//     version independently, which is the whole point of the split.
//   * Updates are a real 3-way merge via `git merge-file`. The base is the template at the
//     commit recorded in /.scaffold.json — immutable, so once fetched it is cached forever and
//     reproducible even if the template repository later moves. Local changes are never
//     silently overwritten: either they merge, or they come back as conflict markers and a
//     non-zero exit code.
//   * /.scaffold.json also records which paths each scaffold installed. That is what tells a
//     file the template dropped from one the project brought itself, and what stops two
//     scaffolds in the same project from fighting over one path.
//   * A template may ship a scaffold.hooks.mjs, which this process imports and runs. It is
//     remote code with the user's privileges — see the README, and --no-hooks.

import { run } from '../dist/cli.js';
import { Env } from '../dist/env.js';

process.exit(await run(process.argv.slice(2), Env.default()));
