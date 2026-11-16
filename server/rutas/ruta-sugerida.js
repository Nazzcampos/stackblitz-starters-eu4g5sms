// Ruta sugerida (ruteo), resumen del reparto y diagnóstico.
const { app, pool } = require('../core.js');
const { claveNombre, requireChofer } = require('../auth.js');
const { codigosReparto, esNotaCredito, calcularCobro } = require('./hoja-de-ruta.js');
const { hoyArgentina, fechaValida } = require('./documentacion.js');
const { filtroAnuladas, RE_FECHA } = require('./deposito.js');

// =====================================================================
//  RUTA SUGERIDA (mapa del chofer)
//  Calcula el recorrido por calles pasando por las paradas en el orden del reparto.
//  Usa un servicio OSRM (por defecto el público de OpenStreetMap Alemania); se puede cambiar con la variable ROUTING_URL.
// =====================================================================
const ROUTING_URL = (process.env.ROUTING_URL || 'https://routing.openstreetmap.de/routed-car/route/v1/driving').replace(/\/+$/, '');
const MAX_PUNTOS_RUTA = 50;
const cacheRutaSugerida = new Map();
const ultimaConsultaRuta = new Map();

function pedirJson(urlTexto, ms) {
    return new Promise((resolve, reject) => {
        let u;
        try { u = new URL(urlTexto); } catch (e) { return reject(new Error('URL inválida')); }
        const lib = u.protocol === 'http:' ? require('http') : require('https');
        const rq = lib.get(u, { headers: { 'User-Agent': 'BeniQ-flota/1.0', 'Accept': 'application/json' } }, resp => {
            const partes = [];
            resp.on('data', d => partes.push(d));
            resp.on('end', () => {
                try {
                    const j = JSON.parse(Buffer.concat(partes).toString('utf8'));
                    if (resp.statusCode >= 400) return reject(new Error(j.message || j.code || ('HTTP ' + resp.statusCode)));
                    resolve(j);
                } catch (e) { reject(new Error('Respuesta inválida del servicio de rutas')); }
            });
        });
        rq.on('error', reject);
        rq.setTimeout(ms, () => rq.destroy(new Error('El servicio de rutas tardó demasiado')));
    });
}

app.post('/api/ruta-sugerida', requireChofer, async (req, res) => {
    const crudos = Array.isArray((req.body || {}).puntos) ? req.body.puntos : [];
    const puntos = crudos.map(p => [Number(p && p[0]), Number(p && p[1])]);
    if (puntos.length < 2 || puntos.length > MAX_PUNTOS_RUTA
        || puntos.some(([la, lo]) => !Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180)) {
        return res.status(400).json({ error: 'Puntos inválidos para calcular la ruta' });
    }
    const ahora = Date.now();
    const quien = claveNombre(req.chofer);
    if (ahora - (ultimaConsultaRuta.get(quien) || 0) < 2000) return res.status(429).json({ error: 'Esperá un momento antes de recalcular la ruta' });
    ultimaConsultaRuta.set(quien, ahora);

    const coords = puntos.map(([la, lo]) => `${lo.toFixed(6)},${la.toFixed(6)}`).join(';');
    const hit = cacheRutaSugerida.get(coords);
    if (hit && ahora - hit.ts < 60000) return res.json(hit.datos);
    try {
        const j = await pedirJson(`${ROUTING_URL}/${coords}?overview=full&geometries=polyline6&steps=true&annotations=false&continue_straight=false`, 15000);
        if (j.code !== 'Ok' || !j.routes || !j.routes[0]) throw new Error(j.message || 'No se encontró un recorrido');
        const r = j.routes[0];
        const datos = {
            distancia: Math.round(r.distance), duracion: Math.round(r.duration), geometria: r.geometry,
            tramos: r.legs.map(l => ({
                distancia: Math.round(l.distance), duracion: Math.round(l.duration),
                pasos: l.steps.map(st => ({
                    t: st.maneuver.type, m: st.maneuver.modifier || '', n: st.name || '', ex: st.maneuver.exit || 0,
                    d: Math.round(st.distance), ll: [st.maneuver.location[1], st.maneuver.location[0]]
                }))
            }))
        };
        cacheRutaSugerida.set(coords, { ts: ahora, datos });
        if (cacheRutaSugerida.size > 200) cacheRutaSugerida.delete(cacheRutaSugerida.keys().next().value);
        res.json(datos);
    } catch (err) {
        console.error('⚠️ Ruta sugerida:', err.message);
        res.status(502).json({ error: 'No se pudo calcular la ruta en este momento' });
    }
});


