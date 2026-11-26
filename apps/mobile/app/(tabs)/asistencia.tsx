import { LinearGradient } from "expo-linear-gradient";
import { Check, Clock, MapPinOff, TriangleAlert } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, FlatList, RefreshControl, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { NetworkError } from "../../src/api/client";
import { punchApi } from "../../src/api/endpoints";
import { SyncIndicator } from "../../src/components/SyncIndicator";
import { useOffline } from "../../src/offline/OfflineContext";
import { BRAND_GRADIENT, colors } from "../../src/lib/theme";

type HistoryItem = Awaited<ReturnType<typeof punchApi.history>>["items"][number];

const PUNCH_LABELS: Record<string, string> = {
  IN: "Entrada",
  LUNCH_START: "Inicio de refrigerio",
  LUNCH_END: "Fin de refrigerio",
  OUT: "Salida",
};

function PunchRow({ item }: { item: HistoryItem }) {
  const at = new Date(item.serverTimestamp);
  const date = new Intl.DateTimeFormat("es-PE", {
    timeZone: "America/Lima",
    day: "2-digit",
    month: "short",
  }).format(at);
  const time = new Intl.DateTimeFormat("es-PE", {
    timeZone: "America/Lima",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(at);

  const outsideGeofence = item.isWithinGeofence === false;
  const hasAlert = item.isMockLocation || outsideGeofence;

  return (
    <View className="mb-2 flex-row items-center rounded-2xl border border-white/10 bg-white/5 p-4">
      <View
        className={`h-10 w-10 items-center justify-center rounded-2xl ${
          hasAlert ? "bg-amber-500/15" : "bg-emerald-500/15"
        }`}
      >
        {item.isMockLocation ? (
          <TriangleAlert size={17} color={colors.amber} />
        ) : outsideGeofence ? (
          <MapPinOff size={17} color={colors.amber} />
        ) : (
          <Check size={17} color={colors.emerald} />
        )}
      </View>

      <View className="ml-3 flex-1">
        <Text className="text-sm font-semibold text-white">
          {PUNCH_LABELS[item.punchType] ?? item.punchType}
        </Text>
        <Text className="mt-0.5 text-xs text-slate-500">
          {date} · {item.branch.name}
          {item.source === "MOBILE_OFFLINE" ? " · Sincronizada sin conexion" : ""}
        </Text>
        {item.isMockLocation && (
          <Text className="mt-1 text-xs text-amber-400">Ubicacion simulada detectada</Text>
        )}
        {!item.isMockLocation && outsideGeofence && (
          <Text className="mt-1 text-xs text-amber-400">Fuera del area de la sucursal</Text>
        )}
      </View>

      <View className="items-end">
        <Text className="text-base font-bold tabular-nums text-white">{time}</Text>
        {item.tardinessMinutes > 0 && (
          <Text className="text-xs text-amber-400">+{item.tardinessMinutes} min</Text>
        )}
      </View>
    </View>
  );
}

export default function AsistenciaScreen() {
  const insets = useSafeAreaInsets();
  const { pending } = useOffline();
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      setError(null);
      const response = await punchApi.history({ pageSize: 50 });
      setItems(response.items);
    } catch (cause) {
      setError(
        cause instanceof NetworkError
          ? "Sin conexion. No pudimos cargar tu historial."
          : "No pudimos cargar tu historial",
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Se recarga al vaciarse la cola: las enviadas pasan al historial.
  useEffect(() => {
    void load();
  }, [load, pending.length]);

  return (
    <LinearGradient colors={[...BRAND_GRADIENT]} style={{ flex: 1 }}>
      <View style={{ paddingTop: insets.top + 12 }} className="px-5 pb-3">
        <Text className="text-2xl font-bold text-white">Asistencia</Text>
        <Text className="mt-1 text-sm text-slate-400">Tus marcaciones registradas</Text>
      </View>

      <View className="px-5">
        <SyncIndicator />
      </View>

      {pending.length > 0 && (
        <View className="px-5 pt-3">
          {pending.map((item) => (
            <View
              key={item.clientPunchId}
              className="mb-2 flex-row items-center rounded-2xl border border-amber-500/20 bg-amber-500/10 p-4"
            >
              <Clock size={17} color={colors.amber} />
              <View className="ml-3 flex-1">
                <Text className="text-sm font-semibold text-white">
                  {PUNCH_LABELS[item.payload.punchType]}
                </Text>
                <Text className="mt-0.5 text-xs text-amber-400">Pendiente de sincronizar</Text>
              </View>
              <Text className="text-base font-bold tabular-nums text-white">
                {new Date(item.payload.deviceTimestamp).toLocaleTimeString("es-PE")}
              </Text>
            </View>
          ))}
        </View>
      )}

      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <PunchRow item={item} />}
        contentContainerStyle={{ padding: 20, paddingTop: 12, paddingBottom: 24 }}
        refreshControl={
          <RefreshControl refreshing={isLoading} onRefresh={load} tintColor={colors.teal} />
        }
        ListEmptyComponent={
          isLoading ? (
            <View className="items-center py-16">
              <ActivityIndicator color={colors.teal} />
            </View>
          ) : (
            <View className="items-center rounded-3xl border border-white/10 bg-white/5 px-6 py-12">
              <Clock size={30} color={colors.slate[500]} />
              <Text className="mt-4 text-center text-base font-semibold text-slate-300">
                {error ?? "Aun no tienes marcaciones"}
              </Text>
              {!error && (
                <Text className="mt-1 text-center text-sm text-slate-500">
                  Tus fichajes apareceran aqui en cuanto marques por primera vez
                </Text>
              )}
            </View>
          )
        }
      />
    </LinearGradient>
  );
}
