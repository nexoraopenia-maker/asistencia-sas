import { uploadAsync, FileSystemUploadType, getInfoAsync } from "expo-file-system/legacy";
import { punchApi } from "./endpoints";
import { NetworkError } from "./client";

/**
 * Sube la selfie al bucket y devuelve la clave del objeto.
 *
 * La foto NO pasa por la API: se pide una URL PUT firmada y el dispositivo
 * sube el binario directamente a S3/R2. Ademas de ahorrar ancho de banda,
 * evita que la avalancha de marcaciones de las 9:00 sature el servidor.
 *
 * Se usa `uploadAsync` del sistema de ficheros y no `fetch` con un blob: en
 * React Native, convertir una foto de varios MB a blob la carga entera en
 * memoria JS, mientras que `uploadAsync` la transmite desde disco.
 */
export async function uploadSelfie(photoUri: string, punchType: string): Promise<string> {
  const info = await getInfoAsync(photoUri);
  if (!info.exists) {
    throw new Error("La foto ya no esta disponible en el dispositivo");
  }

  const contentType = "image/jpeg";
  const presigned = await punchApi.presignedUrl({
    punchType,
    contentType,
    contentLength: info.size ?? 0,
  });

  const result = await uploadAsync(presigned.uploadUrl, photoUri, {
    httpMethod: "PUT",
    uploadType: FileSystemUploadType.BINARY_CONTENT,
    // Las cabeceras van firmadas: si no coinciden exactamente, S3 rechaza el PUT.
    headers: presigned.requiredHeaders,
  });

  if (result.status < 200 || result.status >= 300) {
    throw new NetworkError(`El almacenamiento rechazo la subida (HTTP ${result.status})`);
  }

  return presigned.objectKey;
}
