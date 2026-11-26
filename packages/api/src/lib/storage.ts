import { randomUUID } from "node:crypto";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { AppError, ErrorCode } from "@scire/shared";
import { isStorageConfigured, loadConfig } from "../config.js";

/**
 * Almacenamiento de selfies en S3 / Cloudflare R2.
 *
 * Las imagenes NUNCA se sirven por URL publica ni pasan por la API: el movil
 * las sube directamente al bucket con una URL PUT firmada de vida corta, y el
 * dashboard las lee con una URL GET firmada igual de efimera. Asi el servidor
 * no gasta ancho de banda en subir/servir binarios, y una fuga de la base de
 * datos no expone ninguna foto: solo claves de objeto inservibles por si solas.
 */

/**
 * Traduce cualquier fallo del SDK de AWS a un `AppError` de almacenamiento.
 *
 * Sin esto, un `S3_ENDPOINT` mal escrito sale del SDK como `TypeError: Invalid
 * URL` y el manejador de errores lo convierte en un 500 generico: el empleado
 * ve "Error interno del servidor" cuando el problema real es una variable de
 * entorno, y quien opera el despliegue no tiene ninguna pista.
 */
async function withStorageErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AppError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    console.error("[storage] fallo al firmar la peticion", error);
    throw new AppError(
      ErrorCode.STORAGE_ERROR,
      "El almacenamiento de selfies no esta disponible. Revisa la configuracion S3_* del servidor.",
      { detail },
    );
  }
}

let client: S3Client | undefined;

function getClient(): S3Client {
  const config = loadConfig();
  if (!isStorageConfigured(config)) {
    throw new AppError(
      ErrorCode.STORAGE_ERROR,
      "El almacenamiento de selfies no esta configurado. Revisa las variables S3_* en el entorno.",
    );
  }

  client ??= new S3Client({
    region: config.S3_REGION,
    ...(config.S3_ENDPOINT ? { endpoint: config.S3_ENDPOINT } : {}),
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: config.S3_ACCESS_KEY_ID!,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY!,
    },
  });
  return client;
}

/**
 * Construye la clave del objeto.
 *
 * El prefijo empieza por `companyId`: permite aplicar politicas de ciclo de
 * vida y borrados masivos por tenant (baja de contrato, derecho al olvido) con
 * un solo prefijo, sin recorrer la base de datos.
 */
export function buildSelfieKey(input: {
  companyId: string;
  userId: string;
  punchType: string;
  contentType: string;
}): string {
  const extension = input.contentType === "image/png" ? "png" : input.contentType === "image/webp" ? "webp" : "jpg";
  const day = new Date().toISOString().slice(0, 10);
  return `punches/${input.companyId}/${input.userId}/${day}/${input.punchType.toLowerCase()}-${randomUUID()}.${extension}`;
}

export interface PresignedPut {
  uploadUrl: string;
  objectKey: string;
  expiresAt: string;
  requiredHeaders: Record<string, string>;
}

/**
 * Firma una URL PUT para que el movil suba la selfie directamente.
 *
 * `ContentType` y `ContentLength` van dentro de la firma: el cliente no puede
 * subir un objeto de otro tipo ni de otro tamano al que se le autorizo, asi
 * que la URL no sirve para colar un binario arbitrario en el bucket.
 */
export async function createPresignedUpload(input: {
  objectKey: string;
  contentType: string;
  contentLength: number;
}): Promise<PresignedPut> {
  const config = loadConfig();
  const expiresIn = config.S3_PRESIGN_PUT_TTL;

  const command = new PutObjectCommand({
    Bucket: config.S3_BUCKET,
    Key: input.objectKey,
    ContentType: input.contentType,
    ContentLength: input.contentLength,
  });

  const uploadUrl = await withStorageErrors(() =>
    getSignedUrl(getClient(), command, { expiresIn }),
  );

  return {
    uploadUrl,
    objectKey: input.objectKey,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    requiredHeaders: {
      "Content-Type": input.contentType,
      "Content-Length": String(input.contentLength),
    },
  };
}

