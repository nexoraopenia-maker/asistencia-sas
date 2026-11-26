import { toZonedDateString, type WeeklySchedule } from "@scire/shared";
import { useCallback, useEffect, useState } from "react";
import { NetworkError } from "../api/client";
import { shiftsApi } from "../api/endpoints";

/**
 * Calendario semanal del empleado.
 *
 * Alimenta a la vez la tira de dias y el detalle del turno, por lo que una
 * sola peticion cubre toda la pantalla de inicio.
 */
export function useWeeklySchedule(weekOf?: string) {
  const anchor = weekOf ?? toZonedDateString(new Date(), "America/Lima");
  const [schedule, setSchedule] = useState<WeeklySchedule | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      setSchedule(await shiftsApi.week(anchor));
    } catch (cause) {
      setError(
        cause instanceof NetworkError
          ? "Sin conexion. Mostrando la ultima informacion disponible."
          : "No pudimos cargar tu calendario",
      );
    } finally {
      setIsLoading(false);
    }
  }, [anchor]);

  useEffect(() => {
    void load();
  }, [load]);

  return { schedule, isLoading, error, reload: load };
}
