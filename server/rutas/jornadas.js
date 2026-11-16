// Jornadas de los choferes y kilómetros.
const { app } = require('../core.js');
const base = require('../base.js');
const { db, requireDb } = require('../base.js');
const { requireChofer, requireAdmin } = require('../auth.js');
const { ESTILO, crearXlsx, enviarXlsx, rangoFechas } = require('../xlsx.js');
const { hoyArgentina, fechaValida, normalizarDominio } = require('./documentacion.js');

// =====================================================================
//  JORNADAS: inicio y fin del turno de cada chofer.
//  El chofer toca "Iniciar jornada" al salir y "Finalizar jornada" al volver; si se olvida, el sistema la cierra solo
//  (al cambiar el día, o pasadas 20 horas) usando la hora de su última posición GPS.
// =====================================================================
const aMs = v => v instanceof Date ? v.getTime() : Date.parse(String(v).replace(/(\.\d{3})\d+/, '$1'));
const SQL_DOMINIO = (col) => `regexp_replace(upper(${col}), '[^A-Z0-9]', '', 'g')`;

// Kilómetros recorridos por el vehículo entre dos momentos (el odómetro diario es acumulado, se resta lo que ya tenía al empezar)
async function kmJornada(vehiculo, desde, hasta) {
    const dom = normalizarDominio(vehiculo);
    if (!dom) return 0;
    const r = await db.query(`
        SELECT COALESCE((SELECT MAX(distancia_total_km) FROM flota_posicion
                         WHERE ${SQL_DOMINIO('vehiculo')} = $1 AND creado >= $2::timestamptz - interval '1 day' AND creado BETWEEN $2::timestamptz AND $3::timestamptz), 0)::float8 AS fin,
               COALESCE((SELECT distancia_total_km FROM flota_posicion
                         WHERE ${SQL_DOMINIO('vehiculo')} = $1 AND creado >= $2::timestamptz - interval '1 day' AND creado < $2::timestamptz
                           AND (creado AT TIME ZONE 'America/Argentina/Buenos_Aires')::date = ($2::timestamptz AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
                         ORDER BY id DESC LIMIT 1), 0)::float8 AS ini`, [dom, desde, hasta]);
    const f = r.rows[0];
    return Math.max(0, Number((f.fin - f.ini).toFixed(2)));
}

async function cerrarJornada(j, fin, motivo) {
    const finReal = new Date(Math.max(aMs(fin), aMs(j.inicio)));
    const km = await kmJornada(j.vehiculo, j.inicio, finReal);
    const r = await db.query(`UPDATE flota_jornada SET fin = $2, cierre = $3, km = $4 WHERE id = $1 AND fin IS NULL RETURNING inicio, fin, km::float8 AS km, vehiculo`, [j.id, finReal, motivo, km]);
    return r.rows[0] || null;
}

// Cierra las jornadas que quedaron abiertas de un día anterior (o de más de 20 horas). Si se pasa un chofer, solo las de él.
async function cerrarJornadasVencidas(chofer) {
    const filtro = chofer ? 'AND chofer = $1' : '';
    const abiertas = await db.query(`
        SELECT id, chofer, vehiculo, inicio FROM flota_jornada
        WHERE fin IS NULL ${filtro}
          AND ((inicio AT TIME ZONE 'America/Argentina/Buenos_Aires')::date < (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
               OR inicio < now() - interval '20 hours')`, chofer ? [chofer] : []);
    for (const j of abiertas.rows) {
        const ult = await db.query(`SELECT MAX(creado) AS ultima FROM flota_posicion WHERE chofer = $1 AND creado >= $2`, [j.chofer, j.inicio]);
        await cerrarJornada(j, ult.rows[0].ultima || j.inicio, 'auto');
    }
    return abiertas.rowCount;
}
async function tareaJornadas() {
    if (!base.dbListo) return;
    try {
        const n = await cerrarJornadasVencidas();
        if (n) console.log(`🕛 Jornadas cerradas automáticamente: ${n}`);
    } catch (err) { console.error('⚠️ Cierre automático de jornadas:', err.message); }
}
setInterval(tareaJornadas, 10 * 60 * 1000).unref();
setTimeout(tareaJornadas, 45 * 1000).unref();

