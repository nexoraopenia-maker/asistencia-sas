import type { Config } from "tailwindcss";

/**
 * Design tokens de Scire 360 Chronos (FASE 8).
 *
 * Los colores de shadcn/ui viven como variables CSS en globals.css para que el
 * cambio claro/oscuro sea un swap de variables y no un arbol de clases `dark:`.
 * Los tokens de marca (`brand`, `accent-teal`, `accent-violet`) son literales:
 * no cambian entre temas, son la identidad del producto.
 */
const config: Config = {
  darkMode: ["class"],
  content: ["./src/**/*.{ts,tsx}", "./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    container: {
      center: true,
      padding: "1.5rem",
      screens: { "2xl": "1400px" },
    },
    extend: {
      fontFamily: {
        sans: ["var(--font-sans)", "Plus Jakarta Sans", "Inter", "system-ui", "sans-serif"],
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },

        // --- Estados semanticos ---
        // Cambian con el tema. Un componente usa `text-state-success` y nunca
        // un tono fijo: el mismo tono no puede servir sobre el gradiente
        // noche-purpura y sobre blanco.
        state: {
          success: "hsl(var(--state-success-fg))",
          "success-bg": "hsl(var(--state-success-bg))",
          warning: "hsl(var(--state-warning-fg))",
          "warning-bg": "hsl(var(--state-warning-bg))",
          danger: "hsl(var(--state-danger-fg))",
          "danger-bg": "hsl(var(--state-danger-bg))",
          info: "hsl(var(--state-info-fg))",
          "info-bg": "hsl(var(--state-info-bg))",
          violet: "hsl(var(--state-violet-fg))",
          "violet-bg": "hsl(var(--state-violet-bg))",
        },

        // --- Identidad de marca ---
        brand: {
          50: "#eef2ff",
          100: "#e0e7ff",
          200: "#c7d2fe",
          300: "#a5b4fc",
          400: "#818cf8",
          500: "#6366f1",
          600: "#4f46e5", // Indigo electrico — accion primaria
          700: "#4338ca",
          800: "#3730a3",
          900: "#312e81", // Indigo profundo — fondo del gradiente
          950: "#1e1b4b",
        },
        teal: {
          DEFAULT: "#14b8a6", // Turquesa — presente / marcacion valida
        },
        violet: {
          DEFAULT: "#8b5cf6", // Morado electrico — acento secundario
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      backgroundImage: {
        // Gradiente maestro de la marca.
        "brand-deep": "linear-gradient(135deg, #0f172a 0%, #1e1b4b 45%, #581c87 100%)",
        "brand-cta": "linear-gradient(135deg, #312e81 0%, #4f46e5 100%)",
      },
      boxShadow: {
        // Elevacion en dos capas: una sombra amplia y difusa para separar del
        // fondo y un contacto cercano que ancla la tarjeta. Una sola sombra
        // grande flota; una sola pequena no separa.
        elevated:
          "0 1px 2px -1px rgb(2 6 23 / 0.10), 0 12px 32px -12px rgb(2 6 23 / 0.35)",
        floating:
          "0 2px 4px -2px rgb(2 6 23 / 0.12), 0 24px 56px -20px rgb(2 6 23 / 0.45)",
        glow: "0 0 32px -8px rgb(20 184 166 / 0.45)",
      },
      keyframes: {
        shimmer: {
          "100%": { transform: "translateX(100%)" },
        },
        "fade-up": {
          from: { opacity: "0", transform: "translateY(6px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
      },
      animation: {
        shimmer: "shimmer 1.8s infinite",
        "fade-up": "fade-up 0.25s ease-out both",
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};

export default config;
