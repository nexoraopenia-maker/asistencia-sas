import { CloudOff, RefreshCw, TriangleAlert } from "lucide-react-native";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useOffline } from "../offline/OfflineContext";
import { colors } from "../lib/theme";

/**
 * Estado de la cola offline.
 *
 * Solo aparece cuando hay algo que contar —sin red, con marcaciones en cola o
 * con rechazos que revisar—. Un indicador permanente de "todo bien" es ruido
 * que la gente deja de mirar justo cuando importa.
 */
export function SyncIndicator() {
  const { isOnline, pendingCount, isSyncing, rejections, sync } = useOffline();

  if (isOnline && pendingCount === 0 && rejections.length === 0) return null;

  if (rejections.length > 0) {
    return (
      <View className="flex-row items-center rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3">
        <TriangleAlert size={16} color={colors.rose} />
        <Text className="ml-2 flex-1 text-sm text-rose-300">
          {rejections.length === 1
            ? "1 marcacion no pudo registrarse"
            : `${rejections.length} marcaciones no pudieron registrarse`}
        </Text>
      </View>
    );
  }

  const label = !isOnline
    ? pendingCount > 0
      ? `Sin conexion · ${pendingCount} pendiente${pendingCount === 1 ? "" : "s"} de sincronizar`
      : "Sin conexion · tus marcaciones se guardaran en el dispositivo"
    : `${pendingCount} marcacion${pendingCount === 1 ? "" : "es"} pendiente${pendingCount === 1 ? "" : "s"} de sincronizar`;

  return (
    <Pressable
      onPress={isOnline && !isSyncing ? () => void sync() : undefined}
      accessibilityRole={isOnline ? "button" : "text"}
      accessibilityLabel={label}
      className="flex-row items-center rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3"
    >
      {isSyncing ? (
        <ActivityIndicator size="small" color={colors.amber} />
      ) : isOnline ? (
        <RefreshCw size={16} color={colors.amber} />
      ) : (
        <CloudOff size={16} color={colors.amber} />
      )}
      <Text className="ml-2 flex-1 text-sm text-amber-300">
        {isSyncing ? "Sincronizando marcaciones..." : label}
      </Text>
      {isOnline && !isSyncing && pendingCount > 0 && (
        <Text className="text-xs font-semibold text-amber-400">Reintentar</Text>
      )}
    </Pressable>
  );
}
