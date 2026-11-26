import { getSystemClient } from "@scire/database";
import { isStorageConfigured, loadConfig } from "../config.js";
import { deleteObjects } from "../lib/storage.js";

/**
 * Politica de retencion de datos biometricos.
 *
 * Cumple el principio de limitacion del plazo de conservacion (GDPR art. 5.1.e
 * y equivalentes en las leyes de proteccion de datos de LATAM): una selfie de
 * marcacion es un dato biometrico y no puede guardarse indefinidamente "por si
 * acaso".
 *
 * **Lo que se borra es la IMAGEN, nunca el registro.** La marcacion —hora,
 * ubicacion, tipo, resultado de la verificacion— y su rastro de auditoria se
 * conservan intactos: son documentacion laboral con plazos de conservacion
 * propios, mucho mas largos, y destruirlos dejaria a la empresa sin prueba de
 * las horas trabajadas.
 *
 * `selfiePurgedAt` distingue "nunca tuvo foto" de "la tuvo y se depuro": sin
 * ese campo, una auditoria no podria diferenciar una marcacion sin verificar
 * de una depurada conforme a la ley.
 */

const system = getSystemClient();

export interface PurgeResult {
  companiesReviewed: number;
  /** Marcaciones cuyo archivo se elimino. */
  purged: number;
  /** Archivos borrados del almacenamiento. */
  objectsDeleted: number;
  errors: number;
}

/** Resta meses a una fecha conservando el dia cuando es posible. */
function monthsAgo(months: number, from = new Date()): Date {
  const cutoff = new Date(from);
  cutoff.setMonth(cutoff.getMonth() - months);
  return cutoff;
}

export interface PurgeOptions {
  /** Limita el barrido a una empresa. Util para una solicitud de borrado. */
  companyId?: string;
  /** Tope de marcaciones por ejecucion. Evita barridos de horas. */
  batchSize?: number;
  /**
   * No borra nada: solo informa de cuanto se borraria.
   * Es lo primero que se ejecuta al activar la politica en una empresa.
   */
  dryRun?: boolean;
}

/**
 * Depura las selfies que han superado el plazo de conservacion.
 *
 * Recorre empresa por empresa porque el plazo es configurable por empresa: un
 * unico corte global aplicaria el plazo equivocado a casi todas.
 */
export async function purgeExpiredBiometrics(options: PurgeOptions = {}): Promise<PurgeResult> {
  const { companyId, batchSize = 500, dryRun = false } = options;
  const result: PurgeResult = {
    companiesReviewed: 0,
    purged: 0,
    objectsDeleted: 0,
    errors: 0,
  };

  const companies = await system.company.findMany({
    where: companyId ? { id: companyId } : {},
    select: { id: true, name: true, dataRetentionMonths: true },
  });

  const storageReady = isStorageConfigured(loadConfig());

  for (const company of companies) {
    result.companiesReviewed++;
    const cutoff = monthsAgo(company.dataRetentionMonths);

    const expired = await system.attendanceRecord.findMany({
      where: {
        companyId: company.id,
        selfieObjectKey: { not: null },
        selfiePurgedAt: null,
        serverTimestamp: { lt: cutoff },
      },
      select: { id: true, selfieObjectKey: true },
      take: batchSize,
    });

    if (expired.length === 0) continue;
    if (dryRun) {
      result.purged += expired.length;
      continue;
    }

    const keys = expired.map((record) => record.selfieObjectKey!).filter(Boolean);

    // Primero el archivo, despues la fila. Si el orden fuera el inverso y el
    // borrado en S3 fallara, la clave se habria perdido y el objeto quedaria
    // huerfano en el bucket para siempre: un dato biometrico sin dueno ni
    // forma de encontrarlo.
    let deletedKeys: string[] = keys;
    if (storageReady) {
      try {
        deletedKeys = await deleteObjects(keys);
      } catch (error) {
        console.error("[retention] fallo el borrado en el almacenamiento", {
          company: company.name,
          error,
        });
        result.errors++;
        continue;
      }
    } else {
      // Sin almacenamiento configurado (desarrollo, CI) se desvincula igual:
      // el objetivo de cumplimiento es que la referencia deje de existir.
      console.warn("[retention] almacenamiento no configurado: solo se desvincula la referencia");
    }

    result.objectsDeleted += deletedKeys.length;

    const purgedIds = expired
      .filter((record) => deletedKeys.includes(record.selfieObjectKey!))
      .map((record) => record.id);

    if (purgedIds.length > 0) {
      await system.attendanceRecord.updateMany({
        where: { id: { in: purgedIds } },
        data: { selfieObjectKey: null, selfiePurgedAt: new Date() },
      });
      result.purged += purgedIds.length;
    }

    console.log(
      `[retention] ${company.name}: ${purgedIds.length} selfies depuradas (plazo ${company.dataRetentionMonths} meses)`,
    );
  }

  return result;
}

