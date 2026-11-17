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
    ruta-sugerida.js       Ruta sugerida, resumen del reparto, diagnóstico
    comprobantes.js        Comprobantes en PDF
```

Dónde tocar según lo que quieras cambiar:
- Un cálculo o endpoint → el archivo del tema en `server/rutas/`.
- Cómo se ve una pantalla → `public/css/<pantalla>.css`.
- Cómo se comporta una pantalla → `public/js/<pantalla>.js`.
- Una tabla nueva → `server/base.js` (MIGRACION).

Novedades: campanita de notificaciones (server/avisos.js + rutas/notificaciones.js + public/js/campana.js), aviso de retornos compacto, cajas obligatorias, resumen mensual de combustible, cabecera con saludo, rediseño del panel admin, costo logístico por cliente/km/% de la venta en Venta por camión.
