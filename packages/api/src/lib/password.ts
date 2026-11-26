import bcrypt from "bcryptjs";
import { loadConfig } from "../config.js";

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, loadConfig().BCRYPT_ROUNDS);
}

/**
 * Verifica una contrasena contra su hash.
 *
 * `hash` puede ser null (usuario INVITED que aun no fijo contrasena). En ese
 * caso se hace igualmente una comparacion contra un hash ficticio para que el
 * tiempo de respuesta no delate si la cuenta existe o esta activada.
 */
const DUMMY_HASH = "$2a$12$C6UzMDM.H6dfI/f/IKcEe.7QQeiaHhXjLPfDQ0.OB3T5nqfLxpsGO";

export async function verifyPassword(plain: string, hash: string | null): Promise<boolean> {
  if (!hash) {
    await bcrypt.compare(plain, DUMMY_HASH);
    return false;
  }
  return bcrypt.compare(plain, hash);
}
