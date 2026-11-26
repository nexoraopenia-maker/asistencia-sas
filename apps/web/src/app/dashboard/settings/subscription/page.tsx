import { redirect } from "next/navigation";

/**
 * Alias en ingles del panel de suscripcion.
 *
 * La ruta canonica es `/dashboard/suscripcion`, en linea con el resto del
 * panel, que esta en espanol. Este alias existe para no romper enlaces
 * externos o marcadores que apunten a la forma inglesa.
 */
export default function SubscriptionSettingsAlias() {
  redirect("/dashboard/suscripcion");
}
