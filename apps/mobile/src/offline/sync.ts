import { deleteAsync } from "expo-file-system/legacy";
import { punchApi } from "../api/endpoints";
import { uploadSelfie } from "../api/upload";
import { attachSelfieKey, listPending, markAttempt, recordRejection, removePending } from "./queue";
import { runSync, type SyncResult } from "./syncCore";

export type { SyncResult } from "./syncCore";

/**
 * Sincronizacion de la cola offline (cableado nativo de `syncCore`).
 *
 * Se dispara al iniciar sesion, al volver a primer plano, al recuperar red y
 * periodicamente mientras queden pendientes. Es idempotente: cada marcacion
 * lleva su `clientPunchId`, asi que un reenvio se resuelve como duplicado.
 */
let syncInFlight: Promise<SyncResult> | null = null;

export async function syncPendingPunches(userId: string): Promise<SyncResult> {
  // Un solo envio en vuelo: varios disparadores pueden coincidir.
  syncInFlight ??= runSync({
    listPending: () => listPending(userId),
    uploadSelfie,
    attachSelfieKey,
    sendBatch: punchApi.batch,
    settle: async (items) => {
      await removePending(items.map((i) => i.clientPunchId));
      // La foto ya no se necesita: liberar el espacio del dispositivo.
      await Promise.all(
        items.map((i) =>
          i.photoUri ? deleteAsync(i.photoUri, { idempotent: true }).catch(() => {}) : null,
        ),
      );
    },
    recordRejection: (rejection) => recordRejection(userId, rejection),
    markAttempt,
  }).finally(() => {
    syncInFlight = null;
  });

  return syncInFlight;
}