function fichaJornada(f) { return f ? { id: Number(f.id), inicio: f.inicio, vehiculo: f.vehiculo } : null; }

app.get('/api/jornada/actual', requireChofer, requireDb, async (req, res) => {
    try {
        await cerrarJornadasVencidas(req.chofer);
        const r = await db.query(`SELECT id, inicio, vehiculo FROM flota_jornada WHERE chofer = $1 AND fin IS NULL`, [req.chofer]);
        res.json({ jornada: fichaJornada(r.rows[0]) });
    } catch (err) {
        console.error('❌ Jornada actual:', err.message);
        res.status(500).json({ error: 'No se pudo consultar la jornada' });
    }
});

app.post('/api/jornada/iniciar', requireChofer, requireDb, async (req, res) => {
    const vehiculo = String((req.body || {}).dominio || '').trim().toUpperCase().slice(0, 20);
    if (normalizarDominio(vehiculo).length < 5) return res.status(400).json({ error: 'Ingresá la patente del camión.' });
    try {
        await cerrarJornadasVencidas(req.chofer);
        const abierta = await db.query(`SELECT id, inicio, vehiculo FROM flota_jornada WHERE chofer = $1 AND fin IS NULL`, [req.chofer]);
        const previa = abierta.rows[0];
        if (previa) {
            if (normalizarDominio(previa.vehiculo) === normalizarDominio(vehiculo)) return res.json({ jornada: fichaJornada(previa), yaIniciada: true });
            await cerrarJornada(previa, new Date(), 'cambio');   // cambió de camión: se cierra la anterior
        }
        const r = await db.query(
            `INSERT INTO flota_jornada (chofer, vehiculo) VALUES ($1, $2)
             ON CONFLICT (chofer) WHERE fin IS NULL DO NOTHING RETURNING id, inicio, vehiculo`, [req.chofer, vehiculo]);
        let fila = r.rows[0];
        if (!fila) fila = (await db.query(`SELECT id, inicio, vehiculo FROM flota_jornada WHERE chofer = $1 AND fin IS NULL`, [req.chofer])).rows[0];
        res.status(201).json({ jornada: fichaJornada(fila), yaIniciada: !r.rows[0] });
    } catch (err) {
        console.error('❌ Iniciar jornada:', err.message);
        res.status(500).json({ error: 'No se pudo iniciar la jornada' });
    }
});

app.post('/api/jornada/finalizar', requireChofer, requireDb, async (req, res) => {
    try {
        const abierta = await db.query(`SELECT id, inicio, vehiculo FROM flota_jornada WHERE chofer = $1 AND fin IS NULL`, [req.chofer]);
        if (!abierta.rows[0]) return res.json({ jornada: null, yaFinalizada: true });
        const c = await cerrarJornada(abierta.rows[0], new Date(), 'manual');
        res.json({ jornada: c ? { inicio: c.inicio, fin: c.fin, km: c.km, minutos: Math.round((aMs(c.fin) - aMs(c.inicio)) / 60000), vehiculo: c.vehiculo } : null });
    } catch (err) {
        console.error('❌ Finalizar jornada:', err.message);
        res.status(500).json({ error: 'No se pudo finalizar la jornada' });
    }
});

