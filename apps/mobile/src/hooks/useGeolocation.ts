import * as Location from "expo-location";
import { useCallback, useState } from "react";

/**
 * Lectura de la posicion para una marcacion.
 *
 * Siempre se pide una lectura FRESCA (`getCurrentPositionAsync`) y nunca la
 * ultima conocida: una posicion cacheada de hace una hora podria situar al
 * empleado dentro de la geocerca desde su casa.
 */

export interface PunchLocation {
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
  altitudeMeters: number | null;
  /** Android expone `mocked` cuando la posicion viene de una app de GPS falso. */
  isMockLocation: boolean;
}

export class LocationDeniedError extends Error {
  constructor() {
    super("Necesitamos tu ubicacion para confirmar que marcas desde tu sucursal");
    this.name = "LocationDeniedError";
  }
}

export function useGeolocation() {
  const [isLocating, setIsLocating] = useState(false);

  const getLocation = useCallback(async (): Promise<PunchLocation> => {
    setIsLocating(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== Location.PermissionStatus.GRANTED) {
        throw new LocationDeniedError();
      }

      const position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });

      return {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracyMeters: position.coords.accuracy ?? null,
        altitudeMeters: position.coords.altitude ?? null,
        // El flag lo reporta el sistema operativo. Es una senal, no una prueba:
        // el servidor decide si rechaza la marcacion o la guarda como
        // sospechosa. El cliente se limita a informar con honestidad.
        isMockLocation: Boolean((position as { mocked?: boolean }).mocked),
      };
    } finally {
      setIsLocating(false);
    }
  }, []);

  return { getLocation, isLocating };
}
