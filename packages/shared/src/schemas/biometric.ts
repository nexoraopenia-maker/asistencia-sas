import { z } from "zod";
import { PunchType } from "../enums.js";
import { idSchema } from "./common.js";

/**
 * Integracion con relojes biometricos.
 *
 * Un reloj (ZKTeco, Hikvision, Suprema, Anviz...) o el conector que lee su log
 * envia, por cada marcacion, QUIEN marco (codigo de empleado / DNI), CUANDO y
 * DONDE. El tipo (entrada, salida, refrigerio) es opcional: muchos equipos no
 * lo distinguen y el servidor lo deduce de la secuencia del dia.
 */

/** `2026-03-02 08:01:33`, `2026-03-02T08:01` — hora de pared del reloj, sin zona. */
const LOCAL_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2})?$/;

/**
 * Instante de la marcacion.
 *
 * Admite ISO 8601 con zona (`2026-03-02T08:01:33-05:00`, `...Z`) o la hora
 * LOCAL tal como la guarda el reloj; en ese caso se interpreta en la zona de
 * la sucursal (o de la empresa si la sucursal no tiene una propia).
 */
export const biometricTimestampSchema = z
  .string()
  .trim()
  .refine(
    (value) =>
      LOCAL_TIMESTAMP.test(value) || z.string().datetime({ offset: true }).safeParse(value).success,
    "Usa ISO 8601 (2026-03-02T08:01:33-05:00) o la hora local del reloj (2026-03-02 08:01:33)",
  );

/** Si el instante viene sin zona, devuelve fecha y hora locales para convertirlo. */
export function parseLocalTimestamp(value: string): { date: string; time: string } | null {
  const match = LOCAL_TIMESTAMP.exec(value.trim());
  if (!match) return null;
  return { date: match[1]!, time: `${match[2]}${match[3] ?? ":00"}` };
}

/**
 * Codigos de estado de los relojes ZKTeco (y compatibles: la mayoria de marcas
 * chinas copia la convencion). Las horas extra se tratan como entrada/salida.
 */
export const DEVICE_STATE_TO_PUNCH: Record<number, PunchType> = {
  0: PunchType.IN, // Check-In
  1: PunchType.OUT, // Check-Out
  2: PunchType.LUNCH_START, // Break-Out
  3: PunchType.LUNCH_END, // Break-In
  4: PunchType.IN, // OT-In
  5: PunchType.OUT, // OT-Out
};

export const BIOMETRIC_VERIFY_MODES = [
  "FINGERPRINT",
  "FACE",
  "CARD",
  "PASSWORD",
  "PALM",
  "OTHER",
] as const;

export const biometricPunchSchema = z.object({
  /** Codigo de empleado o DNI. Debe coincidir EXACTAMENTE con `User.employeeCode`. */
  employeeCode: z.string().trim().min(1).max(32),
  timestamp: biometricTimestampSchema,
  /** Tipo explicito. Es una pista: si rompe la secuencia del dia, se deduce. */
  punchType: z.nativeEnum(PunchType).optional(),
  /** Alternativa a `punchType`: codigo de estado crudo del reloj (0-5, ZKTeco). */
  deviceState: z.coerce.number().int().min(0).max(5).optional(),
  /** Sucursal. Obligatoria si el dispositivo no tiene una sucursal asignada. */
  branchId: idSchema.optional(),
  /** Id del registro en el log del reloj. Solo trazabilidad, no idempotencia. */
  deviceLogId: z.string().trim().max(64).optional(),
  verifyMode: z.enum(BIOMETRIC_VERIFY_MODES).optional(),
});
export type BiometricPunchInput = z.infer<typeof biometricPunchSchema>;

export const biometricImportSchema = z.object({
  punches: z
    .array(biometricPunchSchema)
    .min(1, "El lote no puede estar vacio")
    .max(500, "Maximo 500 marcaciones por lote"),
});
export type BiometricImportInput = z.infer<typeof biometricImportSchema>;

export interface BiometricImportItemResult {
  /** Posicion en el lote enviado, para conciliar sin depender del orden. */
  index: number;
  employeeCode: string;
  timestamp: string;
  /**
   * - `created`   registrada.
   * - `duplicate` ya existia (reenvio, doble lectura del dedo, o la misma
   *   marcacion llego por otra via). Para el reloj es un exito.
   * - `rejected`  no se registro; ver `error`.
   */
  status: "created" | "duplicate" | "rejected";
  recordId?: string;
  punchType?: PunchType;
  /** Instante normalizado a UTC. */
  serverTimestamp?: string;
  error?: { code: string; message: string };
}

export interface BiometricImportResponse {
  results: BiometricImportItemResult[];
  created: number;
  duplicates: number;
  rejected: number;
}

export const createBiometricDeviceSchema = z.object({
  name: z.string().trim().min(2).max(80),
  serialNumber: z.string().trim().max(64).optional(),
  /** Sucursal por defecto de las marcaciones del equipo. */
  branchId: idSchema.optional(),
});
export type CreateBiometricDeviceInput = z.infer<typeof createBiometricDeviceSchema>;