// --- RESUMEN DEL REPARTO: cuántos clientes, cuánta plata y cuántos kilos lleva el chofer en un día ---
// El peso de Gescom (item.peso) es un entero: se asume en gramos. Si no coincide con Gescom, se ajusta con la variable PESO_DIVISOR (1000 = gramos, 1 = kilos).
const PESO_DIVISOR = Number(process.env.PESO_DIVISOR) > 0 ? Number(process.env.PESO_DIVISOR) : 1000;
app.get('/api/resumen-reparto', requireChofer, async (req, res) => {
    const fecha = String(req.query.fecha || '') || hoyArgentina();
    if (!RE_FECHA.test(fecha) || !fechaValida(fecha)) return res.status(400).json({ error: 'Fecha inválida' });
    try {
        const filtro = await filtroAnuladas();
        const palabras = t => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
        const claveChofer = palabras(req.chofer);
        const excluidos = new Set((process.env.CLIENTES_EXCLUIDOS_REPARTO || '').split(',').map(x => x.trim()).filter(Boolean));
        const codigos = await codigosReparto(req.chofer, fecha);
        const cab = await pool.query(`SELECT v.id::text AS id, v.cliente_id::text AS cliente_id, v.razon_social AS nombre, v.importe_total AS total, v.tipo_comprobante_codigo AS tipo, v.condpago_descripcion AS cond
            FROM venta v WHERE v.empleado_chofer_nombre = $1 AND (v.fecha_entrega::date = $2::date OR v.reparto_codigo::text = ANY($3::text[]))${filtro}`, [req.chofer, fecha, codigos]);
        // Igual que la lista de paradas: el remito de cajas a nombre del chofer y los clientes excluidos no cuentan
        const ventas = cab.rows.filter(f => palabras(f.nombre) !== claveChofer && !excluidos.has(String(f.cliente_id)));
        // Antes de facturar, la cabecera puede venir en $0: en ese caso se estima con el importe de los renglones
        const porVenta = new Map();
        if (ventas.length) {
            const r = await pool.query(`SELECT vi.venta_id::text AS id,
                    COALESCE(SUM(COALESCE(NULLIF(vi.unidades, 0), vi.cantidad * COALESCE(NULLIF(vi.unidad_factor, 0), 1)) * COALESCE(it.peso, 0)), 0) AS gramos,
                    COALESCE(SUM(vi.importe_total_c_imp), 0) AS importe
                FROM venta_item vi LEFT JOIN item it ON it.id = vi.item_id AND it.tenant_id = vi.tenant_id
                WHERE vi.venta_id = ANY($1::bigint[]) GROUP BY vi.venta_id`, [ventas.map(v => v.id)]);
            r.rows.forEach(f => porVenta.set(f.id, f));
        }
        let kg = 0, importe = 0, estimado = false;
        ventas.forEach(v => {
            if (esNotaCredito(v.tipo)) return; // las notas de crédito no suman al reparto
            const it = porVenta.get(v.id);
            if (it) kg += Number(it.gramos) / PESO_DIVISOR;
            const cab = Number(v.total) || 0;
            if (cab > 0) importe += cab;
            else if (it && Number(it.importe) > 0) { importe += Number(it.importe); estimado = true; }
        });
        res.json({
            fecha,
            clientes: new Set(ventas.map(v => v.cliente_id)).size,
            comprobantes: ventas.filter(v => !esNotaCredito(v.tipo)).length,
            contado: Number([...calcularCobro(ventas).values()].reduce((a, c) => a + c.contado, 0).toFixed(2)),
            importe: Number(importe.toFixed(2)),
            estimado,
            kg: Number(kg.toFixed(1))
        });
    } catch (err) {
        console.error('❌ Error al calcular el resumen del reparto:', err.message);
        res.status(500).json({ error: 'No se pudo calcular el resumen del reparto' });
    }
});

