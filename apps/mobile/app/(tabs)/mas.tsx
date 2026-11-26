import { LinearGradient } from "expo-linear-gradient";
import {
  Building2,
  ChevronRight,
  Fingerprint,
  LogOut,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react-native";
import { Alert, Pressable, ScrollView, Switch, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { API_URL } from "../../src/api/client";
import { useAuth } from "../../src/auth/AuthContext";
import { EmployeeHeader } from "../../src/components/EmployeeHeader";
import { BRAND_GRADIENT, colors } from "../../src/lib/theme";
import { dismissRejections } from "../../src/offline/queue";
import { useOffline } from "../../src/offline/OfflineContext";

function Row({
  icon,
  title,
  subtitle,
  right,
  onPress,
  danger,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  onPress?: () => void;
  danger?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole={onPress ? "button" : undefined}
      className="flex-row items-center border-b border-white/5 px-5 py-4"
    >
      {icon}
      <View className="ml-3 flex-1">
        <Text className={`text-sm font-semibold ${danger ? "text-rose-400" : "text-white"}`}>
          {title}
        </Text>
        {subtitle && <Text className="mt-0.5 text-xs text-slate-500">{subtitle}</Text>}
      </View>
      {right ?? (onPress ? <ChevronRight size={16} color={colors.slate[500]} /> : null)}
    </Pressable>
  );
}

export default function MasScreen() {
  const insets = useSafeAreaInsets();
  const { user, logout, biometric, biometricEnabled, toggleBiometric } = useAuth();
  const { pendingCount, rejections, sync, isSyncing, refreshQueueState } = useOffline();

  if (!user) return null;

  const confirmLogout = () => {
    Alert.alert(
      "Cerrar sesion",
      pendingCount > 0
        ? `Tienes ${pendingCount} marcacion${pendingCount === 1 ? "" : "es"} sin sincronizar. Si cierras sesion ahora se perderan.`
        : "Se cerrara tu sesion en este dispositivo.",
      [
        { text: "Cancelar", style: "cancel" },
        { text: "Cerrar sesion", style: "destructive", onPress: () => void logout() },
      ],
    );
  };

  return (
    <LinearGradient colors={[...BRAND_GRADIENT]} style={{ flex: 1 }}>
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + 12,
          paddingBottom: 32,
          paddingHorizontal: 20,
          gap: 16,
        }}
      >
        <EmployeeHeader user={user} />

        <View className="overflow-hidden rounded-3xl border border-white/10 bg-white/5">
          <Text className="px-5 pb-2 pt-4 text-xs font-semibold uppercase tracking-widest text-slate-500">
            Seguridad
          </Text>

          <Row
            icon={<Fingerprint size={18} color={colors.teal} />}
            title={biometric.available ? `Acceso con ${biometric.label}` : "Acceso biometrico"}
            subtitle={
              !biometric.available
                ? "Este dispositivo no tiene sensor biometrico"
                : !biometric.enrolled
                  ? "Configura tu huella o rostro en los ajustes del sistema"
                  : "Se valida en el dispositivo; nunca sale de el"
            }
            right={
              <Switch
                value={biometricEnabled}
                onValueChange={(value) => void toggleBiometric(value)}
                disabled={!biometric.available || !biometric.enrolled}
                trackColor={{ false: colors.slate[700], true: colors.teal }}
                thumbColor="#fff"
              />
            }
          />

          <Row
            icon={<ShieldCheck size={18} color={colors.violet} />}
            title="Tus datos"
            subtitle="Las selfies se guardan cifradas y solo se acceden con enlaces temporales"
          />
        </View>

        <View className="overflow-hidden rounded-3xl border border-white/10 bg-white/5">
          <Text className="px-5 pb-2 pt-4 text-xs font-semibold uppercase tracking-widest text-slate-500">
            Sincronizacion
          </Text>

          <Row
            icon={<RefreshCw size={18} color={pendingCount > 0 ? colors.amber : colors.emerald} />}
            title={
              pendingCount > 0
                ? `${pendingCount} marcacion${pendingCount === 1 ? "" : "es"} en cola`
                : "Todo sincronizado"
            }
            subtitle={pendingCount > 0 ? "Toca para reintentar el envio" : undefined}
            onPress={pendingCount > 0 && !isSyncing ? () => void sync() : undefined}
          />

          {rejections.length > 0 && (
            <Row
              icon={<TriangleAlert size={18} color={colors.rose} />}
              title={`${rejections.length} marcacion${rejections.length === 1 ? "" : "es"} rechazada${rejections.length === 1 ? "" : "s"}`}
              subtitle={rejections[0]?.errorMessage}
              danger
              onPress={() => {
                Alert.alert(
                  "Marcaciones rechazadas",
                  rejections
                    .map((r) => `· ${r.punchType}: ${r.errorMessage}`)
                    .join("\n"),
                  [
                    { text: "Cerrar", style: "cancel" },
                    {
                      text: "Entendido, descartar",
                      onPress: () => void dismissRejections().then(refreshQueueState),
                    },
                  ],
                );
              }}
            />
          )}
        </View>

        <View className="overflow-hidden rounded-3xl border border-white/10 bg-white/5">
          <Text className="px-5 pb-2 pt-4 text-xs font-semibold uppercase tracking-widest text-slate-500">
            Cuenta
          </Text>

          <Row
            icon={<Building2 size={18} color={colors.slate[400]} />}
            title={user.companyName}
            subtitle={`${user.email} · ${user.role}`}
          />

          <Row
            icon={<LogOut size={18} color={colors.rose} />}
            title="Cerrar sesion"
            danger
            onPress={confirmLogout}
          />
        </View>

        <Text className="text-center text-xs text-slate-600">
          Scire 360 Chronos · v0.1.0{"\n"}
          {API_URL}
        </Text>
      </ScrollView>
    </LinearGradient>
  );
}
