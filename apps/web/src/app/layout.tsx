import type { Metadata } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import { Providers } from "../components/providers";
import "./globals.css";

const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Scire 360 Chronos",
    template: "%s · Scire 360 Chronos",
  },
  description:
    "Panel de Recursos Humanos: asistencia, turnos, nomina y auditoria laboral.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // `suppressHydrationWarning` es necesario con next-themes: el script que
    // fija la clase del tema corre antes de la hidratacion y React veria una
    // discrepancia entre servidor y cliente que no es un error.
    <html lang="es" className={jakarta.variable} suppressHydrationWarning>
      <body className="min-h-screen bg-background font-sans antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
