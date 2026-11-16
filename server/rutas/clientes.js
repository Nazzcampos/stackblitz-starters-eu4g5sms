// ================================================================
//  MÓDULO PROVISORIO: Seguimiento de clientes  ->  /clientes
//  Para QUITARLO: borrar este archivo, clientes.html (en la raíz)
//  y la línea  require('./server/rutas/clientes.js');  de index.js.
//  No toca nada más de BeniQ ni usa la base propia (Supabase).
//
//  Variables de entorno (Render > Environment):
//      CLIENTES_PIN   -> PIN de acceso del supervisor de ventas (obligatoria)
//      GESCOM_TENANT  -> tenant de BIDO en Gescom (por defecto 116)
//
//  FECHA DE ALTA: Gescom no la guarda (la primera versión de todo cliente
//  figura con fecha 2000-01-01). Se estima con el número correlativo hist_id:
//  la primera fila de un cliente nuevo recibe el número siguiente al último que
//  había, así que su alta es la fecha de la primera fila con fecha real que entró
//  después. Los clientes que ya existían al empezar el registro quedan como
//  "previos" (sin fecha de alta).
// ================================================================
const path = require('path');
const { app, pool } = require('../core.js');

const TENANT = Number(process.env.GESCOM_TENANT || 116);
const PIN = process.env.CLIENTES_PIN || '';
const CACHE_MS = 10 * 60 * 1000; // 10 minutos, para no cargar a Gescom en cada visita

// Comprobantes que NO cuentan como compra: remitos de comodato (REME/REMI) y notas de crédito (NCR-A/B)
const EXCLUIR_COMPROBANTES = ['REM%', 'NC%'];

const SQL = `
WITH h AS (
  SELECT id, hist_id, fecha_inicio
  FROM cliente_hist
  WHERE tenant_id = $1
),
primera AS (
  SELECT id, MIN(hist_id) AS h0 FROM h GROUP BY id
),
eventos AS (
  SELECT h0 AS hid, id, NULL::timestamp AS f FROM primera
  UNION ALL
  SELECT hist_id, NULL::bigint, fecha_inicio FROM h WHERE fecha_inicio > '2001-01-01'
),
estim AS (
  SELECT id, MIN(f) OVER (ORDER BY hid DESC, (f IS NULL) ROWS UNBOUNDED PRECEDING) AS alta
  FROM eventos
),
inicio AS (
  SELECT MIN(fecha_inicio) AS f0 FROM h WHERE fecha_inicio > '2001-01-01'
),
alta AS (
  SELECT e.id,
         CASE WHEN COALESCE(e.alta, now()) < (SELECT f0 FROM inicio) + interval '7 days' THEN NULL
              ELSE COALESCE(e.alta, now()) END AS fecha_alta
  FROM estim e
  WHERE e.id IS NOT NULL
),
cli AS (
  SELECT c.id, c.codigo, c.nombre, c.localidad,
         COALESCE(NULLIF(c.ramo_descripcion, ''), 'Sin ramo') AS ramo,
         COALESCE(c.subramo_descripcion, '') AS subramo,
         COALESCE(c.segmento_cliente_descripcion, '') AS segmento,
         (c.activo AND c.tipo_inactivo IS NULL) AS activo
  FROM cliente_hist c
  WHERE c.actual AND c.tenant_id = $1
),
ruta AS (
  SELECT DISTINCT ON (r.cliente_id) r.cliente_id, r.vendedor_codigo, r.vendedor_nombre
  FROM cliente_ruta_hist r
  WHERE r.actual AND r.tenant_id = $1
  ORDER BY r.cliente_id, (r.fuerza_venta = 'Principal') DESC NULLS LAST, r.vendedor_codigo
),
pc AS (
  SELECT v.cliente_id, MIN(v.fecha_comprobante) AS primera_compra
  FROM venta v
  WHERE v.tenant_id = $1
    AND v.fecha_comprobante IS NOT NULL
    AND NOT (COALESCE(v.tipo_comprobante_codigo, '') ILIKE ANY ($2::text[]))
  GROUP BY v.cliente_id
)
SELECT cli.codigo, cli.nombre, cli.localidad, cli.ramo, cli.subramo, cli.segmento, cli.activo,
       ruta.vendedor_codigo, ruta.vendedor_nombre,
       to_char(alta.fecha_alta, 'YYYY-MM-DD') AS alta,
       to_char(pc.primera_compra, 'YYYY-MM-DD') AS primera_compra
FROM cli
LEFT JOIN ruta ON ruta.cliente_id = cli.id
LEFT JOIN alta ON alta.id = cli.id
LEFT JOIN pc   ON pc.cliente_id = cli.id
ORDER BY cli.nombre;
`;

let cache = { t: 0, data: null, pendiente: null };

async function obtenerDatos(forzar) {
    if (!forzar && cache.data && Date.now() - cache.t < CACHE_MS) return cache.data;
    if (cache.pendiente) return cache.pendiente;
    cache.pendiente = (async () => {
        try {
            const { rows } = await pool.query(SQL, [TENANT, EXCLUIR_COMPROBANTES]);
            cache.data = rows;
            cache.t = Date.now();
            return rows;
        } finally {
            cache.pendiente = null;
        }
    })();
    return cache.pendiente;
}

app.get('/clientes', (req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'clientes.html'));
});

app.get('/api/clientes/datos', async (req, res) => {
    if (!PIN) {
        return res.status(500).json({ error: 'Falta configurar CLIENTES_PIN en Render.' });
    }
    if (req.get('x-pin') !== PIN) {
        return res.status(401).json({ error: 'PIN incorrecto' });
    }
    try {
        const filas = await obtenerDatos(req.query.refresh === '1');
        res.json({ actualizado: new Date(cache.t).toISOString(), filas });
    } catch (err) {
        console.error('❌ [clientes] Error en consulta:', err.message);
        res.status(500).json({ error: err.message });
    }
});

console.log('📊 Módulo provisorio de seguimiento de clientes activo en /clientes');

module.exports = {};