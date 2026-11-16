// Hoja de ruta con saldo, cuenta corriente detallada y cobro (contado / cuenta corriente).
const { app, pool } = require('../core.js');
const { db } = require('../base.js');
const { claveNombre, requireChofer, requireAdmin, clientesPermitidos } = require('../auth.js');
const { DIAS_DEUDA_RECIENTE, HOY_AR_SQL, obtenerDeudas, obtenerExhibidores, detectarColumnasCodigo } = require('../gescom.js');
const { hoyArgentina, fechaValida } = require('./documentacion.js');
const { filtroAnuladas, RE_FECHA } = require('./deposito.js');

// --- MÓDULO DE HOJA DE RUTA CON SALDO TOTAL (DÉBITOS - CRÉDITOS) ---
// Un reparto de Gescom puede llevar ventas con otra fecha de entrega (ej. pedidos del día siguiente cargados en el mismo reparto).
// Los repartos del chofer en esa fecha se toman de la tabla reparto, y se cuentan todas las ventas que lleva cada uno.
async function codigosReparto(chofer, fecha) {
    const codigos = new Set();
    // 1) Repartos de las propias ventas del chofer en esa fecha (no depende de la tabla reparto)
    try {
        const r = await pool.query(`/*REPARTOCOD1*/ SELECT DISTINCT reparto_codigo::text AS c FROM venta
            WHERE empleado_chofer_nombre = $1 AND fecha_entrega::date = $2::date AND reparto_codigo IS NOT NULL`, [chofer, fecha]);
        r.rows.forEach(f => codigos.add(String(f.c)));
    } catch (err) { console.error('⚠️ Repartos por ventas:', err.message); }
    // 2) Repartos de la tabla reparto (por si el reparto no tiene ventas ese día)
    try {
        const r = await pool.query(`/*REPARTOCOD2*/ SELECT DISTINCT reparto_codigo::text AS c FROM reparto
            WHERE empleado_chofer_nombre = $1 AND fecha_entrega = $2::date AND reparto_codigo IS NOT NULL`, [chofer, fecha]);
        r.rows.forEach(f => codigos.add(String(f.c)));
    } catch (err) { console.error('⚠️ Repartos por tabla reparto:', err.message); }
    return [...codigos];
}
const esNotaCredito = tipo => /^NC/i.test(String(tipo || ''));
const esCondContado = c => /^CON/i.test(String(c || '').trim());
// Cobro de cada cliente según la condición de pago: lo que es de contado lo cobra el chofer al entregar (facturas de contado menos notas de crédito)
function calcularCobro(rows) {
    const por = new Map();
    rows.forEach(v => {
        const k = String(v.cliente_id);
        const e = por.get(k) || { fac: 0, nc: 0, conds: new Set(), contado: false };
        const t = Math.abs(Number(v.total) || 0);
        if (esNotaCredito(v.tipo)) e.nc += t;
        else {
            if (v.cond) e.conds.add(String(v.cond).trim());
            if (esCondContado(v.cond)) { e.fac += t; e.contado = true; }
        }
        por.set(k, e);
    });
    const out = new Map();
    por.forEach((e, k) => out.set(k, { contado: e.contado ? Number(Math.max(0, e.fac - e.nc).toFixed(2)) : 0, condicion: [...e.conds].join(' / ') }));
    return out;
}

