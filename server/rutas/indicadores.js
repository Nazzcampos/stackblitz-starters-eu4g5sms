// Indicadores del chofer para Pepsico: Rechazo %, Efectividad de entrega y Retorno de cartón, con ranking.
// Por ahora solo trae el DIAGNÓSTICO (solo lectura, protegido con ADMIN_TOKEN) para ver en qué columnas de Gescom
// está cada dato. Con lo que devuelva se arman las consultas definitivas y el panel del chofer.
const { app, pool } = require('../core.js');

// /api/diagnostico-indicadores?token=...   (opcional: &dias=30)
app.get('/api/diagnostico-indicadores', async (req, res) => {
    const tokenAdmin = process.env.ADMIN_TOKEN;
    if (!tokenAdmin || req.query.token !== tokenAdmin) return res.status(404).json({ error: 'No encontrado' });
    const dias = Math.min(Math.max(parseInt(req.query.dias, 10) || 30, 1), 120);
    if (req.query.paso === '2') return diagnosticoPaso2(req, res);
    if (req.query.paso === '3') return diagnosticoPaso3(req, res);
    const salida = { dias };
    const paso = async (clave, fn) => {
        try { salida[clave] = await fn(); } catch (err) { salida[clave] = { error: err.message }; }
    };

    // 1) Columnas de Gescom que pueden tener que ver con rechazos, entregas y cartón
    await paso('columnas', async () => {
        const r = await pool.query(`/*DIAGIND1*/ SELECT table_name, column_name, data_type FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name IN ('venta', 'venta_item', 'reparto')
              AND (column_name ILIKE '%rechaz%' OR column_name ILIKE '%entreg%' OR column_name ILIKE '%caja%' OR column_name ILIKE '%carton%'
                   OR column_name ILIKE '%devol%' OR column_name ILIKE '%envase%' OR column_name ILIKE '%liquid%' OR column_name ILIKE '%motivo%'
                   OR column_name ILIKE '%cerrad%' OR column_name ILIKE '%adicional%')
            ORDER BY table_name, column_name`);
        return r.rows;
    });

    // 2) Cómo se reparten las ventas de los últimos días según sus marcas (rechazada, no entregada, etc.)
    await paso('banderas_venta', async () => {
        const r = await pool.query(`/*DIAGIND2*/ SELECT COALESCE(v.tipo_comprobante_codigo, '') AS tipo, v.rechazada::text AS rechazada,
                v.no_entregada::text AS no_entregada, v.entregada::text AS entregada, v.es_adicional::text AS es_adicional, v.cerrada::text AS cerrada,
                COUNT(*)::int AS ventas, ROUND(SUM(v.importe_total)::numeric, 0) AS importe
            FROM venta v WHERE v.fecha_entrega >= CURRENT_DATE - $1::int
            GROUP BY 1, 2, 3, 4, 5, 6 ORDER BY ventas DESC LIMIT 60`, [dias]);
        return r.rows;
    });

    // 3) Por chofer: ventas, rechazadas y no entregadas de los últimos días (para ver que los números se parecen al informe de Pepsico)
    await paso('por_chofer', async () => {
        const r = await pool.query(`/*DIAGIND3*/ SELECT v.empleado_chofer_nombre AS chofer, COUNT(*)::int AS ventas,
                COUNT(*) FILTER (WHERE v.rechazada::text IN ('t', 'true', '1'))::int AS rechazadas,
                COUNT(*) FILTER (WHERE v.no_entregada::text IN ('t', 'true', '1'))::int AS no_entregadas,
                ROUND(SUM(v.importe_total) FILTER (WHERE v.rechazada::text IN ('t', 'true', '1'))::numeric, 0) AS importe_rechazado,
                ROUND(SUM(v.importe_total)::numeric, 0) AS importe_total
            FROM venta v
            WHERE v.fecha_entrega >= CURRENT_DATE - $1::int AND v.empleado_chofer_nombre IS NOT NULL
              AND (v.tipo_comprobante_codigo ILIKE 'FAC%')
            GROUP BY 1 ORDER BY 1`, [dias]);
        return r.rows;
    });

    // 4) Dónde está el cartón: artículos que parecen cajas/cartón y a qué comprobantes pertenecen
    await paso('articulos_carton', async () => {
        const r = await pool.query(`/*DIAGIND4*/ SELECT COALESCE(v.tipo_comprobante_codigo, '') AS tipo, vi.item_codigo AS codigo,
                COALESCE(it.descripcion, vi.item_codigo) AS descripcion, COUNT(*)::int AS lineas, SUM(vi.cantidad) AS cantidad
            FROM venta v
            JOIN venta_item vi ON vi.venta_id = v.id AND vi.tenant_id = v.tenant_id
            LEFT JOIN item it ON it.id = vi.item_id AND it.tenant_id = vi.tenant_id
            WHERE v.fecha_entrega >= CURRENT_DATE - $1::int
              AND (it.descripcion ILIKE '%caj%' OR it.descripcion ILIKE '%cart%' OR it.descripcion ILIKE '%envase%' OR it.descripcion ILIKE '%cajon%')
            GROUP BY 1, 2, 3 ORDER BY lineas DESC LIMIT 40`, [dias]);
        return r.rows;
    });

    // 5) Remitos a nombre del chofer (el remito de cajas del reparto): qué tipos de comprobante y cuántas líneas tienen
    await paso('remitos_a_nombre_del_chofer', async () => {
        const r = await pool.query(`/*DIAGIND5*/ SELECT COALESCE(v.tipo_comprobante_codigo, '') AS tipo, COUNT(DISTINCT v.id)::int AS ventas,
                COUNT(vi.*)::int AS lineas, SUM(vi.cantidad) AS cantidad
            FROM venta v LEFT JOIN venta_item vi ON vi.venta_id = v.id AND vi.tenant_id = v.tenant_id
            WHERE v.fecha_entrega >= CURRENT_DATE - $1::int AND v.empleado_chofer_nombre IS NOT NULL
              AND upper(regexp_replace(v.razon_social, '[^A-Za-z ]', ' ', 'g')) IN (
                  SELECT upper(regexp_replace(x.empleado_chofer_nombre, '[^A-Za-z ]', ' ', 'g')) FROM venta x WHERE x.empleado_chofer_nombre IS NOT NULL GROUP BY 1)
            GROUP BY 1 ORDER BY ventas DESC`, [dias]);
        return r.rows;
    });

    res.json(salida);
});