// Panel del supervisor: jornadas entre dos fechas (por defecto, los últimos 7 días)
async function consultarJornadas(q) {
    const hoy = hoyArgentina();
    const rango = (q.desde || q.hasta) ? rangoFechas(q) : { desde: new Date(Date.parse(hoy + 'T00:00:00Z') - 6 * 86400000).toISOString().slice(0, 10), hasta: hoy };
    if (!rango || !fechaValida(rango.desde) || !fechaValida(rango.hasta)) return { error: 'Revisá las fechas (máximo un año).' };
    const chofer = String(q.chofer || '').trim().slice(0, 80);
    const r = await db.query(`
        SELECT id::int AS id, chofer, vehiculo, inicio, fin, cierre, km::float8 AS km,
               (inicio AT TIME ZONE 'America/Argentina/Buenos_Aires')::date::text AS fecha
        FROM flota_jornada
        WHERE (inicio AT TIME ZONE 'America/Argentina/Buenos_Aires')::date BETWEEN $1::date AND $2::date
          AND ($3 = '' OR chofer = $3)
        ORDER BY inicio DESC LIMIT 2000`, [rango.desde, rango.hasta, chofer]);
    const ahora = Date.now();
    const filas = [];
    for (const f of r.rows) {
        const enCurso = !f.fin;
        const fin = enCurso ? new Date() : f.fin;
        filas.push({
            id: f.id, fecha: f.fecha, chofer: f.chofer, vehiculo: f.vehiculo, inicio: f.inicio, fin: enCurso ? null : f.fin,
            minutos: Math.max(0, Math.round((aMs(fin) - aMs(f.inicio)) / 60000)),
            km: enCurso ? await kmJornada(f.vehiculo, f.inicio, fin) : Number(f.km),
            cierre: enCurso ? 'en_curso' : (f.cierre || 'manual')
        });
    }
    return { desde: rango.desde, hasta: rango.hasta, filas };
}
app.get('/api/admin/jornadas', requireAdmin, requireDb, async (req, res) => {
    try {
        const r = await consultarJornadas(req.query);
        if (r.error) return res.status(400).json({ error: r.error });
        res.json(r);
    } catch (err) {
        console.error('❌ Listar jornadas:', err.message);
        res.status(500).json({ error: 'No se pudieron leer las jornadas' });
    }
});
app.get('/api/admin/jornadas/exportar', requireAdmin, requireDb, async (req, res) => {
    try {
        const r = await consultarJornadas(req.query);
        if (r.error) return res.status(400).json({ error: r.error });
        const fmtF = f => f.split('-').reverse().join('/');
        const hora = t => t ? new Date(t).toLocaleTimeString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', minute: '2-digit', hour12: false }) : '';
        const horas = m => Math.round(m / 6) / 10;
        const motivo = { en_curso: 'En curso', manual: 'Finalizada por el chofer', auto: 'Cierre automático (no la finalizó)', cambio: 'Cambió de camión' };
        const filas = [['Fecha', 'Chofer', 'Patente', 'Salida', 'Regreso', 'Horas', 'Km', 'Cierre']];
        r.filas.forEach(f => filas.push([fmtF(f.fecha), f.chofer, f.vehiculo, hora(f.inicio), hora(f.fin),
            { v: horas(f.minutos), s: ESTILO.numero }, { v: f.km, s: ESTILO.numero },
            f.cierre === 'auto' ? { v: motivo.auto, s: ESTILO.falla } : motivo[f.cierre] || f.cierre]));
        const porChofer = new Map();
        r.filas.forEach(f => { const t = porChofer.get(f.chofer) || { chofer: f.chofer, dias: new Set(), min: 0, km: 0 }; t.dias.add(f.fecha); t.min += f.minutos; t.km += f.km; porChofer.set(f.chofer, t); });
        const resumen = [['Chofer', 'Días trabajados', 'Horas totales', 'Promedio de horas por día', 'Km totales']];
        [...porChofer.values()].sort((a, b) => a.chofer.localeCompare(b.chofer)).forEach(t => resumen.push([t.chofer, { v: t.dias.size, s: ESTILO.numero },
            { v: horas(t.min), s: ESTILO.numero }, { v: horas(t.min / t.dias.size), s: ESTILO.numero }, { v: Math.round(t.km * 10) / 10, s: ESTILO.numero }]));
        enviarXlsx(res, `jornadas_${r.desde}_a_${r.hasta}.xlsx`, crearXlsx([
            { nombre: 'Jornadas', filas, anchos: [12, 28, 12, 9, 9, 8, 9, 34] },
            { nombre: 'Resumen por chofer', filas: resumen, anchos: [28, 16, 14, 24, 12] }
        ]));
    } catch (err) {
        console.error('❌ Exportar jornadas:', err.message);
        res.status(500).json({ error: 'No se pudo generar el Excel' });
    }
});


module.exports = { aMs, SQL_DOMINIO, kmJornada, cerrarJornada, cerrarJornadasVencidas, tareaJornadas, fichaJornada, consultarJornadas };