app.get('/api/ventas-chofer/:nombre', requireChofer, async (req, res) => {
    // Cada chofer solo puede ver su propio reparto
    if (claveNombre(decodeURIComponent(req.params.nombre)) !== claveNombre(req.chofer)) {
        return res.status(403).json({ error: 'No tenés acceso al reparto de otro chofer' });
    }
    const choferNombre = req.chofer;
    const fechaSeleccionada = req.query.fecha;

    try {
        const exprCodigo = await detectarColumnasCodigo();
        let query = `
            SELECT DISTINCT
                v.cliente_id AS id,
                ${exprCodigo} AS cliente_codigo,
                v.razon_social AS nombre,
                c.direccion,
                c.localidad,
                rh.latitud AS lat,
                rh.longitud AS lon,
                v.orden_planeado AS orden_planeado,
                rh.orden AS orden_ruta,
                v.reparto_codigo,
                v.empleado_chofer_nombre AS chofer,
                $2::date AS fecha_entrega
            FROM venta v
            JOIN cliente_hist c ON v.cliente_id = c.id AND c.actual = true
            JOIN cliente_ruta_hist rh ON v.cliente_id = rh.cliente_id AND rh.actual = true
            WHERE v.empleado_chofer_nombre = $1
              AND rh.latitud IS NOT NULL 
              AND rh.latitud != 0 
              AND rh.longitud IS NOT NULL 
              AND rh.longitud != 0
        `;

        const fechaEf = (fechaSeleccionada && RE_FECHA.test(fechaSeleccionada) && fechaValida(fechaSeleccionada)) ? fechaSeleccionada : hoyArgentina();
        const codigos = await codigosReparto(choferNombre, fechaEf);
        const params = [choferNombre, fechaEf, codigos];
        query += ` AND (v.fecha_entrega::date = $2::date OR v.reparto_codigo::text = ANY($3::text[])) `;

        query += ` ORDER BY reparto_codigo, orden_ruta ASC NULLS LAST, orden_planeado ASC;`;

        const resultado = await pool.query(query, params);

        // Se recuerda qué clientes recibió este chofer para limitar luego la consulta de cuenta corriente
        const claveChofer = claveNombre(choferNombre);
        if (!clientesPermitidos.has(claveChofer)) clientesPermitidos.set(claveChofer, new Set());
        resultado.rows.forEach(f => clientesPermitidos.get(claveChofer).add(String(f.id)));

        // La deuda se trae una sola vez para todos los clientes (con caché)
        let mapaDeudas = new Map();
        let mapaCodigos = new Map();
        let mapaRecientes = new Map();
        try {
            const deudas = await obtenerDeudas();
            mapaDeudas = deudas.mapa;
            mapaCodigos = deudas.codigos;
            mapaRecientes = deudas.recientes;
        } catch (errDeuda) {
            console.error("⚠️ No se pudo obtener la deuda, se devuelve la ruta sin saldos:", errDeuda.message);
        }

        // orden_planeado de Gescom llega siempre en 1, así que se numera según
        // la secuencia de la ruta del cliente (cliente_ruta_hist.orden)
        // Exhibidores en comodato de cada cliente (si falla la consulta, la ruta sale igual y sin ese dato)
        let mapaExhibidores = null;
        try {
            mapaExhibidores = await obtenerExhibidores(resultado.rows.map(f => f.id));
        } catch (errExh) {
            console.error("⚠️ No se pudieron obtener los exhibidores:", errExh.message);
        }

        // saldo_deuda = total de la cuenta corriente; deuda_cobrar = lo que ya corresponde cobrar;
        // deuda_reciente = pedidos de los últimos días que todavía no se cobran (se descuentan los créditos de lo más viejo primero)
        // En Gescom el chofer figura como "cliente" del remito de cajas/envases que sale en el reparto: no es una parada
        const palabras = t => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
        const claveChoferNombre = palabras(choferNombre);
        const excluidos = new Set((process.env.CLIENTES_EXCLUIDOS_REPARTO || '').split(',').map(x => x.trim()).filter(Boolean));
        const paradas = resultado.rows.filter(f =>
            palabras(f.nombre) !== claveChoferNombre
            && !excluidos.has(String(f.id)) && !(f.cliente_codigo && excluidos.has(String(f.cliente_codigo))));

        // Orden de reparto del camionero (importado de Gescom); los clientes sin ese dato van al final, con el orden de ruta como antes
        let ordenesReparto = new Map();
        try {
            if (db) (await db.query(`SELECT cliente_codigo, orden FROM flota_orden_cliente`)).rows.forEach(f => ordenesReparto.set(String(f.cliente_codigo), Number(f.orden)));
        } catch (errOrd) { console.error('⚠️ No se pudo leer el orden de reparto:', errOrd.message); }
        if (ordenesReparto.size) {
            const cod = f => String(f.cliente_codigo || mapaCodigos.get(String(f.id)) || '');
            paradas.forEach((f, i) => { f._i = i; f._ord = ordenesReparto.has(cod(f)) ? ordenesReparto.get(cod(f)) : null; });
            paradas.sort((a, b) => String(a.reparto_codigo).localeCompare(String(b.reparto_codigo), 'es', { numeric: true })
                || ((a._ord == null) - (b._ord == null)) || ((a._ord ?? 0) - (b._ord ?? 0)) || (a._i - b._i));
            paradas.forEach(f => { delete f._i; });
        }
        // Condición de pago de lo que se entrega (contado = lo cobra el chofer ahora)
        let cobros = new Map();
        try {
            const filtroAn = await filtroAnuladas();
            const cr = await pool.query(`/*COBRO*/ SELECT v.cliente_id::text AS cliente_id, v.tipo_comprobante_codigo AS tipo, v.condpago_descripcion AS cond, v.importe_total AS total
                FROM venta v WHERE v.empleado_chofer_nombre = $1 AND (v.fecha_entrega::date = $2::date OR v.reparto_codigo::text = ANY($3::text[]))${filtroAn}`, params);
            cobros = calcularCobro(cr.rows);
        } catch (errCob) { console.error('⚠️ No se pudo leer la condición de pago:', errCob.message); }
        const filas = paradas.map((f, i) => {
            const total = mapaDeudas.get(String(f.id)) || 0;
            const reciente = mapaRecientes.get(String(f.id)) || 0;
            const redondear = n => Number(n.toFixed(2));
            return {
                ...f,
                orden: i + 1,
                orden_reparto: f._ord == null ? null : f._ord,
                contado: (cobros.get(String(f.id)) || {}).contado || 0,
                condicion_pago: (cobros.get(String(f.id)) || {}).condicion || '',
                _ord: undefined,
                cliente_codigo: f.cliente_codigo || mapaCodigos.get(String(f.id)) || null,
                saldo_deuda: redondear(total),
                deuda_cobrar: total > 0 ? redondear(Math.max(0, total - reciente)) : 0,
                deuda_reciente: total > 0 ? redondear(Math.min(reciente, total)) : 0,
                dias_reciente: DIAS_DEUDA_RECIENTE,
                exhibidores: mapaExhibidores ? (mapaExhibidores.get(String(f.id)) || []) : null
            };
        });

        res.json(filas);

    } catch (err) {
        console.error("❌ Error al consultar las ventas del chofer en Gescom:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// --- MÓDULO DE CUENTA CORRIENTE DETALLADA (ÚLTIMA FOTO, CON CRÉDITOS EN NEGATIVO) ---
app.get('/api/cta-cte/:cliente_id', requireChofer, async (req, res) => {
    const clienteId = req.params.cliente_id;

    if (!/^\d+$/.test(clienteId)) {
        return res.status(400).json({ error: "cliente_id inválido" });
    }
    const permitidos = clientesPermitidos.get(claveNombre(req.chofer));
    if (!permitidos || !permitidos.has(clienteId)) {
        return res.status(403).json({ error: "Ese cliente no figura en tu reparto. Actualizá la hoja de ruta." });
    }

    try {
        const { fecha } = await obtenerDeudas();
        if (!fecha) return res.json([]);

        const query = `
            SELECT tipo_comprobante_codigo,
                   punto_venta_codigo,
                   numero_comprobante,
                   numero_cuota,
                   to_char(fecha_comprobante, 'YYYY-MM-DD') AS fecha_comprobante,
                   to_char(fecha_vencimiento, 'YYYY-MM-DD') AS fecha_vencimiento,
                   importe_original,
                   CASE WHEN es_credito THEN -importe ELSE importe END AS saldo_pendiente,
                   es_credito,
                   (NOT es_credito AND fecha_comprobante::date > (${HOY_AR_SQL} - $3::int)) AS reciente,
                   detalle
            FROM cta_cte_cliente
            WHERE cliente_id = $1
              AND fecha_sync = $2::date
            ORDER BY es_credito, fecha_comprobante, numero_comprobante, numero_cuota;
        `;

        const resultado = await pool.query(query, [clienteId, fecha, DIAS_DEUDA_RECIENTE]);
        res.json(resultado.rows);

    } catch (err) {
        console.error("Error al consultar la cuenta corriente en Gescom:", err.message);
        res.status(500).json({ error: "Error interno al obtener la cuenta corriente" });
    }
});

app.get('/api/clientes/:dia', requireAdmin, async (req, res) => {
    const diaParam = req.params.dia.toUpperCase();
    const mapaDias = {
        'LU': 'lunes',
        'MA': 'martes',
        'MI': 'miercoles',
        'JU': 'jueves',
        'VI': 'viernes',
        'SA': 'sabado',
        'DO': 'domingo'
    };
    const columnaDia = mapaDias[diaParam] || 'lunes';

    try {
        const query = `
            SELECT 
                c.id AS id,
                c.razon_social AS nombre,
                c.direccion,
                c.localidad,
                rh.latitud AS lat,
                rh.longitud AS lon,
                rh.ruta_codigo,
                rh.orden
            FROM cliente_ruta_hist rh
            JOIN cliente_hist c ON rh.cliente_id = c.id AND c.actual = true
            WHERE rh.actual = true 
              AND rh.${columnaDia} = 1
            ORDER BY rh.orden ASC;
        `;
        const resultado = await pool.query(query);
        res.json(resultado.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


module.exports = { codigosReparto, esNotaCredito, esCondContado, calcularCobro };