// --- Diagnóstico (solo con ADMIN_TOKEN): compara lo que Gescom tiene en un reparto con lo que cuenta la app ---
// /api/diagnostico-reparto?token=...&reparto=2447  (sin datos personales: solo códigos, fechas e importes)
app.get('/api/diagnostico-reparto', async (req, res) => {
    const tokenAdmin = process.env.ADMIN_TOKEN;
    if (!tokenAdmin || req.query.token !== tokenAdmin) return res.status(404).json({ error: 'No encontrado' });
    // /api/diagnostico-reparto?token=...&cliente=108&reparto=2447 -> dónde guarda Gescom el "Orden de reparto" del cliente
    if (req.query.cliente) {
        try {
            const cod = String(req.query.cliente).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20);
            const rep = String(req.query.reparto || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 30);
            const cut = t => t == null ? null : String(t).slice(0, 1500);
            const c = await pool.query(`/*DIAGCLI*/ SELECT codigo, direccion_entrega_id::text AS direccion_entrega_id, demora_entrega_id::text AS demora_entrega_id,
                    entidad_propiedades_json, entidad_fiscal_propiedades_json FROM cliente_hist WHERE actual = true AND codigo = $1 LIMIT 1`, [cod]);
            const t = await pool.query(`/*DIAGCLI2*/ SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
                    AND (table_name ILIKE '%direcc%' OR table_name ILIKE '%entrega%' OR table_name ILIKE '%sede%' OR table_name ILIKE '%ruta%' OR table_name ILIKE '%cliente%') ORDER BY 1`);
            const out = { cliente: c.rows.map(f => ({ codigo: f.codigo, direccion_entrega_id: f.direccion_entrega_id, demora_entrega_id: f.demora_entrega_id,
                entidad_propiedades_json: cut(f.entidad_propiedades_json), entidad_fiscal_propiedades_json: cut(f.entidad_fiscal_propiedades_json) })), tablas: t.rows.map(f => f.table_name) };
            if (rep) {
                const o = await pool.query(`/*DIAGCLI3*/ SELECT COUNT(*)::int AS ventas, COUNT(DISTINCT orden_planeado)::int AS planeado_distintos, MIN(orden_planeado) AS planeado_min, MAX(orden_planeado) AS planeado_max,
                        COUNT(DISTINCT orden_realizado)::int AS realizado_distintos, MIN(orden_realizado) AS realizado_min, MAX(orden_realizado) AS realizado_max
                    FROM venta WHERE reparto_codigo::text = $1`, [rep]);
                out.orden_en_venta = o.rows[0];
            }
            return res.json(out);
        } catch (err) { return res.status(500).json({ error: err.message }); }
    }
    // /api/diagnostico-reparto?token=...&vehiculos=1 -> últimos repartos con su vehículo (para armar la venta por camión)
    if (req.query.vehiculos) {
        try {
            const r = await pool.query(`/*DIAGVEH*/ SELECT r.reparto_codigo::text AS reparto, to_char(r.fecha_entrega, 'YYYY-MM-DD') AS fecha,
                    r.vehiculo_codigo::text AS vehiculo_codigo, r.vehiculo_nombre,
                    (SELECT COUNT(*) FROM venta v WHERE v.reparto_codigo::text = r.reparto_codigo::text) AS ventas
                FROM reparto r WHERE r.fecha_entrega >= CURRENT_DATE - 7 ORDER BY r.fecha_entrega DESC, r.reparto_codigo DESC LIMIT 40`);
            return res.json(r.rows);
        } catch (err) { return res.status(500).json({ error: err.message }); }
    }
    const reparto = String(req.query.reparto || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 30);
    if (!reparto) return res.status(400).json({ error: 'Falta reparto' });
    // /api/diagnostico-reparto?token=...&reparto=2447&orden=1 -> qué filas de cliente_ruta_hist tienen los clientes de ese reparto (sin nombres)
    if (req.query.orden) {
        try {
            const r = await pool.query(`/*DIAGORDEN*/ SELECT rh.fuerza_venta, rh.ruta_codigo, rh.ruta_descripcion, rh.vendedor_codigo, rh.frecuencia_visita,
                    COUNT(*)::int AS filas, COUNT(DISTINCT rh.cliente_id)::int AS clientes, MIN(rh.orden) AS orden_min, MAX(rh.orden) AS orden_max,
                    COUNT(DISTINCT rh.orden)::int AS ordenes_distintos
                FROM cliente_ruta_hist rh
                WHERE rh.actual = true AND rh.cliente_id IN (SELECT v.cliente_id FROM venta v WHERE v.reparto_codigo::text = $1)
                GROUP BY 1, 2, 3, 4, 5 ORDER BY filas DESC LIMIT 40`, [reparto]);
            const mult = await pool.query(`/*DIAGORDEN2*/ SELECT n, COUNT(*)::int AS clientes FROM (
                    SELECT rh.cliente_id, COUNT(*)::int AS n FROM cliente_ruta_hist rh
                    WHERE rh.actual = true AND rh.cliente_id IN (SELECT v.cliente_id FROM venta v WHERE v.reparto_codigo::text = $1)
                    GROUP BY rh.cliente_id) x GROUP BY n ORDER BY n`, [reparto]);
            return res.json({ grupos: r.rows, filas_por_cliente: mult.rows });
        } catch (err) { return res.status(500).json({ error: err.message }); }
    }
    try {
        const filas = await pool.query(`/*DIAG*/ SELECT v.id::text AS id, v.cliente_id::text AS cliente, v.empleado_chofer_nombre AS chofer,
                v.reparto_codigo AS reparto, to_char(v.fecha_entrega, 'YYYY-MM-DD') AS entrega, v.tipo_comprobante_codigo AS tipo,
                v.importe_total AS total, v.rechazada, v.no_entregada, v.es_adicional, v.entregada, v.cerrada
            FROM venta v WHERE v.reparto_codigo = $1 ORDER BY v.id LIMIT 600`, [reparto]);
        const grupos = {};
        filas.rows.forEach(f => {
            const k = [f.chofer, f.entrega, f.tipo, 'rech:' + f.rechazada, 'noent:' + f.no_entregada, 'adic:' + f.es_adicional].join(' | ');
            const g = grupos[k] || (grupos[k] = { ventas: 0, clientes: new Set(), total: 0 });
            g.ventas++; g.clientes.add(f.cliente); g.total += Number(f.total) || 0;
        });
        const salida = Object.entries(grupos).map(([grupo, g]) => ({ grupo, ventas: g.ventas, clientes: g.clientes.size, total: Number(g.total.toFixed(2)) }));
        const choferes = [...new Set(filas.rows.map(f => f.chofer))];
        res.json({ reparto, ventas_en_reparto: filas.rows.length, clientes_en_reparto: new Set(filas.rows.map(f => f.cliente)).size, choferes, grupos: salida });
    } catch (err) {
        console.error('❌ Error en el diagnóstico del reparto:', err.message);
        res.status(500).json({ error: err.message });
    }
});


module.exports = { ROUTING_URL, MAX_PUNTOS_RUTA, cacheRutaSugerida, ultimaConsultaRuta, pedirJson, PESO_DIVISOR };
