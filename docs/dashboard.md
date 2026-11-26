# Dashboard web de RRHH — Scire 360 Chronos

Next.js 15 (App Router) · Tailwind · shadcn/ui · Recharts

---

## Arquitectura de sesión: BFF con cookies httpOnly

El navegador **nunca ve el token**. La secuencia es:

```
Navegador ──► /api/auth/login  ──► API  (valida credenciales y rol)
          ◄── Set-Cookie httpOnly: scire_at, scire_rt

Navegador ──► /api/proxy/v1/… ──► lee la cookie, adjunta el Bearer ──► API
          ◄── respuesta (+ cookies rotadas si el token había caducado)
```

Guardar el token en `localStorage`, que es lo habitual, convierte cualquier XSS —una dependencia comprometida, un nombre de empleado renderizado sin escapar— en un robo de sesión completo. Con `httpOnly`, un XSS puede actuar mientras la pestaña está abierta pero no puede exfiltrar la credencial.

El proxy también centraliza el **refresco**: cuando la API responde 401, refresca, resella las cookies y reintenta. Si el refresco falla, borra las cookies para que el middleware devuelva al login en vez de dejar un panel que no carga nada.

**El refresco no se hace en Server Components**: allí no se pueden escribir cookies, y un refresco cuyo resultado se pierde acabaría disparando la detección de reutilización del backend contra el propio usuario.

**El rol se comprueba en el servidor.** `/api/auth/login` rechaza a quien no sea `HR_ADMIN` o superior: un colaborador con credenciales válidas entra en la app móvil, no aquí. No es ocultar botones en la interfaz.

---

## Módulos

| Ruta | Qué hace |
|---|---|
| `/dashboard` | Feed en vivo: tabla y tarjetas, refresco cada 15 s, filtro de alertas, inspector de marcación |
| `/dashboard/empleados` | Listado con búsqueda, filtros, invitación y suspensión/reactivación |
| `/dashboard/horarios` | Matriz semanal, asignación masiva de plantillas y reglas de tolerancia |
| `/dashboard/reportes` | KPIs, gráficos y exportación en Excel y PDF |
| `/dashboard/auditoria` | Rastro inmutable con comparación lado a lado del valor previo y el nuevo |
| `/dashboard/configuracion` | Reglas de marcación, sucursales y geocercas |
| `/dashboard/suscripcion` | Plan, consumo de asientos e historial de facturas |

El **selector de sucursal** es global: vive en el sidebar, se recuerda en `localStorage` y filtra el feed, los KPIs y la nómina desde una sola decisión.

---

## Detalles que importan

**El feed refresca sin spinner.** Un parpadeo cada 15 segundos en una pantalla que RRHH deja abierta todo el día es insoportable. El polling se puede pausar.

**La alerta de GPS simulado gana a todo lo demás.** El orden de las comprobaciones de estado es deliberado: una tardanza en una marcación falsificada es lo de menos.

**El mapa de geocerca es SVG, no un proveedor de mapas.** Lo que RRHH necesita saber es si el punto cayó dentro del radio y a qué distancia, no el callejero. Evita además enviar las coordenadas de un empleado a un tercero solo para pintar un recuadro.

**Las selfies se piden al abrir el modal.** La URL firmada caduca en minutos y la clave del objeto nunca sale en el listado — solo un booleano `hasSelfie`.

**El alta de empleado es una invitación.** RRHH nunca conoce credenciales ajenas: la persona fija su propia contraseña con un token de un solo uso. Es lo que hace creíble el rastro de auditoría.

**Los accesos se ocultan del rastro por defecto.** Los `LOGIN` generan una entrada por sesión y en pocas semanas son el 95 % de la tabla, enterrando justo lo que este módulo existe para inspeccionar. Siguen consultables con "Incluir accesos".

**Las tolerancias solo afectan al futuro.** La tardanza de un registro ya existente se calculó con la regla vigente en aquel momento y no se recalcula.

---

## Exportación de nómina

Se genera en el servidor de Next (`/api/reports/payroll`), no en el navegador: el token vive en una cookie que el cliente no puede leer, y un informe de 150 colaboradores por 30 días no debería construirse en el hilo principal de una pestaña.

- **Excel** (`exceljs`): cabecera con formato, fila congelada, autofiltro y fila de totales — lo primero que busca quien revisa una nómina.
- **PDF** (`pdf-lib`): A4 apaisado con salto de página automático y pie con numeración. Se eligió `pdf-lib` sobre `pdfkit` porque es JavaScript puro sin ficheros de fuente que empaquetar, lo que evita sorpresas con el bundler en el route handler.

Las horas salen como `8:30`, no como `8.5`: la unidad de la nómina son horas y minutos.

---

## Tema claro/oscuro

`next-themes` con `attribute="class"`. Todo el color sale de variables CSS, así que el cambio de tema es un intercambio de tokens y no un árbol de clases `dark:`. `color-scheme` se declara en ambos temas para que el navegador pinte también los controles nativos —scrollbars, autofill, selectores de fecha— o el modo oscuro se rompería en los bordes.

---

## Verificación en navegador

Las capturas de esta fase se tomaron con Chrome headless por CDP, inyectando las cookies httpOnly de una sesión real (no se pueden fijar desde JavaScript de página). El script vive en el scratchpad de la sesión; para repetirlo:

```bash
# 1. API y web en marcha
node -r dotenv/config packages/api/dist/server.js &
cd apps/web && pnpm build
rm -rf .next/standalone/apps/web/.next/static .next/standalone/apps/web/public
cp -r .next/static .next/standalone/apps/web/.next/static
cp -r public .next/standalone/apps/web/public
(cd .next/standalone && API_URL=http://localhost:4000 PORT=3100 node apps/web/server.js &)
```

> **Al reiniciar el servidor standalone, mátalo por PID (`lsof -ti:3100`).** El proceso renombra su título a `next-server`, así que un `pkill -f "server.js"` no lo encuentra y se queda una instancia vieja sirviendo el build anterior — que se manifiesta como `ChunkLoadError` en el navegador.
