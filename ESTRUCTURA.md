# BeniQ — cómo está ordenado el proyecto

```
index.js                      Arranque (≈ 25 líneas): carga los módulos y enciende el servidor
package.json                  (sin cambios)
index.html / admin.html / deposito.html   Estructura de cada pantalla (HTML)
public/
  css/  chofer.css  supervisor.css  deposito.css     Estilos de cada pantalla
  js/   chofer.js   supervisor.js   deposito.js      Lógica de cada pantalla
server/
  core.js        Servidor Express, páginas y conexión de SOLO LECTURA a Gescom
  base.js        Base propia (Supabase): conexión, tablas automáticas, limpieza diaria
  auth.js        Login, tokens, PIN, requireChofer / requireAdmin
  gescom.js      Consultas compartidas a Gescom (deudas, exhibidores, código de cliente)
  xlsx.js        Generador de Excel y utilidades de fechas
  rutas/
    choferes.js            Lista de choferes, PIN, login del chofer
    hoja-de-ruta.js        Hoja de ruta, cuenta corriente, cobro contado / cta. cte.
    gps-y-checklist.js     GPS (odómetro diario) y check-lists
    combustible.js         Cargas de combustible
    orden-de-reparto.js    Orden de reparto: propuestas, aprobación, exportación
    importar-orden.js      Importar el orden desde Gescom (Excel)
    documentacion.js       Documentación de camiones y choferes
    deposito.js            Retorno del camión y usuarios del depósito
    jornadas.js            Jornadas y kilómetros
    venta-por-camion.js    Venta por camión + costo logístico (combustible, km GPS) + Excel
    planificacion.js       Acompañantes (usuarios y PIN), planificación diaria de repartos, vista del acompañante
    indicadores.js         Indicadores del chofer para Pepsico (por ahora solo el diagnóstico de datos)
    clientes.js            Seguimiento de clientes, cobertura de marcas, stock en vivo, combos Pehuamar (lista de 227 clientes en server/datos/combos-clientes.json) y ruteo de vendedores (/clientes). Acceso: CLIENTES_PIN (5940) -> Supervisor (SUPERVISOR_PIN, 1234) o Vendedor (VENDEDORES_CODIGOS)
    ruta-sugerida.js       Ruta sugerida, resumen del reparto, diagnóstico
    comprobantes.js        Comprobantes en PDF
```

Dónde tocar según lo que quieras cambiar:
- Un cálculo o endpoint → el archivo del tema en `server/rutas/`.
- Cómo se ve una pantalla → `public/css/<pantalla>.css`.
- Cómo se comporta una pantalla → `public/js/<pantalla>.js`.
- Una tabla nueva → `server/base.js` (MIGRACION).

Novedades: campanita de notificaciones (server/avisos.js + rutas/notificaciones.js + public/js/campana.js), aviso de retornos compacto, cajas obligatorias, resumen mensual de combustible, cabecera con saludo, rediseño del panel admin, costo logístico por cliente/km/% de la venta en Venta por camión. Acompañantes y Planificación de repartos (acompanante.html, rutas/planificacion.js). Página /clientes (gestion.html en la raíz + rutas/clientes.js). Mapa del supervisor: tramos sin señal punteados, paradas, clientes visitados/pendientes del camión elegido y vista satélite. GPS: precisión máxima de envío 50 m y el odómetro no suma tramos menores al error del GPS.

## Depósito (perfil "Encargado depósito" en /gestion, código ENCARGADO_PIN, por defecto 1234)
Cartelera de indicadores por bodeguista (día, semana y mes), ranking, errores de armado e incentivo mensual. Código en `server/rutas/clientes.js` + `gestion.html`.
- Unidades y pedidos: `venta` por `fecha_preparacion`, tipos VEN/FAC-A/FAC-B, artículos con `item.prov_codigo = 100`.
- Errores: NC (`NCR%`) con `motivo_rechazo_desc` en la lista de motivos; solo artículos del proveedor 100; se asignan al día y preparador del pedido original (`venta_referenciada_id`).
- Minutos: el tiempo de picking NO está en la base de Gescom; se importa el Excel del reporte "Picking Bodeguista/Fecha" (botón en "Minutos de armado", tabla `deposito_gescom`). La corrección manual por día (`deposito_minutos`) pisa al valor de Gescom.
- Incentivo: base 65.832 (DEPOSITO_PREMIO_BASE), escalas de la planilla; ver `DEP_INCENTIVO`.
- Variables opcionales: DEPOSITO_PROVEEDOR, DEPOSITO_BODEGUISTAS, DEPOSITO_MOTIVOS (separados por |), ENCARGADO_PIN.
- Ajuste de errores por el encargado: se puede quitar una línea de error (tabla `deposito_error_excluir`) o escribir un total por día y bodeguista (`deposito_errores_ajuste`, reemplaza al calculado).

