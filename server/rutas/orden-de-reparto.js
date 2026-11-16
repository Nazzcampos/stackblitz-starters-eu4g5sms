// Orden de reparto: propuestas del chofer, aprobación, exportación e importación del orden actual.
const { app, pool } = require('../core.js');
const { db, requireDb } = require('../base.js');
const { claveNombre, requireChofer, requireAdmin } = require('../auth.js');
const { obtenerDeudas } = require('../gescom.js');
const { ESTILO, crearXlsx, enviarXlsx } = require('../xlsx.js');

// =====================================================================
//  ORDEN DE REPARTO
//  El orden vive en Gescom (cliente_ruta_hist.orden, uno por zona/ruta). La app NUNCA escribe en Gescom:
//  el chofer arma una propuesta, el administrador la aprueba y baja un Excel para cargarlo en Gescom.
// =====================================================================
const RUTAS_ORDEN_EXCLUIDAS = (process.env.RUTAS_ORDEN_EXCLUIDAS || '99').split(',').map(s => s.trim()).filter(Boolean);
const DIAS_SEMANA = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'];
const MAX_CLIENTES_ORDEN = 1500;
const cacheRutasChofer = new Map();

// Zonas que recorre un chofer: las de los clientes que entregó en los últimos 45 días (sin las rutas generales excluidas)
async function rutasDelChofer(nombre) {
    const clave = claveNombre(nombre);
    const c = cacheRutasChofer.get(clave);
    if (c && Date.now() - c.ts < 5 * 60 * 1000) return c.datos;
    const r = await pool.query(`
        SELECT rh.ruta_codigo::text AS ruta, COUNT(DISTINCT v.cliente_id)::int AS entregas
        FROM venta v
        JOIN cliente_ruta_hist rh ON rh.cliente_id = v.cliente_id AND rh.actual = true
        WHERE v.empleado_chofer_nombre = $1
          AND v.fecha_entrega::date >= CURRENT_DATE - 45
          AND rh.ruta_codigo IS NOT NULL
          AND rh.ruta_codigo::text <> ALL($2::text[])
        GROUP BY rh.ruta_codigo::text
        HAVING COUNT(DISTINCT v.cliente_id) >= 3
        ORDER BY 1`, [nombre, RUTAS_ORDEN_EXCLUIDAS]);
    const datos = r.rows.map(f => ({ ruta: String(f.ruta), entregas: Number(f.entregas) }));
    cacheRutasChofer.set(clave, { ts: Date.now(), datos });
    return datos;
}

// Cantidad de clientes de cada zona y cuántos se visitan cada día de la semana
async function resumenRutas(rutas) {
    if (!rutas.length) return new Map();
    const r = await pool.query(`
        SELECT rh.ruta_codigo::text AS ruta, COUNT(*)::int AS clientes,
               ${DIAS_SEMANA.map(d => `COUNT(*) FILTER (WHERE rh.${d} = 1)::int AS ${d}`).join(', ')}
        FROM cliente_ruta_hist rh
        JOIN cliente_hist c ON c.id = rh.cliente_id AND c.actual = true AND COALESCE(c.activo, true) = true
        WHERE rh.actual = true AND rh.ruta_codigo::text = ANY($1::text[])
        GROUP BY rh.ruta_codigo::text`, [rutas]);
    return new Map(r.rows.map(f => [String(f.ruta), f]));
}

function validarRutaDia(ruta, dia) {
    ruta = String(ruta || '').trim();
    dia = String(dia || '').trim().toLowerCase();
    if (!/^[A-Za-z0-9_-]{1,20}$/.test(ruta)) return null;
    if (dia && !DIAS_SEMANA.includes(dia)) return null;
    return { ruta, dia };
}

