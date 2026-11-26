import { PunchSource, type BatchPunchResponse, type CreatePunchInput } from "@scire/shared";
import { ApiError, NetworkError } from "../lib/errors";

/**
 * Logica de sincronizacion de la cola offline, sin dependencias nativas para
 * poder probarla. Las reglas que protegen una marcacion real:
 *
 * 1. Un fallo transitorio (sin red, 5xx, 429) NUNCA saca nada de la cola.
 * 2. Se envia en orden: si una se queda atras, las posteriores tambien, o el
 *    servidor rechazaria una salida cuya entrada aun no recibio.
 * 3. Solo un rechazo definitivo del servidor retira una marcacion, y queda
 *    visible para el empleado.
 */

export interface QueuedPunch {
  clientPunchId: string;
  payload: CreatePunchInput;
  /** URI local de la selfie, si aun no se ha podido subir al bucket. */
  photoUri: string | null;
  createdAt: number;
  attempts: number;
  lastError: string | null;
}

export interface RejectedPunch {
  clientPunchId: string;
  punchType: string;
  occurredAt: number;
  errorCode: string;
  errorMessage: string;
}

export interface SyncResult {
  synced: number;
  duplicates: number;
  rejected: number;
  /** Siguen en cola; se reintentaran. */
  deferred: number;
  /** Motivo por el que quedaron en cola, si el servidor lo explico. */
  blockedReason: string | null;
}

export interface SyncDeps {
  listPending: () => Promise<QueuedPunch[]>;
  uploadSelfie: (photoUri: string, punchType: string) => Promise<string>;
  attachSelfieKey: (clientPunchId: string, objectKey: string) => Promise<void>;
  sendBatch: (punches: CreatePunchInput[]) => Promise<BatchPunchResponse>;
  /** Retira de la cola y borra la foto local. */
  settle: (items: QueuedPunch[]) => Promise<void>;
  recordRejection: (rejection: RejectedPunch) => Promise<void>;
  markAttempt: (clientPunchId: string, error: string) => Promise<void>;
}

/** Tamano maximo de lote que acepta la API. */
export const BATCH_SIZE = 100;

/** Codigos por elemento que merecen reintento. */
const RETRYABLE_CODES = new Set(["INTERNAL_ERROR", "STORAGE_ERROR", "RATE_LIMITED"]);

/** Errores que pueden resolverse solos: la marcacion debe esperar, no perderse. */
export function isTransient(error: unknown): boolean {
  if (error instanceof NetworkError) return true;
  return error instanceof ApiError && (error.status >= 500 || error.status === 429 || error.status === 408);
}

export async function runSync(deps: SyncDeps): Promise<SyncResult> {
  const result: SyncResult = { synced: 0, duplicates: 0, rejected: 0, deferred: 0, blockedReason: null };
  const pending = [...(await deps.listPending())].sort((a, b) =>
    a.payload.deviceTimestamp.localeCompare(b.payload.deviceTimestamp),
  );
  if (pending.length === 0) return result;

  // --- Selfies ---------------------------------------------------------------
  const ready: { item: QueuedPunch; payload: CreatePunchInput }[] = [];
  for (const item of pending) {
    if (!item.photoUri || item.payload.selfieObjectKey) {
      ready.push({ item, payload: item.payload });
      continue;
    }
    try {
      const objectKey = await deps.uploadSelfie(item.photoUri, item.payload.punchType);
      await deps.attachSelfieKey(item.clientPunchId, objectKey);
      ready.push({ item, payload: { ...item.payload, selfieObjectKey: objectKey } });
    } catch (error) {
      const message = error instanceof Error ? error.message : "No se pudo subir la foto";
      await deps.markAttempt(item.clientPunchId, message);
      if (isTransient(error) || (error instanceof ApiError && error.status === 401)) {
        result.blockedReason = message;
        break;
      }
      // La foto se perdio o fue rechazada definitivamente: se envia sin ella y
      // el servidor decide segun la politica de la empresa.
      ready.push({ item, payload: item.payload });
    }
  }

  // --- Lotes -----------------------------------------------------------------
  let settledCount = 0;
  for (let start = 0; start < ready.length; start += BATCH_SIZE) {
    const chunk = ready.slice(start, start + BATCH_SIZE);
    let response: BatchPunchResponse;
    try {
      response = await deps.sendBatch(
        chunk.map(({ payload }) => ({ ...payload, source: PunchSource.MOBILE_OFFLINE })),
      );
    } catch (error) {
      // Plan sin modo offline, sesion caducada, sin red... la cola se conserva.
      result.blockedReason = error instanceof Error ? error.message : "No se pudo sincronizar";
      break;
    }

    result.synced += response.created;
    result.duplicates += response.duplicates;

    const settled: QueuedPunch[] = [];
    // El servidor procesa en orden cronologico: tras un fallo transitorio, los
    // rechazos posteriores son consecuencia suya y tambien se reintentan.
    let retrying = false;
    const byId = new Map(response.results.map((r) => [r.clientPunchId, r]));
    for (const { item } of chunk) {
      const outcome = byId.get(item.clientPunchId);
      if (!outcome) continue;
      if (outcome.status !== "rejected") {
        settled.push(item);
        continue;
      }
      const code = outcome.error?.code ?? "UNKNOWN";
      if (retrying || RETRYABLE_CODES.has(code)) {
        retrying = true;
        result.blockedReason = outcome.error?.message ?? code;
        await deps.markAttempt(item.clientPunchId, result.blockedReason);
        continue;
      }
      await deps.recordRejection({
        clientPunchId: item.clientPunchId,
        punchType: item.payload.punchType,
        occurredAt: Date.parse(item.payload.deviceTimestamp),
        errorCode: code,
        errorMessage: outcome.error?.message ?? "La marcacion fue rechazada",
      });
      result.rejected++;
      settled.push(item);
    }

    await deps.settle(settled);
    settledCount += settled.length;
    if (retrying) break;
  }

  result.deferred = pending.length - settledCount;
  return result;
}
