import * as SecureStore from "expo-secure-store";

/**
 * Almacenamiento de credenciales.
 *
 * Los tokens van a `expo-secure-store`, que usa el Keychain en iOS y el
 * KeyStore cifrado en Android. Nunca a AsyncStorage: en un dispositivo con
 * root o en una copia de seguridad sin cifrar, AsyncStorage es texto plano.
 */

const ACCESS_TOKEN = "scire.accessToken";
const REFRESH_TOKEN = "scire.refreshToken";
const DEVICE_ID = "scire.deviceId";
const BIOMETRIC_ENABLED = "scire.biometricEnabled";

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
}

export async function saveTokens(tokens: StoredTokens): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(ACCESS_TOKEN, tokens.accessToken),
    SecureStore.setItemAsync(REFRESH_TOKEN, tokens.refreshToken, {
      // Exige que el dispositivo tenga bloqueo configurado para guardar el
      // token de larga duracion: sin PIN, huella o cara no hay sesion persistente.
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    }),
  ]);
}

export async function getTokens(): Promise<StoredTokens | null> {
  const [accessToken, refreshToken] = await Promise.all([
    SecureStore.getItemAsync(ACCESS_TOKEN),
    SecureStore.getItemAsync(REFRESH_TOKEN),
  ]);
  if (!accessToken || !refreshToken) return null;
  return { accessToken, refreshToken };
}

const CACHED_USER = "scire.user";

/** Perfil de la sesion, para poder abrir la app y marcar sin conexion. */
export async function saveCachedUser(user: unknown): Promise<void> {
  await SecureStore.setItemAsync(CACHED_USER, JSON.stringify(user));
}

export async function getCachedUser<T>(): Promise<T | null> {
  const raw = await SecureStore.getItemAsync(CACHED_USER);
  return raw ? (JSON.parse(raw) as T) : null;
}

export async function clearTokens(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(CACHED_USER),
    SecureStore.deleteItemAsync(ACCESS_TOKEN),
    SecureStore.deleteItemAsync(REFRESH_TOKEN),
  ]);
}

/**
 * Identificador estable del dispositivo.
 *
 * Se genera una vez y sobrevive a los cierres de sesion: es lo que permite a
 * RRHH ver "iPhone de Maria" en la lista de sesiones activas y revocar un
 * aparato concreto.
 */
export async function getDeviceId(): Promise<string> {
  let id = await SecureStore.getItemAsync(DEVICE_ID);
  if (!id) {
    id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    await SecureStore.setItemAsync(DEVICE_ID, id);
  }
  return id;
}

export async function setBiometricEnabled(enabled: boolean): Promise<void> {
  await SecureStore.setItemAsync(BIOMETRIC_ENABLED, enabled ? "1" : "0");
}

export async function isBiometricEnabled(): Promise<boolean> {
  return (await SecureStore.getItemAsync(BIOMETRIC_ENABLED)) === "1";
}
