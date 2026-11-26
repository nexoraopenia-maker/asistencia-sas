import { formatDuration, toZonedDateString } from "@scire/shared";
import { LinearGradient } from "expo-linear-gradient";
import { TrendingUp } from "lucide-react-native";
import { RefreshControl, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useWeeklySchedule } from "../../src/hooks/useWeeklySchedule";
import { BRAND_GRADIENT, colors, STATUS_STYLES } from "../../src/lib/theme";

/**
 * Resumen de la semana.
 *
 * Las barras se dibujan con Views y no con una libreria de graficos: son
 * proporciones simples sobre un maximo conocido y anadir una dependencia de
 * charting a la app movil por esto seria pagar peso de bundle sin ganar nada.
 */
export default function ReportesScreen() {
  const insets = useSafeAreaInsets();
  const { schedule, isLoading, reload } = useWeeklySchedule();

  const totals = schedule?.totals;
  const maxMinutes = Math.max(
    ...(schedule?.days.map((day) => day.workedMinutes) ?? [0]),
    // Suelo de una jornada de 8 h: sin el, un dia de 20 min dibujaria una
    // barra a tope y daria una impresion falsa de jornada completa.
    480,
  );

  const compliance =
    totals && totals.scheduledMinutes > 0
      ? Math.min(100, Math.round((totals.workedMinutes / totals.scheduledMinutes) * 100))
      : 0;

  return (
    <LinearGradient colors={[...BRAND_GRADIENT]} style={{ flex: 1 }}>
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + 12,
          paddingBottom: 32,
          paddingHorizontal: 20,
          gap: 16,
        }}
        refreshControl={
          <RefreshControl refreshing={isLoading} onRefresh={reload} tintColor={colors.teal} />
        }
      >
        <View>
          <Text className="text-2xl font-bold text-white">Reportes</Text>
          <Text className="mt-1 text-sm text-slate-400">
            Semana del {schedule?.weekStart ?? "—"} al {schedule?.weekEnd ?? "—"}
          </Text>
        </View>

        <View className="flex-row gap-3">
          <View className="flex-1 rounded-3xl border border-white/10 bg-white/5 p-5">
            <Text className="text-[11px] uppercase tracking-wide text-slate-500">Trabajado</Text>
            <Text className="mt-1 text-2xl font-bold tabular-nums text-teal">
              {formatDuration((totals?.workedMinutes ?? 0) * 60)}
            </Text>
            <Text className="mt-1 text-xs text-slate-500">
              de {formatDuration((totals?.scheduledMinutes ?? 0) * 60)} programadas
            </Text>
          </View>

          <View className="flex-1 rounded-3xl border border-white/10 bg-white/5 p-5">
            <Text className="text-[11px] uppercase tracking-wide text-slate-500">Cumplimiento</Text>
            <View className="mt-1 flex-row items-baseline">
              <Text className="text-2xl font-bold tabular-nums text-white">{compliance}</Text>
              <Text className="ml-0.5 text-base text-slate-400">%</Text>
            </View>
            <View className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
              <View
                className="h-full rounded-full"
                style={{
                  width: `${compliance}%`,
                  backgroundColor: compliance >= 90 ? colors.emerald : colors.amber,
                }}
              />
            </View>
          </View>
        </View>

        <View className="flex-row gap-3">
          <View className="flex-1 rounded-2xl border border-white/10 bg-white/5 p-4">
            <Text className="text-[11px] uppercase tracking-wide text-slate-500">Refrigerio</Text>
            <Text className="mt-1 text-base font-bold tabular-nums text-white">
              {formatDuration((totals?.lunchMinutes ?? 0) * 60)}
            </Text>
          </View>
          <View className="flex-1 rounded-2xl border border-white/10 bg-white/5 p-4">
            <Text className="text-[11px] uppercase tracking-wide text-slate-500">Tardanza</Text>
            <Text
              className={`mt-1 text-base font-bold tabular-nums ${
                (totals?.tardinessMinutes ?? 0) > 0 ? "text-amber-400" : "text-white"
              }`}
            >
              {totals?.tardinessMinutes ?? 0} min
            </Text>
          </View>
          <View className="flex-1 rounded-2xl border border-white/10 bg-white/5 p-4">
            <Text className="text-[11px] uppercase tracking-wide text-slate-500">Extras</Text>
            <Text className="mt-1 text-base font-bold tabular-nums text-white">
              {formatDuration((totals?.overtimeMinutes ?? 0) * 60)}
            </Text>
          </View>
        </View>

        <View className="rounded-3xl border border-white/10 bg-white/5 p-5">
          <View className="flex-row items-center">
            <TrendingUp size={16} color={colors.teal} />
            <Text className="ml-2 text-sm font-bold text-white">Horas por dia</Text>
          </View>

          <View className="mt-5 flex-row items-end justify-between" style={{ height: 120 }}>
            {(schedule?.days ?? []).map((day) => {
              const heightPct = Math.round((day.workedMinutes / maxMinutes) * 100);
              const status = STATUS_STYLES[day.status];
              return (
                <View key={day.date} className="flex-1 items-center">
                  <View className="w-full flex-1 justify-end px-1">
                    <View
                      className="w-full rounded-t-lg"
                      style={{
                        // Minimo de 3 px para que un dia sin horas siga
                        // dibujando su base y la fila no se vea rota.
                        height: `${Math.max(heightPct, 3)}%`,
                        backgroundColor: day.workedMinutes > 0 ? colors.teal : "rgba(255,255,255,0.08)",
                        opacity: day.isToday ? 1 : 0.75,
                      }}
                    />
                  </View>
                  <Text className="mt-2 text-[10px] font-semibold uppercase text-slate-500">
                    {day.weekdayLabel}
                  </Text>
                  <View
                    className="mt-1 h-1 w-1 rounded-full"
                    style={{ backgroundColor: status.dot }}
                  />
                </View>
              );
            })}
          </View>
        </View>

        <Text className="text-center text-xs text-slate-600">
          La exportacion de nomina en PDF y Excel se genera desde el panel web de RRHH
        </Text>
      </ScrollView>
    </LinearGradient>
  );
}
