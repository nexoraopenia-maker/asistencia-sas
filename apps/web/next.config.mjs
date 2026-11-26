import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Produce un bundle autocontenido: la imagen Docker no necesita node_modules.
  output: "standalone",
  // El build de Next debe salir de la raiz del monorepo para arrastrar
  // los paquetes del workspace dentro del bundle standalone.
  //
  // `fileURLToPath` y NO `new URL(...).pathname`: pathname devuelve la ruta
  // percent-encoded, asi que una carpeta con espacios se convierte en
  // "marcacion%20de%20asistencia" — un directorio que no existe. Next no falla,
  // simplemente no genera el standalone, y el error solo aparece al desplegar.
  outputFileTracingRoot: fileURLToPath(new URL("../../", import.meta.url)),
  reactStrictMode: true,
  transpilePackages: ["@scire/shared", "@scire/database"],
  // exceljs trae dependencias de Node (streams, zlib) que webpack no debe
  // empaquetar: se dejan como externas para que el route handler las cargue
  // en tiempo de ejecucion.
  serverExternalPackages: ["exceljs"],
  // En Next 15.5 dejo de ser experimental.
  typedRoutes: true,
};

export default nextConfig;
