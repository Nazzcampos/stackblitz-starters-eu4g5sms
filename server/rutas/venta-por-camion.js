// Venta por camión (vista de administración y Excel).
const { app, pool } = require('../core.js');
const { db, requireDb } = require('../base.js');
const { claveNombre, requireAdmin } = require('../auth.js');
const { esNotaCredito } = require('./hoja-de-ruta.js');
const { ESTILO, crearXlsx, enviarXlsx, rangoFechas } = require('../xlsx.js');
const { normalizarDominio } = require('./documentacion.js');
const { filtroAnuladas } = require('./deposito.js');
const { SQL_DOMINIO } = require('./jornadas.js');
const { PESO_DIVISOR } = require('./ruta-sugerida.js');

// =====================================================================
//  VENTA POR CAMIÓN (Gescom: reparto.vehiculo_* + ventas del reparto)
// =====================================================================
const claveTextoVenta = t => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
const SQL_REPARTOS_VALIDOS = `COALESCE(r.cancelado::text, 'f') NOT IN ('t', 'true', '1')`;

// Costos del período por patente: litros, plata de combustible (cargas anotadas) y km del GPS.
const claveDom = d => String(d || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
async function costosFlota(desde, hasta) {
    const fecha = `(creado AT TIME ZONE 'America/Argentina/Buenos_Aires')::date`;
    const comb = await db.query(`SELECT ${SQL_DOMINIO('dominio')} AS clave, COALESCE(SUM(litros), 0)::float8 AS litros,
            COALESCE(SUM(costo_total), 0)::float8 AS costo,
            COALESCE(SUM(litros) FILTER (WHERE costo_total IS NOT NULL), 0)::float8 AS litros_con_costo
        FROM flota_combustible WHERE ${fecha} BETWEEN $1::date AND $2::date GROUP BY 1`, [desde, hasta]);
    const km = await db.query(`SELECT ${SQL_DOMINIO('vehiculo')} AS clave, COALESCE(SUM(km), 0)::float8 AS km
        FROM flota_odometro_dia WHERE fecha BETWEEN $1::date AND $2::date GROUP BY 1`, [desde, hasta]);
    const tc = comb.rows.reduce((t, f) => ({ c: t.c + f.costo, l: t.l + f.litros_con_costo }), { c: 0, l: 0 });
    return {
        precioLitro: tc.l > 0 ? tc.c / tc.l : null,
        comb: new Map(comb.rows.map(f => [f.clave, f])),
        km: new Map(km.rows.map(f => [f.clave, f.km]))
    };
}
const redondear = (n, d = 2) => n === null || n === undefined || !isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d;

// Algunas bases de Gescom no traen la columna "cancelado" en reparto: si no está, no se filtra por ella.
let _repartoCancelado = null;
async function repartoTieneCancelado() {
    if (_repartoCancelado !== null) return _repartoCancelado;
    try {
        const r = await pool.query(`/*COLREPARTO*/ SELECT 1 FROM information_schema.columns WHERE table_name = 'reparto' AND column_name = 'cancelado' LIMIT 1`);
        _repartoCancelado = r.rows.length > 0;
    } catch (e) { return true; }
    return _repartoCancelado;
}
async function consultarVentaCamion(q) {
    const rango = rangoFechas(q);
    if (!rango) return { error: 'Indicá desde y hasta (AAAA-MM-DD).' };
    if ((Date.parse(rango.hasta) - Date.parse(rango.desde)) > 92 * 86400000) return { error: 'El período máximo es de 3 meses.' };
    const filtro = await filtroAnuladas();
    const excluidos = new Set((process.env.CLIENTES_EXCLUIDOS_REPARTO || '').split(',').map(x => x.trim()).filter(Boolean));
    const validos = (await repartoTieneCancelado()) ? ` AND ${SQL_REPARTOS_VALIDOS}` : '';
    const desde = `FROM reparto r JOIN venta v ON v.reparto_codigo::text = r.reparto_codigo::text
                   WHERE r.fecha_entrega BETWEEN $1::date AND $2::date${validos}${filtro}`;
    const cab = await pool.query(`/*VENTACAMION*/ SELECT v.id::text AS id, v.cliente_id::text AS cliente_id, v.razon_social AS nombre,
            v.importe_total AS total, v.tipo_comprobante_codigo AS tipo, r.reparto_codigo::text AS reparto,
            to_char(r.fecha_entrega, 'YYYY-MM-DD') AS fecha, r.vehiculo_codigo::text AS codigo, r.vehiculo_nombre AS camion,
            v.empleado_chofer_nombre AS chofer ${desde}`, [rango.desde, rango.hasta]);
    const items = await pool.query(`/*VENTACAMION2*/ SELECT vi.venta_id::text AS id,
            COALESCE(SUM(COALESCE(NULLIF(vi.unidades, 0), vi.cantidad * COALESCE(NULLIF(vi.unidad_factor, 0), 1)) * COALESCE(it.peso, 0)), 0) AS gramos,
            COALESCE(SUM(vi.importe_total_c_imp), 0) AS importe
        FROM venta_item vi LEFT JOIN item it ON it.id = vi.item_id AND it.tenant_id = vi.tenant_id
        WHERE vi.venta_id IN (SELECT v.id ${desde}) GROUP BY vi.venta_id`, [rango.desde, rango.hasta]);
    const porVenta = new Map(items.rows.map(f => [f.id, f]));
    const grupos = new Map();
    cab.rows.forEach(v => {
        if (claveTextoVenta(v.nombre) === claveTextoVenta(v.chofer) || excluidos.has(String(v.cliente_id))) return;
        const k = v.reparto;
        const g = grupos.get(k) || { fecha: v.fecha, reparto: v.reparto, codigo: v.codigo, clave: claveNombre(v.camion), camion: v.camion, chofer: v.chofer, clientes: new Set(), comprobantes: 0, importe: 0, kg: 0, estimado: false };
        g.clientes.add(v.cliente_id);
        if (!esNotaCredito(v.tipo)) {
            const it = porVenta.get(v.id);
            g.comprobantes += 1;
            if (it) g.kg += Number(it.gramos) / PESO_DIVISOR;
            const c = Number(v.total) || 0;
            if (c > 0) g.importe += c;
            else if (it && Number(it.importe) > 0) { g.importe += Number(it.importe); g.estimado = true; }
        }
        grupos.set(k, g);
    });
    // El camión se identifica por su nombre en Gescom (el código numérico puede repetirse o cambiar de nombre)
    let mapa = new Map();
    try { (await db.query(`SELECT vehiculo_codigo, dominio FROM flota_camion_gescom`)).rows.forEach(f => mapa.set(f.vehiculo_codigo, f.dominio)); } catch (e) {}
    const filas = [...grupos.values()].map(g => ({
        fecha: g.fecha, reparto: g.reparto, codigo: g.codigo, clave: g.clave, camion: g.camion, dominio: mapa.get(g.clave) || mapa.get(g.codigo) || '', chofer: g.chofer,
        clientes: g.clientes.size, comprobantes: g.comprobantes, importe: Number(g.importe.toFixed(2)), kg: Number(g.kg.toFixed(1)), estimado: g.estimado
    })).sort((a, b) => b.fecha.localeCompare(a.fecha) || String(a.camion).localeCompare(String(b.camion), 'es', { numeric: true }));
    const por = new Map();
    filas.forEach(f => {
        const t = por.get(f.clave) || { codigo: f.codigo, clave: f.clave, camion: f.camion, dominio: f.dominio, fechas: new Set(), clientes: 0, importe: 0, kg: 0 };
        t.fechas.add(f.fecha); t.clientes += f.clientes; t.importe += f.importe; t.kg += f.kg;
        por.set(f.clave, t);
    });
    const resumen = [...por.values()].map(t => ({ codigo: t.codigo, clave: t.clave, camion: t.camion, dominio: t.dominio, dias: t.fechas.size, clientes: t.clientes,
        importe: Number(t.importe.toFixed(2)), kg: Number(t.kg.toFixed(1)), promedioDia: Number((t.importe / t.fechas.size).toFixed(2)) }))
        .sort((a, b) => String(a.camion).localeCompare(String(b.camion), 'es', { numeric: true }));
    // ---- Costo logístico: combustible (cargas del período) + otros costos por día de camión que indique el usuario ----
    const otros = Math.max(0, Number(String(q.otros || '0').replace(',', '.')) || 0);
    let costos = null;
    if (!q.sinCostos) try { costos = await costosFlota(rango.desde, rango.hasta); } catch (e) { console.error('⚠ Costos de flota:', e.message); }
    let ref = { importe: 0, clientes: 0, dias: 0, km: 0, combustible: 0, kg: 0 }, sinPatente = 0, sinDatos = 0;
    resumen.forEach(t => {
        const clave = claveDom(t.dominio);
        const c = costos && clave ? costos.comb.get(clave) : null;
        const kmGps = costos && clave ? (costos.km.get(clave) || 0) : 0;
        t.km = redondear(kmGps, 1); t.litros = c ? redondear(c.litros, 1) : null;
        t.combustible = null; t.combustibleEstimado = false;
        if (!t.dominio) sinPatente++;
        else if (!c && !kmGps) sinDatos++;
        if (c && (c.litros > 0 || kmGps > 0)) {
            let costo = c.costo;
            const sinCosto = c.litros - c.litros_con_costo;
            if (sinCosto > 0.01 && costos.precioLitro) { costo += sinCosto * costos.precioLitro; t.combustibleEstimado = true; }
            t.combustible = redondear(costo, 2);
        }
        t.otros = redondear(otros * t.dias, 2);
        const conDatos = t.combustible !== null;
        t.costoLogistico = conDatos ? redondear(t.combustible + t.otros, 2) : null;
        t.costoCliente = conDatos && t.clientes > 0 ? redondear(t.costoLogistico / t.clientes, 2) : null;
        t.costoKm = conDatos && kmGps > 0 ? redondear(t.costoLogistico / kmGps, 2) : null;
        t.pctVenta = conDatos && t.importe > 0 ? redondear(t.costoLogistico / t.importe * 100, 2) : null;
        t.costoKg = conDatos && t.kg > 0 ? redondear(t.costoLogistico / t.kg * 100, 2) : null;
        if (conDatos) { ref.importe += t.importe; ref.clientes += t.clientes; ref.dias += t.dias; ref.km += kmGps; ref.combustible += t.combustible; ref.kg += t.kg; }
    });
    const logist = ref.combustible + otros * ref.dias;
    const totales = {
        camionesConCosto: resumen.filter(t => t.combustible !== null).length, sinPatente, sinDatos, otrosPorDia: otros,
        importe: redondear(ref.importe), clientes: ref.clientes, dias: ref.dias, km: redondear(ref.km, 1),
        combustible: redondear(ref.combustible), costoLogistico: redondear(logist),
        costoCliente: ref.clientes > 0 ? redondear(logist / ref.clientes) : null,
        costoKm: ref.km > 0 ? redondear(logist / ref.km) : null,
        pctVenta: ref.importe > 0 ? redondear(logist / ref.importe * 100) : null,
        costoKg: ref.kg > 0 ? redondear(logist / ref.kg * 100) : null,
        ventaKm: ref.km > 0 ? redondear(ref.importe / ref.km) : null
    };
    return { desde: rango.desde, hasta: rango.hasta, filas, resumen, totales };
}
app.get('/api/admin/venta-camion', requireAdmin, requireDb, async (req, res) => {
    try {
        const r = await consultarVentaCamion(req.query);
        if (r.error) return res.status(400).json({ error: r.error });
        res.json(r);
    } catch (err) {
        console.error('❌ Venta por camión:', err.message);
        res.status(500).json({ error: 'No se pudo leer la venta por camión', detalle: String(err.message || '').slice(0, 300) });
    }
});
app.get('/api/admin/venta-camion/exportar', requireAdmin, requireDb, async (req, res) => {
    try {
        const r = await consultarVentaCamion(req.query);
        if (r.error) return res.status(400).json({ error: r.error });
        const fmtF = f => f.split('-').reverse().join('/');
        const num = v => ({ v, s: ESTILO.numero });
        const filas = [['Fecha', 'Camión', 'Patente', 'Chofer', 'Reparto', 'Clientes', 'Comprobantes', 'Importe ($)', 'Kg aprox.']];
        r.filas.slice().sort((a, b) => a.fecha.localeCompare(b.fecha) || String(a.camion).localeCompare(String(b.camion), 'es', { numeric: true }))
            .forEach(f => filas.push([fmtF(f.fecha), f.camion, f.dominio, f.chofer, f.reparto, num(f.clientes), num(f.comprobantes), num(f.importe), num(f.kg)]));
        const resumen = [['Camión', 'Patente', 'Días en ruta', 'Clientes visitados', 'Importe total ($)', 'Importe promedio por día ($)', 'Kg aprox.']];
        let tImp = 0, tKg = 0, tCli = 0;
        r.resumen.forEach(t => { tImp += t.importe; tKg += t.kg; tCli += t.clientes; resumen.push([t.camion, t.dominio, num(t.dias), num(t.clientes), num(t.importe), num(t.promedioDia), num(t.kg)]); });
        if (r.resumen.length) resumen.push([{ v: 'TOTAL', s: ESTILO.negrita }, '', '', { v: tCli, s: ESTILO.negritaNumero }, { v: Number(tImp.toFixed(2)), s: ESTILO.negritaNumero }, '', { v: Number(tKg.toFixed(1)), s: ESTILO.negritaNumero }]);
        const costosH = [['Camión', 'Patente', 'Días en ruta', 'Clientes visitados', 'Venta ($)', 'Km (GPS)', 'Combustible ($)', 'Otros costos ($)', 'Costo logístico ($)', 'Costo por cliente ($)', 'Costo por km ($)', '% sobre la venta', 'Costo por 100 kg ($)']];
        const pn = v => v === null || v === undefined ? '' : num(v);
        r.resumen.forEach(t => costosH.push([t.camion, t.dominio || 'sin asignar', num(t.dias), num(t.clientes), num(t.importe), pn(t.km), pn(t.combustible), pn(t.otros), pn(t.costoLogistico), pn(t.costoCliente), pn(t.costoKm), pn(t.pctVenta), pn(t.costoKg)]));
        const T = r.totales;
        costosH.push([{ v: 'TOTAL (camiones con datos)', s: ESTILO.negrita }, '', { v: T.dias, s: ESTILO.negritaNumero }, { v: T.clientes, s: ESTILO.negritaNumero }, { v: T.importe, s: ESTILO.negritaNumero }, { v: T.km, s: ESTILO.negritaNumero }, { v: T.combustible, s: ESTILO.negritaNumero }, '', { v: T.costoLogistico, s: ESTILO.negritaNumero }, T.costoCliente === null ? '' : { v: T.costoCliente, s: ESTILO.negritaNumero }, T.costoKm === null ? '' : { v: T.costoKm, s: ESTILO.negritaNumero }, T.pctVenta === null ? '' : { v: T.pctVenta, s: ESTILO.negritaNumero }, T.costoKg === null ? '' : { v: T.costoKg, s: ESTILO.negritaNumero }]);
        enviarXlsx(res, `venta_por_camion_${r.desde}_a_${r.hasta}.xlsx`, crearXlsx([
            { nombre: 'Resumen por camión', filas: resumen, anchos: [18, 12, 13, 17, 18, 24, 12] },
            { nombre: 'Costo logístico', filas: costosH, anchos: [18, 12, 12, 16, 16, 11, 16, 15, 18, 18, 15, 15, 18] },
            { nombre: 'Venta por día', filas, anchos: [12, 18, 12, 28, 10, 10, 14, 16, 11] }
        ]));
    } catch (err) {
        console.error('❌ Exportar venta por camión:', err.message);
        res.status(500).json({ error: 'No se pudo generar el Excel' });
    }
});
// Camiones de Gescom (últimos 90 días, uno por nombre) con la patente asignada + patentes conocidas de la app
app.get('/api/admin/venta-camion/mapeo', requireAdmin, requireDb, async (req, res) => {
    try {
        const g = await pool.query(`/*VENTACAMION3*/ SELECT DISTINCT r.vehiculo_codigo::text AS codigo, r.vehiculo_nombre AS nombre
            FROM reparto r WHERE r.fecha_entrega >= CURRENT_DATE - 90 AND r.vehiculo_nombre IS NOT NULL`);
        const m = new Map();
        (await db.query(`SELECT vehiculo_codigo, dominio FROM flota_camion_gescom`)).rows.forEach(f => m.set(f.vehiculo_codigo, f.dominio));
        const d = await db.query(`SELECT DISTINCT dom FROM (
                SELECT ${SQL_DOMINIO('dominio')} AS dom FROM flota_checklist
                UNION SELECT ${SQL_DOMINIO('vehiculo')} FROM flota_jornada
                UNION SELECT ${SQL_DOMINIO('dominio')} FROM flota_combustible) x WHERE dom <> '' ORDER BY dom`);
        const porNombre = new Map();
        g.rows.forEach(f => {
            const clave = claveNombre(f.nombre);
            const c = porNombre.get(clave) || { clave, nombre: String(f.nombre).trim().replace(/\s+/g, ' '), codigos: [] };
            c.codigos.push(f.codigo);
            porNombre.set(clave, c);
        });
        const camiones = [...porNombre.values()].map(c => ({ clave: c.clave, nombre: c.nombre, codigos: c.codigos,
            dominio: m.get(c.clave) || c.codigos.map(x => m.get(x)).find(Boolean) || '' }))
            .sort((a, b) => String(a.nombre).localeCompare(String(b.nombre), 'es', { numeric: true }));
        res.json({ camiones, dominios: d.rows.map(f => f.dom) });
    } catch (err) {
        console.error('❌ Mapeo de camiones:', err.message);
        res.status(500).json({ error: 'No se pudo leer la lista de camiones' });
    }
});
app.post('/api/admin/venta-camion/mapeo', requireAdmin, requireDb, async (req, res) => {
    const clave = claveNombre(String((req.body || {}).clave || '').replace(/[^A-Za-z0-9 _-]/g, '')).slice(0, 40);
    const dominio = normalizarDominio((req.body || {}).dominio);
    if (!clave) return res.status(400).json({ error: 'Falta el camión' });
    try {
        if (!dominio) await db.query(`DELETE FROM flota_camion_gescom WHERE vehiculo_codigo = $1`, [clave]);
        else await db.query(`INSERT INTO flota_camion_gescom (vehiculo_codigo, dominio) VALUES ($1, $2)
            ON CONFLICT (vehiculo_codigo) DO UPDATE SET dominio = EXCLUDED.dominio`, [clave, dominio]);
        res.json({ exito: true, dominio });
    } catch (err) {
        console.error('❌ Guardar patente del camión:', err.message);
        res.status(500).json({ error: 'No se pudo guardar' });
    }
});


module.exports = { claveTextoVenta, SQL_REPARTOS_VALIDOS, consultarVentaCamion };
