/**
 * Design tokens de Scire 360 Chronos para NativeWind (FASE 8).
 * Espeja apps/web/tailwind.config.ts: misma paleta, mismos radios.
 */
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{js,jsx,ts,tsx}", "./src/**/*.{js,jsx,ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      fontFamily: {
        sans: ["PlusJakartaSans_400Regular", "System"],
        semibold: ["PlusJakartaSans_600SemiBold", "System"],
        bold: ["PlusJakartaSans_700Bold", "System"],
      },
      colors: {
        brand: {
          50: "#eef2ff",
          100: "#e0e7ff",
          200: "#c7d2fe",
          300: "#a5b4fc",
          400: "#818cf8",
          500: "#6366f1",
          600: "#4f46e5",
          700: "#4338ca",
          800: "#3730a3",
          900: "#312e81",
          950: "#1e1b4b",
        },
        teal: "#14b8a6",
        violet: "#8b5cf6",
        surface: {
          DEFAULT: "#0f172a",
          raised: "#171e35",
        },
      },
      borderRadius: {
        "2xl": 16,
        "3xl": 24,
      },
    },
  },
  plugins: [],
};
