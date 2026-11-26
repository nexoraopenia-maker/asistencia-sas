"use client";

import {
  Building2,
  CalendarClock,
  ChevronsLeft,
  CreditCard,
  FileSpreadsheet,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Radio,
  ScrollText,
  Settings,
  ShieldCheck,
  Smartphone,
  Sun,
  TriangleAlert,
  Users,
} from "lucide-react";
import { useTheme } from "next-themes";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { cn } from "../lib/utils";
import type { SessionProfile } from "../lib/session";
import { AnimatePresence, motion } from "./motion";
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui";
import { useBranch } from "./branch-context";

const NAV = [
  { href: "/dashboard", label: "Feed en vivo", icon: Radio },
  { href: "/dashboard/empleados", label: "Empleados", icon: Users },
  { href: "/dashboard/horarios", label: "Horarios y turnos", icon: CalendarClock },
  { href: "/dashboard/reportes", label: "Reportes de nomina", icon: FileSpreadsheet },
  { href: "/dashboard/incidencias", label: "Incidencias", icon: TriangleAlert },
  { href: "/dashboard/auditoria", label: "Auditoria laboral", icon: ScrollText },
  { href: "/dashboard/configuracion", label: "Configuracion", icon: Settings },
  { href: "/dashboard/suscripcion", label: "Suscripcion", icon: CreditCard },
  { href: "/descargar", label: "App movil", icon: Smartphone },
] as const;

/** Valor centinela del selector: Radix Select no admite value="". */
const ALL_BRANCHES = "__all__";

/**
 * Selector de tema con tres estados: claro, oscuro y sistema.
 *
 * "Sistema" no es un extra: quien tiene el equipo en modo oscuro por la noche
 * espera que el panel lo siga sin tener que cambiarlo a mano. `next-themes`
 * persiste la eleccion en localStorage y la aplica antes de la hidratacion,
 * asi que no hay destello de tema equivocado al cargar.
 */
function ThemeToggle({ collapsed }: { collapsed: boolean }) {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // El tema real solo se conoce en el cliente: renderizar el icono antes de
  // montar produciria una discrepancia de hidratacion.
  useEffect(() => setMounted(true), []);
  if (!mounted) return <div className="h-9" />;

  const options = [
    { value: "light", label: "Claro", Icon: Sun },
    { value: "dark", label: "Oscuro", Icon: Moon },
    { value: "system", label: "Sistema", Icon: Monitor },
  ] as const;

  if (collapsed) {
    // Contraido no hay sitio para tres botones: se alterna entre claro y
    // oscuro y el modo sistema queda accesible al expandir.
    const isDark = resolvedTheme === "dark";
    return (
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setTheme(isDark ? "light" : "dark")}
        aria-label={isDark ? "Cambiar a modo claro" : "Cambiar a modo oscuro"}
        className="w-10 justify-center px-0"
      >
        {isDark ? <Sun /> : <Moon />}
      </Button>
    );
  }

  return (
    <div
      role="radiogroup"
      aria-label="Tema de la interfaz"
      className="flex rounded-xl border border-border bg-secondary/50 p-0.5"
    >
      {options.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={theme === value}
          aria-label={label}
          title={label}
          onClick={() => setTheme(value)}
          className={cn(
            "flex flex-1 items-center justify-center rounded-lg py-1.5 transition-colors",
            theme === value
              ? "bg-card text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Icon className="h-4 w-4" />
        </button>
      ))}
    </div>
  );
}

/**
 * Contenido de la navegacion.
 *
 * Lo comparten el sidebar de escritorio y el cajon movil: duplicar la lista de
 * rutas en dos sitios garantiza que algun dia diverjan.
 */
