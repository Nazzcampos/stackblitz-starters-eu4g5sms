// Cargas de combustible.
const { app } = require('../core.js');
const { db, requireDb } = require('../base.js');
const { requireChofer, requireAdmin } = require('../auth.js');

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


module.exports = {  };
