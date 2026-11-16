import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
    // Photo tests encode AVIF; on the server (2 GHz Xeon) one photo takes about
    // 2 s, so the default 5 s limit fails good code.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
