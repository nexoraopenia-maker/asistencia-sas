import { Bell } from "lucide-react-native";
import { Pressable, Text, View } from "react-native";
import type { AuthenticatedUser } from "../api/endpoints";
import { colors } from "../lib/theme";

/**
 * Ficha del empleado: avatar, nombre, cargo, ID y campana de notificaciones.
 *
 * El avatar es un monograma generado a partir del nombre y no una imagen
 * remota: la foto de perfil es un dato biometrico —es el patron contra el que
 * se compara el face-match— y no tiene por que estar cacheada en cada
 * dispositivo solo para decorar una cabecera.
 */
export function EmployeeHeader({
  user,
  notificationCount = 0,
  onPressNotifications,
}: {
  user: AuthenticatedUser;
  notificationCount?: number;
  onPressNotifications?: () => void;
}) {
  const initials = user.fullName
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <View className="flex-row items-center rounded-3xl border border-white/10 bg-white/5 p-4">
      <View className="h-14 w-14 items-center justify-center rounded-2xl border border-teal/30 bg-brand-600/30">
        <Text className="text-lg font-bold text-teal">{initials}</Text>
      </View>

      <View className="ml-3 flex-1">
        <Text className="text-lg font-bold text-white" numberOfLines={1}>
          {user.fullName}
        </Text>
        <Text className="text-sm text-slate-400" numberOfLines={1}>
          {user.jobTitle ?? "Colaborador"}
        </Text>
        <Text className="mt-0.5 text-xs text-slate-500">ID {user.employeeCode}</Text>
      </View>

      <Pressable
        onPress={onPressNotifications}
        accessibilityRole="button"
        accessibilityLabel={
          notificationCount > 0
            ? `Notificaciones, ${notificationCount} sin leer`
            : "Notificaciones"
        }
        // Area tactil de 44 pt aunque el icono sea mas pequeno.
        hitSlop={12}
        className="h-11 w-11 items-center justify-center rounded-2xl border border-white/10 bg-white/5"
      >
        <Bell size={20} color={colors.slate[300]} />
        {notificationCount > 0 && (
          <View className="absolute right-2 top-2 h-2.5 w-2.5 rounded-full border border-surface bg-rose-500" />
        )}
      </Pressable>
    </View>
  );
}
