"use client";

import { LayoutDashboard, LogOut, ShieldCheck } from "lucide-react";
import Link from "next/link";
import type { SessionProfile } from "../lib/session";
import { Button } from "./ui";

/**
 * Barra de la consola de plataforma.
 *
 * No reutiliza el sidebar del panel: aquel depende del contexto de sucursales
 * de UNA empresa, que en una vista transversal a todos los tenants no aplica.
 */
export function AdminTopbar({ profile }: { profile: SessionProfile }) {
  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    window.location.href = "/login";
  };

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-card px-4 sm:px-6">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-cta">
        <span className="text-sm font-bold text-white">S</span>
      </div>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 truncate text-sm font-bold leading-tight">
          <ShieldCheck className="h-4 w-4 shrink-0 text-primary" />
          Consola de plataforma
        </p>
        <p className="truncate text-xs text-muted-foreground">{profile.email}</p>
      </div>
      <Button asChild variant="ghost" size="sm">
        <Link href="/dashboard">
          <LayoutDashboard />
          <span className="hidden sm:inline">Mi panel</span>
        </Link>
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground hover:text-state-danger"
        onClick={() => void logout()}
        aria-label="Cerrar sesion"
      >
        <LogOut />
        <span className="hidden sm:inline">Salir</span>
      </Button>
    </header>
  );
}
