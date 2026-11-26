import type { DaySchedule, PunchType } from "@scire/shared";
import { Check, Clock, TriangleAlert, UtensilsCrossed, X } from "lucide-react-native";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { colors, STATUS_STYLES, type AttendanceStatus } from "../lib/theme";

/**
 * Detalle del turno con el desglose exacto de marcaciones.
 *
 * Las horas se muestran en `HH:mm:ss` completo, con segundos y en cifras
 * tabulares. En un sistema con valor legal laboral el segundo importa —una
 * tardanza se discute al minuto— y la anchura fija evita que los digitos
 * bailen cuando la vista se actualiza en vivo.
 */

const PUNCH_LABELS: Record<PunchType, string> = {
  IN: "Entrada",
  LUNCH_START: "Inicio de refrigerio",
  LUNCH_END: "Fin de refrigerio",
  OUT: "Salida",
};

function TimeRange({
  icon,
  title,
  scheduled,
  actual,
}: {
  icon: React.ReactNode;
  title: string;
  scheduled: string | null;
  actual: { start?: string; end?: string };
}) {
  return (
    <View className="rounded-2xl border border-white/10 bg-white/5 p-4">
      <View className="flex-row items-center">
        {icon}
        <Text className="ml-2 text-sm font-semibold text-white">{title}</Text>
      </View>

      {scheduled && (
        <Text className="mt-2 text-xs text-slate-500">Programado · {scheduled}</Text>
      )}

      <View className="mt-3 flex-row">
        <View className="flex-1">
          <Text className="text-[11px] uppercase tracking-wide text-slate-500">Ingreso</Text>
          <Text className="mt-0.5 text-base font-bold tabular-nums text-teal">
            {actual.start ?? "--:--:--"}
          </Text>
        </View>
        <View className="flex-1">
          <Text className="text-[11px] uppercase tracking-wide text-slate-500">Salida</Text>
          <Text className="mt-0.5 text-base font-bold tabular-nums text-teal">
            {actual.end ?? "--:--:--"}
          </Text>
        </View>
      </View>
    </View>
  );
}

export function ShiftDetailModal({
  visible,
  day,
  onClose,
}: {
  visible: boolean;
  day: DaySchedule | null;
  onClose: () => void;
}) {
  if (!day) return null;

  const timeOf = (type: PunchType) => day.punches.find((p) => p.punchType === type)?.time;
  const status = STATUS_STYLES[day.status as AttendanceStatus] ?? STATUS_STYLES.SCHEDULED;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View className="flex-1 justify-end bg-black/60">
        <View className="max-h-[85%] rounded-t-3xl border-t border-white/10 bg-surface-raised">
          {/* Asa de arrastre: senala que la hoja se puede cerrar deslizando. */}
          <View className="items-center pt-3">
            <View className="h-1 w-10 rounded-full bg-white/20" />
          </View>

          <View className="flex-row items-center px-6 pb-2 pt-4">
            <View className="flex-1">
              <Text className="text-xl font-bold text-white">Detalle del turno</Text>
              <Text className="mt-0.5 text-sm text-slate-400">
                {day.weekdayLabel} {day.dayOfMonth} · <Text className={status.text}>{status.label}</Text>
              </Text>
            </View>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Cerrar"
              hitSlop={12}
              className="h-10 w-10 items-center justify-center rounded-2xl border border-white/10 bg-white/5"
            >
              <X size={18} color={colors.slate[300]} />
            </Pressable>
          </View>

          <ScrollView contentContainerClassName="gap-3 px-6 pb-8 pt-2">
            <TimeRange
              icon={<Clock size={16} color={colors.teal} />}
              title="Trabajo"
              scheduled={day.work ? `${day.work.startTime} - ${day.work.endTime}` : null}
              actual={{ start: timeOf("IN"), end: timeOf("OUT") }}
            />

            <TimeRange
              icon={<UtensilsCrossed size={16} color={colors.violet} />}
              title="Refrigerio"
              scheduled={day.lunch ? `${day.lunch.startTime} - ${day.lunch.endTime}` : null}
              actual={{ start: timeOf("LUNCH_START"), end: timeOf("LUNCH_END") }}
            />

            {day.tardinessMinutes > 0 && (
              <View className="flex-row items-center rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3">
                <TriangleAlert size={16} color={colors.amber} />
                <Text className="ml-2 text-sm text-amber-300">
                  {day.tardinessMinutes} min de tardanza registrados
                </Text>
              </View>
            )}

            {day.punches.length > 0 && (
              <View className="mt-1">
                <Text className="mb-2 text-xs font-semibold uppercase tracking-widest text-slate-500">
                  Marcaciones del dia
                </Text>
                <View className="overflow-hidden rounded-2xl border border-white/10">
                  {day.punches.map((punch, index) => (
                    <View
                      key={punch.id}
                      className={[
                        "flex-row items-center bg-white/5 px-4 py-3",
                        index > 0 ? "border-t border-white/5" : "",
                      ].join(" ")}
                    >
                      <View
                        className={[
                          "h-7 w-7 items-center justify-center rounded-full",
                          punch.hasAlert ? "bg-amber-500/15" : "bg-emerald-500/15",
                        ].join(" ")}
                      >
                        {punch.hasAlert ? (
                          <TriangleAlert size={13} color={colors.amber} />
                        ) : (
                          <Check size={13} color={colors.emerald} />
                        )}
                      </View>
                      <Text className="ml-3 flex-1 text-sm text-slate-300">
                        {PUNCH_LABELS[punch.punchType]}
                      </Text>
                      <Text className="text-sm font-semibold tabular-nums text-white">
                        {punch.time}
                      </Text>
                    </View>
                  ))}
                </View>
              </View>
            )}

            {day.punches.length === 0 && (
              <View className="items-center rounded-2xl border border-white/10 bg-white/5 px-6 py-8">
                <Clock size={28} color={colors.slate[500]} />
                <Text className="mt-3 text-center text-sm text-slate-400">
                  Todavia no hay marcaciones registradas para este dia
                </Text>
              </View>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
