"use client";

import { Clock, Lock, Mail, ShieldCheck } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Button, Card, Input, Label } from "../../components/ui";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        setError(payload?.error?.message ?? "No se pudo iniciar sesion");
        return;
      }

      // Navegacion completa, no `router.push`: las cookies de sesion acaban de
      // cambiar y el Server Component del panel tiene que renderizarse con ellas.
      // El operador de plataforma aterriza en su consola, no en el panel de RRHH.
      const home = payload?.data?.user?.role === "SUPER_ADMIN" ? "/admin" : "/dashboard";
      window.location.href = params.get("next") ?? home;
    } catch {
      setError("No pudimos conectar con el servidor. Revisa tu conexion.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="email">Correo corporativo</Label>
        <div className="relative">
          <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="rrhh@empresa.com"
            className="pl-9"
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="password">Contrasena</Label>
        <div className="relative">
          <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-600 dark:text-rose-400"
        >
          {error}
        </div>
      )}

      <Button type="submit" size="lg" className="w-full" disabled={isSubmitting}>
        {isSubmitting ? "Verificando..." : "Entrar al panel"}
      </Button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="grid min-h-screen lg:grid-cols-2">
      {/* Panel de marca: solo en pantallas grandes, donde hay sitio de sobra. */}
      <section className="hidden bg-brand-deep p-12 lg:flex lg:flex-col lg:justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">
            Scire 360 <span className="text-teal">Chronos</span>
          </h1>
          <p className="mt-3 max-w-sm text-slate-300">
            Control de asistencia, turnos y nomina con trazabilidad legal.
          </p>
        </div>

        <ul className="space-y-5">
          {[
            { icon: Clock, title: "Precision al segundo", text: "Reloj del servidor con validez legal" },
            { icon: ShieldCheck, title: "Auditoria inmutable", text: "Cada ajuste manual deja rastro" },
            { icon: Lock, title: "Datos cifrados", text: "Selfies solo con enlaces temporales" },
          ].map(({ icon: Icon, title, text }) => (
            <li key={title} className="flex gap-3">
              <Icon className="mt-0.5 h-5 w-5 shrink-0 text-teal" aria-hidden />
              <div>
                <p className="font-semibold text-white">{title}</p>
                <p className="text-sm text-slate-400">{text}</p>
              </div>
            </li>
          ))}
        </ul>

        <p className="text-xs text-slate-500">
          Panel exclusivo de Recursos Humanos. Los colaboradores marcan desde la app movil.
        </p>
      </section>

      <section className="flex items-center justify-center p-6">
        <Card className="w-full max-w-md p-8">
          <div className="mb-8">
            <h2 className="text-2xl font-bold tracking-tight">Panel de Recursos Humanos</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Accede con tu cuenta de administrador
            </p>
          </div>

          <Suspense fallback={<div className="h-64" />}>
            <LoginForm />
          </Suspense>
        </Card>
      </section>
    </main>
  );
}
