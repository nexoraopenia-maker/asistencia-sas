const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");
const path = require("node:path");

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

// --- Soporte de monorepo ----------------------------------------------------
// Metro tiene que vigilar la raiz del workspace para recoger los cambios en
// packages/shared. Se ANADE a lo que Expo ya vigila por defecto: sobreescribir
// la lista deja fuera rutas que el propio Expo necesita.
config.watchFolders = [...(config.watchFolders ?? []), monorepoRoot];

// Resuelve modulos primero en la app y despues en la raiz del workspace.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(monorepoRoot, "node_modules"),
];

// NO se desactiva la busqueda jerarquica: con `nodeLinker: hoisted`
// (ver pnpm-workspace.yaml) el arbol es plano estilo npm y Metro necesita
// poder subir directorios para resolver dependencias transitivas como
// react-native-css-interop desde dentro de expo-router.

module.exports = withNativeWind(config, { input: "./src/global.css" });
