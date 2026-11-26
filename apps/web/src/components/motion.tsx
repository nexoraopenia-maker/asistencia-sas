"use client";

import { motion, useReducedMotion, type HTMLMotionProps, type Variants } from "framer-motion";
import type { ReactNode } from "react";

/**
 * Primitivas de movimiento.
 *
 * Todo el movimiento del panel pasa por aqui para que tenga la misma curva y
 * la misma duracion. Una interfaz donde cada componente anima a su ritmo se
 * percibe como desordenada aunque cada pieza suelta este bien.
 *
 * Duraciones cortas a proposito: esto es una herramienta de trabajo que RRHH
 * abre decenas de veces al dia, no una landing. Por encima de ~250 ms la
 * animacion deja de leerse como fluidez y empieza a leerse como lentitud.
 */

/** Curva de salida suave: rapida al principio, asentada al final. */
const EASE = [0.16, 1, 0.3, 1] as const;

export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.24, ease: EASE } },
  exit: { opacity: 0, y: 4, transition: { duration: 0.12 } },
};

export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: 0.18 } },
  exit: { opacity: 0, transition: { duration: 0.1 } },
};

/**
 * Contenedor con entrada escalonada.
 *
 * El retardo entre hijos es de 35 ms: suficiente para que el ojo perciba una
 * cascada, corto para que una tabla de 50 filas no tarde dos segundos en
 * aparecer. Se topa la cascada a las primeras filas por el mismo motivo.
 */
export const staggerContainer: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.035, delayChildren: 0.02 } },
};

/** Entrada de un panel lateral desde la derecha. */
export const slideInRight: Variants = {
  hidden: { opacity: 0, x: 24 },
  visible: { opacity: 1, x: 0, transition: { duration: 0.24, ease: EASE } },
  exit: { opacity: 0, x: 16, transition: { duration: 0.14 } },
};

/**
 * Envoltorio que respeta `prefers-reduced-motion`.
 *
 * No es una preferencia estetica: para quien tiene sensibilidad vestibular, el
 * movimiento puede producir mareo. Con la preferencia activa el contenido
 * aparece sin desplazamiento, no sin aparecer.
 */
export function Motion({
  children,
  variants = fadeUp,
  className,
  ...props
}: {
  children: ReactNode;
  variants?: Variants;
  className?: string;
} & Omit<HTMLMotionProps<"div">, "variants" | "children">) {
  const reduced = useReducedMotion();

  return (
    <motion.div
      initial="hidden"
      animate="visible"
      exit="exit"
      variants={reduced ? fadeIn : variants}
      className={className}
      {...props}
    >
      {children}
    </motion.div>
  );
}

/** Lista con entrada escalonada de sus hijos. */
export function MotionList({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const reduced = useReducedMotion();

  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={reduced ? fadeIn : staggerContainer}
      className={className}
    >
      {children}
    </motion.div>
  );
}

/** Elemento de una lista escalonada. */
export function MotionItem({
  children,
  className,
  ...props
}: { children: ReactNode; className?: string } & Omit<HTMLMotionProps<"div">, "children">) {
  return (
    <motion.div variants={fadeUp} className={className} {...props}>
      {children}
    </motion.div>
  );
}

export { motion, AnimatePresence } from "framer-motion";
