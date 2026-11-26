import { formatDuration, toZonedDateString, type PunchType } from "@scire/shared";
import { LinearGradient } from "expo-linear-gradient";
import { ChevronRight, Clock, Fingerprint, UtensilsCrossed } from "lucide-react-native";
import { useEffect, useMemo, useState } from "react";
import { RefreshControl, ScrollView, Text, View, Pressable } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "../../src/auth/AuthContext";
import { CalendarStrip } from "../../src/components/CalendarStrip";
import { EmployeeHeader } from "../../src/components/EmployeeHeader";
import { PunchSheet } from "../../src/components/PunchSheet";
import { ShiftDetailModal } from "../../src/components/ShiftDetailModal";
import { SyncIndicator } from "../../src/components/SyncIndicator";
import { useWeeklySchedule } from "../../src/hooks/useWeeklySchedule";
import { nextPunchType } from "../../src/lib/punchFlow";
import { BRAND_GRADIENT, colors, CTA_GRADIENT, STATUS_STYLES } from "../../src/lib/theme";
import { useOffline } from "../../src/offline/OfflineContext";
import type { PunchOutcome } from "../../src/hooks/usePunch";

const NEXT_PUNCH_LABEL: Record<PunchType, string> = {
  IN: "Marcar entrada",
  LUNCH_START: "Iniciar refrigerio",
  LUNCH_END: "Terminar refrigerio",
  OUT: "Marcar salida",
};