// Paso 2: por chofer y para un período, varias formas posibles de calcular cada indicador, para compararlas con el informe de Pepsico.
// /api/diagnostico-indicadores?token=...&paso=2&desde=2026-11-01&hasta=2026-11-15
async function diagnosticoPaso2(req, res) {
    const fechaOk = f => /^\d{4}-\d{2}-\d{2}$/.test(String(f || ''));
    const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
    const hasta = fechaOk(req.query.hasta) ? req.query.hasta : hoy;
    const desde = fechaOk(req.query.desde) ? req.query.desde : hoy.slice(0, 7) + '-01';
    const salida = { desde, hasta };
    const paso = async (clave, fn) => {
        try { salida[clave] = await fn(); } catch (err) { salida[clave] = { error: err.message }; }
    };
    const FAC = `v.tipo_comprobante_codigo ILIKE 'FAC%'`, NCR = `v.tipo_comprobante_codigo ILIKE 'NCR%'`;
    const MOT = `COALESCE(v.motivo_rechazo_codigo, '') <> ''`;

    // Por chofer: facturación, notas de crédito (con y sin motivo de rechazo) y conteos de entrega
    await paso('por_chofer', async () => {
        const r = await pool.query(`/*DIAGIND6*/ SELECT trim(v.empleado_chofer_nombre) AS chofer,
                ROUND(SUM(v.importe_total) FILTER (WHERE ${FAC})::numeric, 0) AS facturacion,
                ROUND(SUM(ABS(v.importe_total)) FILTER (WHERE ${NCR})::numeric, 0) AS ncr_total,
                ROUND(SUM(ABS(v.importe_total)) FILTER (WHERE ${NCR} AND COALESCE(v.es_adicional, 0) = 1)::numeric, 0) AS ncr_adicional,
                ROUND(SUM(ABS(v.importe_total)) FILTER (WHERE ${NCR} AND ${MOT})::numeric, 0) AS ncr_con_motivo_rechazo,
                ROUND(SUM(ABS(v.importe_total)) FILTER (WHERE ${MOT})::numeric, 0) AS cualquier_con_motivo_rechazo,
                COUNT(*) FILTER (WHERE ${FAC})::int AS facturas,
                COUNT(*) FILTER (WHERE ${FAC} AND COALESCE(v.entregada, 0) = 0)::int AS facturas_sin_entregada,
                COUNT(*) FILTER (WHERE ${FAC} AND COALESCE(v.no_entregada, 0) = 1)::int AS facturas_no_entregada,
                COUNT(*) FILTER (WHERE ${FAC} AND ${MOT})::int AS facturas_con_motivo_rechazo,
                COUNT(DISTINCT v.cliente_id) FILTER (WHERE ${FAC})::int AS clientes
            FROM venta v
            WHERE v.fecha_entrega::date BETWEEN $1::date AND $2::date AND COALESCE(v.empleado_chofer_nombre, '') <> ''
            GROUP BY 1 ORDER BY 1`, [desde, hasta]);
        return r.rows;
    });

    // Motivos de rechazo: qué comprobantes los llevan y cuánto suman
    await paso('motivos_rechazo', async () => {
        const r = await pool.query(`/*DIAGIND7*/ SELECT COALESCE(v.tipo_comprobante_codigo, '') AS tipo, v.motivo_rechazo_codigo AS codigo, v.motivo_rechazo_desc AS descripcion,
                COUNT(*)::int AS ventas, ROUND(SUM(ABS(v.importe_total))::numeric, 0) AS importe
            FROM venta v WHERE v.fecha_entrega::date BETWEEN $1::date AND $2::date AND ${MOT}
            GROUP BY 1, 2, 3 ORDER BY importe DESC NULLS LAST LIMIT 40`, [desde, hasta]);
        return r.rows;
    });
    await paso('motivos_cambio', async () => {
        const r = await pool.query(`/*DIAGIND8*/ SELECT COALESCE(v.tipo_comprobante_codigo, '') AS tipo, v.motivo_cambio_codigo AS codigo, v.motivo_cambio_desc AS descripcion,
                COUNT(*)::int AS ventas, ROUND(SUM(ABS(v.importe_total))::numeric, 0) AS importe
            FROM venta v WHERE v.fecha_entrega::date BETWEEN $1::date AND $2::date AND COALESCE(v.motivo_cambio_codigo, '') <> ''
            GROUP BY 1, 2, 3 ORDER BY importe DESC NULLS LAST LIMIT 40`, [desde, hasta]);
        return r.rows;
    });

    // Cartón por chofer: cajas en remitos REME y REMI (artículo "Caja de Carton Recuperada Buen Estado")
    await paso('carton_por_chofer', async () => {
        const r = await pool.query(`/*DIAGIND9*/ SELECT trim(v.empleado_chofer_nombre) AS chofer,
                SUM(vi.cantidad) FILTER (WHERE v.tipo_comprobante_codigo = 'REME')::int AS reme,
                SUM(vi.cantidad) FILTER (WHERE v.tipo_comprobante_codigo = 'REMI')::int AS remi,
                SUM(vi.cantidad) FILTER (WHERE v.tipo_comprobante_codigo = 'REME' AND COALESCE(v.es_adicional, 0) = 1)::int AS reme_adicional,
                SUM(vi.cantidad) FILTER (WHERE v.tipo_comprobante_codigo = 'REMI' AND COALESCE(v.es_adicional, 0) = 1)::int AS remi_adicional,
                COUNT(DISTINCT v.id) FILTER (WHERE v.tipo_comprobante_codigo = 'REME')::int AS remitos_reme,
                COUNT(DISTINCT v.id) FILTER (WHERE v.tipo_comprobante_codigo = 'REMI')::int AS remitos_remi
            FROM venta v JOIN venta_item vi ON vi.venta_id = v.id AND vi.tenant_id = v.tenant_id
            WHERE v.fecha_entrega::date BETWEEN $1::date AND $2::date AND vi.item_codigo = '1100000130'
              AND v.tipo_comprobante_codigo IN ('REME', 'REMI')
            GROUP BY 1 ORDER BY 1`, [desde, hasta]);
        return r.rows;
    });

    // Cajas de producto que salen por chofer (por si el retorno se mide contra lo despachado)
    await paso('cajas_producto_por_chofer', async () => {
        const r = await pool.query(`/*DIAGIND10*/ SELECT trim(v.empleado_chofer_nombre) AS chofer,
                ROUND(SUM(vi.cantidad)::numeric, 0) AS unidades_facturadas
            FROM venta v JOIN venta_item vi ON vi.venta_id = v.id AND vi.tenant_id = v.tenant_id
            WHERE v.fecha_entrega::date BETWEEN $1::date AND $2::date AND ${FAC}
              AND COALESCE(v.empleado_chofer_nombre, '') <> ''
            GROUP BY 1 ORDER BY 1`, [desde, hasta]);
        return r.rows;
    });

    res.json(salida);
}

