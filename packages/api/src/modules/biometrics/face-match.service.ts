import { CompareFacesCommand, RekognitionClient } from "@aws-sdk/client-rekognition";
import { getSystemClient } from "@scire/database";
import {
  Feature,
  VerificationStatus,
  hasFeature,
  type SubscriptionTier,
} from "@scire/shared";
import { loadConfig } from "../../config.js";

/**
 * Verificacion facial de la selfie de marcacion.
 *
 * Compara la foto tomada al fichar contra la foto de perfil oficial del
 * empleado. Ambas viven en S3/R2 y **nunca salen del bucket**: Rekognition
 * recibe referencias `S3Object`, no los bytes, asi que la imagen no viaja por
 * la API ni se carga en memoria del servidor.
 *
 * Corre SIEMPRE en segundo plano, nunca dentro del request de marcacion. Una
 * llamada a Rekognition tarda entre 300 ms y 2 s; meter eso en el camino
 * caliente convertiria el fichaje de la manana en una cola. La marcacion queda
 * `PENDING` y el trabajador la resuelve en segundos.
 */

export interface FaceMatchOutcome {
  /** Similitud 0-100. `null` si no se pudo comparar. */
  score: number | null;
  status: VerificationStatus;
  /** Motivo legible cuando no hay puntuacion. */
  reason?: string;
}

export interface FaceMatchInput {
  selfieKey: string;
  profileKey: string;
  /** Umbral por debajo del cual la marcacion se marca como sospechosa. */
  minScore: number;
}

/** Contrato del comparador. Permite sustituir el proveedor sin tocar el resto. */
export interface FaceComparator {
  readonly id: string;
  compare(input: FaceMatchInput): Promise<FaceMatchOutcome>;
}

// -----------------------------------------------------------------------------
// AWS Rekognition
// -----------------------------------------------------------------------------

let rekognition: RekognitionClient | null = null;

function getRekognition(): RekognitionClient {
  const config = loadConfig();
  rekognition ??= new RekognitionClient({
    region: config.AWS_REKOGNITION_REGION,
    credentials: {
      accessKeyId: config.AWS_ACCESS_KEY_ID!,
      secretAccessKey: config.AWS_SECRET_ACCESS_KEY!,
    },
  });
  return rekognition;
}

export const rekognitionComparator: FaceComparator = {
  id: "aws-rekognition",

  async compare({ selfieKey, profileKey, minScore }) {
    const config = loadConfig();

    try {
      const response = await getRekognition().send(
        new CompareFacesCommand({
          SourceImage: { S3Object: { Bucket: config.S3_BUCKET, Name: profileKey } },
          TargetImage: { S3Object: { Bucket: config.S3_BUCKET, Name: selfieKey } },
          // Umbral de la API al ras: se pide TODA coincidencia y la decision de
          // aceptar o no se toma aqui, con el umbral de la empresa. Delegarlo
          // en AWS haria que un cambio de politica exigiera redesplegar.
          SimilarityThreshold: 0,
          QualityFilter: "AUTO",
        }),
      );

      const best = response.FaceMatches?.[0]?.Similarity;

      if (best === undefined) {
        // Rekognition encontro caras pero ninguna coincide, o la selfie no
        // tiene cara reconocible. Ambos casos exigen revision humana.
        const hadFaces = (response.UnmatchedFaces?.length ?? 0) > 0;
        return {
          score: hadFaces ? 0 : null,
          status: VerificationStatus.REJECTED,
          reason: hadFaces
            ? "El rostro de la selfie no coincide con la foto de perfil"
            : "No se detecto un rostro utilizable en la selfie",
        };
      }

      const score = Math.round(best * 100) / 100;
      return {
        score,
        status: score >= minScore ? VerificationStatus.VERIFIED : VerificationStatus.SUSPICIOUS,
      };
    } catch (error) {
      // Un fallo del proveedor NO puede invalidar una marcacion legitima: se
      // deja PENDING para que un reintento posterior la resuelva.
      const message = error instanceof Error ? error.message : String(error);
      console.error("[face-match] Rekognition fallo", message);
      return { score: null, status: VerificationStatus.PENDING, reason: message };
    }
  },
};

// -----------------------------------------------------------------------------
// Comparador local (desarrollo y tests)
// -----------------------------------------------------------------------------

/**
 * Sustituto determinista de Rekognition.
 *
 * NO reconoce caras: deriva una puntuacion estable de las claves de los dos
 * objetos. Sirve para ejercitar el flujo completo —cola, umbral, estados,
 * auditoria— sin credenciales de AWS ni coste por llamada.
 *
 * Es determinista a proposito: un valor aleatorio haria que un mismo caso
 * pasara unas veces y fallara otras, y un test asi no prueba nada.
 *
 * ⚠️ Nunca debe usarse en produccion. El arranque avisa si el face-match esta
 * activo sin credenciales de AWS.
 */
export const localComparator: FaceComparator = {
  id: "local-stub",

  async compare({ selfieKey, profileKey, minScore }) {
    // Convencion para los tests: una clave que contiene "nomatch" simula un
    // desajuste facial, y "noface" una selfie sin rostro utilizable.
    if (selfieKey.includes("noface")) {
      return {
        score: null,
        status: VerificationStatus.REJECTED,
        reason: "No se detecto un rostro utilizable en la selfie",
      };
    }

    const score = selfieKey.includes("nomatch")
      ? 42.5
      : // Puntuacion alta y estable derivada de ambas claves.
        90 + (hashKeys(selfieKey, profileKey) % 1000) / 100;

    const rounded = Math.round(score * 100) / 100;
    return {
      score: rounded,
      status: rounded >= minScore ? VerificationStatus.VERIFIED : VerificationStatus.SUSPICIOUS,
    };
  },
};

