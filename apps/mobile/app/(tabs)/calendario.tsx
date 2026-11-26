import { formatDuration, toZonedDateString, weekDaysFrom } from "@scire/shared";
import { LinearGradient } from "expo-linear-gradient";
import { ChevronLeft, ChevronRight } from "lucide-react-native";
import { useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ShiftDetailModal } from "../../src/components/ShiftDetailModal";
import { useWeeklySchedule } from "../../src/hooks/useWeeklySchedule";
import { BRAND_GRADIENT, colors, STATUS_STYLES } from "../../src/lib/theme";

/** Suma o resta semanas a una fecha `YYYY-MM-DD`. */
function shiftWeek(date: string, weeks: number): string {
  const anchor = new Date(`${date}T12:00:00.000Z`);
  anchor.setUTCDate(anchor.getUTCDate() + weeks * 7);
  return anchor.toISOString().slice(0, 10);
}

export default function CalendarioScreen() {
  const insets = useSafeAreaInsets();
  const [weekOf, setWeekOf] = useState(toZonedDateString(new Date(), "America/Lima"));
  const { schedule, isLoading, reload } = useWeeklySchedule(weekOf);
  const [detailDate, setDetailDate] = useState<string | null>(null);

  const days = weekDaysFrom(weekOf);
  const rangeLabel = `${days[0]!.slice(8)}/${days[0]!.slice(5, 7)} — ${days[6]!.slice(8)}/${days[6]!.slice(5, 7)}`;
  const selectedDay = schedule?.days.find((day) => day.date === detailDate) ?? null;

  return (
    <LinearGradient colors={[...BRAND_GRADIENT]} style={{ flex: 1 }}>
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + 12,
          paddingBottom: 32,
          paddingHorizontal: 20,
        }}
        refreshControl={
          <RefreshControl refreshing={isLoading} onRefresh={reload} tintColor={colors.teal} />
        }
      >
        <Text className="text-2xl font-bold text-white">Calendario</Text>

        <View className="mt-4 flex-row items-center rounded-2xl border border-white/10 bg-white/5 p-2">
          <Pressable
            onPress={() => setWeekOf(shiftWeek(weekOf, -1))}
            accessibilityRole="button"
            accessibilityLabel="Semana anterior"
            hitSlop={10}
            className="h-9 w-9 items-center justify-center rounded-xl bg-white/5"
          >
            <ChevronLeft size={18} color={colors.slate[300]} />
          </Pressable>

          <Text className="flex-1 text-center text-sm font-semibold text-white">{rangeLabel}</Text>

          <Pressable
            onPress={() => setWeekOf(shiftWeek(weekOf, 1))}
            accessibilityRole="button"
            accessibilityLabel="Semana siguiente"
            hitSlop={10}
            className="h-9 w-9 items-center justify-center rounded-xl bg-white/5"
          >
            <ChevronRight size={18} color={colors.slate[300]} />
          </Pressable>
        </View>

        <View className="mt-4 gap-2">
          {(schedule?.days ?? []).map((day) => {
            const status = STATUS_STYLES[day.status];
            return (
              <Pressable
                key={day.date}
                onPress={() => setDetailDate(day.date)}
                accessibilityRole="button"
                accessibilityLabel={`${day.weekdayLabel} ${day.dayOfMonth}, ${status.label}`}
                className={`flex-row items-center rounded-2xl border p-4 ${
                  day.isToday ? "border-teal/30 bg-teal/5" : "border-white/10 bg-white/5"
                }`}
              >
                <View className="w-12">
                  <Text className="text-[11px] font-semibold uppercase text-slate-400">
                    {day.weekdayLabel}
                  </Text>
                  <Text className="text-xl font-bold text-white">{day.dayOfMonth}</Text>
                </View>

                <View className="ml-2 flex-1">
                  <Text className="text-sm text-slate-300">
                    {day.work ? `${day.work.startTime} - ${day.work.endTime}` : "Sin turno"}
                  </Text>
                  {day.lunch && (
                    <Text className="mt-0.5 text-xs text-slate-500">
                      Refrigerio {day.lunch.startTime} - {day.lunch.endTime}
                    </Text>
                  )}
                </View>

                <View className="items-end">
                  <View className="flex-row items-center">
                    <View
                      className="mr-1.5 h-2 w-2 rounded-full"
                      style={{ backgroundColor: status.dot }}
                    />
                    <Text className={`text-xs font-semibold ${status.text}`}>{status.label}</Text>
                  </View>
                  {day.workedMinutes > 0 && (
                    <Text className="mt-1 text-xs tabular-nums text-slate-500">
                      {formatDuration(day.workedMinutes * 60)}
                    </Text>
                  )}
                </View>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>

      <ShiftDetailModal
        visible={detailDate !== null}
        day={selectedDay}
        onClose={() => setDetailDate(null)}
      />
    </LinearGradient>
  );
}
