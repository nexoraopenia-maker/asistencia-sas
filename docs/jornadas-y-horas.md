# Jornadas, turnos nocturnos y cálculo de horas

Código: `packages/shared/src/workday.ts` (jornadas) y `labor.ts` (cálculo).

## Jornada y fecha operativa

- La unidad es la **sesión** entrada → salida, no el día de calendario.
- Una sesión pertenece a la fecha del turno que la ampara (llegada hasta 4 h antes del inicio, o antes de que termine). Sin turno, a la fecha local de la entrada.
- Una entrada sin salida sigue abierta durante `maxShiftHours` (16 por defecto). Después es incidencia `MISSING_OUT` y no suma horas.
- Turno partido: se admite otra entrada si ese día hay más turnos de trabajo que sesiones cerradas, o si la empresa activa `allowSplitShifts`.
- Zona horaria: la de la sucursal; si no tiene, la de la empresa.

## Cálculo (valores iniciales: Perú, régimen general privado)

Todos los parámetros se editan en *Configuración → Reglas laborales*.

| Concepto | Valor inicial |
|---|---|
| Jornada ordinaria | turno programado menos refrigerio; sin turno, 8 h |
| Jornada semanal | 48 h (semana lunes a domingo) |
| Sobretiempo tramo 1 | primeras 2 h, +25 % |
| Sobretiempo tramo 2 | resto, +35 % |
| Horario nocturno | 22:00 a 06:00 |
| Sobretasa nocturna | 35 % sobre la RMV (referencia mensual: RMV × 1.35) |
| Valor hora | remuneración / 240 |
| RMV de referencia | S/ 1 230 (D.S. 015-2026-TR, desde el 01/10/2026) |

El refrigerio no computa. La RMV se puede editar por empresa. Se aplica el valor actual a cualquier periodo consultado, también a los anteriores a octubre de 2026. El decreto prevé un segundo tramo (S/ 1 300 en 2027) que no se aplica solo: actualízalo cuando se publique su norma.

## Limitaciones

- Validar los parámetros y criterios con un asesor laboral.
- No hay catálogo de feriados ni de descansos semanales, ni su sobretasa. El trabajo sin turno se señala como `UNSCHEDULED_WORK`.
- No se guarda el sueldo por empleado: el sistema entrega horas, factores y referencias; la planilla valoriza.
- El exceso semanal se informa, no se valoriza. Las semanas cortadas por el rango del reporte quedan incompletas.
- "Jornada nocturna" (≥ 50 % del tiempo en horario nocturno) es un criterio interno configurable.
- Cambiar una regla recalcula también los periodos pasados. La tardanza queda fijada al marcar.
- Si alguien olvida la salida y vuelve a marcar antes de que venza `maxShiftHours`, esa marcación se toma como salida.

## Reportes y exportación

En *Reportes de nómina* hay atajos de cierre (hoy, ayer, semana, quincenas, mes). Las fechas son **de jornada**: un turno que termina de madrugada entra completo en el día en que empezó.

El Excel (`.xlsx`) tiene cuatro hojas:

| Hoja | Contenido |
|---|---|
| Resumen | Una fila por trabajador con totales |
| Detalle diario | Una fila por jornada: entrada, salida, horas, tardanza y observaciones (justificaciones e incidencias) |
| Incidencias | Una fila por incidencia, filtrable por tipo |
| Parametros | Reglas y referencias monetarias aplicadas |

Las duraciones son números con formato `[h]:mm`, así que se pueden sumar y multiplicar. El PDF es el resumen. La exportación requiere rol RRHH y un plan con reportes avanzados.

## Flujos de RRHH

En **Incidencias** (`/dashboard/incidencias`):

- Conteo y filtro por tipo (salida faltante, sin entrada, falta, tardanza, geocerca, etc.).
- **Regularizar:** agrega la marcación que falta. Origen `MANUAL`, motivo obligatorio y registro en auditoría. Se rechaza si no encaja en la jornada.
- **Justificar:** registra una ausencia ya aprobada. Las horas extra aprobadas autorizan el sobretiempo; una tardanza justificada se marca como tal; una falta injustificada no justifica el día.
- Aprobar o rechazar solicitudes pendientes (nadie resuelve la suya).
- Cumplimiento por colaborador: jornadas con turno completas, puntuales y sin salida anticipada.

Turnos, empleados, sucursales, auditoría y relojes biométricos siguen en sus pantallas.

## Modo sin conexión

Ver [`mobile.md`](mobile.md). El panel web **no** funciona sin conexión: muestra un aviso y no guarda cambios en cola. Las marcaciones sincronizadas desde el móvil figuran como `MOBILE_OFFLINE`.

## API

- `GET /api/v1/reports/payroll?from&to` — totales por colaborador.
- `GET /api/v1/reports/detail?from&to` — jornada por jornada, incidencias y parámetros aplicados.
- `POST /api/v1/punch/manual` — regularización (RRHH).
- `GET|POST /api/v1/absences`, `POST /api/v1/absences/:id/review` — ausencias y justificaciones.

## Despliegue

Ver [`despliegue.md`](despliegue.md). Orden: migraciones, API, web.
