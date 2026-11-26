import type { CreatePunchInput } from "@scire/shared";
import * as SQLite from "expo-sqlite";

/**
 * Cola local de marcaciones pendientes.
 *
 * Se usa SQLite y no AsyncStorage porque esto es el nucleo del modo offline:
 * una marcacion perdida es una hora de trabajo que el empleado no cobra.
 * SQLite da escrituras atomicas y una clave primaria que impide duplicar la
 * misma marcacion si la app se cierra a mitad de encolado; AsyncStorage
 * obligaria a leer-modificar-escribir un JSON entero, con una ventana de
 * corrupcion en cada guardado.
 */

const DB_NAME = "scire-chronos.db";

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

interface PendingRow {
  clientPunchId: string;
  payload: string;
  photoUri: string | null;
  createdAt: number;
  attempts: number;
  lastError: string | null;
}

interface RejectedRow {
  clientPunchId: string;
  punchType: string;
  occurredAt: number;
  errorCode: string;
  errorMessage: string;
}

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

async function getDb(): Promise<SQLite.SQLiteDatabase> {
  dbPromise ??= (async () => {
    const db = await SQLite.openDatabaseAsync(DB_NAME);
    await db.execAsync(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS pending_punches (
        clientPunchId TEXT PRIMARY KEY NOT NULL,
        payload       TEXT NOT NULL,
        photoUri      TEXT,
        createdAt     INTEGER NOT NULL,
        attempts      INTEGER NOT NULL DEFAULT 0,
        lastError     TEXT
      );
      CREATE TABLE IF NOT EXISTS rejected_punches (
        clientPunchId TEXT PRIMARY KEY NOT NULL,
        punchType     TEXT NOT NULL,
        occurredAt    INTEGER NOT NULL,
        errorCode     TEXT NOT NULL,
        errorMessage  TEXT NOT NULL
      );
    `);
    return db;
  })();
  return dbPromise;
}

export async function enqueuePunch(
  payload: CreatePunchInput,
  photoUri: string | null,
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT OR REPLACE INTO pending_punches
       (clientPunchId, payload, photoUri, createdAt, attempts, lastError)
     VALUES (?, ?, ?, ?, 0, NULL)`,
    payload.clientPunchId,
    JSON.stringify(payload),
    photoUri,
    Date.now(),
  );
}

export async function listPending(): Promise<QueuedPunch[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<PendingRow>(
    `SELECT * FROM pending_punches ORDER BY createdAt ASC`,
  );
  return rows.map((row) => ({
    clientPunchId: row.clientPunchId,
    payload: JSON.parse(row.payload) as CreatePunchInput,
    photoUri: row.photoUri,
    createdAt: row.createdAt,
    attempts: row.attempts,
    lastError: row.lastError,
  }));
}

export async function countPending(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ total: number }>(
    `SELECT COUNT(*) AS total FROM pending_punches`,
  );
  return row?.total ?? 0;
}

/** Guarda la clave del objeto una vez subida la selfie, para no re-subirla. */
export async function attachSelfieKey(clientPunchId: string, objectKey: string): Promise<void> {
  const db = await getDb();
  const row = await db.getFirstAsync<PendingRow>(
    `SELECT * FROM pending_punches WHERE clientPunchId = ?`,
    clientPunchId,
  );
  if (!row) return;

  const payload = JSON.parse(row.payload) as CreatePunchInput;
  payload.selfieObjectKey = objectKey;

  await db.runAsync(
    `UPDATE pending_punches SET payload = ?, photoUri = NULL WHERE clientPunchId = ?`,
    JSON.stringify(payload),
    clientPunchId,
  );
}

export async function markAttempt(clientPunchId: string, error: string | null): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE pending_punches SET attempts = attempts + 1, lastError = ? WHERE clientPunchId = ?`,
    error,
    clientPunchId,
  );
}

export async function removePending(clientPunchIds: string[]): Promise<void> {
  if (clientPunchIds.length === 0) return;
  const db = await getDb();
  const placeholders = clientPunchIds.map(() => "?").join(",");
  await db.runAsync(
    `DELETE FROM pending_punches WHERE clientPunchId IN (${placeholders})`,
    ...clientPunchIds,
  );
}

/**
 * Una marcacion rechazada por el servidor (fuera de geocerca, secuencia rota)
 * nunca va a tener exito por reintentarla: sale de la cola y pasa aqui, para
 * que el empleado sepa que ocurrio en vez de verla desaparecer.
 */
export async function recordRejection(rejection: RejectedPunch): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT OR REPLACE INTO rejected_punches
       (clientPunchId, punchType, occurredAt, errorCode, errorMessage)
     VALUES (?, ?, ?, ?, ?)`,
    rejection.clientPunchId,
    rejection.punchType,
    rejection.occurredAt,
    rejection.errorCode,
    rejection.errorMessage,
  );
}

export async function listRejections(): Promise<RejectedPunch[]> {
  const db = await getDb();
  return db.getAllAsync<RejectedRow>(
    `SELECT * FROM rejected_punches ORDER BY occurredAt DESC LIMIT 20`,
  );
}

export async function dismissRejections(): Promise<void> {
  const db = await getDb();
  await db.runAsync(`DELETE FROM rejected_punches`);
}

/** Vacia todo. Se llama al cerrar sesion: la cola es de un empleado concreto. */
export async function clearQueue(): Promise<void> {
  const db = await getDb();
  await db.execAsync(`DELETE FROM pending_punches; DELETE FROM rejected_punches;`);
}
