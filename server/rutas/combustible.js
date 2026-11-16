// Cargas de combustible.
const { app } = require('../core.js');
const { db, requireDb } = require('../base.js');
const { requireChofer, requireAdmin } = require('../auth.js');
const { ESTILO, crearXlsx, enviarXlsx } = require('../xlsx.js');
const { SQL_DOMINIO } = require('./jornadas.js');

// --- COMBUSTIBLE ---
app.post('/api/combustible', requireChofer, requireDb, async (req, res) => {
    const b = req.body || {};
    const dominio = String(b.dominio || '').trim().toUpperCase().slice(0, 20);
    const litros = Number(b.litros);
    const costo = b.costoTotal === '' || b.costoTotal == null ? null : Number(b.costoTotal);
    const odo = b.odometroActual === '' || b.odometroActual == null ? null : Number(b.odometroActual);
    if (!dominio || !Number.isFinite(litros) || litros <= 0 || litros > 2000 ||
        (costo !== null && (!Number.isFinite(costo) || costo < 0)) ||
        (odo !== null && (!Number.isFinite(odo) || odo < 0))) {
        return res.status(400).json({ error: "Revisá los datos de la carga" });
    }
    try {
        await db.query(
            `INSERT INTO flota_combustible (chofer, dominio, litros, costo_total, odometro) VALUES ($1, $2, $3, $4, $5)`,
            [req.chofer, dominio, litros, costo, odo]);
        res.status(201).json({ exito: true });
    } catch (err) {
        console.error("❌ Error al guardar carga de combustible:", err.message);
        res.status(500).json({ error: 'No se pudo guardar la carga' });
    }
});

app.get('/api/combustible', requireAdmin, requireDb, async (req, res) => {
    try {
        const r = await db.query(
            `SELECT id::int AS id, creado AS fecha, chofer, dominio, litros::float8 AS litros,
                    costo_total::float8 AS "costoTotal", odometro::float8 AS "odometroActual"
             FROM (SELECT * FROM flota_combustible ORDER BY id DESC LIMIT 1000) t ORDER BY id ASC`);
        res.json(r.rows);
    } catch (err) {
        console.error("❌ Error al leer combustible:", err.message);
        res.status(500).json({ error: 'No se pudieron leer las cargas' });
    }
});

app.delete('/api/combustible/:id', requireAdmin, requireDb, async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'id inválido' });
    try {
        await db.query('DELETE FROM flota_combustible WHERE id = $1', [req.params.id]);
        res.json({ exito: true });
    } catch (err) {
        res.status(500).json({ error: 'No se pudo borrar' });
    }
});

// --- RESUMEN MENSUAL POR CAMIÓN ---
// Litros y gasto salen de las cargas (flota_combustible); los km, del GPS (flota_odometro_dia); además se informa el recorrido
// según el odómetro anotado en las cargas (último - primero del mes). Los meses se toman con la hora de Argentina.
const SQL_FECHA_AR = `(creado AT TIME ZONE 'America/Argentina/Buenos_Aires')::date`;
function limitesMes(mes) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(mes || ''))) return null;
    const [a, m] = mes.split('-').map(Number);
    const fin = new Date(Date.UTC(a, m, 0)).getUTCDate();
    const ant = new Date(Date.UTC(a, m - 2, 1)).toISOString().slice(0, 7);
    return { mes, desde: `${mes}-01`, hasta: `${mes}-${String(fin).padStart(2, '0')}`, anterior: ant };
}
async function resumenCombustible(mes) {
    const lim = limitesMes(mes);
    if (!lim) return { error: 'Elegí un mes válido (AAAA-MM).' };
    const ant = limitesMes(lim.anterior);
    const r = await db.query(
        `SELECT ${SQL_DOMINIO('dominio')} AS clave, MIN(dominio) AS dominio, COUNT(*)::int AS cargas,
                SUM(litros)::float8 AS litros, SUM(costo_total)::float8 AS costo,
                COALESCE(SUM(litros) FILTER (WHERE costo_total IS NOT NULL), 0)::float8 AS litros_con_costo,
                MIN(odometro) FILTER (WHERE odometro > 0)::float8 AS odo_min, MAX(odometro) FILTER (WHERE odometro > 0)::float8 AS odo_max,
                COUNT(*) FILTER (WHERE odometro > 0)::int AS cargas_odo
         FROM flota_combustible WHERE ${SQL_FECHA_AR} BETWEEN $1::date AND $2::date GROUP BY 1 ORDER BY 2`, [lim.desde, lim.hasta]);
    const km = await db.query(
        `SELECT ${SQL_DOMINIO('vehiculo')} AS clave, SUM(km)::float8 AS km FROM flota_odometro_dia WHERE fecha BETWEEN $1::date AND $2::date GROUP BY 1`, [lim.desde, lim.hasta]);
    const kmPor = new Map(km.rows.map(f => [f.clave, f.km]));
    const a = await db.query(
        `SELECT COALESCE(SUM(litros), 0)::float8 AS litros, COALESCE(SUM(costo_total), 0)::float8 AS costo, COUNT(*)::int AS cargas
         FROM flota_combustible WHERE ${SQL_FECHA_AR} BETWEEN $1::date AND $2::date`, [ant.desde, ant.hasta]);
    const redondeo = (n, d = 1) => n === null || n === undefined ? null : Math.round(n * 10 ** d) / 10 ** d;
    const camiones = r.rows.map(f => {
        const kmGps = redondeo(kmPor.get(f.clave) || 0);
        const kmOdo = f.cargas_odo >= 2 ? redondeo(f.odo_max - f.odo_min) : null;
        return {
            dominio: f.dominio, cargas: f.cargas, litros: redondeo(f.litros), costo: f.costo === null ? null : redondeo(f.costo, 2), litrosConCosto: f.litros_con_costo,
            precioLitro: f.litros_con_costo > 0 ? redondeo(f.costo / f.litros_con_costo, 2) : null,
            kmGps, kmOdometro: kmOdo,
            lPor100: kmGps > 0 ? redondeo(f.litros / kmGps * 100) : null
        };
    });
    const tot = camiones.reduce((t, c) => ({
        cargas: t.cargas + c.cargas, litros: t.litros + c.litros, costo: t.costo + (c.costo || 0), litrosCosto: t.litrosCosto + c.litrosConCosto,
        km: t.km + c.kmGps, litrosConKm: t.litrosConKm + (c.kmGps > 0 ? c.litros : 0)
    }), { cargas: 0, litros: 0, costo: 0, litrosCosto: 0, km: 0, litrosConKm: 0 });
    return {
        mes: lim.mes, camiones,
        totales: { cargas: tot.cargas, litros: redondeo(tot.litros), costo: redondeo(tot.costo, 2), precioLitro: tot.litrosCosto > 0 ? redondeo(tot.costo / tot.litrosCosto, 2) : null, kmGps: redondeo(tot.km), lPor100: tot.km > 0 ? redondeo(tot.litrosConKm / tot.km * 100) : null },
        anterior: { mes: lim.anterior, cargas: a.rows[0].cargas, litros: redondeo(a.rows[0].litros), costo: redondeo(a.rows[0].costo, 2) }
    };
}