export default function HomeScreen() {
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const { schedule, staleSince, isLoading, error, reload } = useWeeklySchedule();
  const { pending, pendingCount } = useOffline();

  const today = toZonedDateString(new Date(), "America/Lima");
  const [selectedDate, setSelectedDate] = useState(today);
  const [detailOpen, setDetailOpen] = useState(false);
  const [punchOpen, setPunchOpen] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const selectedDay = useMemo(
    () => schedule?.days.find((day) => day.date === selectedDate),
    [schedule, selectedDate],
  );
  const todayDay = useMemo(
    () => schedule?.days.find((day) => day.date === today),
    [schedule, today],
  );

  const pendingPunch = nextPunchType(todayDay, schedule?.currentJornada, {
    pending: pending.map((p) => ({
      punchType: p.payload.punchType,
      at: Date.parse(p.payload.deviceTimestamp),
    })),
    staleSince,
  });

  // Al vaciarse la cola (o crecer) el calendario del servidor cambia.
  useEffect(() => {
    void reload();
  }, [pendingCount, reload]);
  const status = selectedDay ? STATUS_STYLES[selectedDay.status] : null;

  const handlePunchResult = (outcome: PunchOutcome) => {
    setPunchOpen(false);
    setFeedback(
      outcome.kind === "submitted"
        ? `Marcacion registrada a las ${new Date(outcome.result.serverTimestamp).toLocaleTimeString("es-PE")}`
        : "Marcacion guardada en este telefono. Se enviara sola cuando haya conexion.",
    );
    void reload();
    setTimeout(() => setFeedback(null), 4000);
  };

  if (!user) return null;

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
        <EmployeeHeader user={user} notificationCount={pendingCount} />

        <SyncIndicator />

        {feedback && (
          <View className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3">
            <Text className="text-sm text-emerald-300">{feedback}</Text>
          </View>
        )}

        {error && (
          <View className="rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3">
            <Text className="text-sm text-amber-300">{error}</Text>
          </View>
        )}

        {/* --- Tira semanal --- */}
        <View>
          <Text className="mb-3 text-xs font-semibold uppercase tracking-widest text-slate-400">
            Tu semana
          </Text>
          {schedule ? (
            <CalendarStrip
              days={schedule.days}
              selectedDate={selectedDate}
              onSelect={setSelectedDate}
            />
          ) : (
            <View className="h-[86px] animate-pulse rounded-2xl bg-white/5" />
          )}
        </View>

        {/* --- Accion rapida --- */}
        {pendingPunch ? (
          <Pressable onPress={() => setPunchOpen(true)} accessibilityRole="button">
            <LinearGradient
              colors={[...CTA_GRADIENT]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={{ borderRadius: 24, padding: 20 }}
            >
              <View className="flex-row items-center">
                <View className="h-12 w-12 items-center justify-center rounded-2xl bg-white/15">
                  <Fingerprint size={22} color="#fff" />
                </View>
                <View className="ml-4 flex-1">
                  <Text className="text-lg font-bold text-white">
                    {NEXT_PUNCH_LABEL[pendingPunch]}
                  </Text>
                  <Text className="mt-0.5 text-sm text-indigo-200">
                    Selfie + validacion de geocerca
                  </Text>
                </View>
                <ChevronRight size={20} color="#c7d2fe" />
              </View>
            </LinearGradient>
          </Pressable>
        ) : (
          <View className="items-center rounded-3xl border border-emerald-500/20 bg-emerald-500/10 px-6 py-6">
            <Text className="text-base font-semibold text-emerald-300">Jornada completada</Text>
            <Text className="mt-1 text-sm text-emerald-400/70">
              Ya registraste todas tus marcaciones de hoy
            </Text>
          </View>
        )}

        {/* --- Detalle del turno --- */}
        {selectedDay && (
          <Pressable
            onPress={() => setDetailOpen(true)}
            accessibilityRole="button"
            accessibilityLabel="Ver detalle del turno"
            className="rounded-3xl border border-white/10 bg-white/5 p-5"
          >
            <View className="flex-row items-center">
              <Text className="flex-1 text-base font-bold text-white">Detalle del turno</Text>
              {status && (
                <View className="flex-row items-center">
                  <View
                    className="mr-1.5 h-2 w-2 rounded-full"
                    style={{ backgroundColor: status.dot }}
                  />
                  <Text className={`text-xs font-semibold ${status.text}`}>{status.label}</Text>
                </View>
              )}
            </View>

            <View className="mt-4 gap-3">
              <View className="flex-row items-center">
                <Clock size={15} color={colors.teal} />
                <Text className="ml-2 flex-1 text-sm text-slate-400">Trabajo</Text>
                <Text className="text-sm font-semibold tabular-nums text-white">
                  {selectedDay.work
                    ? `${selectedDay.work.startTime} - ${selectedDay.work.endTime}`
                    : "Sin turno"}
                </Text>
              </View>

              <View className="flex-row items-center">
                <UtensilsCrossed size={15} color={colors.violet} />
                <Text className="ml-2 flex-1 text-sm text-slate-400">Refrigerio</Text>
                <Text className="text-sm font-semibold tabular-nums text-white">
                  {selectedDay.lunch
                    ? `${selectedDay.lunch.startTime} - ${selectedDay.lunch.endTime}`
                    : "—"}
                </Text>
              </View>
            </View>

            <View className="mt-4 flex-row items-center border-t border-white/5 pt-3">
              <Text className="flex-1 text-sm text-slate-500">
                {selectedDay.punches.length} marcacion
                {selectedDay.punches.length === 1 ? "" : "es"} registrada
                {selectedDay.punches.length === 1 ? "" : "s"}
              </Text>
              <Text className="text-sm font-semibold text-teal">Ver mas</Text>
              <ChevronRight size={16} color={colors.teal} />
            </View>
          </Pressable>
        )}

        {/* --- Resumen semanal --- */}
        {schedule && (
          <View className="flex-row gap-3">
            {[
              { label: "Trabajado", value: formatDuration(schedule.totals.workedMinutes * 60) },
              { label: "Refrigerio", value: formatDuration(schedule.totals.lunchMinutes * 60) },
              {
                label: "Tardanza",
                value: `${schedule.totals.tardinessMinutes} min`,
                warn: schedule.totals.tardinessMinutes > 0,
              },
            ].map((metric) => (
              <View
                key={metric.label}
                className="flex-1 rounded-2xl border border-white/10 bg-white/5 p-4"
              >
                <Text className="text-[11px] uppercase tracking-wide text-slate-500">
                  {metric.label}
                </Text>
                <Text
                  className={`mt-1 text-base font-bold tabular-nums ${
                    metric.warn ? "text-amber-400" : "text-white"
                  }`}
                >
                  {metric.value}
                </Text>
              </View>
            ))}
          </View>
        )}
      </ScrollView>

      <ShiftDetailModal
        visible={detailOpen}
        day={selectedDay ?? null}
        onClose={() => setDetailOpen(false)}
      />

      {pendingPunch && user.branchId && (
        <PunchSheet
          visible={punchOpen}
          punchType={pendingPunch}
          branchId={user.branchId}
          onClose={() => setPunchOpen(false)}
          onSuccess={handlePunchResult}
        />
      )}
    </LinearGradient>
  );
}
