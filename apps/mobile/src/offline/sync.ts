import { PunchSource, type CreatePunchInput } from "@scire/shared";
import { deleteAsync } from "expo-file-system/legacy";
import { ApiError, NetworkError } from "../api/client";
import { punchApi } from "../api/endpoints";
import { uploadSelfie } from "../api/upload";
import {
  attachSelfieKey,
  listPending,
  markAttempt,
  recordRejection,
  removePending,
} from "./queue";

/**
 * Sincronizacion de la cola offline.
 *
 * Se dispara cuando NetInfo detecta conectividad y al abrir la aplicacion.
 * Es idempotente por diseno: cada marcacion lleva su `clientPunchId`, asi que
 * un lote reenviado se resuelve como duplicado en el servidor, no como error.
 */

export interface SyncResult {
  synced: number;
  duplicates: number;
  rejected: number;
  /** Quedaron en cola por falta de red; se reintentaran. */
  deferred: number;
}

let syncInFlight: Promise<SyncResult> | null = null;

/**
 * Sube las selfies pendientes y devuelve los payloads listos para el lote.
 *
 * Una marcacion offline se toma sin cobertura, asi que no hubo forma de pedir
 * la URL firmada en su momento: la foto quedo en disco y se sube ahora, justo
 * antes de enviar el lote.
 */
async function resolveSelfies(
  pending: Awaited<ReturnType<typeof listPending>>,
): Promise<{ ready: CreatePunchInput[]; deferred: number }> {
  const ready: CreatePunchInput[] = [];
  let deferred = 0;

  for (const item of pending) {
    if (!item.photoUri || item.payload.selfieObjectKey) {
      ready.push(item.payload);
      continue;
    }

    try {
      const objectKey = await uploadSelfie(item.photoUri, item.payload.punchType);
      await attachSelfieKey(item.clientPunchId, objectKey);
      // La foto ya vive en el bucket: liberar el espacio del dispositivo.
      await deleteAsync(item.photoUri, { idempotent: true }).catch(() => {});
      ready.push({ ...item.payload, selfieObjectKey: objectKey });
    } catch (error) {
      if (error instanceof NetworkError) {
        // Se cayo la red a mitad de la sincronizacion: se deja en cola tal cual.
        deferred++;
        continue;
      }
      // La foto se perdio o el bucket la rechazo. Se envia la marcacion sin
      // ella: que el servidor decida segun la politica de la empresa, en vez
      // de descartar en silencio un fichaje real.
      await markAttempt(item.clientPunchId, (error as Error).message);
      ready.push(item.payload);
    }
  }

  return { ready, deferred };
}

export async function syncPendingPunches(): Promise<SyncResult> {
  // Un solo lote en vuelo: NetInfo puede emitir varios eventos de reconexion
  // seguidos y no tiene sentido enviar el mismo lote tres veces.
  if (syncInFlight) return syncInFlight;

  syncInFlight = (async (): Promise<SyncResult> => {
    const empty: SyncResult = { synced: 0, duplicates: 0, rejected: 0, deferred: 0 };

    try {
      const pending = await listPending();
      if (pending.length === 0) return empty;

      const { ready, deferred } = await resolveSelfies(pending);
      if (ready.length === 0) return { ...empty, deferred };

      const response = await punchApi.batch(
        ready.map((punch) => ({ ...punch, source: PunchSource.MOBILE_OFFLINE })),
      );

      const settled: string[] = [];
      let rejected = 0;

      for (const result of response.results) {
        if (result.status === "created" || result.status === "duplicate") {
          settled.push(result.clientPunchId);
          continue;
        }
        // Rechazada por regla de negocio: reintentarla daria el mismo
        // resultado, asi que sale de la cola y se le muestra al empleado.
        const original = pending.find((p) => p.clientPunchId === result.clientPunchId);
        await recordRejection({
          clientPunchId: result.clientPunchId,
          punchType: original?.payload.punchType ?? "IN",
          occurredAt: original?.createdAt ?? Date.now(),
          errorCode: result.error?.code ?? "UNKNOWN",
          errorMessage: result.error?.message ?? "La marcacion fue rechazada",
        });
        settled.push(result.clientPunchId);
        rejected++;
      }

      await removePending(settled);

      return {
        synced: response.created,
        duplicates: response.duplicates,
        rejected,
        deferred,
      };
    } catch (error) {
      if (error instanceof NetworkError) {
        // Sigue sin haber red: la cola se queda intacta para el proximo intento.
        return empty;
      }
      if (error instanceof ApiError) {
        // 402 (el plan no incluye el lote offline) o 401. No se pierde nada:
        // la cola se conserva y se reintentara cuando cambie la situacion.
        console.warn("[sync] el servidor rechazo el lote", error.code, error.message);
        return empty;
      }
      console.error("[sync] fallo inesperado", error);
      return empty;
    } finally {
      syncInFlight = null;
    }
  })();

  return syncInFlight;
}
