"use client";

import { AlertTriangle, Sparkles, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Button } from "./ui";

/**
 * Aviso global de estado de cuenta.
 *
 * Es una barra fina, no un modal: interrumpir el trabajo de RRHH cada vez que
 * abre el panel para recordarle que le quedan dos dias de prueba convierte el
 * aviso en algo que se cierra sin leer.
 *
 * Solo aparece en dos casos —trial a punto de vencer o cobro fallido— y se
 * puede descartar por sesion. La suspension real no se descarta: en ese estado
 * nada funciona y ocultarlo solo generaria confusion.
 */
interface AccountState {
  status: string;
  graceEndsAt: string | null;
  trialEndingSoon: boolean;
  trialDaysLeft: number | null;
}

const DISMISS_KEY = "scire.accountBannerDismissed";

export function AccountBanner() {
  const pathname = usePathname();
  const [state, setState] = useState<AccountState | null>(null);
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    setDismissed(window.sessionStorage.getItem(DISMISS_KEY) === "1");

    void (async () => {
      try {
        const data = await api<{
          account: { status: string; graceEndsAt: string | null; trialEndingSoon: boolean };
          subscription: { trialDaysLeft: number | null };
        }>("/v1/subscription");
        setState({
          status: data.account.status,
          graceEndsAt: data.account.graceEndsAt,
          trialEndingSoon: data.account.trialEndingSoon,
          trialDaysLeft: data.subscription.trialDaysLeft,
        });
      } catch {
        // Un fallo al leer el estado de la cuenta no debe estropear el panel:
        // simplemente no se muestra la barra.
        setState(null);
      }
    })();
  }, []);

  if (!state) return null;
  // En la propia pagina de suscripcion el aviso ya sale completo dentro.
  if (pathname.startsWith("/dashboard/suscripcion")) return null;

  const isSuspended = state.status === "SUSPENDED";
  const isPastDue = state.status === "PAST_DUE";
  const showTrial = state.trialEndingSoon;

  if (!isSuspended && !isPastDue && !showTrial) return null;
  if (dismissed && !isSuspended) return null;

  const dismiss = () => {
    window.sessionStorage.setItem(DISMISS_KEY, "1");
    setDismissed(true);
  };

  const graceDays = state.graceEndsAt
    ? Math.max(0, Math.ceil((new Date(state.graceEndsAt).getTime() - Date.now()) / 86_400_000))
    : null;

  const tone = isSuspended
    ? "border-state-danger-bg/25 bg-state-danger-bg/10 text-state-danger"
    : "border-state-warning-bg/25 bg-state-warning-bg/10 text-state-warning";

  const message = isSuspended
    ? "Cuenta suspendida: tus colaboradores no pueden marcar asistencia."
    : isPastDue
      ? `No pudimos procesar tu ultimo pago.${graceDays !== null ? ` El servicio sigue activo ${graceDays} dia${graceDays === 1 ? "" : "s"} mas.` : ""}`
      : state.trialDaysLeft === 0
        ? "Tu prueba gratuita termina hoy."
        : `Quedan ${state.trialDaysLeft} dias de prueba.`;

  return (
    <div
      role={isSuspended ? "alert" : "status"}
      className={`flex flex-wrap items-center gap-3 border-b px-6 py-2.5 text-sm ${tone}`}
    >
      {isSuspended || isPastDue ? (
        <AlertTriangle className="h-4 w-4 shrink-0" />
      ) : (
        <Sparkles className="h-4 w-4 shrink-0" />
      )}
      <span className="min-w-0 flex-1">{message}</span>

      <Button size="sm" variant={isSuspended ? "default" : "outline"} asChild>
        <Link href="/dashboard/suscripcion">
          {isSuspended ? "Reactivar" : isPastDue ? "Regularizar" : "Ver planes"}
        </Link>
      </Button>

      {!isSuspended && (
        <button
          type="button"
          onClick={dismiss}
          aria-label="Ocultar aviso"
          className="rounded p-1 opacity-60 transition hover:opacity-100"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
