import { LinearGradient } from "expo-linear-gradient";
import { ActivityIndicator, Text, View } from "react-native";
import { BRAND_GRADIENT, colors } from "../lib/theme";

/** Pantalla de carga de marca: arranque de la app y restauracion de sesion. */
export function BrandSplash({ message }: { message?: string }) {
  return (
    <LinearGradient colors={[...BRAND_GRADIENT]} style={{ flex: 1 }}>
      <View className="flex-1 items-center justify-center">
        <Text className="text-3xl font-bold text-white">
          Scire 360 <Text className="text-teal">Chronos</Text>
        </Text>
        <ActivityIndicator className="mt-6" color={colors.teal} />
        {message && <Text className="mt-4 text-sm text-slate-400">{message}</Text>}
      </View>
    </LinearGradient>
  );
}
