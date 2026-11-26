import path from "node:path";
import { config as loadDotenv } from "dotenv";

// Los tests corren fuera del CLI de Prisma: cargan el .env de la raiz.
loadDotenv({ path: path.resolve(import.meta.dirname, "../../.env"), quiet: true });

// El almacenamiento S3 no esta disponible en los tests. Las empresas de prueba
// se crean con `requireSelfie: false`, asi que ningun camino ejercitado llega
// a firmar ni a consultar el bucket.
process.env.NODE_ENV = "test";

// El limitador se apaga por defecto: los helpers crean decenas de tenants y
// cada uno hace tres logins, lo que agotaria el limite de autenticacion en
// segundos. `src/middleware/rate-limit.test.ts` lo enciende explicitamente
// para probarlo, que es donde toca.
process.env.RATE_LIMIT_ENABLED = "false";
