import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Los tests de aislamiento tocan una base real y comparten filas de control:
    // en serie para que no se pisen entre si.
    fileParallelism: false,
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.ts"],
  },
});
