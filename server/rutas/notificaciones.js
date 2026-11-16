// Centro de notificaciones (campanita) del administrador y del encargado de depósito:
// lista, marcar como leída, archivar, y la tarea que genera los avisos automáticos (retornos sin cargar y documentación).
const { app } = require('../core.js');
const base = require('../base.js');
const { db, requireDb } = require('../base.js');
const { notificar, resolverTipo, eventos } = require('../avisos.js');
const { requireDepAdmin, calcularPendientesRetorno } = require('./deposito.js');
const { hoyArgentina, armarResumenDocumentos } = require('./documentacion.js');

const destinoDe = req => req.esAdmin ? 'admin' : 'deposito';
const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const diaCorto = f => `${DIAS[new Date(f + 'T12:00:00Z').getUTCDay()]} ${f.split('-').reverse().slice(0, 2).join('/')}`;

app.get('/api/notificaciones', requireDepAdmin, requireDb, async (req, res) => {
    const archivadas = req.query.archivadas === '1';
    try {
        const r = await db.query(
            `SELECT id::int AS id, tipo, nivel, titulo, mensaje, actualizado AS fecha, (leida IS NOT NULL) AS leida, (archivada IS NOT NULL) AS archivada, resuelta
             FROM flota_notificacion WHERE destino = $1 AND (archivada IS NOT NULL) = $2
             ORDER BY ${archivadas ? 'archivada' : 'actualizado'} DESC LIMIT 60`, [destinoDe(req), archivadas]);
        const n = await db.query(`SELECT COUNT(*)::int AS n FROM flota_notificacion WHERE destino = $1 AND archivada IS NULL AND leida IS NULL`, [destinoDe(req)]);
        res.json({ noLeidas: n.rows[0].n, items: r.rows });
    } catch (err) {
        console.error('❌ Notificaciones:', err.message);
        res.status(500).json({ error: 'No se pudieron leer las notificaciones' });
    }
});

// { id, leida: true|false } o { todas: true }
app.post('/api/notificaciones/leer', requireDepAdmin, requireDb, async (req, res) => {
    const b = req.body || {};
    try {
        if (b.todas) await db.query(`UPDATE flota_notificacion SET leida = COALESCE(leida, now()) WHERE destino = $1 AND archivada IS NULL`, [destinoDe(req)]);
        else if (Number.isInteger(Number(b.id))) await db.query(`UPDATE flota_notificacion SET leida = ${b.leida === false ? 'NULL' : 'COALESCE(leida, now())'} WHERE id = $1 AND destino = $2`, [Number(b.id), destinoDe(req)]);
        else return res.status(400).json({ error: 'Faltan datos' });
        res.json({ exito: true });
    } catch (err) { res.status(500).json({ error: 'No se pudo actualizar' }); }
});

// { id, archivar: true|false } o { leidas: true } (archiva todas las ya leídas)
app.post('/api/notificaciones/archivar', requireDepAdmin, requireDb, async (req, res) => {
    const b = req.body || {};
    try {
        if (b.leidas) await db.query(`UPDATE flota_notificacion SET archivada = now() WHERE destino = $1 AND archivada IS NULL AND leida IS NOT NULL`, [destinoDe(req)]);
        else if (Number.isInteger(Number(b.id))) await db.query(
            b.archivar === false ? `UPDATE flota_notificacion SET archivada = NULL WHERE id = $1 AND destino = $2`
                                 : `UPDATE flota_notificacion SET archivada = now(), leida = COALESCE(leida, now()) WHERE id = $1 AND destino = $2`, [Number(b.id), destinoDe(req)]);
        else return res.status(400).json({ error: 'Faltan datos' });
        res.json({ exito: true });
    } catch (err) { res.status(500).json({ error: 'No se pudo actualizar' }); }
});

// ---- Avisos automáticos (cada 10 minutos) ----
async function avisosRetornos() {
    const d = await calcularPendientesRetorno(14);
    if (!d.gescom) return; // si Gescom no respondió no se toca nada (evita archivar de más)
    const porFecha = new Map();
    d.pendientes.filter(p => !p.esHoy).forEach(p => { if (!porFecha.has(p.fecha)) porFecha.set(p.fecha, []); porFecha.get(p.fecha).push(p); });
    const vigentes = [];
    for (const [fecha, lista] of porFecha) {
        const clave = 'ret|' + fecha; vigentes.push(clave);
        const lineas = lista.slice(0, 8).map(p => `• ${p.chofer}${p.reparto ? ' · reparto ' + p.reparto : ''}`);
        if (lista.length > 8) lineas.push(`… y ${lista.length - 8} más`);
        await notificar(['deposito', 'admin'], {
            clave, tipo: 'retorno', nivel: 'alerta',
            titulo: `Faltan cargar ${lista.length} retorno${lista.length === 1 ? '' : 's'} del ${diaCorto(fecha)}`, mensaje: lineas.join('\n')
        });
    }
    await resolverTipo('retorno', vigentes);
}
async function avisosDocumentos() {
    const r = await armarResumenDocumentos();
    const graves = r.atencion.filter(a => a.estado === 'vencido' || a.estado === 'ultimo');
    const hoy = hoyArgentina();
    const lunes = new Date(Date.parse(hoy + 'T00:00:00Z') - ((new Date(hoy + 'T00:00:00Z').getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10);
    const vigentes = [];
    if (graves.length) {
        const clave = 'docs|' + lunes; vigentes.push(clave);
        const lineas = graves.slice(0, 8).map(a => `• ${a.nombre} · ${a.doc} · ${a.estado === 'vencido' ? 'VENCIDO' : 'vence en ' + a.dias + ' día' + (a.dias === 1 ? '' : 's')}`);
        if (graves.length > 8) lineas.push(`… y ${graves.length - 8} más`);
        await notificar('admin', {
            clave, tipo: 'docs', nivel: 'aviso',
            titulo: `Documentación: ${r.contadores.vencidos} vencido${r.contadores.vencidos === 1 ? '' : 's'}, ${r.contadores.ultimo} por vencer pronto`, mensaje: lineas.join('\n')
        });
    }
    await resolverTipo('docs', vigentes);
}
async function tareaAvisos() {
    if (!base.dbListo) return;
    try { await avisosRetornos(); } catch (err) { console.error('⚠️ Avisos de retorno:', err.message); }
    try { await avisosDocumentos(); } catch (err) { console.error('⚠️ Avisos de documentación:', err.message); }
    try { await db.query(`DELETE FROM flota_notificacion WHERE archivada < now() - interval '60 days'`); } catch (err) { /* nada */ }
}
eventos.on('retorno-guardado', () => { if (base.dbListo) avisosRetornos().catch(err => console.error('⚠️ Avisos de retorno:', err.message)); });
setInterval(tareaAvisos, 10 * 60 * 1000).unref();
setTimeout(tareaAvisos, 25 * 1000).unref();

module.exports = { tareaAvisos };
