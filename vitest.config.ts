import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The suite exercises the Node entry point, which loads the wasm module from the filesystem.
    // The browser build is covered by the same journeys in CI's `browser` job, which runs them
    // against `pkg/web` under headless Chromium.
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // The engine is compiled in; a cold first instantiation plus a corpus walk is comfortably
    // inside this, and a hang means a trap, which should fail rather than sit there.
    testTimeout: 30_000,
  },
});