// Código de cliente (el "Número" de Gescom) para una lista de clientes, buscándolo en todas las fuentes disponibles:
// 1) cliente_hist.codigo  2) cuenta corriente  3) el último comprobante de venta del cliente
let promesaFuentesCodigo = null;
function fuentesCodigoCliente() {
    if (!promesaFuentesCodigo) {
        promesaFuentesCodigo = pool.query(`
            SELECT table_name, column_name FROM information_schema.columns
            WHERE table_schema = 'public'
              AND ((table_name = 'venta' AND column_name = 'cliente_codigo') OR (table_name = 'cliente_hist' AND column_name = 'codigo'))`)
            .then(r => ({
                hist: r.rows.some(x => x.table_name === 'cliente_hist'),
                venta: r.rows.some(x => x.table_name === 'venta')
            }))
            .catch(err => { promesaFuentesCodigo = null; return { hist: false, venta: false }; });
    }
    return promesaFuentesCodigo;
}
async function codigosDeClientes(ids) {
    const lista = [...new Set(ids.map(String).filter(id => /^\d+$/.test(id)))];
    const mapa = new Map();
    if (!lista.length) return mapa;
    const fuentes = await fuentesCodigoCliente();
    const poner = (id, cod) => { if (cod !== null && cod !== undefined && String(cod).trim() !== '' && !mapa.has(String(id))) mapa.set(String(id), String(cod).trim()); };
    if (fuentes.hist) {
        try {
            const r = await pool.query(`SELECT id::text AS id, codigo::text AS codigo FROM cliente_hist WHERE actual = true AND id = ANY($1::bigint[])`, [lista]);
            r.rows.forEach(f => poner(f.id, f.codigo));
        } catch (e) { console.error('⚠️ Código desde cliente_hist:', e.message); }
    }
    if (lista.some(id => !mapa.has(id))) {
        try { const d = await obtenerDeudas(); lista.forEach(id => poner(id, d.codigos.get(id))); } catch (e) { /* solo informativo */ }
    }
    const faltan = lista.filter(id => !mapa.has(id));
    if (fuentes.venta && faltan.length) {
        try {
            const r = await pool.query(`
                SELECT DISTINCT ON (cliente_id) cliente_id::text AS id, cliente_codigo::text AS codigo
                FROM venta WHERE cliente_id = ANY($1::bigint[]) AND cliente_codigo IS NOT NULL
                ORDER BY cliente_id, fecha_entrega DESC NULLS LAST`, [faltan]);
            r.rows.forEach(f => poner(f.id, f.codigo));
        } catch (e) { console.error('⚠️ Código desde venta:', e.message); }
    }
    return mapa;
}

// Clientes de una zona (opcionalmente solo los de un día) con su orden actual en Gescom
async function clientesDeRuta(ruta, dia) {
    const filtroDia = dia ? ` AND rh.${dia} = 1` : '';
    const r = await pool.query(`
        SELECT rh.cliente_id::text AS id, c.razon_social AS nombre, c.direccion, c.localidad, rh.orden::int AS orden
        FROM cliente_ruta_hist rh
        JOIN cliente_hist c ON c.id = rh.cliente_id AND c.actual = true AND COALESCE(c.activo, true) = true
        WHERE rh.actual = true AND rh.ruta_codigo::text = $1${filtroDia}
        ORDER BY rh.orden ASC NULLS FIRST, c.razon_social ASC
        LIMIT ${MAX_CLIENTES_ORDEN}`, [ruta]);
    const codigos = await codigosDeClientes(r.rows.map(f => f.id));
    // El orden que importa es el "Orden de reparto" del camionero (importado de Gescom); si todavía no se importó, se usa el del vendedor
    let ordenApp = new Map();
    try { (await db.query(`SELECT cliente_codigo, orden FROM flota_orden_cliente`)).rows.forEach(f => ordenApp.set(String(f.cliente_codigo), Number(f.orden))); } catch (e) { /* sin base propia */ }
    const usarApp = ordenApp.size > 0;
    const lista = r.rows.map(f => {
        const codigo = codigos.get(String(f.id)) || null;
        const o = usarApp ? (codigo && ordenApp.has(String(codigo)) ? ordenApp.get(String(codigo)) : null)
                          : (f.orden === null || f.orden === undefined ? null : Number(f.orden));
        return {
            id: String(f.id),
            codigo,
            nombre: f.nombre || '',
            direccion: f.direccion || '',
            localidad: f.localidad || '',
            orden: o,
            sin_ubicar: o === null || o <= 0   // alta reciente o sin orden de reparto cargado: todavía sin lugar en el recorrido
        };
    });
    if (usarApp) lista.sort((a, b) => ((a.orden == null || a.orden <= 0 ? 0 : 1) - (b.orden == null || b.orden <= 0 ? 0 : 1)) || ((a.orden || 0) - (b.orden || 0)) || a.nombre.localeCompare(b.nombre, 'es'));
    return lista;
}

