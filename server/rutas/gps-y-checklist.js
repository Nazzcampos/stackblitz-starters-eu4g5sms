// GPS (odómetro diario) y check-lists de los vehículos.
const { app } = require('../core.js');
const { db, requireDb, INICIO_DIA_AR } = require('../base.js');
const { requireChofer, requireAdmin } = require('../auth.js');
const { notificar } = require('../avisos.js');
const { calcularDistancia } = require('../gescom.js');

// --- GPS: cada punto se guarda en Supabase; el odómetro se reinicia cada día (hora de Argentina) ---
app.post('/api/ubicacion', requireChofer, requireDb, async (req, res) => {
    const chofer = req.chofer; // siempre el chofer de la sesión, no el que diga el cuerpo del mensaje
    const latitud = Number((req.body || {}).latitud);
    const longitud = Number((req.body || {}).longitud);
    if (!Number.isFinite(latitud) || !Number.isFinite(longitud) || Math.abs(latitud) > 90 || Math.abs(longitud) > 180) {
        return res.status(400).json({ error: "Faltan datos obligatorios" });
    }
    const vehiculo = String((req.body || {}).vehiculo || 'Sin asignar').trim().slice(0, 30) || 'Sin asignar';
    try {
        const previo = await db.query(
            `SELECT latitud, longitud, distancia_total_km::float8 AS km
             FROM flota_posicion
             WHERE vehiculo = $1 AND creado >= ${INICIO_DIA_AR}
             ORDER BY id DESC LIMIT 1`, [vehiculo]);
        let km = 0;
        if (previo.rows[0]) {
            km = previo.rows[0].km;
            const tramo = calcularDistancia(previo.rows[0].latitud, previo.rows[0].longitud, latitud, longitud);
            if (tramo < 10 && tramo > 0.001) km += tramo;
        }
        km = Number(km.toFixed(3));
        await db.query(
            `INSERT INTO flota_posicion (chofer, vehiculo, latitud, longitud, distancia_total_km) VALUES ($1, $2, $3, $4, $5)`,
            [chofer, vehiculo, latitud, longitud, km]);
        await db.query(
            `INSERT INTO flota_odometro_dia (fecha, vehiculo, chofer, km)
             VALUES ((now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date, $1, $2, $3)
             ON CONFLICT (fecha, vehiculo) DO UPDATE SET
                km = GREATEST(flota_odometro_dia.km, EXCLUDED.km),
                ultima = now(),
                chofer = CASE WHEN position(EXCLUDED.chofer in flota_odometro_dia.chofer) > 0
                              THEN flota_odometro_dia.chofer
                              ELSE flota_odometro_dia.chofer || ', ' || EXCLUDED.chofer END`,
            [vehiculo, chofer, km]);
        res.status(201).json({ exito: true, distanciaTotalKm: Number(km.toFixed(2)) });
    } catch (err) {
        console.error("❌ Error al guardar ubicación:", err.message);
        res.status(500).json({ error: 'No se pudo guardar la ubicación' });
    }
});

// Puntos de hoy (hasta 4000, los más recientes), del más viejo al más nuevo
app.get('/api/ubicaciones', requireAdmin, requireDb, async (req, res) => {
    try {
        const r = await db.query(
            `SELECT vehiculo, chofer AS chofer_id, latitud, longitud,
                    distancia_total_km::float8 AS "distanciaTotalKm", creado AS fecha_hora
             FROM (SELECT * FROM flota_posicion WHERE creado >= ${INICIO_DIA_AR} ORDER BY id DESC LIMIT 4000) t
             ORDER BY id ASC`);
        res.json(r.rows.map(f => ({ ...f, distanciaTotalKm: Number(f.distanciaTotalKm.toFixed(2)) })));
    } catch (err) {
        console.error("❌ Error al leer ubicaciones:", err.message);
        res.status(500).json({ error: 'No se pudieron leer las ubicaciones' });
    }
});

app.get('/api/estadisticas', requireAdmin, requireDb, async (req, res) => {
    try {
        const r = await db.query(
            `SELECT DISTINCT ON (vehiculo) vehiculo, chofer, distancia_total_km::float8 AS km
             FROM flota_posicion WHERE creado >= ${INICIO_DIA_AR}
             ORDER BY vehiculo, id DESC`);
        res.json(r.rows.map(f => ({ vehiculo: f.vehiculo, chofer: f.chofer, distanciaTotalKm: Number(f.km.toFixed(2)) })));
    } catch (err) {
        res.status(500).json({ error: 'No se pudieron leer las estadísticas' });
    }
});

// --- CHECK-LISTS ---
app.post('/api/checklist', requireChofer, requireDb, async (req, res) => {
    const b = req.body || {};
    const dominio = String(b.dominio || '').trim().toUpperCase().slice(0, 20);
    if (!dominio) return res.status(400).json({ error: "Faltan datos obligatorios" });
    const respuestas = (b.respuestas && typeof b.respuestas === 'object' && !Array.isArray(b.respuestas)) ? b.respuestas : {};
    if (JSON.stringify(respuestas).length > 8000) return res.status(400).json({ error: "Respuestas demasiado largas" });
    try {
        const r = await db.query(
            `INSERT INTO flota_checklist (chofer, dominio, tipo_vehiculo, respuestas, observaciones)
             VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING id::int AS id`,
            [req.chofer, dominio, String(b.tipo_vehiculo || '').slice(0, 40), JSON.stringify(respuestas), String(b.observaciones || '').slice(0, 2000)]);
        const fallas = Object.entries(respuestas).filter(([, v]) => String(v).toLowerCase() === 'falla').map(([k]) => k);
        if (fallas.length) notificar('admin', { clave: 'chk|' + r.rows[0].id, tipo: 'checklist', nivel: 'alerta', titulo: `Check-list con fallas: ${dominio}`,
            mensaje: `${req.chofer} reportó ${fallas.length} falla${fallas.length === 1 ? '' : 's'}:\n` + fallas.map(f => '• ' + f).join('\n') + (b.observaciones ? `\nObs.: ${String(b.observaciones).slice(0, 200)}` : '') });
        res.status(201).json({ exito: true, id: r.rows[0].id });
    } catch (err) {
        console.error("❌ Error al guardar check-list:", err.message);
        res.status(500).json({ error: 'No se pudo guardar el check-list' });
    }
});

app.get('/api/checklists', requireAdmin, requireDb, async (req, res) => {
    try {
        const r = await db.query(
            `SELECT id::int AS id, creado AS marca_temporal, chofer, dominio, tipo_vehiculo, respuestas, observaciones
             FROM (SELECT * FROM flota_checklist ORDER BY id DESC LIMIT 1000) t ORDER BY id ASC`);
        res.json(r.rows);
    } catch (err) {
        console.error("❌ Error al leer check-lists:", err.message);
        res.status(500).json({ error: 'No se pudieron leer los check-lists' });
    }
});

app.delete('/api/checklist/:id', requireAdmin, requireDb, async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'id inválido' });
    try {
        await db.query('DELETE FROM flota_checklist WHERE id = $1', [req.params.id]);
        res.json({ exito: true });
    } catch (err) {
        res.status(500).json({ error: 'No se pudo borrar' });
    }
});


module.exports = {  };
