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
import { AppState } from "react-native";
import { useAuth } from "../auth/AuthContext";
import {
  dismissRejections,
  enqueuePunch,
  listPending,
  listRejections,
  type QueuedPunch,
  type RejectedPunch,
} from "./queue";
import { syncPendingPunches, type SyncResult } from "./sync";

/** Cada cuanto se reintenta mientras queden marcaciones por enviar. */
const RETRY_INTERVAL_MS = 60_000;
/** Cuanto se muestra la confirmacion de "sincronizadas". */
const SYNCED_NOTICE_MS = 6_000;

/**
 * Estado de conectividad y de la cola offline, compartido por toda la app.
 *
 * Es lo que alimenta el indicador de "pendiente de sincronizacion" y lo que
 * decide si una marcacion se envia o se encola.
 */
interface OfflineContextValue {
  isOnline: boolean;
  /** Marcaciones guardadas en el dispositivo y aun no enviadas. */
  pending: QueuedPunch[];
  pendingCount: number;
  isSyncing: boolean;
  /** Enviadas en la ultima sincronizacion (para confirmarlo en pantalla). */
  justSynced: number;
  /** Por que siguen en cola, si el servidor lo explico. */
  blockedReason: string | null;
  rejections: RejectedPunch[];
  /** Guarda una marcacion en la cola local. */
  queuePunch: (payload: CreatePunchInput, photoUri: string | null) => Promise<void>;
  /** Fuerza un intento de sincronizacion. */
  sync: () => Promise<SyncResult | null>;
  dismiss: () => Promise<void>;
}

const OfflineContext = createContext<OfflineContextValue | null>(null);

export function OfflineProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [isOnline, setIsOnline] = useState(true);
  const [pending, setPending] = useState<QueuedPunch[]>([]);
  const [isSyncing, setIsSyncing] = useState(false);
  const [justSynced, setJustSynced] = useState(0);
  const [blockedReason, setBlockedReason] = useState<string | null>(null);
  const [rejections, setRejections] = useState<RejectedPunch[]>([]);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshQueueState = useCallback(async () => {
    if (!userId) {
      setPending([]);
      setRejections([]);
      return;
    }
    const [queued, rejected] = await Promise.all([listPending(userId), listRejections(userId)]);
    setPending(queued);
    setRejections(rejected);
  }, [userId]);

  const sync = useCallback(async () => {
    // Sin sesion no se envia nada: las filas son de un empleado concreto.
    if (!userId) return null;
    setIsSyncing(true);
    try {
      const result = await syncPendingPunches(userId);
      setBlockedReason(result.blockedReason);
      const sent = result.synced + result.duplicates;
      if (sent > 0) {
        setJustSynced(sent);
        if (noticeTimer.current) clearTimeout(noticeTimer.current);
        noticeTimer.current = setTimeout(() => setJustSynced(0), SYNCED_NOTICE_MS);
      }
      return result;
    } catch (error) {
      console.error("[sync] fallo inesperado", error);
      return null;
    } finally {
      await refreshQueueState();
      setIsSyncing(false);
    }
  }, [userId, refreshQueueState]);

  // Al abrir la app o iniciar sesion.
  useEffect(() => {
    void refreshQueueState().then(sync);
  }, [refreshQueueState, sync]);

  useEffect(() => {
    let wasOnline: boolean | null = null;
    const unsubscribeNet = NetInfo.addEventListener((state) => {
      // `isInternetReachable` puede ser null mientras se comprueba: se toma
      // como "hay red" para no marcar la app como offline en cada arranque.
      const online = Boolean(state.isConnected) && state.isInternetReachable !== false;
      setIsOnline(online);
      // Solo en la TRANSICION a con red: NetInfo emite eventos muy a menudo.
      if (online && wasOnline === false) void sync();
      wasOnline = online;
    });
    const appState = AppState.addEventListener("change", (status) => {
      if (status === "active") void sync();
    });
    return () => {
      unsubscribeNet();
      appState.remove();
    };
  }, [sync]);

  // Hay red pero el envio fallo (servidor caido, limite de peticiones).
  useEffect(() => {
    if (!isOnline || pending.length === 0) return;
    const timer = setInterval(() => void sync(), RETRY_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [isOnline, pending.length, sync]);

  const queuePunch = useCallback(
    async (payload: CreatePunchInput, photoUri: string | null) => {
      if (!userId) throw new Error("Inicia sesion para marcar");
      await enqueuePunch(userId, payload, photoUri);
      await refreshQueueState();
    },
    [userId, refreshQueueState],
  );

  const dismiss = useCallback(async () => {
    if (!userId) return;
    await dismissRejections(userId);
    await refreshQueueState();
  }, [userId, refreshQueueState]);

  const value = useMemo(
    () => ({
      isOnline,
      pending,
      pendingCount: pending.length,
      isSyncing,
      justSynced,
      blockedReason,
      rejections,
      queuePunch,
      sync,
      dismiss,
    }),
    [isOnline, pending, isSyncing, justSynced, blockedReason, rejections, queuePunch, sync, dismiss],
  );

  return <OfflineContext.Provider value={value}>{children}</OfflineContext.Provider>;
}

export function useOffline(): OfflineContextValue {
  const context = useContext(OfflineContext);
  if (!context) throw new Error("useOffline debe usarse dentro de OfflineProvider");
  return context;
}
