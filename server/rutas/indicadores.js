// Indicadores del chofer para Pepsico: Rechazo %, Efectividad de entrega y Retorno de cartón, con ranking.
// Por ahora solo trae el DIAGNÓSTICO (solo lectura, protegido con ADMIN_TOKEN) para ver en qué columnas de Gescom
// está cada dato. Con lo que devuelva se arman las consultas definitivas y el panel del chofer.
const { app, pool } = require('../core.js');

// /api/diagnostico-indicadores?token=...   (opcional: &dias=30)
app.get('/api/diagnostico-indicadores', async (req, res) => {
    const tokenAdmin = process.env.ADMIN_TOKEN;
    if (!tokenAdmin || req.query.token !== tokenAdmin) return res.status(404).json({ error: 'No encontrado' });
    const dias = Math.min(Math.max(parseInt(req.query.dias, 10) || 30, 1), 120);
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

module.exports = {};
