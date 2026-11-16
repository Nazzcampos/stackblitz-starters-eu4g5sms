// Centro de notificaciones (campanita): crea y resuelve avisos para el administrador y el encargado de depósito.
// Cada aviso tiene una clave única por destino: si se vuelve a generar, se actualiza el texto en vez de duplicarse.
const { EventEmitter } = require('events');
const { db } = require('./base.js');
const eventos = new EventEmitter(); // 'retorno-guardado' → recalcula los avisos de retornos al instante

// destino: 'admin' | 'deposito' (o una lista). n: { clave, tipo, titulo, mensaje, nivel: 'info' | 'aviso' | 'alerta' }
async function notificar(destino, n) {
    try {
        for (const d of [].concat(destino)) {
            await db.query(
                `INSERT INTO flota_notificacion (destino, clave, tipo, nivel, titulo, mensaje) VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (destino, clave) DO UPDATE SET nivel = EXCLUDED.nivel, titulo = EXCLUDED.titulo, mensaje = EXCLUDED.mensaje,
                    actualizado = CASE WHEN flota_notificacion.mensaje IS DISTINCT FROM EXCLUDED.mensaje THEN now() ELSE flota_notificacion.actualizado END`,
                [d, String(n.clave).slice(0, 120), String(n.tipo).slice(0, 30), n.nivel || 'info', String(n.titulo).slice(0, 200), String(n.mensaje || '').slice(0, 2000)]);
        }
    } catch (err) { console.error('⚠️ No se pudo crear la notificación:', err.message); }
}

// Archiva automáticamente los avisos de un tipo que ya no corresponden (claves vigentes = las que siguen activas)
async function resolverTipo(tipo, clavesVigentes) {
    try {
        await db.query(
            `UPDATE flota_notificacion SET archivada = now(), resuelta = true, leida = COALESCE(leida, now()),
                    titulo = CASE WHEN tipo = 'retorno' THEN regexp_replace(titulo, '^Faltan cargar \\d+ retornos?', 'Retornos cargados') ELSE titulo END
             WHERE tipo = $1 AND archivada IS NULL AND NOT (clave = ANY($2::text[]))`, [tipo, clavesVigentes]);
    } catch (err) { console.error('⚠️ No se pudieron resolver notificaciones:', err.message); }
}

module.exports = { notificar, resolverTipo, eventos };
