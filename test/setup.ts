import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

// A temp root of this test file's own, before anything else reads tmpdir().
//
// Test files run in parallel processes against one shared tmpdir(), so "what is in there" is not a
// question any single file can answer: a fixture another file creates or reclaims mid-assertion
// changes the answer. os.tmpdir() re-reads these variables on every call, so redirecting them here
// puts every temp directory — fixtures, the scratch clones the CLI makes under test, the ones the
// compiled binary makes in its own process — under a root that belongs to this file alone.
//
// Removing that root afterwards is the other half: a test that never disposes of a checkout, or a
// production path that leaks one, used to leave it in the developer's /tmp for good.
const TEMP_ROOT = mkdtempSync(join(tmpdir(), 'neoskop-scaffold-test-'));
process.env['TMPDIR'] = TEMP_ROOT;
// The two os.tmpdir() consults on Windows instead.
process.env['TEMP'] = TEMP_ROOT;
process.env['TMP'] = TEMP_ROOT;

afterAll(() => rmSync(TEMP_ROOT, { recursive: true, force: true }));

// Neither `git merge-file` nor the fixture repositories may pick up the developer's git config.
process.env['GIT_CONFIG_GLOBAL'] = '/dev/null';
process.env['GIT_CONFIG_SYSTEM'] = '/dev/null';

// ...which just removed the identity a commit needs. A fixed date on top, so a fixture's commit
// hashes are the same on every machine and can be asserted on.
process.env['GIT_AUTHOR_NAME'] = 'scaffold tests';
process.env['GIT_COMMITTER_NAME'] = 'scaffold tests';
process.env['GIT_AUTHOR_EMAIL'] = 'tests@example.invalid';
process.env['GIT_COMMITTER_EMAIL'] = 'tests@example.invalid';
process.env['GIT_AUTHOR_DATE'] = '2020-01-01T00:00:00+0000';
process.env['GIT_COMMITTER_DATE'] = '2020-01-01T00:00:00+0000';

// The hermeticity guarantee, enforced by git rather than intended by us: fixtures are cloned
// over file://, and anything that accidentally reaches for a network remote fails instantly
// with "transport 'https' not allowed" instead of going out to the internet. This is why the
// suite does NOT set NEOSKOP_SCAFFOLD_NO_FETCH globally — that would switch off the very code
// path most of these tests exist to exercise.
process.env['GIT_ALLOW_PROTOCOL'] = 'file';

// Nothing may ever prompt: a hung runner is worse than a failing one.
process.env['GIT_TERMINAL_PROMPT'] = '0';

// Never the developer's real cache — it would leak between runs and produce false green.
process.env['XDG_CACHE_HOME'] = mkdtempSync(join(tmpdir(), 'neoskop-scaffold-cache-'));
delete process.env['NEOSKOP_SCAFFOLD_CACHE_DIR'];

// Output assertions compare plain text. neon decides per call, so the switch is set here rather
// than injected — and it reaches the spawned binary through the inherited env too.
process.env['NO_COLOR'] = '1';
