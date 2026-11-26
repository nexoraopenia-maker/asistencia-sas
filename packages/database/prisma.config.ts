import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { defineConfig } from "prisma/config";

// Con un prisma.config.ts presente, Prisma deja de cargar .env automaticamente:
// hay que hacerlo a mano antes de que se lea DATABASE_URL.
loadDotenv({ path: path.resolve(import.meta.dirname, "../../.env") });

export default defineConfig({
  schema: path.join(import.meta.dirname, "schema.prisma"),
  migrations: {
    path: path.join(import.meta.dirname, "migrations"),
    seed: "tsx seed.ts",
  },
});
