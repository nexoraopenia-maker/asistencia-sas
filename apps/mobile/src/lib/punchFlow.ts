import {
  VALID_PUNCH_TRANSITIONS,
  type DaySchedule,
  type PunchType,
  type WeeklySchedule,
} from "@scire/shared";
import { ApiError, NetworkError } from "./errors";

/**
 * Logica de la marcacion que no depende de APIs nativas.
 *
 * Vive aparte de los hooks a proposito: `usePunch` importa expo-camera,
 * expo-haptics y expo-location en el nivel de modulo, asi que no se puede
 * cargar fuera de un dispositivo. Estas dos funciones concentran las
 * decisiones que de verdad conviene cubrir con tests.
 */

/** Plazo en que una jornada abierta sigue esperando su salida (igual que la API). */
const OPEN_SHIFT_MS = 16 * 3_600_000;

export interface OfflineHints {
  /** Marcaciones en cola, de la mas antigua a la mas reciente. */
  pending?: readonly { punchType: PunchType; at: number }[];
  /** Momento de la copia del calendario, si no se pudo actualizar. */
  staleSince?: number | null;
  now?: number;
}

/**
 * Siguiente marcacion que corresponde segun lo ya registrado hoy.
 *
 * Usa la MISMA tabla de transiciones que valida el servidor. Compartir la
 * regla en `@scire/shared` es lo que evita que la app ofrezca un boton que el
 * backend vaya a rechazar.
 */
export function nextPunchType(
  day: DaySchedule | undefined,
  current?: WeeklySchedule["currentJornada"],
  offline: OfflineHints = {},
): PunchType | null {
  const now = offline.now ?? Date.now();
  const fresh = (at: number) => now - at <= OPEN_SHIFT_MS;
  const sameDay = (at: number) => new Date(at).toDateString() === new Date(now).toDateString();

  // 1. Lo guardado en el dispositivo es lo mas reciente que se ha hecho.
  const queued = offline.pending?.at(-1);
  if (queued) {
    if (queued.punchType === "OUT") return sameDay(queued.at) ? null : "IN";
    return fresh(queued.at) ? (VALID_PUNCH_TRANSITIONS[queued.punchType][0] ?? null) : "IN";
  }

  // 2. Copia guardada del calendario: solo vale mientras la jornada siga viva.
  const { staleSince } = offline;
  if (staleSince && !(current?.isOpen ? fresh(staleSince) : sameDay(staleSince))) return "IN";

  // 3. Manda el servidor: en turno noche la jornada abierta es la de ayer, y en
  // turno partido puede tocar una segunda entrada el mismo dia.
  if (current) return current.allowedPunches[0] ?? null;
  const last = day?.punches.at(-1)?.punchType ?? "NONE";
  return VALID_PUNCH_TRANSITIONS[last][0] ?? null;
}

/**
 * Traduce un error de la API al mensaje que lee el empleado.
 *
 * Se traduce por `code`, nunca por el texto del servidor: el codigo es parte
 * del contrato y el mensaje puede cambiar. Cuando el error trae contexto
 * accionable —los metros que faltan para entrar en la geocerca— se usa, porque
 * "acercate 340 m" resuelve el problema y "estas fuera del area" no.
 */
export function punchErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "OUTSIDE_GEOFENCE": {
        const distance = error.details?.distanceMeters as number | undefined;
        return distance
          ? `Estas a ${Math.round(distance)} m de tu sucursal. Acercate para poder marcar.`
          : error.message;
      }
      case "MOCK_LOCATION_DETECTED":
        return "Detectamos una app de ubicacion falsa. Desactivala para poder marcar.";
      case "DUPLICATE_PUNCH":
        return "Esta marcacion ya estaba registrada.";
      case "SELFIE_REQUIRED":
        return "Tu empresa exige una selfie para validar la marcacion.";
      case "SELFIE_NOT_UPLOADED":
        return "No pudimos guardar tu foto. Vuelve a tomarla.";
      case "USER_SUSPENDED":
        return "Tu cuenta no esta activa. Contacta con Recursos Humanos.";
      case "FEATURE_NOT_IN_PLAN":
        return "El modo sin conexion no esta incluido en el plan de tu empresa.";
      case "STORAGE_ERROR":
        // Es un problema del servidor, no del empleado: no tiene sentido
        // pedirle que repita la foto una y otra vez.
        return "No podemos guardar tu foto ahora mismo. Avisa a Recursos Humanos.";
      // INVALID_PUNCH_SEQUENCE ya llega con un mensaje concreto del servidor
      // ("tu ultima marcacion fue OUT"), mas util que cualquier texto generico.
      default:
        return error.message;
    }
  }
  if (error instanceof NetworkError) return "Sin conexion. La marcacion quedo en cola.";
  if (error instanceof Error) return error.message;
  return "No se pudo completar la marcacion";
}
