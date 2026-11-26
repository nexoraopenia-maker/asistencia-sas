import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Los tests levantan la app real contra PostgreSQL y comparten la base:
    // en serie para que no compitan por las mismas filas.
    fileParallelism: false,
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
