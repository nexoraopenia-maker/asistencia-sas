"use client";

import { ThemeProvider, useTheme } from "next-themes";
import { Toaster } from "sonner";
import type { ReactNode } from "react";

/**
 * Proveedores del cliente.
 *
 * `attribute="class"` porque el sistema de tokens de Tailwind conmuta con la
 * clase `.dark` en el elemento raiz. `disableTransitionOnChange` evita que
 * todo el panel haga un fundido de 150 ms al cambiar de tema, que se percibe
 * como un fallo de renderizado y no como una transicion.
 */
/**
 * Toasts que siguen el tema del panel.
 *
 * Sonner necesita saber el tema resuelto: sin pasarselo, en modo oscuro pinta
 * tarjetas claras que deslumbran sobre el gradiente noche-purpura.
 *
 * `richColors` da a cada variante su color semantico; el borde y el radio se
 * igualan a los de las tarjetas para que un toast se lea como parte del mismo
 * sistema y no como un componente de una libreria distinta.
 */
function ThemedToaster() {
  const { resolvedTheme } = useTheme();

  return (
    <Toaster
      theme={(resolvedTheme as "light" | "dark") ?? "dark"}
      position="top-right"
      richColors
      closeButton
      // 5 s: suficiente para leer dos lineas sin que un error se pierda antes
      // de que el usuario levante la vista de otra parte de la pantalla.
      duration={5000}
      visibleToasts={4}
      toastOptions={{
        className: "rounded-2xl border border-border shadow-floating",
        classNames: {
          title: "font-semibold",
          description: "text-muted-foreground",
        },
      }}
    />
  );
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
      {children}
      <ThemedToaster />
    </ThemeProvider>
  );
}