// Dada la lista en el nuevo orden, asigna a cada cliente un número de orden:
// se reutilizan los números que ya tenía la zona (así no se toca lo que no cambió) y, si hacen falta más, se agregan al final de 10 en 10.
// Los clientes marcados como baja no ocupan lugar.
function calcularOrden(clientes, idsOrdenados, bajas) {
    const porId = new Map(clientes.map(c => [c.id, c]));
    const vistos = new Set();
    const lista = [];
    idsOrdenados.forEach(id => { id = String(id); if (porId.has(id) && !vistos.has(id)) { vistos.add(id); lista.push(porId.get(id)); } });
    clientes.forEach(c => { if (!vistos.has(c.id)) lista.push(c); });   // los que no vinieron se agregan al final, sin perderlos
    const setBajas = new Set((bajas || []).map(String));
    const activos = lista.filter(c => !setBajas.has(c.id));
    const slots = [];
    clientes.map(c => c.orden).filter(o => Number.isFinite(o) && o > 0).sort((a, b) => a - b).forEach(o => {
        slots.push(slots.length && o <= slots[slots.length - 1] ? slots[slots.length - 1] + 1 : o);
    });
    while (slots.length < activos.length) slots.push((slots.length ? slots[slots.length - 1] : 0) + 10);
    const nuevoDe = new Map(activos.map((c, i) => [c.id, slots[i]]));
    return lista.map(c => {
        const baja = setBajas.has(c.id);
        const nuevo = baja ? null : nuevoDe.get(c.id);
        return { id: c.id, codigo: c.codigo, nombre: c.nombre, direccion: c.direccion, localidad: c.localidad,
                 antes: c.orden, nuevo, baja, cambio: baja || nuevo !== c.orden };
    });
}

const COLS_PROPUESTA = `id::int AS id, chofer, ruta, dia, estado, base, cambios::int AS cambios, nota,
    actualizado, enviado, resuelto`;

async function ultimaPropuesta(chofer, ruta, dia) {
    const r = await db.query(
        `SELECT ${COLS_PROPUESTA}, items FROM flota_orden_propuesta
         WHERE chofer = $1 AND ruta = $2 AND dia = $3 ORDER BY id DESC LIMIT 1`, [chofer, ruta, dia]);
    return r.rows[0] || null;
}

// Zonas del chofer, con los días que se visitan y el estado de sus propuestas
app.get('/api/orden/rutas', requireChofer, requireDb, async (req, res) => {
    try {
        const rutas = await rutasDelChofer(req.chofer);
        const resumen = await resumenRutas(rutas.map(r => r.ruta));
        const props = await db.query(
            `SELECT DISTINCT ON (ruta, dia) ruta, dia, estado, cambios::int AS cambios, nota
             FROM flota_orden_propuesta WHERE chofer = $1 ORDER BY ruta, dia, id DESC`, [req.chofer]);
        res.json({
            rutas: rutas.map(r => {
                const s = resumen.get(r.ruta) || {};
                const dias = {};
                DIAS_SEMANA.forEach(d => { if (Number(s[d]) > 0) dias[d] = Number(s[d]); });
                return { ruta: r.ruta, entregas: r.entregas, clientes: Number(s.clientes) || 0, dias };
            }).filter(r => r.clientes > 0),
            propuestas: props.rows.filter(p => ['borrador', 'enviada', 'aprobada', 'rechazada'].includes(p.estado))
        });
    } catch (err) {
        console.error('❌ Error al leer las zonas del chofer:', err.message);
        res.status(500).json({ error: 'No se pudieron cargar tus zonas' });
    }
});

