import type { DaySchedule } from "@scire/shared";
import { useEffect } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { STATUS_STYLES, type AttendanceStatus } from "../lib/theme";

/**
 * Tira semanal de dias (`Dom 12` .. `Sab 18`).
 *
 * Cada dia muestra su estado de asistencia con un punto de color, y el dia
 * seleccionado se destaca con el gradiente de marca. El punto va ademas
 * acompanado de etiqueta accesible: distinguir presente de tardanza no puede
 * depender solo del color.
 */
/**
 * Un dia de la tira, con transicion al seleccionarse.
 *
 * El muelle se aplica a la escala y la opacidad, no al color: animar color en
 * React Native obliga a interpolar en el hilo de JS y produce tirones en gama
 * media. Escala y opacidad viven en el hilo de UI y van a 60 fps aunque JS
 * este ocupado sincronizando la cola offline.
 */
function DayCell({
  day,
  isSelected,
  onSelect,
}: {
  day: DaySchedule;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const status = STATUS_STYLES[day.status as AttendanceStatus] ?? STATUS_STYLES.SCHEDULED;
  const progress = useSharedValue(isSelected ? 1 : 0);

  useEffect(() => {
    progress.value = withSpring(isSelected ? 1 : 0, {
      damping: 18,
      stiffness: 220,
      mass: 0.6,
    });
  }, [isSelected, progress]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + progress.value * 0.06 }],
  }));

  const glowStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
  }));

  return (
    <Animated.View style={animatedStyle}>
      <Pressable
        onPress={onSelect}
        accessibilityRole="button"
        accessibilityState={{ selected: isSelected }}
        accessibilityLabel={`${day.weekdayLabel} ${day.dayOfMonth}, ${status.label}`}
        className={[
          "w-[58px] items-center overflow-hidden rounded-2xl border py-3",
          isSelected
            ? "border-teal/40 bg-brand-600"
            : day.isToday
              ? "border-white/20 bg-white/10"
              : "border-white/10 bg-white/5",
        ].join(" ")}
      >
        {/* Halo turquesa que aparece con el dia activo. */}
        <Animated.View
          pointerEvents="none"
          style={glowStyle}
          className="absolute inset-0 bg-teal/10"
        />
        <Text
          className={[
            "text-[11px] font-semibold uppercase",
            isSelected ? "text-teal" : "text-slate-400",
          ].join(" ")}
        >
          {day.weekdayLabel}
        </Text>
        <Text
          className={[
            "mt-1 text-lg font-bold",
            isSelected || day.isToday ? "text-white" : "text-slate-300",
          ].join(" ")}
        >
          {day.dayOfMonth}
        </Text>
        <View
          className="mt-1.5 h-1.5 w-1.5 rounded-full"
          style={{ backgroundColor: status.dot }}
        />
      </Pressable>
    </Animated.View>
  );
}

export function CalendarStrip({
  days,
  selectedDate,
  onSelect,
}: {
  days: DaySchedule[];
  selectedDate: string;
  onSelect: (date: string) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerClassName="gap-2 px-1"
      className="-mx-1"
    >
      {days.map((day) => (
        <DayCell
          key={day.date}
          day={day}
          isSelected={day.date === selectedDate}
          onSelect={() => onSelect(day.date)}
        />
      ))}
    </ScrollView>
  );
}