/**
 * Firma una URL GET de vida corta para ver una selfie desde el dashboard.
 *
 * El TTL esta topado a 15 minutos en la configuracion: una URL firmada de una
 * selfie es un dato biometrico circulando por la red, y cuanto menos viva,
 * menor es la ventana en la que un enlace reenviado por error sigue sirviendo.
 *
 * **Sobre el nombre del bucket**: una URL firmada tiene que direccionar el
 * objeto, asi que el host o la ruta contienen inevitablemente el bucket. Lo
 * que se puede —y se hace— es enmascararlo tras un dominio propio o CDN
 * cuando `S3_PUBLIC_BASE_URL` esta configurado. Conviene ser claro sobre el
 * alcance: el nombre del bucket no es un secreto y por si solo no da acceso a
 * nada; el control real es la firma y su caducidad. Las credenciales NUNCA
 * aparecen en la URL — la firma es un HMAC derivado, no la clave.
 */
export async function createPresignedDownload(objectKey: string): Promise<{
  url: string;
  expiresAt: string;
}> {
  const config = loadConfig();
  const expiresIn = config.S3_PRESIGN_GET_TTL;

  const command = new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: objectKey });
  const signed = await withStorageErrors(() => getSignedUrl(getClient(), command, { expiresIn }));

  return {
    url: maskBucketHost(signed, config.S3_PUBLIC_BASE_URL),
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
  };
}

/**
 * Reescribe el origen de una URL firmada para servirla por un dominio propio.
 *
 * La firma de AWS SigV4 cubre el host, asi que el CDN debe reenviar la
 * peticion al bucket **conservando la cabecera Host original**; de lo
 * contrario la firma no valida. Es la configuracion estandar de un dominio
 * personalizado en Cloudflare R2 o CloudFront.
 */
function maskBucketHost(signedUrl: string, publicBase?: string): string {
  if (!publicBase) return signedUrl;
  try {
    const source = new URL(signedUrl);
    const target = new URL(publicBase);
    source.protocol = target.protocol;
    source.host = target.host;
    return source.toString();
  } catch {
    return signedUrl;
  }
}

/**
 * Comprueba que la selfie llego realmente al bucket antes de dar por buena la
 * marcacion. Sin esto, un cliente podria pedir la URL firmada, no subir nada y
 * registrar una marcacion "con foto" que apunta a un objeto inexistente.
 */
export async function objectExists(objectKey: string): Promise<boolean> {
  const config = loadConfig();
  try {
    await getClient().send(new HeadObjectCommand({ Bucket: config.S3_BUCKET, Key: objectKey }));
    return true;
  } catch (error) {
    // Un 404 es la respuesta legitima: la selfie no llego. Cualquier otro
    // fallo (credenciales, endpoint, red) NO significa que falte la foto, y
    // devolver false lo haria pasar por "no la subiste" ante el empleado.
    const name = (error as { name?: string })?.name;
    if (name === "NotFound" || name === "NoSuchKey") return false;
    return withStorageErrors(() => Promise.reject(error));
  }
}

/**
 * Elimina objetos del bucket en lotes.
 *
 * `DeleteObjects` acepta hasta 1000 claves por llamada. Se trocea aqui en vez
 * de dejarlo al llamante: la purga de retencion puede tener que borrar decenas
 * de miles de selfies de golpe.
 *
 * Devuelve las claves realmente eliminadas. Una clave que ya no existe cuenta
 * como eliminada: el objetivo es que deje de estar, no que estuviera.
 */
export async function deleteObjects(objectKeys: string[]): Promise<string[]> {
  if (objectKeys.length === 0) return [];
  const config = loadConfig();
  const deleted: string[] = [];

  for (let index = 0; index < objectKeys.length; index += 1000) {
    const chunk = objectKeys.slice(index, index + 1000);
    const response = await withStorageErrors(() =>
      getClient().send(
        new DeleteObjectsCommand({
          Bucket: config.S3_BUCKET,
          Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: false },
        }),
      ),
    );

    for (const item of response.Deleted ?? []) {
      if (item.Key) deleted.push(item.Key);
    }
    for (const failure of response.Errors ?? []) {
      // Un objeto ausente ya cumple el objetivo de la purga.
      if (failure.Code === "NoSuchKey" && failure.Key) deleted.push(failure.Key);
      else console.error("[storage] no se pudo borrar", failure.Key, failure.Message);
    }
  }

  return deleted;
}

/** Solo para tests: descarta el cliente memorizado. */
export function resetStorageClient(): void {
  client = undefined;
}