## CCC Pepsico (pestaña del supervisor en /gestion)
Clientes con 3 unidades o más de productos del proveedor 100 en el mes (facturas menos NC, por `fecha_entrega`) y saldo (`importe_total_c_imp`) mayor a $1.
Objetivo y avance por vendedor, y lista de clientes sin CCC por vendedor y zona (ruta). Objetivo por vendedor: de Gescom (`objetivo_detalle`, objetivo '15', grupo Pepsico, medida Cantidad); lo escrito a mano en la web (tabla `ccc_objetivo` en Supabase) tiene prioridad. Variables opcionales: CCC_MIN_UNIDADES, CCC_OBJETIVO_CODIGO.
Lista de faltantes: filtros por vendedor y día de visita (Lu a Vi), agrupada por vendedor y día; botón PDF (generado en el navegador, sin librerías) que en la PC se descarga y en el celular abre "Compartir" (WhatsApp, etc.).

## /gestion (antes /clientes) — rediseño oscuro y perfil Bodeguista
- La web ahora vive en `/gestion` (archivo `gestion.html`); `/clientes` redirige a `/gestion`. Las rutas de API `/api/seguimiento-clientes/...` no cambiaron.
- Diseño oscuro (paleta BeniQ, Inter, iconos tipo Lucide en SVG), menú lateral expandible/contraíble y barra superior (hora, estado de base de datos, usuario).
- Perfil **Bodeguista** (código `BODEGUISTA_PIN`, por defecto 1234, header `x-bod`): solo lectura, salvo "Pedir cartel" (ver abajo). Ve la tabla mensual de indicadores y el detalle de errores de armado (con filtro por bodeguista). No ve incentivo ($), ranking, minutos ni cartelera; no puede quitar errores, editar minutos ni importar. El servidor solo le habilita `GET /api/seguimiento-clientes/deposito` (sin incentivo); todos los POST siguen siendo del encargado.

## Administración — resúmenes de cuenta corriente en PDF (perfil "Administración" en /gestion)
- Código `ADMINISTRACION_PIN` (por defecto 1234, header `x-adm`). Código en `server/rutas/clientes.js` (sección ADMINISTRACIÓN) + vista `#vAdm` en `gestion.html`.
- Se arma con movimientos reales (el reporte de Gescom calcula mal los saldos): facturas / NC / ND de `venta`; cobros de `caja_movimiento` ("Cobro de cliente <código>", confirmados, varios medios = un cobro); ajustes DAJ/CAJ de `asiento_movimiento` (Gescom los guarda desde jul-2026).
- Saldo anclado a las fotos diarias de `cta_cte_cliente` (variable `CTA_FOTOS_DESDE`, por defecto 2026-07-27): lo que no se puede detallar queda como "Saldo anterior". El saldo se controla contra la foto de la fecha final y la pantalla avisa si no coincide.
- Clientes asociados (sucursales/bocas): grupos guardados en la tabla propia `adm_grupos` (Supabase), con sugerencia por mismo CUIT. Gescom no sincroniza su módulo de "clientes asociados".
- API: `/api/administracion/{grupos,buscar,resumen}`.

## Artículos y carteles de rack (bodeguistas / encargado → Administración)
- Pestaña **Artículos** (perfiles Bodeguista y Encargado): buscador por nombre o código de artículos activos de Gescom (`GET /api/seguimiento-clientes/articulos?q=`). El filtro de "activo" se detecta solo mirando las columnas de `item` (activo / habilitado / inactivo / baja).
- "Pedir cartel" (`POST .../articulos/pedir-cartel`): guarda el pedido en la tabla propia `cartel_pedidos` (código y nombre salen de Gescom, no del navegador; un artículo ya pedido y pendiente no se duplica). Es lo único que el bodeguista puede escribir.
- Perfil **Administración**: menú lateral con dos secciones separadas, "Resúmenes de cuenta" y "Carteles de rack". En Carteles hay una tarjeta con los pedidos pendientes/impresos; "Generar carteles" baja un PDF A4 horizontal, 4 carteles por hoja (código grande + nombre, con guías de corte punteadas) y marca los pedidos como impresos. Se pueden descartar pedidos. API: `/api/administracion/carteles`.
