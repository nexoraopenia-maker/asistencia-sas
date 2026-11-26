import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Solo la logica pura: los hooks y componentes importan modulos nativos de
    // Expo que no existen fuera de un dispositivo. Probarlos aqui exigiria una
    // capa de mocks que verificaria los mocks, no la app.
    include: ["src/lib/**/*.test.ts", "src/offline/**/*.test.ts"],
  },
});
