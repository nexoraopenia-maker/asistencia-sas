import { VALID_PUNCH_TRANSITIONS, type DaySchedule, type PunchType } from "@scire/shared";
import { ApiError, NetworkError } from "./errors";

/**
 * Logica de la marcacion que no depende de APIs nativas.
 *
 * Vive aparte de los hooks a proposito: `usePunch` importa expo-camera,
 * expo-haptics y expo-location en el nivel de modulo, asi que no se puede
 * cargar fuera de un dispositivo. Estas dos funciones concentran las
 * decisiones que de verdad conviene cubrir con tests.
 */

/**
 * Siguiente marcacion que corresponde segun lo ya registrado hoy.
 *
 * Usa la MISMA tabla de transiciones que valida el servidor. Compartir la
 * regla en `@scire/shared` es lo que evita que la app ofrezca un boton que el
 * backend vaya a rechazar.
 */
export function nextPunchType(day: DaySchedule | undefined): PunchType | null {
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
