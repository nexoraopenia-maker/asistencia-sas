# Design system — Scire 360 Chronos

---

## Tipografía

**Plus Jakarta Sans** en web y móvil. En web vía `next/font/google` (autoalojada, sin petición a Google en runtime y sin salto de layout); en móvil vía `@expo-google-fonts/plus-jakarta-sans` empaquetada en el bundle.

Las cifras usan `font-variant-numeric: tabular-nums`. No es un detalle estético: sin anchura fija, las horas `HH:mm:ss` bailan al refrescarse en vivo y la tabla parece temblar.

---

## Color

Todo el color sale de **variables CSS**. Un componente nunca fija un tono de Tailwind directamente, porque el mismo tono no puede servir sobre el gradiente noche‑púrpura y sobre blanco.

### Identidad

| Token | Valor | Uso |
|---|---|---|
| Gradiente profundo | `#0f172a → #1e1b4b → #581c87` | Fondos de marca, login, app móvil |
| Gradiente de acción | `#312e81 → #4f46e5` | Botón primario, avatar |
| Turquesa | `#14b8a6` | Acento: presente, marcación válida |
| Morado eléctrico | `#8b5cf6` | Acento secundario: refrigerio |

### Estados semánticos

Cinco pares (`fg` para el texto, `bg` para el tinte y el borde) que **cambian con el tema**:

```css
.badge-success {
  border: 1px solid hsl(var(--state-success-bg) / 0.25);
  background-color: hsl(var(--state-success-bg) / 0.1);
  color: hsl(var(--state-success-fg));
}
```

En **oscuro** son los tonos `400` — exactamente la paleta del brief (`bg-emerald-500/10 text-emerald-400 border-emerald-500/20`). En **claro** son los `600‑700`: son los únicos que superan AA sobre un tinte del 10 % sobre blanco.

---

## Contraste WCAG AA

Los pares están **medidos, no estimados**. `pnpm --filter @scire/web contrast` calcula el ratio real de cada combinación, incluida la mezcla del tinte translúcido sobre la superficie.

La primera pasada encontró **9 fallos**, todos en modo claro:

| Par | Antes | Después |
|---|---|---|
| Badge alerta (`text-amber-400`) | **1.54:1** | 4.67:1 |
| Badge éxito (`text-emerald-400`) | 1.75:1 | 5.07:1 |
| Badge peligro (`text-rose-400`) | 2.37:1 | 5.51:1 |
| Turquesa sobre blanco | 2.49:1 | 5.21:1 |
| Violeta sobre tinte (oscuro) | 4.01:1 | 6.14:1 |
| `slate-500` terciario (oscuro) | 3.92:1 | 7.28:1 |

`1.54:1` es prácticamente ilegible. El fallo venía de que la paleta del brief está pensada para el gradiente oscuro —donde funciona muy bien, 9.67:1— y se estaba reutilizando tal cual sobre blanco.

**26/26 pares cumplen ahora el mínimo.** El script está en el repositorio para que una regresión se detecte antes de llegar a producción.

---

## Superficies

- Radios: `rounded-2xl` (16 px, base del sistema) y `rounded-3xl` (24 px) para contenedores mayores.
- Bordes ultrafinos: `border-white/10` en oscuro, `border-border` como token.
- Elevación en **dos capas**: una sombra amplia y difusa que separa del fondo, más un contacto cercano que ancla la tarjeta. Una sola sombra grande flota; una sola pequeña no separa.

```js
elevated: "0 1px 2px -1px rgb(2 6 23 / .10), 0 12px 32px -12px rgb(2 6 23 / .35)"
floating: "0 2px 4px -2px rgb(2 6 23 / .12), 0 24px 56px -20px rgb(2 6 23 / .45)"
```

---

## Movimiento

### Web — Framer Motion

Todo pasa por [`motion.tsx`](../apps/web/src/components/motion.tsx) para que tenga la misma curva y la misma duración. Una interfaz donde cada componente anima a su ritmo se percibe desordenada aunque cada pieza suelta esté bien.

