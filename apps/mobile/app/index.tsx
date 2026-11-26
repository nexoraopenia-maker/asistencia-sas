import { Redirect } from "expo-router";
import { useAuth } from "../src/auth/AuthContext";
import { BrandSplash } from "../src/components/BrandSplash";

/**
 * Punto de entrada: decide si el empleado va al panel o al login.
 *
 * Mientras se restaura la sesion se muestra la pantalla de marca, para que
 * quien ya tiene sesion guardada no vea parpadear el formulario de acceso.
 */
export default function Index() {
  const { user, isRestoring } = useAuth();

  if (isRestoring) return <BrandSplash message="Restaurando tu sesion" />;
  return <Redirect href={user ? "/(tabs)" : "/login"} />;
}
