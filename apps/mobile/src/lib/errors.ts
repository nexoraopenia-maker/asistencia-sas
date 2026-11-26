/**
 * Tipos de error del cliente.
 *
 * Viven aqui y no dentro del cliente HTTP para que la logica que los inspecciona
 * —traducir un codigo a un mensaje, decidir si una marcacion se encola— sea
 * comprobable sin arrastrar expo-constants ni expo-secure-store, que solo
 * existen dentro de un dispositivo.
 */

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * El dispositivo no pudo hablar con el servidor.
 *
 * Es un tipo aparte a proposito: es la UNICA situacion en la que una marcacion
 * debe irse a la cola offline. Un 422 por geocerca tambien "falla", pero
 * encolarlo solo aplazaria el mismo rechazo.
 */
export class NetworkError extends Error {
  constructor(message = "Sin conexion con el servidor") {
    super(message);
    this.name = "NetworkError";
  }
}