// Clientes de una zona (y día) en el orden que corresponde mostrar: el borrador/propuesta si existe, si no el de Gescom
app.get('/api/orden/ruta/:ruta', requireChofer, requireDb, async (req, res) => {
    const v = validarRutaDia(req.params.ruta, req.query.dia);
    if (!v) return res.status(400).json({ error: 'Zona o día inválido' });
    try {
        const permitidas = (await rutasDelChofer(req.chofer)).map(r => r.ruta);
        if (!permitidas.includes(v.ruta)) return res.status(403).json({ error: 'Esa zona no es de tu reparto' });
        const clientes = await clientesDeRuta(v.ruta, v.dia);
        const prop = await ultimaPropuesta(req.chofer, v.ruta, v.dia);
        const vigente = prop && prop.base === 'reparto' && ['borrador', 'enviada', 'aprobada'].includes(prop.estado) ? prop : null;
        let lista = clientes.map(c => ({ ...c, nuevo: c.orden, baja: false }));
        if (vigente) {
            const porId = new Map(clientes.map(c => [c.id, c]));
            const ordenado = [];
            const usados = new Set();
            (vigente.items || []).forEach(it => {
                const c = porId.get(String(it.id));
                if (c) { usados.add(c.id); ordenado.push({ ...c, nuevo: it.nuevo, baja: !!it.baja }); }
            });
            // clientes que aparecieron en Gescom después de armar la propuesta: arriba y marcados
            const recien = clientes.filter(c => !usados.has(c.id)).map(c => ({ ...c, nuevo: c.orden, baja: false, aparecio: true }));
            lista = recien.concat(ordenado);
        } else {
            // altas sin lugar asignado (orden 0 o vacío) primero, para que se vean
            lista = lista.filter(c => c.sin_ubicar).concat(lista.filter(c => !c.sin_ubicar));
        }
        res.json({
            ruta: v.ruta, dia: v.dia, total: clientes.length,
            editable: !(vigente && vigente.estado !== 'borrador'),
            propuesta: prop ? { id: prop.id, estado: prop.estado, cambios: prop.cambios, nota: prop.nota || '' } : null,
            clientes: lista
        });
    } catch (err) {
        console.error('❌ Error al leer la zona:', err.message);
        res.status(500).json({ error: 'No se pudo cargar la zona' });
    }
});

// Guarda el borrador (se llama cada vez que el chofer mueve algo)
app.put('/api/orden/borrador', requireChofer, requireDb, async (req, res) => {
    const b = req.body || {};
    const v = validarRutaDia(b.ruta, b.dia);
    if (!v) return res.status(400).json({ error: 'Zona o día inválido' });
    if (!Array.isArray(b.ids) || b.ids.length > MAX_CLIENTES_ORDEN) return res.status(400).json({ error: 'Lista inválida' });
    const bajas = Array.isArray(b.bajas) ? b.bajas.slice(0, MAX_CLIENTES_ORDEN) : [];
    try {
        const permitidas = (await rutasDelChofer(req.chofer)).map(r => r.ruta);
        if (!permitidas.includes(v.ruta)) return res.status(403).json({ error: 'Esa zona no es de tu reparto' });
        const prop = await ultimaPropuesta(req.chofer, v.ruta, v.dia);
        if (prop && ['enviada', 'aprobada'].includes(prop.estado)) {
            return res.status(409).json({ error: 'Ya enviaste una propuesta para esta zona. Esperá a que el administrador la revise o retirala.' });
        }
        const clientes = await clientesDeRuta(v.ruta, v.dia);
        const items = calcularOrden(clientes, b.ids, bajas);
        const cambios = items.filter(i => i.cambio).length;
        if (prop && prop.estado === 'borrador') {
            await db.query(`UPDATE flota_orden_propuesta SET items = $1::jsonb, cambios = $2, base = 'reparto', actualizado = now() WHERE id = $3`,
                [JSON.stringify(items), cambios, prop.id]);
        } else {
            await db.query(`INSERT INTO flota_orden_propuesta (chofer, ruta, dia, estado, cambios, items, base) VALUES ($1, $2, $3, 'borrador', $4, $5::jsonb, 'reparto')`,
                [req.chofer, v.ruta, v.dia, cambios, JSON.stringify(items)]);
        }
        res.json({ exito: true, cambios, items: items.map(i => ({ id: i.id, nuevo: i.nuevo, baja: i.baja })) });
    } catch (err) {
        console.error('❌ Error al guardar el borrador de orden:', err.message);
        res.status(500).json({ error: 'No se pudo guardar el borrador' });
    }
});

