import { toZonedDateString, type WeeklySchedule } from "@scire/shared";
import { useCallback, useEffect, useState } from "react";
import { NetworkError } from "../api/client";
import { shiftsApi } from "../api/endpoints";
import { useAuth } from "../auth/AuthContext";
import { readCache, writeCache } from "../offline/queue";

interface CachedSchedule {
  schedule: WeeklySchedule;
  fetchedAt: number;
}

/**
 * Calendario semanal del empleado.
 *
 * Alimenta a la vez la tira de dias y el detalle del turno. La ultima respuesta
 * se guarda en el dispositivo para que la app sirva al abrirse sin red.
 */
export function useWeeklySchedule(weekOf?: string) {
  const { user } = useAuth();
  const anchor = weekOf ?? toZonedDateString(new Date(), "America/Lima");
  const cacheKey = `schedule:${user?.id}:${weekOf ?? "current"}`;
  const [data, setData] = useState<CachedSchedule | null>(null);
  const [isStale, setIsStale] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const fresh = { schedule: await shiftsApi.week(anchor), fetchedAt: Date.now() };
      setData(fresh);
      setIsStale(false);
      await writeCache(cacheKey, fresh);
    } catch (cause) {
      const cached = await readCache<CachedSchedule>(cacheKey);
      if (cached) setData(cached);
      setIsStale(true);
      setError(
        cause instanceof NetworkError
          ? "Sin conexion. Mostrando la ultima informacion disponible."
          : "No pudimos cargar tu calendario",
      );
    } finally {
      setIsLoading(false);
    }
  }, [anchor, cacheKey]);

  useEffect(() => {
    void load();
  }, [load]);

  return {
    schedule: data?.schedule ?? null,
    /** Momento de la copia, solo si no se pudo actualizar. */
    staleSince: isStale && data ? data.fetchedAt : null,
    isLoading,
    error,
    reload: load,
  };
}