function hashKeys(a: string, b: string): number {
  let hash = 0x811c9dc5;
  for (const char of `${a}|${b}`) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * Comparador activo.
 *
 * Sin credenciales de AWS cae al sustituto local: exigirlas en desarrollo
 * obligaria a cada persona del equipo a tener una cuenta de AWS para poder
 * ejecutar los tests.
 */
export function getComparator(): FaceComparator {
  const config = loadConfig();
  const hasAws = Boolean(config.AWS_ACCESS_KEY_ID && config.AWS_SECRET_ACCESS_KEY);
  return hasAws && config.FACE_MATCH_ENABLED ? rekognitionComparator : localComparator;
}

// -----------------------------------------------------------------------------
// Procesamiento
// -----------------------------------------------------------------------------

const system = getSystemClient();

export interface ProcessResult {
  processed: number;
  verified: number;
  suspicious: number;
  rejected: number;
  skipped: number;
}

/**
 * Verifica una marcacion concreta.
 *
 * Devuelve el resultado sin escribirlo si el registro no es apto (sin selfie,
 * sin foto de perfil, empresa sin la funcionalidad). Nunca elimina ni trunca
 * el registro: una marcacion rechazada por face-match sigue siendo una
 * marcacion con valor legal, solo que marcada para revision.
 */
export async function verifyRecord(recordId: string): Promise<FaceMatchOutcome> {
  const record = await system.attendanceRecord.findUnique({
    where: { id: recordId },
    select: {
      id: true,
      selfieObjectKey: true,
      isVoided: true,
      user: { select: { profilePhotoKey: true } },
      company: {
        select: { tier: true, faceMatchEnabled: true, faceMatchMinScore: true },
      },
    },
  });

  if (!record || record.isVoided) {
    return { score: null, status: VerificationStatus.PENDING, reason: "Marcacion no encontrada" };
  }

  const { company } = record;

  // Feature gating: exclusivo de ENTERPRISE.
  if (!hasFeature(company.tier as SubscriptionTier, Feature.FACE_MATCH) || !company.faceMatchEnabled) {
    return {
      score: null,
      status: VerificationStatus.VERIFIED,
      reason: "La verificacion facial no esta habilitada para esta empresa",
    };
  }

  if (!record.selfieObjectKey) {
    return { score: null, status: VerificationStatus.VERIFIED, reason: "Marcacion sin selfie" };
  }

  if (!record.user.profilePhotoKey) {
    // Sin patron de referencia no hay nada que comparar. Se marca como
    // sospechosa —no como rechazada— porque el problema es administrativo:
    // falta subir la foto oficial, no hay indicio de fraude.
    const outcome: FaceMatchOutcome = {
      score: null,
      status: VerificationStatus.SUSPICIOUS,
      reason: "El colaborador no tiene foto de perfil oficial para comparar",
    };
    await persist(recordId, outcome);
    return outcome;
  }

  const outcome = await getComparator().compare({
    selfieKey: record.selfieObjectKey,
    profileKey: record.user.profilePhotoKey,
    minScore: company.faceMatchMinScore,
  });

  await persist(recordId, outcome);
  return outcome;
}

async function persist(recordId: string, outcome: FaceMatchOutcome): Promise<void> {
  // Una marcacion PENDING se deja intacta salvo por la marca de intento: el
  // proveedor fallo y hay que reintentar, no dar por buena ni por mala.
  if (outcome.status === VerificationStatus.PENDING) return;

  await system.attendanceRecord.update({
    where: { id: recordId },
    data: {
      faceMatchScore: outcome.score,
      faceMatchedAt: new Date(),
      verificationStatus: outcome.status,
      ...(outcome.reason ? { notes: outcome.reason } : {}),
    },
  });
}

/**
 * Procesa las marcaciones pendientes de verificacion.
 *
 * Solo mira empresas ENTERPRISE con la funcion activa: recorrer todas las
 * marcaciones del sistema para descartarlas por plan seria trabajo tirado.
 */
export async function processPendingVerifications(limit = 50): Promise<ProcessResult> {
  const result: ProcessResult = {
    processed: 0,
    verified: 0,
    suspicious: 0,
    rejected: 0,
    skipped: 0,
  };

  const pending = await system.attendanceRecord.findMany({
    where: {
      verificationStatus: VerificationStatus.PENDING,
      isVoided: false,
      selfieObjectKey: { not: null },
      faceMatchedAt: null,
      company: { faceMatchEnabled: true, tier: "ENTERPRISE" },
    },
    select: { id: true },
    orderBy: { serverTimestamp: "asc" },
    take: limit,
  });

  for (const { id } of pending) {
    const outcome = await verifyRecord(id);
    result.processed++;
    if (outcome.status === VerificationStatus.VERIFIED) result.verified++;
    else if (outcome.status === VerificationStatus.SUSPICIOUS) result.suspicious++;
    else if (outcome.status === VerificationStatus.REJECTED) result.rejected++;
    else result.skipped++;
  }

  return result;
}

/** Arranca el trabajador. Devuelve la funcion para detenerlo. */
export function startFaceMatchWorker(): () => void {
  const intervalMs = loadConfig().FACE_MATCH_INTERVAL_SECONDS * 1_000;
  let running = false;

  const timer = setInterval(() => {
    if (running) return;
    running = true;
    processPendingVerifications()
      .then((result) => {
        if (result.processed > 0) console.log("[face-match] verificaciones procesadas", result);
      })
      .catch((error) => console.error("[face-match] fallo el trabajador", error))
      .finally(() => {
        running = false;
      });
  }, intervalMs);

  timer.unref();
  return () => clearInterval(timer);
}

/** Solo para tests: descarta el cliente memorizado de Rekognition. */
export function resetRekognitionClient(): void {
  rekognition = null;
}
