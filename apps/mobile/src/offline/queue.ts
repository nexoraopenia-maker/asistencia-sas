import type { CreatePunchInput } from "@scire/shared";
import { copyAsync, documentDirectory, makeDirectoryAsync } from "expo-file-system/legacy";
import * as SQLite from "expo-sqlite";
import type { QueuedPunch, RejectedPunch } from "./syncCore";

export type { QueuedPunch, RejectedPunch } from "./syncCore";

/**
 * Cola local de marcaciones pendientes.
 *
 * Se usa SQLite y no AsyncStorage porque esto es el nucleo del modo offline:
 * una marcacion perdida es una hora de trabajo que el empleado no cobra.
 * SQLite da escrituras atomicas y una clave primaria que impide duplicar la
 * misma marcacion si la app se cierra a mitad de encolado; AsyncStorage
 * obligaria a leer-modificar-escribir un JSON entero, con una ventana de
 * corrupcion en cada guardado.
 *
 * Cada fila pertenece a un empleado (`userId`). La cola SOBREVIVE al cierre de
 * sesion y a la caducidad del token: solo su dueno puede verla y enviarla.
 */

const DB_NAME = "scire-chronos.db";

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
      CREATE TABLE IF NOT EXISTS kv (
        key   TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );
    `);
    // Instalaciones previas: las tablas existian sin dueno.
    for (const table of ["pending_punches", "rejected_punches"]) {
      const columns = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`);
      if (!columns.some((c) => c.name === "userId")) {
        await db.execAsync(`ALTER TABLE ${table} ADD COLUMN userId TEXT`);
      }
    }
    return db;
  })();
  return dbPromise;
}

/**
 * La camara deja la foto en la cache, que el sistema puede vaciar cuando
 * quiera: se copia a documentos, que persiste hasta que la app la borre.
 */
async function persistPhoto(clientPunchId: string, photoUri: string): Promise<string> {
  try {
    const dir = `${documentDirectory}punch-photos/`;
    await makeDirectoryAsync(dir, { intermediates: true });
    const target = `${dir}${clientPunchId}.jpg`;
    await copyAsync({ from: photoUri, to: target });
    return target;
  } catch {
    // Mejor encolar con la ruta temporal que perder la marcacion.
    return photoUri;
  }
}

export async function enqueuePunch(
  userId: string,
  payload: CreatePunchInput,
  photoUri: string | null,
): Promise<void> {
  const db = await getDb();
  const storedPhoto = photoUri ? await persistPhoto(payload.clientPunchId, photoUri) : null;
  await db.runAsync(
    `INSERT OR REPLACE INTO pending_punches
       (clientPunchId, payload, photoUri, createdAt, attempts, lastError, userId)
     VALUES (?, ?, ?, ?, 0, NULL, ?)`,
    payload.clientPunchId,
    JSON.stringify(payload),
    storedPhoto,
    Date.now(),
    userId,
  );
}

/** Filas sin dueno (version anterior) se atribuyen a quien este conectado. */
const OWNED = "(userId = ? OR userId IS NULL)";

export async function listPending(userId: string): Promise<QueuedPunch[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<PendingRow>(
    `SELECT * FROM pending_punches WHERE ${OWNED} ORDER BY createdAt ASC`,
    userId,
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
    `UPDATE pending_punches SET payload = ? WHERE clientPunchId = ?`,
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
export async function recordRejection(userId: string, rejection: RejectedPunch): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT OR REPLACE INTO rejected_punches
       (clientPunchId, punchType, occurredAt, errorCode, errorMessage, userId)
     VALUES (?, ?, ?, ?, ?, ?)`,
    rejection.clientPunchId,
    rejection.punchType,
    rejection.occurredAt,
    rejection.errorCode,
    rejection.errorMessage,
    userId,
  );
}

export async function listRejections(userId: string): Promise<RejectedPunch[]> {
  const db = await getDb();
  return db.getAllAsync<RejectedRow>(
    `SELECT * FROM rejected_punches WHERE ${OWNED} ORDER BY occurredAt DESC LIMIT 20`,
    userId,
  );
}

export async function dismissRejections(userId: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(`DELETE FROM rejected_punches WHERE ${OWNED}`, userId);
}

/** Cache local (calendario) para que la app funcione al abrirse sin red. */
export async function writeCache(key: string, value: unknown): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)`,
    key,
    JSON.stringify(value),
  );
}

export async function readCache<T>(key: string): Promise<T | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(`SELECT value FROM kv WHERE key = ?`, key);
  return row ? (JSON.parse(row.value) as T) : null;
}
