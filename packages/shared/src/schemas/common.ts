import { z } from "zod";
import { DATE_PATTERN, TIME_PATTERN } from "../time.js";

/** Identificador cuid2 generado por Prisma. */
export const idSchema = z.string().min(1).max(64);

export const emailSchema = z.string().trim().toLowerCase().email("Email invalido").max(255);

/** E.164 — el formato que exige Evolution API / WhatsApp. */
export const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{7,14}$/, "El telefono debe estar en formato E.164 (ej. +51987654321)");

export const timeStringSchema = z
  .string()
  .regex(TIME_PATTERN, "La hora debe tener formato HH:mm:ss");

export const dateStringSchema = z
  .string()
  .regex(DATE_PATTERN, "La fecha debe tener formato YYYY-MM-DD");

export const latitudeSchema = z.number().min(-90).max(90);
export const longitudeSchema = z.number().min(-180).max(180);

export const coordinatesSchema = z.object({
  latitude: latitudeSchema,
  longitude: longitudeSchema,
});

/**
 * Contrasena: 10 caracteres minimo con mezcla de tipos.
 * Se prioriza longitud sobre reglas barrocas — es lo que de verdad resiste.
 */
export const passwordSchema = z
  .string()
  .min(10, "La contrasena debe tener al menos 10 caracteres")
  .max(128)
  .regex(/[a-z]/, "Debe incluir al menos una minuscula")
  .regex(/[A-Z]/, "Debe incluir al menos una mayuscula")
  .regex(/\d/, "Debe incluir al menos un numero");

/** Zona horaria IANA. Se valida contra el runtime, no contra una lista estatica. */
export const timezoneSchema = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, "Zona horaria IANA invalida (ej. America/Lima)");

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type Pagination = z.infer<typeof paginationSchema>;

export const dateRangeSchema = z
  .object({
    from: dateStringSchema,
    to: dateStringSchema,
  })
  .refine((r) => r.from <= r.to, {
    message: "La fecha inicial no puede ser posterior a la final",
    path: ["from"],
  });
export type DateRange = z.infer<typeof dateRangeSchema>;

/** Envoltorio estandar de todas las respuestas de la API. */
export interface ApiSuccess<T> {
  success: true;
  data: T;
}

export interface ApiFailure {
  success: false;
  error: {
    code: string;
    message: string;
    /**
     * Contexto estructurado del error, pensado para que el cliente PUEDA ACTUAR
     * sin analizar el mensaje:
     *
     * - VALIDATION_ERROR   -> `{ [campo]: string[] }` con los errores por campo
     * - OUTSIDE_GEOFENCE   -> `{ distanceMeters, radiusMeters }` para decir al
     *                         empleado cuanto tiene que acercarse
     * - DUPLICATE_PUNCH    -> `{ recordId }` para que la cola offline concilie
     * - FEATURE_NOT_IN_PLAN-> `{ feature, tier }` para ofrecer el upgrade
     */
    details?: Record<string, unknown>;
  };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export interface PaginatedResult<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}
