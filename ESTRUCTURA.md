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

Novedades: campanita de notificaciones (server/avisos.js + rutas/notificaciones.js + public/js/campana.js), aviso de retornos compacto, cajas obligatorias, resumen mensual de combustible, cabecera con saludo, rediseño del panel admin, costo logístico por cliente/km/% de la venta en Venta por camión. Acompañantes y Planificación de repartos (acompanante.html, rutas/planificacion.js). Página /clientes (clientes.html en la raíz + rutas/clientes.js). Mapa del supervisor: tramos sin señal punteados, paradas, clientes visitados/pendientes del camión elegido y vista satélite. GPS: precisión máxima de envío 50 m y el odómetro no suma tramos menores al error del GPS.

## Depósito (perfil "Encargado depósito" en /clientes, código ENCARGADO_PIN, por defecto 1234)
Cartelera de indicadores por bodeguista (día, semana y mes), ranking, errores de armado e incentivo mensual. Código en `server/rutas/clientes.js` + `clientes.html`.
- Unidades y pedidos: `venta` por `fecha_preparacion`, tipos VEN/FAC-A/FAC-B, artículos con `item.prov_codigo = 100`.
- Errores: NC (`NCR%`) con `motivo_rechazo_desc` en la lista de motivos; solo artículos del proveedor 100; se asignan al día y preparador del pedido original (`venta_referenciada_id`).
- Minutos: el tiempo de picking NO está en la base de Gescom; se importa el Excel del reporte "Picking Bodeguista/Fecha" (botón en "Minutos de armado", tabla `deposito_gescom`). La corrección manual por día (`deposito_minutos`) pisa al valor de Gescom.
- Incentivo: base 65.832 (DEPOSITO_PREMIO_BASE), escalas de la planilla; ver `DEP_INCENTIVO`.
- Variables opcionales: DEPOSITO_PROVEEDOR, DEPOSITO_BODEGUISTAS, DEPOSITO_MOTIVOS (separados por |), ENCARGADO_PIN.
- Ajuste de errores por el encargado: se puede quitar una línea de error (tabla `deposito_error_excluir`) o escribir un total por día y bodeguista (`deposito_errores_ajuste`, reemplaza al calculado).

## CCC Pepsico (pestaña del supervisor en /clientes)
Clientes con 3 unidades o más de productos del proveedor 100 en el mes (facturas menos NC, por `fecha_entrega`) y saldo (`importe_total_c_imp`) mayor a $1.
Objetivo y avance por vendedor, y lista de clientes sin CCC por vendedor y zona (ruta). Objetivo por vendedor: de Gescom (`objetivo_detalle`, objetivo '15', grupo Pepsico, medida Cantidad); lo escrito a mano en la web (tabla `ccc_objetivo` en Supabase) tiene prioridad. Variables opcionales: CCC_MIN_UNIDADES, CCC_OBJETIVO_CODIGO.
Lista de faltantes: filtros por vendedor y día de visita (Lu a Vi), agrupada por vendedor y día; botón PDF (generado en el navegador, sin librerías) que en el celular abre "Compartir" para mandarlo por WhatsApp.