// Envía el borrador al administrador
app.post('/api/orden/enviar', requireChofer, requireDb, async (req, res) => {
    const v = validarRutaDia((req.body || {}).ruta, (req.body || {}).dia);
    if (!v) return res.status(400).json({ error: 'Zona o día inválido' });
    try {
        const prop = await ultimaPropuesta(req.chofer, v.ruta, v.dia);
        if (!prop || prop.estado !== 'borrador') return res.status(409).json({ error: 'No hay un borrador para enviar.' });
        if (!prop.cambios) return res.status(400).json({ error: 'No hiciste ningún cambio en el orden.' });
        await db.query(`UPDATE flota_orden_propuesta SET estado = 'enviada', enviado = now(), actualizado = now() WHERE id = $1`, [prop.id]);
        res.json({ exito: true });
    } catch (err) {
        console.error('❌ Error al enviar el orden:', err.message);
        res.status(500).json({ error: 'No se pudo enviar la propuesta' });
    }
});

// Vuelve a abrir para editar una propuesta enviada o aprobada (conserva todos los cambios; el administrador deja de verla hasta que se reenvíe)
app.post('/api/orden/reabrir', requireChofer, requireDb, async (req, res) => {
    const v = validarRutaDia((req.body || {}).ruta, (req.body || {}).dia);
    if (!v) return res.status(400).json({ error: 'Zona o día inválido' });
    try {
        const prop = await ultimaPropuesta(req.chofer, v.ruta, v.dia);
        if (!prop || !['enviada', 'aprobada'].includes(prop.estado)) return res.status(409).json({ error: 'No hay una propuesta para reabrir.' });
        const r = await db.query(
            `UPDATE flota_orden_propuesta SET estado = 'borrador', enviado = NULL, resuelto = NULL, nota = NULL, actualizado = now()
             WHERE id = $1 AND estado IN ('enviada', 'aprobada')
               AND NOT EXISTS (SELECT 1 FROM flota_orden_propuesta WHERE chofer = $2 AND ruta = $3 AND dia = $4 AND estado = 'borrador')
             RETURNING id`, [prop.id, req.chofer, v.ruta, v.dia]);
        if (!r.rows.length) return res.status(409).json({ error: 'La propuesta cambió de estado. Actualizá la pantalla.' });
        res.json({ exito: true, estabaAprobada: prop.estado === 'aprobada' });
    } catch (err) {
        console.error('❌ Error al reabrir el orden:', err.message);
        res.status(500).json({ error: 'No se pudo reabrir la propuesta' });
    }
});

// Descarta el borrador o retira una propuesta ya enviada (si todavía no se aprobó)
app.delete('/api/orden/propuesta', requireChofer, requireDb, async (req, res) => {
    const v = validarRutaDia(req.query.ruta, req.query.dia);
    if (!v) return res.status(400).json({ error: 'Zona o día inválido' });
    try {
        const r = await db.query(
            `DELETE FROM flota_orden_propuesta WHERE chofer = $1 AND ruta = $2 AND dia = $3 AND estado IN ('borrador', 'enviada')`,
            [req.chofer, v.ruta, v.dia]);
        res.json({ exito: true, borradas: r.rowCount || 0 });
    } catch (err) {
        res.status(500).json({ error: 'No se pudo descartar' });
    }
});

