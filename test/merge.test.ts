import { describe, expect, it } from 'vitest';

import { CONFLICT_MARKER, mergeFile } from '../src/merge.js';

const labels = { local: 'local', base: 'base', incoming: 'incoming' };

describe('mergeFile', () => {
    it('combines changes to different regions without conflicts', () => {
        const { text, conflicts } = mergeFile({
            base: 'one\ntwo\nthree\n',
            local: 'one\ntwo\nthree\nlocal\n',
            incoming: 'upstream\none\ntwo\nthree\n',
            labels,
        }).unwrap();

        expect(conflicts).toBe(0);
        expect(text).toBe('upstream\none\ntwo\nthree\nlocal\n');
    });

    it('counts conflicts and keeps both sides plus the base hunk', () => {
        const { text, conflicts } = mergeFile({
            base: 'name = base\n',
            local: 'name = ours\n',
            incoming: 'name = theirs\n',
            labels,
        }).unwrap();

        expect(conflicts).toBe(1);
        expect(text).toContain('name = ours');
        expect(text).toContain('name = theirs');
        // --diff3 keeps the base, which is what makes a hand resolution possible.
        expect(text).toContain('name = base');
        expect(CONFLICT_MARKER.test(text)).toBe(true);
    });

    it('returns the local text unchanged when it already has the upstream change', () => {
        const local = 'one\ntwo\n';
        const { text, conflicts } = mergeFile({ base: 'one\n', local, incoming: local, labels }).unwrap();

        expect(conflicts).toBe(0);
        expect(text).toBe(local);
    });

    it('labels the sides so a conflict says where each version came from', () => {
        const { text } = mergeFile({
            base: 'a\n',
            local: 'b\n',
            incoming: 'c\n',
            labels: { local: 'file (local)', base: 'template v0.1.0', incoming: 'template v0.2.0' },
        }).unwrap();

        expect(text).toContain('<<<<<<< file (local)');
        expect(text).toContain('||||||| template v0.1.0');
        expect(text).toContain('>>>>>>> template v0.2.0');
    });
});

describe('CONFLICT_MARKER', () => {
    it('matches real markers anywhere in the file', () => {
        expect(CONFLICT_MARKER.test('fine\n<<<<<<< ours\n')).toBe(true);
        expect(CONFLICT_MARKER.test('fine\n>>>>>>> theirs\n')).toBe(true);
    });

    it('does not match prose that merely looks like one', () => {
        expect(CONFLICT_MARKER.test('see <<<<<<< in the docs\n')).toBe(false);
        expect(CONFLICT_MARKER.test('<<<<<<<<\n')).toBe(false);
    });
});
