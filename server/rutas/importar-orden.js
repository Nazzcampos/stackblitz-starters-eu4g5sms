// Importación del "Orden de reparto" exportado desde Gescom.
const { app, pool } = require('../core.js');
const { db, requireDb } = require('../base.js');
const { requireAdmin } = require('../auth.js');

// =====================================================================
//  IMPORTAR "ORDEN DE REPARTO" DESDE GESCOM (export de Abm-Cliente)
// =====================================================================
app.get('/api/admin/orden-reparto/estado', requireAdmin, requireDb, async (req, res) => {
    try {
        const r = await db.query(`SELECT COUNT(*)::int AS total, MAX(actualizado) AS actualizado FROM flota_orden_cliente`);
        res.json(r.rows[0]);
    } catch (err) { res.status(500).json({ error: 'No se pudo leer el estado' }); }
});
// Recibe de a tandas: { filas: [{ codigo, orden }], primera: true|false }  (primera=true vacía lo anterior)
app.post('/api/admin/orden-reparto/importar', requireAdmin, requireDb, async (req, res) => {
    const filas = Array.isArray((req.body || {}).filas) ? req.body.filas : null;
    if (!filas || !filas.length || filas.length > 3000) return res.status(400).json({ error: 'Tanda inválida' });
    const codigos = [], ordenes = [];
    filas.forEach(f => {
        const c = String((f && f.codigo) == null ? '' : f.codigo).trim().slice(0, 30);
        const o = Math.round(Number(f && f.orden));
        if (c && Number.isFinite(o) && o > 0 && o < 1000000) { codigos.push(c); ordenes.push(o); }
    });
    if (!codigos.length) return res.status(400).json({ error: 'No hay filas válidas (código y orden numérico)' });
    try {
        // Cambios aprobados que todavía no se cargaron en Gescom: no se pisan con el export (que aún tiene el orden viejo)
        const prot = (await db.query(`SELECT DISTINCT i->>'codigo' AS c FROM flota_orden_propuesta p, jsonb_array_elements(p.items) i
            WHERE p.estado = 'aprobada' AND p.base = 'reparto' AND COALESCE(i->>'codigo', '') <> '' AND (COALESCE((i->>'cambio')::boolean, false) OR COALESCE((i->>'baja')::boolean, false))`)).rows.map(f => f.c);
        if (req.body.primera) await db.query(`DELETE FROM flota_orden_cliente WHERE cliente_codigo <> ALL($1::text[])`, [prot]);
        await db.query(`INSERT INTO flota_orden_cliente (cliente_codigo, orden)
            SELECT DISTINCT ON (c) c, o FROM unnest($1::text[], $2::int[]) AS t(c, o) WHERE c <> ALL($3::text[])
            ON CONFLICT (cliente_codigo) DO UPDATE SET orden = EXCLUDED.orden, actualizado = now()`, [codigos, ordenes, prot]);
        // Control: cuántos de esos códigos existen realmente en Gescom (detecta si se eligió mal la columna del código)
        let encontrados = null;
        try { encontrados = (await pool.query(`SELECT COUNT(DISTINCT codigo)::int AS n FROM cliente_hist WHERE actual = true AND codigo = ANY($1::text[])`, [codigos])).rows[0].n; } catch (e) {}
        res.json({ exito: true, guardados: codigos.length, encontrados });
    } catch (err) {
        console.error('❌ Importar orden de reparto:', err.message);
        res.status(500).json({ error: 'No se pudo guardar el orden de reparto' });
    }
});


module.exports = {  };