// --- Administración ---
app.get('/api/admin/orden', requireAdmin, requireDb, async (req, res) => {
    try {
        const r = await db.query(
            `SELECT ${COLS_PROPUESTA} FROM flota_orden_propuesta
             WHERE estado <> 'borrador' ORDER BY (estado = 'enviada') DESC, COALESCE(enviado, creado) DESC LIMIT 300`);
        res.json(r.rows);
    } catch (err) {
        console.error('❌ Error al leer propuestas de orden:', err.message);
        res.status(500).json({ error: 'No se pudieron leer las propuestas' });
    }
});

app.get('/api/admin/orden/:id', requireAdmin, requireDb, async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'id inválido' });
    try {
        const r = await db.query(`SELECT ${COLS_PROPUESTA}, items FROM flota_orden_propuesta WHERE id = $1 AND estado <> 'borrador'`, [req.params.id]);
        if (!r.rows[0]) return res.status(404).json({ error: 'No existe esa propuesta' });
        res.json(r.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'No se pudo leer la propuesta' });
    }
});

// Aplica (o revierte) en la base de la app el "Orden de reparto" de una propuesta. Gescom no se toca: el Excel se carga a mano.
async function aplicarOrdenPropuesta(items, revertir) {
    const cods = [], ords = [], borrar = [];
    (items || []).forEach(i => {
        if (!i.codigo || !(i.cambio || i.baja)) return;
        const o = Number(revertir ? i.antes : (i.baja ? null : i.nuevo));
        if (Number.isFinite(o) && o > 0) { cods.push(String(i.codigo)); ords.push(Math.round(o)); } else borrar.push(String(i.codigo));
    });
    if (cods.length) await db.query(`INSERT INTO flota_orden_cliente (cliente_codigo, orden)
        SELECT DISTINCT ON (c) c, o FROM unnest($1::text[], $2::int[]) AS t(c, o)
        ON CONFLICT (cliente_codigo) DO UPDATE SET orden = EXCLUDED.orden, actualizado = now()`, [cods, ords]);
    if (borrar.length) await db.query(`DELETE FROM flota_orden_cliente WHERE cliente_codigo = ANY($1::text[])`, [borrar]);
    return cods.length + borrar.length;
}
app.post('/api/admin/orden/:id/estado', requireAdmin, requireDb, async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'id inválido' });
    const estado = String((req.body || {}).estado || '');
    const nota = String((req.body || {}).nota || '').trim().slice(0, 300);
    const permitido = { aprobada: ['enviada'], rechazada: ['enviada', 'aprobada'], aplicada: ['aprobada'] };
    if (!permitido[estado]) return res.status(400).json({ error: 'Estado inválido' });
    try {
        const previa = (await db.query(`SELECT estado, base, items FROM flota_orden_propuesta WHERE id = $1`, [req.params.id])).rows[0];
        const r = await db.query(
            `UPDATE flota_orden_propuesta SET estado = $1, nota = $2, resuelto = now(), actualizado = now()
             WHERE id = $3 AND estado = ANY($4::text[]) RETURNING id`,
            [estado, nota, req.params.id, permitido[estado]]);
        if (!r.rows.length) return res.status(409).json({ error: 'La propuesta cambió de estado. Actualizá la lista.' });
        let aplicados = null;
        if (previa && previa.base === 'reparto') {
            const items = previa.items || [];
            if (estado === 'aprobada') {
                // los clientes viejos de la propuesta pueden no traer el código: se completa antes de aplicar
                const sin = items.filter(i => !i.codigo).map(i => i.id);
                if (sin.length) {
                    const cods = await codigosDeClientes(sin);
                    items.forEach(i => { if (!i.codigo && cods.has(String(i.id))) i.codigo = cods.get(String(i.id)); });
                    await db.query(`UPDATE flota_orden_propuesta SET items = $1::jsonb WHERE id = $2`, [JSON.stringify(items), req.params.id]);
                }
                aplicados = await aplicarOrdenPropuesta(items, false);
            } else if (estado === 'rechazada' && previa.estado === 'aprobada') {
                aplicados = await aplicarOrdenPropuesta(items, true);   // ya estaba aplicada en la app: se deshace
            }
        }
        res.json({ exito: true, aplicados });
    } catch (err) {
        console.error('❌ Error al cambiar el estado del orden:', err.message);
        res.status(500).json({ error: 'No se pudo actualizar' });
    }
});