Duraciones cortas a propósito: **240 ms de entrada, 120 ms de salida**. Esto es una herramienta que RRHH abre decenas de veces al día, no una landing; por encima de ~250 ms la animación deja de leerse como fluidez y empieza a leerse como lentitud.

El feed y el rastro de auditoría entran **escalonados** con 35 ms entre filas: suficiente para percibir la cascada, corto para que 50 filas no tarden dos segundos.

El cajón de navegación móvil entra con muelle (`damping: 30, stiffness: 320`).

### Móvil — Reanimated

- **CalendarStrip**: muelle en escala y opacidad al cambiar de día, más un halo turquesa. Se anima escala y opacidad, no color: interpolar color obliga a pasar por el hilo de JS y produce tirones en gama media; escala y opacidad viven en el hilo de UI y van a 60 fps aunque JS esté ocupado sincronizando la cola offline.
- **Confirmación de selfie**: el check entra con muelle y una *insinuación* de rebote —no un rebote completo, que se leería como juguetón en una herramienta de fichaje— y el texto le sigue con 120 ms de retardo. Esa secuencia es lo que hace que se perciba como «hecho».

### Movimiento reducido

`prefers-reduced-motion` desactiva desplazamientos y el barrido del shimmer. No es una preferencia estética: para quien tiene sensibilidad vestibular, el movimiento puede producir mareo. Con la preferencia activa el contenido aparece **sin desplazamiento, no sin aparecer**.

---

## Estados de carga y vacíos

**Skeletons con shimmer**, no spinners. El `animate-pulse` de Tailwind solo cambia la opacidad; el barrido de luz comunica mejor «esto está cargando» y evita que se confunda con un elemento deshabilitado.

**Empty states ilustrados** ([`empty-state.tsx`](../apps/web/src/components/empty-state.tsx)): calendario sin turnos, lupa sin resultados, reloj en calma, carpeta vacía. Son SVG en línea, no imágenes — heredan el color del tema (funcionan igual en claro y oscuro sin duplicar assets), pesan cientos de bytes y no provocan salto de layout.

El copy distingue **«no hay nada»** de **«tu búsqueda no encontró nada»**: son situaciones distintas y la salida también.

---

## Tema claro / oscuro / sistema

`next-themes` con `attribute="class"`. Tres estados, no dos: quien tiene el equipo en modo oscuro por la noche espera que el panel lo siga sin cambiarlo a mano.

La elección persiste en `localStorage` y se aplica **antes de la hidratación**, así que no hay destello de tema equivocado al cargar. `color-scheme` se declara en ambos temas para que el navegador pinte también scrollbars, autofill y selectores de fecha.

Contraído el sidebar alterna claro/oscuro; expandido muestra los tres.

---

## Responsive

| Ancho | Navegación |
|---|---|
| `< 1024px` | Barra superior con hamburguesa + cajón deslizante |
| `≥ 1024px` | Sidebar fijo, contraíble a 68 px |

Verificado a **390 px (iPhone 14), 834 px (iPad) y 1680 px (escritorio)**.

> La primera captura a 390 px destapó que el sidebar fijo de 256 px empujaba el contenido fuera de pantalla: el panel era inusable en un teléfono. El cajón resolvió eso.

Las tablas anchas —nómina tiene once columnas— van dentro de un contenedor con `overflow-x: auto`, de modo que la tabla se desplaza sin arrastrar la página entera.

---

## Toasts

Sonner con el tema resuelto del panel: sin pasárselo, en modo oscuro pinta tarjetas claras que deslumbran sobre el gradiente. Borde y radio igualados a los de las tarjetas para que se lean como parte del mismo sistema.

Duración de 5 s: suficiente para leer dos líneas sin que un error se pierda antes de que el usuario levante la vista.

---

## Foco

`:focus-visible` unificado con anillo de 2 px y offset. El navegador lo dibuja de formas distintas según el control; unificarlo evita que un usuario de teclado pierda de vista dónde está.