/**
 * Borra las selfies de un colaborador concreto.
 *
 * Atiende una solicitud de supresion (derecho al olvido). Se conserva el
 * registro de asistencia: es documentacion laboral obligatoria y su base
 * juridica no es el consentimiento, sino el cumplimiento de una obligacion
 * legal del empleador — no decae con la solicitud del interesado.
 */
export async function purgeUserBiometrics(userId: string): Promise<PurgeResult> {
  const records = await system.attendanceRecord.findMany({
    where: { userId, selfieObjectKey: { not: null }, selfiePurgedAt: null },
    select: { id: true, selfieObjectKey: true },
  });

  const result: PurgeResult = {
    companiesReviewed: 1,
    purged: 0,
    objectsDeleted: 0,
    errors: 0,
  };
  if (records.length === 0) return result;

  const keys = records.map((record) => record.selfieObjectKey!);
  let deletedKeys = keys;

  if (isStorageConfigured(loadConfig())) {
    try {
      deletedKeys = await deleteObjects(keys);
    } catch (error) {
      console.error("[retention] fallo el borrado del colaborador", { userId, error });
      result.errors++;
      return result;
    }
  }

  // Tambien la foto de perfil: es el patron biometrico de referencia.
  const user = await system.user.findUnique({
    where: { id: userId },
    select: { profilePhotoKey: true },
  });
  if (user?.profilePhotoKey && isStorageConfigured(loadConfig())) {
    await deleteObjects([user.profilePhotoKey]).catch(() => []);
  }

  await system.$transaction([
    system.attendanceRecord.updateMany({
      where: { id: { in: records.map((record) => record.id) } },
      data: { selfieObjectKey: null, selfiePurgedAt: new Date() },
    }),
    system.user.update({ where: { id: userId }, data: { profilePhotoKey: null } }),
  ]);

  result.purged = records.length;
  result.objectsDeleted = deletedKeys.length;
  return result;
}

/** Resumen de lo que hay pendiente de depurar. Alimenta el panel de cumplimiento. */
export async function getRetentionStatus(companyId: string) {
  const company = await system.company.findUniqueOrThrow({
    where: { id: companyId },
    select: { dataRetentionMonths: true },
  });
  const cutoff = monthsAgo(company.dataRetentionMonths);

  const [stored, expired, purged] = await Promise.all([
    system.attendanceRecord.count({
      where: { companyId, selfieObjectKey: { not: null } },
    }),
    system.attendanceRecord.count({
      where: {
        companyId,
        selfieObjectKey: { not: null },
        selfiePurgedAt: null,
        serverTimestamp: { lt: cutoff },
      },
    }),
    system.attendanceRecord.count({ where: { companyId, selfiePurgedAt: { not: null } } }),
  ]);

  return {
    retentionMonths: company.dataRetentionMonths,
    cutoffDate: cutoff.toISOString(),
    selfiesStored: stored,
    pendingPurge: expired,
    alreadyPurged: purged,
  };
}

/** Arranca el barrido periodico. Devuelve la funcion para detenerlo. */
export function startRetentionScheduler(): () => void {
  const intervalMs = loadConfig().RETENTION_INTERVAL_HOURS * 3_600_000;
  let running = false;

  const timer = setInterval(() => {
    if (running) return;
    running = true;
    purgeExpiredBiometrics()
      .then((result) => {
        if (result.purged > 0) console.log("[retention] barrido completado", result);
      })
      .catch((error) => console.error("[retention] fallo el barrido", error))
      .finally(() => {
        running = false;
      });
  }, intervalMs);

  timer.unref();
  return () => clearInterval(timer);
}
