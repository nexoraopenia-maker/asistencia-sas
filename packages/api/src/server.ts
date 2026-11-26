import { disconnectDatabase } from "@scire/database";
import { disconnectRedis, initRedis } from "./lib/redis.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { startBillingScheduler } from "./modules/billing/billing.service.js";
import { startFaceMatchWorker } from "./modules/biometrics/face-match.service.js";
import { startRetentionScheduler } from "./services/retention.service.js";
import { startWebhookDispatcher } from "./services/webhooks.service.js";

const config = loadConfig();
const app = createApp();

// Conexion a Redis antes de aceptar trafico. No bloquea el arranque si falla:
// la API debe poder funcionar con los limitadores degradados a memoria.
void initRedis();

const server = app.listen(config.PORT, () => {
  console.log(`▲ Scire 360 Chronos API escuchando en http://localhost:${config.PORT}`);
  console.log(`  entorno: ${config.NODE_ENV}`);
});

// Outbox de notificaciones hacia n8n / Evolution API.
const stopDispatcher = startWebhookDispatcher();
// Suspension de trials y periodos de gracia vencidos.
const stopBilling = startBillingScheduler();
// Verificacion facial de las marcaciones pendientes.
const stopFaceMatch = startFaceMatchWorker();
// Purga de selfies que superaron el plazo de conservacion.
const stopRetention = startRetentionScheduler();

/**
 * Apagado ordenado: deja de aceptar conexiones, espera a que terminen las
 * marcaciones en vuelo y cierra el pool de PostgreSQL. Sin esto, un redeploy
 * puede cortar una marcacion a mitad de escritura.
 */
async function shutdown(signal: string) {
  console.log(`\n${signal} recibido — cerrando ordenadamente...`);
  stopDispatcher();
  stopBilling();
  stopFaceMatch();
  stopRetention();
  server.close(async () => {
    await disconnectDatabase();
    await disconnectRedis();
    process.exit(0);
  });
  // Red de seguridad: si algo se queda colgado, forzar la salida.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
