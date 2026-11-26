import { LinearGradient } from "expo-linear-gradient";
import { Redirect } from "expo-router";
import { Fingerprint, Lock, Mail } from "lucide-react-native";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ApiError, NetworkError } from "../src/api/client";
import { useAuth } from "../src/auth/AuthContext";
import { getTokens } from "../src/lib/storage";
import { BRAND_GRADIENT, colors, CTA_GRADIENT } from "../src/lib/theme";

function loginErrorMessage(error: unknown): string {
  if (error instanceof NetworkError) {
    return "No pudimos conectar con el servidor. Revisa tu conexion.";
  }
  if (error instanceof ApiError) {
    if (error.code === "BIOMETRIC_CANCELLED") return "";
    return error.message;
  }
  return "No se pudo iniciar sesion";
}

export default function LoginScreen() {
  const { user, login, loginWithBiometrics, isAuthenticating, biometric, biometricEnabled } =
    useAuth();
  const insets = useSafeAreaInsets();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [hasStoredSession, setHasStoredSession] = useState(false);

  // El acceso biometrico solo tiene sentido si ya hay un refresh token
  // guardado: la huella desbloquea una sesion existente, no crea una nueva.
  useEffect(() => {
    void getTokens().then((tokens) => setHasStoredSession(Boolean(tokens)));
  }, []);

  const canUseBiometrics =
    biometric.available && biometric.enrolled && biometricEnabled && hasStoredSession;

  if (user) return <Redirect href="/(tabs)" />;

  const handleLogin = async () => {
    setError(null);
    try {
      await login(email.trim(), password);
    } catch (cause) {
      setError(loginErrorMessage(cause));
    }
  };

  const handleBiometric = async () => {
    setError(null);
    try {
      await loginWithBiometrics();
    } catch (cause) {
      const message = loginErrorMessage(cause);
      if (message) setError(message);
    }
  };

  return (
    <LinearGradient colors={[...BRAND_GRADIENT]} style={{ flex: 1 }}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={{
            flexGrow: 1,
            justifyContent: "center",
            paddingTop: insets.top + 24,
            paddingBottom: insets.bottom + 24,
            paddingHorizontal: 24,
          }}
          keyboardShouldPersistTaps="handled"
        >
          <View className="mb-10">
            <Text className="text-4xl font-bold text-white">
              Scire 360 <Text className="text-teal">Chronos</Text>
            </Text>
            <Text className="mt-2 text-base text-slate-400">
              Marca tu asistencia con verificacion por selfie y geocerca
            </Text>
          </View>

          <View className="gap-3">
            <View className="flex-row items-center rounded-2xl border border-white/10 bg-white/5 px-4">
              <Mail size={18} color={colors.slate[400]} />
              <TextInput
                value={email}
                onChangeText={setEmail}
                placeholder="tu.correo@empresa.com"
                placeholderTextColor={colors.slate[500]}
                autoCapitalize="none"
                autoComplete="email"
                keyboardType="email-address"
                inputMode="email"
                accessibilityLabel="Correo electronico"
                className="ml-3 flex-1 py-4 text-base text-white"
              />
            </View>

            <View className="flex-row items-center rounded-2xl border border-white/10 bg-white/5 px-4">
              <Lock size={18} color={colors.slate[400]} />
              <TextInput
                value={password}
                onChangeText={setPassword}
                placeholder="Contrasena"
                placeholderTextColor={colors.slate[500]}
                secureTextEntry
                autoComplete="current-password"
                accessibilityLabel="Contrasena"
                onSubmitEditing={() => void handleLogin()}
                returnKeyType="go"
                className="ml-3 flex-1 py-4 text-base text-white"
              />
            </View>
          </View>

          {error && (
            <View className="mt-4 rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3">
              <Text className="text-sm text-rose-300">{error}</Text>
            </View>
          )}

          <Pressable
            onPress={() => void handleLogin()}
            disabled={isAuthenticating || !email || !password}
            accessibilityRole="button"
            className={`mt-6 ${isAuthenticating || !email || !password ? "opacity-40" : ""}`}
          >
            <LinearGradient
              colors={[...CTA_GRADIENT]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={{ borderRadius: 16, paddingVertical: 16, alignItems: "center" }}
            >
              {isAuthenticating ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text className="text-base font-bold text-white">Iniciar sesion</Text>
              )}
            </LinearGradient>
          </Pressable>

          {canUseBiometrics && (
            <Pressable
              onPress={() => void handleBiometric()}
              disabled={isAuthenticating}
              accessibilityRole="button"
              accessibilityLabel={`Entrar con ${biometric.label}`}
              className="mt-3 flex-row items-center justify-center rounded-2xl border border-teal/30 bg-teal/10 py-4"
            >
              <Fingerprint size={20} color={colors.teal} />
              <Text className="ml-2 text-base font-semibold text-teal">
                Entrar con {biometric.label}
              </Text>
            </Pressable>
          )}

          <Text className="mt-8 text-center text-xs text-slate-500">
            Tu huella o rostro se validan en el dispositivo.{"\n"}
            Nunca salen de el ni se envian a nuestros servidores.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </LinearGradient>
  );
}
