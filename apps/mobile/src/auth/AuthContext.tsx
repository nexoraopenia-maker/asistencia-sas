import * as LocalAuthentication from "expo-local-authentication";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Platform } from "react-native";
import { ApiError, NetworkError, setSessionExpiredHandler } from "../api/client";
import { authApi, type AuthenticatedUser } from "../api/endpoints";
import {
  clearTokens,
  getCachedUser,
  getDeviceId,
  getTokens,
  isBiometricEnabled,
  saveCachedUser,
  saveTokens,
  setBiometricEnabled,
} from "../lib/storage";

export interface BiometricSupport {
  available: boolean;
  enrolled: boolean;
  /** "Face ID", "Huella dactilar"... para el texto del boton. */
  label: string;
}

interface AuthContextValue {
  user: AuthenticatedUser | null;
  /** Aun comprobando si hay sesion guardada: evita el parpadeo del login. */
  isRestoring: boolean;
  isAuthenticating: boolean;
  biometric: BiometricSupport;
  biometricEnabled: boolean;
  login: (email: string, password: string) => Promise<void>;
  loginWithBiometrics: () => Promise<void>;
  logout: () => Promise<void>;
  toggleBiometric: (enabled: boolean) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const NO_BIOMETRICS: BiometricSupport = { available: false, enrolled: false, label: "" };

async function detectBiometrics(): Promise<BiometricSupport> {
  const [available, enrolled, types] = await Promise.all([
    LocalAuthentication.hasHardwareAsync(),
    LocalAuthentication.isEnrolledAsync(),
    LocalAuthentication.supportedAuthenticationTypesAsync(),
  ]);

  const hasFace = types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION);
  const label = hasFace
    ? Platform.OS === "ios"
      ? "Face ID"
      : "Reconocimiento facial"
    : Platform.OS === "ios"
      ? "Touch ID"
      : "Huella dactilar";

  return { available, enrolled, label };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthenticatedUser | null>(null);
  const [isRestoring, setIsRestoring] = useState(true);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [biometric, setBiometric] = useState<BiometricSupport>(NO_BIOMETRICS);
  const [biometricOn, setBiometricOn] = useState(false);

  const endSession = useCallback(async () => {
    // La cola offline NO se borra: son horas trabajadas. Cada fila lleva su
    // dueno y se enviara cuando esa persona vuelva a iniciar sesion.
    await clearTokens();
    setUser(null);
  }, []);

  const openSession = useCallback(async (next: AuthenticatedUser) => {
    await saveCachedUser(next);
    setUser(next);
  }, []);

  // El cliente HTTP avisa cuando el refresco falla definitivamente (sesion
  // revocada desde el dashboard, token reutilizado, empleado dado de baja).
  useEffect(() => {
    setSessionExpiredHandler(() => {
      void endSession();
    });
  }, [endSession]);

  // Restauracion de sesion al abrir la app.
  useEffect(() => {
    void (async () => {
      try {
        const [support, enabled] = await Promise.all([detectBiometrics(), isBiometricEnabled()]);
        setBiometric(support);
        setBiometricOn(enabled && support.available && support.enrolled);

        const tokens = await getTokens();
        if (!tokens) return;

        // Con biometria activada no se restaura la sesion en silencio: la
        // pantalla de bloqueo pide la huella primero. Sin ella, el token
        // guardado basta.
        if (enabled && support.available && support.enrolled) return;

        await openSession(await authApi.me());
      } catch (error) {
        // Sin cobertura al arrancar no es motivo para echar al empleado: los
        // tokens siguen guardados y se reintentara. Solo un rechazo explicito
        // del servidor cierra la sesion.
        if (error instanceof NetworkError) {
          setUser(await getCachedUser<AuthenticatedUser>());
        } else if (error instanceof ApiError && error.status === 401) {
          await endSession();
        }
      } finally {
        setIsRestoring(false);
      }
    })();
  }, [endSession, openSession]);

  const login = useCallback(async (email: string, password: string) => {
    setIsAuthenticating(true);
    try {
      const deviceId = await getDeviceId();
      const deviceName = `${Platform.OS === "ios" ? "iPhone" : "Android"} · Scire Chronos`;
      const response = await authApi.login(email, password, deviceId, deviceName);
      await saveTokens({
        accessToken: response.tokens.accessToken,
        refreshToken: response.tokens.refreshToken,
      });
      await openSession(response.user);
    } finally {
      setIsAuthenticating(false);
    }
  }, [openSession]);

  /**
   * Desbloqueo biometrico.
   *
   * La huella o Face ID se validan EN EL DISPOSITIVO y lo unico que hacen es
   * autorizar el uso del refresh token guardado en el keychain. El servidor no
   * recibe ni almacena datos biometricos: guardar plantillas seria un riesgo y
   * una carga regulatoria sin contrapartida.
   */
  const loginWithBiometrics = useCallback(async () => {
    setIsAuthenticating(true);
    try {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: "Confirma tu identidad para marcar asistencia",
        cancelLabel: "Usar contrasena",
        disableDeviceFallback: false,
      });

      if (!result.success) {
        throw new ApiError(401, "BIOMETRIC_CANCELLED", "No se pudo verificar tu identidad");
      }

      const tokens = await getTokens();
      if (!tokens) {
        throw new ApiError(401, "UNAUTHENTICATED", "Inicia sesion con tu correo la primera vez");
      }

      try {
        const deviceId = await getDeviceId();
        const refreshed = await authApi.biometric(tokens.refreshToken, deviceId);
        await saveTokens({
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken,
        });
        await openSession(await authApi.me());
      } catch (error) {
        // Sin red: el dispositivo ya verifico a la persona, se abre con el
        // perfil guardado para que pueda marcar. El servidor revalidara.
        const cached = await getCachedUser<AuthenticatedUser>();
        if (!(error instanceof NetworkError) || !cached) throw error;
        setUser(cached);
      }
    } finally {
      setIsAuthenticating(false);
    }
  }, [openSession]);

  const logout = useCallback(async () => {
    const tokens = await getTokens();
    // Se avisa al servidor para que revoque la sesion, pero sin bloquear el
    // cierre local: si no hay red, la sesion se cierra igual en el dispositivo.
    if (tokens) await authApi.logout(tokens.refreshToken).catch(() => {});
    await endSession();
  }, [endSession]);

  const toggleBiometric = useCallback(
    async (enabled: boolean) => {
      if (enabled) {
        const result = await LocalAuthentication.authenticateAsync({
          promptMessage: `Activar ${biometric.label} para Scire Chronos`,
        });
        if (!result.success) return;
      }
      await setBiometricEnabled(enabled);
      setBiometricOn(enabled);
    },
    [biometric.label],
  );

  const value = useMemo(
    () => ({
      user,
      isRestoring,
      isAuthenticating,
      biometric,
      biometricEnabled: biometricOn,
      login,
      loginWithBiometrics,
      logout,
      toggleBiometric,
    }),
    [
      user,
      isRestoring,
      isAuthenticating,
      biometric,
      biometricOn,
      login,
      loginWithBiometrics,
      logout,
      toggleBiometric,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth debe usarse dentro de AuthProvider");
  return context;
}
