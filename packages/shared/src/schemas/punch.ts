import { z } from "zod";
import { PunchSource, PunchType, VerificationStatus } from "../enums.js";
import { idSchema, latitudeSchema, longitudeSchema } from "./common.js";

const punchTypeSchema = z.nativeEnum(PunchType);

/** Paso 1 del flujo: pedir una URL firmada PUT para subir la selfie directo a S3/R2. */
export const presignedUrlRequestSchema = z.object({
  punchType: punchTypeSchema,
  contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  /** Tamano declarado en bytes. Se firma en la politica para acotar el objeto. */
  contentLength: z
    .number()
    .int()
    .positive()
    .max(8 * 1024 * 1024, "La selfie no puede superar 8 MB"),
});
export type PresignedUrlRequest = z.infer<typeof presignedUrlRequestSchema>;

export interface PresignedUrlResponse {
  /** URL PUT de un solo uso y vida corta. */
  uploadUrl: string;
  /** Clave del objeto en el bucket. Es lo que se guarda en la fila, nunca la URL. */
  objectKey: string;
  /** Instante ISO en que caduca `uploadUrl`. */
  expiresAt: string;
  /** Cabeceras obligatorias en el PUT para que la firma valide. */
  requiredHeaders: Record<string, string>;
}

/**
 * Telemetria de posicion del dispositivo.
 *
 * `isMockLocation` lo reporta el propio dispositivo (Android expone
 * `isFromMockProvider`). Es una senal, no una prueba: se registra siempre y el
 * servidor decide si rechaza o marca como SUSPICIOUS segun REJECT_MOCK_LOCATION.
 */
export const locationPayloadSchema = z.object({
  latitude: latitudeSchema,
  longitude: longitudeSchema,
  /** Precision horizontal en metros que reporta el GPS. */
  accuracyMeters: z.number().nonnegative().max(10_000).nullable().optional(),
  altitudeMeters: z.number().nullable().optional(),
  isMockLocation: z.boolean().default(false),
});
export type LocationPayload = z.infer<typeof locationPayloadSchema>;

/** Paso 2 del flujo: confirmar la marcacion una vez subida la selfie. */
export const createPunchSchema = z.object({
  punchType: punchTypeSchema,
  branchId: idSchema,
  location: locationPayloadSchema,
  /**
   * Reloj del dispositivo en el instante de marcar (ISO 8601 con offset).
   * Se guarda tal cual junto al timestamp del servidor: el servidor es la
   * fuente de verdad legal, el del dispositivo permite auditar offline y
   * detectar manipulacion del reloj.
   */
  deviceTimestamp: z.string().datetime({ offset: true }),
  /** Clave devuelta por /punch/presigned-url. Ausente si la empresa no exige selfie. */
  selfieObjectKey: z.string().max(512).optional(),
  source: z.nativeEnum(PunchSource).default(PunchSource.MOBILE),
  /**
   * UUID generado por el cliente. Hace la marcacion idempotente: un reintento
   * por timeout de red no puede duplicar el registro.
   */
  clientPunchId: z.string().uuid(),
  notes: z.string().max(500).optional(),
});
export type CreatePunchInput = z.infer<typeof createPunchSchema>;

/**
 * Sincronizacion de la cola offline.
 *
 * El lote se procesa por elementos: una marcacion invalida no tumba las demas.
 * La respuesta informa del resultado de cada `clientPunchId` para que el
 * dispositivo pueda vaciar solo lo confirmado.
 */
export const batchPunchSchema = z.object({
  punches: z
    .array(createPunchSchema)
    .min(1, "El lote no puede estar vacio")
    .max(100, "Maximo 100 marcaciones por lote"),
});
export type BatchPunchInput = z.infer<typeof batchPunchSchema>;

export interface BatchPunchItemResult {
  clientPunchId: string;
  status: "created" | "duplicate" | "rejected";
  recordId?: string;
  error?: { code: string; message: string };
}

export interface BatchPunchResponse {
  results: BatchPunchItemResult[];
  created: number;
  duplicates: number;
  rejected: number;
}

export interface PunchResult {
  recordId: string;
  punchType: PunchType;
  /** Instante autoritativo, en UTC. */
  serverTimestamp: string;
  deviceTimestamp: string;
  /** Segundos de desfase entre el reloj del dispositivo y el del servidor. */
  clockSkewSeconds: number;
  verificationStatus: VerificationStatus;
  geofence: {
    isInside: boolean;
    distanceMeters: number;
    branchName: string;
  };
  isMockLocation: boolean;
  faceMatchScore: number | null;
  /** Minutos de tardanza ya descontada la tolerancia de la empresa. */
  tardinessMinutes: number;
}

/** Correccion manual de RRHH. Cada uso genera una entrada en AuditLog. */
export const adjustPunchSchema = z.object({
  recordId: idSchema,
  serverTimestamp: z.string().datetime({ offset: true }).optional(),
  punchType: punchTypeSchema.optional(),
  verificationStatus: z.nativeEnum(VerificationStatus).optional(),
  /** Obligatorio: es la justificacion que queda en el registro de auditoria. */
  reason: z.string().trim().min(10, "Explica el motivo del ajuste (minimo 10 caracteres)").max(500),
});
export type AdjustPunchInput = z.infer<typeof adjustPunchSchema>;

export const voidPunchSchema = z.object({
  recordId: idSchema,
  reason: z.string().trim().min(10).max(500),
});
export type VoidPunchInput = z.infer<typeof voidPunchSchema>;
