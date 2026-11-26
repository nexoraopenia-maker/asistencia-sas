import path from "node:path";
import { config as loadDotenv } from "dotenv";

// Los tests se ejecutan fuera del CLI de Prisma: cargan el .env de la raiz.
loadDotenv({ path: path.resolve(import.meta.dirname, "../../.env"), quiet: true });