function NavContent({
  profile,
  collapsed,
  onNavigate,
  onToggleCollapse,
}: {
  profile: SessionProfile;
  collapsed: boolean;
  /** Cierra el cajon al navegar. Sin esto, en movil la ruta cambia detras del panel abierto. */
  onNavigate?: () => void;
  onToggleCollapse?: () => void;
}) {
  const pathname = usePathname();
  const { branches, selectedId, setSelectedId, isLoading } = useBranch();

  const initials = profile.fullName
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-16 items-center gap-2 border-b border-border px-4">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-cta">
          <span className="text-sm font-bold text-white">S</span>
        </div>
        {!collapsed && (
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-bold leading-tight">Scire 360</p>
            <p className="truncate text-xs text-muted-foreground">{profile.companyName}</p>
          </div>
        )}
      </div>

      {/* Selector global de sucursal */}
      {!collapsed && (
        <div className="border-b border-border p-3">
          <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Sucursal
          </label>
          <Select
            value={selectedId ?? ALL_BRANCHES}
            onValueChange={(value) => setSelectedId(value === ALL_BRANCHES ? undefined : value)}
            disabled={isLoading}
          >
            <SelectTrigger className="h-9 text-sm">
              <SelectValue placeholder="Todas" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_BRANCHES}>Todas las sucursales</SelectItem>
              {branches.map((branch) => (
                <SelectItem key={branch.id} value={branch.id}>
                  {branch.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <nav className="flex-1 space-y-1 overflow-y-auto p-3">
        {NAV.map(({ href, label, icon: Icon }) => {
          // Comparacion exacta para el feed: si no, quedaria activo en todas
          // las rutas hijas, que empiezan por /dashboard.
          const isActive = href === "/dashboard" ? pathname === href : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              onClick={onNavigate}
              title={collapsed ? label : undefined}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-colors",
                collapsed && "justify-center px-0",
                isActive
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-secondary hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {!collapsed && <span className="truncate">{label}</span>}
            </Link>
          );
        })}

        {profile.role === "SUPER_ADMIN" && (
          <Link
            href="/admin"
            onClick={onNavigate}
            title={collapsed ? "Consola de plataforma" : undefined}
            className={cn(
              "mt-3 flex items-center gap-3 rounded-xl border border-border px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground",
              collapsed && "justify-center px-0",
            )}
          >
            <ShieldCheck className="h-4 w-4 shrink-0" />
            {!collapsed && <span className="truncate">Consola de plataforma</span>}
          </Link>
        )}
      </nav>

      <div className="space-y-1 border-t border-border p-3">
        <ThemeToggle collapsed={collapsed} />

        {onToggleCollapse && (
          <Button
            variant="ghost"
            size={collapsed ? "icon" : "sm"}
            onClick={onToggleCollapse}
            aria-label={collapsed ? "Expandir menu" : "Contraer menu"}
            className={cn("w-full", collapsed && "w-10 justify-center px-0")}
          >
            <ChevronsLeft className={cn("transition-transform", collapsed && "rotate-180")} />
            {!collapsed && <span className="flex-1 text-left">Contraer</span>}
          </Button>
        )}

        <div
          className={cn(
            "mt-2 flex items-center gap-2 rounded-xl bg-secondary/60 p-2",
            collapsed && "justify-center",
          )}
        >
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-600/20 text-xs font-bold text-brand-500">
            {initials}
          </div>
          {!collapsed && (
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-semibold">{profile.fullName}</p>
              <p className="truncate text-[11px] text-muted-foreground">{profile.email}</p>
            </div>
          )}
        </div>

        <form action="/api/auth/logout" method="post">
          <Button
            type="submit"
            variant="ghost"
            size={collapsed ? "icon" : "sm"}
            className={cn(
              "w-full text-muted-foreground hover:text-state-danger",
              collapsed && "w-10 justify-center px-0",
            )}
            aria-label="Cerrar sesion"
          >
            <LogOut />
            {!collapsed && <span className="flex-1 text-left">Cerrar sesion</span>}
          </Button>
        </form>
      </div>
    </div>
  );
}

/**
 * Navegacion adaptativa.
 *
 * A partir de `lg` (1024 px) el sidebar es fijo y contraible. Por debajo pasa a
 * ser un cajon: un sidebar de 256 px sobre una pantalla de 390 px no deja sitio
 * para el contenido, y el panel se vuelve inservible en un telefono.
 */
export function Sidebar({ profile }: { profile: SessionProfile }) {
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const pathname = usePathname();

  // Cerrar el cajon al cambiar de ruta cubre tambien la navegacion con el
  // boton "atras" del navegador, que no pasa por el onClick de los enlaces.
  useEffect(() => setDrawerOpen(false), [pathname]);

  return (
    <>
      {/* Escritorio */}
      <aside
        className={cn(
          "sticky top-0 hidden h-screen shrink-0 border-r border-border bg-card transition-[width] duration-200 lg:block",
          collapsed ? "w-[68px]" : "w-64",
        )}
      >
        <NavContent
          profile={profile}
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((value) => !value)}
        />
      </aside>

      {/* Barra superior movil */}
      <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-card px-4 lg:hidden">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setDrawerOpen(true)}
          aria-label="Abrir menu de navegacion"
          aria-expanded={drawerOpen}
        >
          <Menu />
        </Button>
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-cta">
          <span className="text-xs font-bold text-white">S</span>
        </div>
        <p className="min-w-0 flex-1 truncate text-sm font-semibold">{profile.companyName}</p>
      </header>

      {/* Cajon movil */}
      <AnimatePresence>
        {drawerOpen && (
          <div className="fixed inset-0 z-50 lg:hidden">
            <motion.button
              type="button"
              aria-label="Cerrar menu"
              onClick={() => setDrawerOpen(false)}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            />
            <motion.div
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ type: "spring", damping: 30, stiffness: 320 }}
              className="absolute inset-y-0 left-0 w-72 max-w-[85vw] border-r border-border bg-card shadow-floating"
            >
              <NavContent
                profile={profile}
                collapsed={false}
                onNavigate={() => setDrawerOpen(false)}
              />
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </>
  );
}

export function BranchBadge() {
  const { selected } = useBranch();
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
      <Building2 className="h-3.5 w-3.5" />
      {selected?.name ?? "Todas las sucursales"}
    </span>
  );
}