// Excel para cargar en Gescom: una propuesta (?id=) o todas las aprobadas pendientes de cargar (?estado=aprobada)
app.get('/api/admin/exportar/orden', requireAdmin, requireDb, async (req, res) => {
    try {
        let r;
        if (/^\d+$/.test(String(req.query.id || ''))) {
            r = await db.query(`SELECT ${COLS_PROPUESTA}, items FROM flota_orden_propuesta WHERE id = $1 AND estado <> 'borrador'`, [req.query.id]);
        } else {
            r = await db.query(`SELECT ${COLS_PROPUESTA}, items FROM flota_orden_propuesta WHERE estado = 'aprobada' ORDER BY ruta, dia, id`);
        }
        if (!r.rows.length) return res.status(404).json({ error: 'No hay propuestas para exportar.' });
        // Propuestas armadas antes de que existiera esta búsqueda pueden no traer el código: se completa ahora
        const sinCodigo = [];
        r.rows.forEach(p => (p.items || []).forEach(i => { if (!i.codigo) sinCodigo.push(i.id); }));
        if (sinCodigo.length) {
            const cods = await codigosDeClientes(sinCodigo);
            r.rows.forEach(p => (p.items || []).forEach(i => { if (!i.codigo && cods.has(String(i.id))) i.codigo = cods.get(String(i.id)); }));
        }
        const enc = ['Zona', 'Día', 'Código cliente', 'ID cliente', 'Cliente', 'Dirección', 'Localidad', 'Orden de reparto anterior', 'Orden de reparto nuevo', 'Qué cambió', 'Chofer', 'Propuesta N°'];
        const todo = [enc], cambios = [enc];
        r.rows.forEach(p => {
            (p.items || []).forEach(i => {
                const que = i.baja ? { v: 'BAJA', s: ESTILO.falla } : (i.cambio ? { v: 'Cambió', s: ESTILO.ok } : '');
                const fila = [p.ruta, p.dia || 'todos', i.codigo || '', i.id, i.nombre, i.direccion || '', i.localidad || '',
                    i.antes === null || i.antes === undefined ? '' : i.antes, i.nuevo === null || i.nuevo === undefined ? '' : i.nuevo,
                    que, p.chofer, p.id];
                todo.push(fila);
                if (i.cambio || i.baja) cambios.push(fila);
            });
        });
        const anchos = [8, 11, 14, 12, 34, 30, 18, 22, 22, 12, 24, 12];
        const nombre = r.rows.length === 1 ? `orden_zona_${r.rows[0].ruta}${r.rows[0].dia ? '_' + r.rows[0].dia : ''}_prop${r.rows[0].id}.xlsx` : 'orden_reparto_aprobado.xlsx';
        enviarXlsx(res, nombre, crearXlsx([
            { nombre: 'Solo cambios', filas: cambios, anchos },
            { nombre: 'Orden completo', filas: todo, anchos }
        ]));
    } catch (err) {
        console.error('❌ Error al exportar el orden:', err.message);
        res.status(500).json({ error: 'No se pudo generar el Excel' });
    }
});


module.exports = { RUTAS_ORDEN_EXCLUIDAS, DIAS_SEMANA, MAX_CLIENTES_ORDEN, cacheRutasChofer, rutasDelChofer, resumenRutas, validarRutaDia, fuentesCodigoCliente, codigosDeClientes, clientesDeRuta, calcularOrden, COLS_PROPUESTA, ultimaPropuesta, aplicarOrdenPropuesta };