app.get('/api/admin/combustible/resumen', requireAdmin, requireDb, async (req, res) => {
    try {
        const d = await resumenCombustible(req.query.mes);
        if (d.error) return res.status(400).json({ error: d.error });
        res.json(d);
    } catch (err) {
        console.error('❌ Resumen de combustible:', err.message);
        res.status(500).json({ error: 'No se pudo calcular el resumen' });
    }
});

app.get('/api/admin/combustible/resumen/exportar', requireAdmin, requireDb, async (req, res) => {
    try {
        const d = await resumenCombustible(req.query.mes);
        if (d.error) return res.status(400).json({ error: d.error });
        const lim = limitesMes(d.mes);
        const n = (v, e) => ({ v: v === null || v === undefined ? '' : v, s: e || ESTILO.numero });
        const filas = [['Camión (dominio)', 'Cargas', 'Litros', 'Gasto ($)', '$ por litro', 'Km (GPS)', 'Litros cada 100 km', 'Km según odómetro de las cargas']];
        d.camiones.forEach(c => filas.push([c.dominio, n(c.cargas, ESTILO.normal), n(c.litros), n(c.costo), n(c.precioLitro), n(c.kmGps), n(c.lPor100), n(c.kmOdometro)]));
        filas.push([{ v: 'TOTAL', s: ESTILO.negrita }, n(d.totales.cargas, ESTILO.negritaNumero), n(d.totales.litros, ESTILO.negritaNumero), n(d.totales.costo, ESTILO.negritaNumero),
            n(d.totales.precioLitro, ESTILO.negritaNumero),
            n(d.totales.kmGps, ESTILO.negritaNumero), n(d.totales.lPor100, ESTILO.negritaNumero), '']);
        filas.push(['', '', '', '', '', '', '', '']);
        filas.push([`Mes anterior (${d.anterior.mes})`, n(d.anterior.cargas, ESTILO.normal), n(d.anterior.litros), n(d.anterior.costo), '', '', '', '']);
        const det = await db.query(
            `SELECT to_char(creado AT TIME ZONE 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY HH24:MI') AS fecha, chofer, dominio, litros::float8 AS litros,
                    costo_total::float8 AS costo, odometro::float8 AS odo
             FROM flota_combustible WHERE ${SQL_FECHA_AR} BETWEEN $1::date AND $2::date ORDER BY creado`, [lim.desde, lim.hasta]);
        const cargas = [['Fecha y hora', 'Chofer', 'Dominio', 'Litros', 'Costo ($)', 'Odómetro']];
        det.rows.forEach(f => cargas.push([f.fecha, f.chofer, f.dominio, n(f.litros), n(f.costo), n(f.odo)]));
        enviarXlsx(res, `combustible_${d.mes}.xlsx`, crearXlsx([
            { nombre: 'Resumen por camión', filas, anchos: [24, 9, 11, 16, 12, 11, 18, 26] },
            { nombre: 'Cargas del mes', filas: cargas, anchos: [18, 28, 14, 10, 14, 12] }
        ]));
    } catch (err) {
        console.error('❌ Exportar combustible:', err.message);
        res.status(500).json({ error: 'No se pudo generar el Excel' });
    }
});

module.exports = { resumenCombustible };
