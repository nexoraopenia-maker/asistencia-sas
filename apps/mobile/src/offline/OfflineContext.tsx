import NetInfo from "@react-native-community/netinfo";
import type { CreatePunchInput } from "@scire/shared";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { countPending, enqueuePunch, listRejections, type RejectedPunch } from "./queue";
import { syncPendingPunches, type SyncResult } from "./sync";

/**
 * Estado de conectividad y de la cola offline, compartido por toda la app.
 *
 * Es lo que alimenta el indicador de "pendiente de sincronizacion" y lo que
 * decide si una marcacion se envia o se encola.
 */
interface OfflineContextValue {
  isOnline: boolean;
  pendingCount: number;
  isSyncing: boolean;
  rejections: RejectedPunch[];
  /** Guarda una marcacion en la cola local. */
  queuePunch: (payload: CreatePunchInput, photoUri: string | null) => Promise<void>;
  /** Fuerza un intento de sincronizacion (pull-to-refresh, boton manual). */
  sync: () => Promise<SyncResult | null>;
  refreshQueueState: () => Promise<void>;
}

const OfflineContext = createContext<OfflineContextValue | null>(null);

export function OfflineProvider({ children }: { children: ReactNode }) {
  const [isOnline, setIsOnline] = useState(true);
  const [pendingCount, setPendingCount] = useState(0);
  const [isSyncing, setIsSyncing] = useState(false);
  const [rejections, setRejections] = useState<RejectedPunch[]>([]);
  const wasOffline = useRef(false);

  const refreshQueueState = useCallback(async () => {
    const [count, rejected] = await Promise.all([countPending(), listRejections()]);
    setPendingCount(count);
    setRejections(rejected);
  }, []);

  const sync = useCallback(async () => {
    setIsSyncing(true);
    try {
      const result = await syncPendingPunches();
      await refreshQueueState();
      return result;
    } finally {
      setIsSyncing(false);
    }
  }, [refreshQueueState]);

  useEffect(() => {
    void refreshQueueState();

    const unsubscribe = NetInfo.addEventListener((state) => {
      // `isInternetReachable` puede ser null mientras se comprueba: se toma
      // como "hay red" para no marcar la app como offline en cada arranque.
      const online = Boolean(state.isConnected) && state.isInternetReachable !== false;
      setIsOnline(online);

      // Solo se sincroniza en la TRANSICION de sin red a con red. NetInfo
      // emite eventos con frecuencia (cambio de wifi a datos, cambio de
      // intensidad) y disparar un lote en cada uno seria ruido.
      if (online && wasOffline.current) {
        void sync();
      }
      wasOffline.current = !online;
    });

    return unsubscribe;
  }, [refreshQueueState, sync]);

  const queuePunch = useCallback(
    async (payload: CreatePunchInput, photoUri: string | null) => {
      await enqueuePunch(payload, photoUri);
      await refreshQueueState();
    },
    [refreshQueueState],
  );

  const value = useMemo(
    () => ({ isOnline, pendingCount, isSyncing, rejections, queuePunch, sync, refreshQueueState }),
    [isOnline, pendingCount, isSyncing, rejections, queuePunch, sync, refreshQueueState],
  );

  return <OfflineContext.Provider value={value}>{children}</OfflineContext.Provider>;
}

export function useOffline(): OfflineContextValue {
  const context = useContext(OfflineContext);
  if (!context) throw new Error("useOffline debe usarse dentro de OfflineProvider");
  return context;
}
