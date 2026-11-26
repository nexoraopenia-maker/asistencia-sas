/**
 * Geolocalizacion y validacion de geocercas.
 *
 * Vive en `@scire/shared` a proposito: la app movil usa las mismas funciones
 * para dar feedback inmediato ("estas a 340 m de la sucursal") y el backend
 * las reusa como fuente de verdad. El cliente nunca decide si esta dentro:
 * solo informa; la validacion vinculante es siempre la del servidor.
 */

/** Radio medio terrestre en metros (WGS-84). */
const EARTH_RADIUS_M = 6_371_008.8;

export interface Coordinates {
  readonly latitude: number;
  readonly longitude: number;
}

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/**
 * Distancia en metros entre dos puntos por la formula de Haversine.
 *
 * Asume una esfera perfecta. El error frente a un elipsoide (Vincenty) es
 * <0.5 %, irrelevante para radios de geocerca de 50-500 m.
 */
export function haversineDistanceMeters(from: Coordinates, to: Coordinates): number {
  const dLat = toRadians(to.latitude - from.latitude);
  const dLon = toRadians(to.longitude - from.longitude);
  const lat1 = toRadians(from.latitude);
  const lat2 = toRadians(to.latitude);

  const a =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);

  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

export interface GeofenceCheckInput {
  /** Posicion reportada por el dispositivo. */
  readonly point: Coordinates;
  /** Centro de la geocerca (sucursal). */
  readonly center: Coordinates;
  /** Radio autorizado de la sucursal, en metros. */
  readonly radiusMeters: number;
  /**
   * Precision del GPS reportada por el dispositivo, en metros.
   * Se suma al radio: un empleado en el borde con GPS de +-30 m no debe
   * ser rechazado por un error del sensor.
   */
  readonly accuracyMeters?: number | null;
  /** Tolerancia extra configurada a nivel de plataforma (GEOFENCE_ACCURACY_BUFFER_M). */
  readonly bufferMeters?: number;
  /** Techo del margen que puede aportar `accuracyMeters`, para que un GPS
   * deliberadamente impreciso no anule la geocerca. */
  readonly maxAccuracyAllowanceMeters?: number;
}

export interface GeofenceCheckResult {
  readonly isInside: boolean;
  /** Distancia real al centro, en metros (redondeada a 1 decimal). */
  readonly distanceMeters: number;
  /** Radio efectivo aplicado tras sumar margenes. */
  readonly effectiveRadiusMeters: number;
  /** Metros fuera del radio efectivo. 0 si esta dentro. */
  readonly overshootMeters: number;
}

const DEFAULT_MAX_ACCURACY_ALLOWANCE_M = 100;

/**
 * Comprueba si un punto cae dentro de la geocerca de una sucursal.
 *
 * El radio efectivo es `radius + buffer + min(accuracy, maxAllowance)`. El tope
 * sobre `accuracy` es lo que impide el ataque trivial de reportar una precision
 * de 5 000 m para que cualquier posicion quede "dentro".
 */
export function checkGeofence(input: GeofenceCheckInput): GeofenceCheckResult {
  const {
    point,
    center,
    radiusMeters,
    accuracyMeters,
    bufferMeters = 0,
    maxAccuracyAllowanceMeters = DEFAULT_MAX_ACCURACY_ALLOWANCE_M,
  } = input;

  const distance = haversineDistanceMeters(point, center);
  const accuracyAllowance = Math.min(
    Math.max(accuracyMeters ?? 0, 0),
    maxAccuracyAllowanceMeters,
  );
  const effectiveRadius = radiusMeters + bufferMeters + accuracyAllowance;

  return {
    isInside: distance <= effectiveRadius,
    distanceMeters: Math.round(distance * 10) / 10,
    effectiveRadiusMeters: Math.round(effectiveRadius * 10) / 10,
    overshootMeters: Math.max(0, Math.round((distance - effectiveRadius) * 10) / 10),
  };
}

export function isValidLatitude(value: number): boolean {
  return Number.isFinite(value) && value >= -90 && value <= 90;
}

export function isValidLongitude(value: number): boolean {
  return Number.isFinite(value) && value >= -180 && value <= 180;
}
