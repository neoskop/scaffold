import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['test/**/*.test.ts'],
        setupFiles: ['test/setup.ts'],
        // test/bin.test.ts drives the compiled binary, which the published package is.
        globalSetup: ['test/build.ts'],
    },
});