// Paso 3: cómo se vincula una nota de crédito con su factura y cuántas facturas se rechazaron completas
// /api/diagnostico-indicadores?token=...&paso=3&desde=2026-11-01&hasta=2026-11-15
async function diagnosticoPaso3(req, res) {
    const fechaOk = f => /^\d{4}-\d{2}-\d{2}$/.test(String(f || ''));
    const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
    const hasta = fechaOk(req.query.hasta) ? req.query.hasta : hoy;
    const desde = fechaOk(req.query.desde) ? req.query.desde : hoy.slice(0, 7) + '-01';
    const salida = { desde, hasta };
    const paso = async (clave, fn) => {
        try { salida[clave] = await fn(); } catch (err) { salida[clave] = { error: err.message }; }
    };

    // Columnas de la venta que pueden vincular una nota de crédito con su factura de origen
    await paso('columnas_vinculo', async () => {
        const r = await pool.query(`/*DIAGIND11*/ SELECT column_name, data_type FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'venta'
              AND (column_name ILIKE '%orig%' OR column_name ILIKE '%relac%' OR column_name ILIKE '%referen%' OR column_name ILIKE '%padre%'
                   OR column_name ILIKE '%asoc%' OR column_name ILIKE '%anul%' OR column_name ILIKE '%comprobante%' OR column_name ILIKE '%pedido%')
            ORDER BY column_name`);
        return r.rows;
    });

    // Algunas notas de crédito de rechazo, sin datos personales (solo columnas que no son nombres, direcciones ni documentos)
    await paso('muestra_ncr', async () => {
        const r = await pool.query(`/*DIAGIND12*/ SELECT to_jsonb(v) AS fila FROM venta v
            WHERE v.tipo_comprobante_codigo ILIKE 'NCR%' AND COALESCE(v.motivo_rechazo_codigo, '') <> ''
              AND v.fecha_entrega::date BETWEEN $1::date AND $2::date ORDER BY v.id DESC LIMIT 4`, [desde, hasta]);
        const oculto = /razon|nombre|cuit|cuil|direccion|mail|telefono|domicilio|contacto|observ|json|dni|documento_n|alias|cliente_desc|empleado/i;
        return r.rows.map(f => Object.fromEntries(Object.entries(f.fila).filter(([k, v]) => !oculto.test(k) && v !== null).map(([k, v]) => [k, String(v).slice(0, 60)])));
    });

    // Por chofer: facturas con nota de crédito del mismo cliente y día, total (98% o más del importe) o parcial
    await paso('rechazo_total_por_chofer', async () => {
        const r = await pool.query(`/*DIAGIND13*/ WITH f AS (
                SELECT v.id, trim(v.empleado_chofer_nombre) AS chofer, v.cliente_id, v.fecha_entrega::date AS dia, v.importe_total AS imp
                FROM venta v WHERE v.tipo_comprobante_codigo ILIKE 'FAC%' AND v.fecha_entrega::date BETWEEN $1::date AND $2::date
                  AND COALESCE(v.empleado_chofer_nombre, '') <> ''),
            n AS (
                SELECT v.cliente_id, v.fecha_entrega::date AS dia, SUM(ABS(v.importe_total)) AS imp
                FROM venta v WHERE v.tipo_comprobante_codigo ILIKE 'NCR%' AND v.fecha_entrega::date BETWEEN $1::date AND $2::date
                  AND COALESCE(v.motivo_rechazo_codigo, '') <> ''
                GROUP BY 1, 2)
            SELECT f.chofer, COUNT(*)::int AS facturas,
                   COUNT(*) FILTER (WHERE n.imp >= 0.98 * f.imp AND f.imp > 0)::int AS rechazo_total,
                   COUNT(*) FILTER (WHERE n.imp > 0 AND n.imp < 0.98 * f.imp)::int AS rechazo_parcial
            FROM f LEFT JOIN n ON n.cliente_id = f.cliente_id AND n.dia = f.dia
            GROUP BY 1 ORDER BY 1`, [desde, hasta]);
        return r.rows;
    });

    res.json(salida);
}

module.exports = {};
