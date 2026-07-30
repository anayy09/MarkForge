import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    // Determinism: a test that depends on wall-clock time or on which other tests
    // ran first is a test that will lie eventually. Fixed timezone and no shared
    // state between files.
    environment: "node",
    globals: false,
    restoreMocks: true,
    // Fidelity and round-trip tests read real DOCX fixtures, so the default 5s is
    // occasionally tight on a cold filesystem. Not raised any further than needed.
    testTimeout: 20_000,
  },
  resolve: {
    // Vitest runs from source, so workspace imports resolve to src/ rather than to
    // dist/. This keeps `pnpm test` working before `pnpm build` has ever run, which
    // matters because the build depends on generated types that a test may be the
    // first thing to exercise.
    alias: [
      { find: /^@markforge\/([a-z-]+)$/, replacement: new URL("./packages/$1/src/index.ts", import.meta.url).pathname },
    ],
  },
});
