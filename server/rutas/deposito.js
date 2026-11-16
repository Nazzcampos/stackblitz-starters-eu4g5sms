// Retorno del camión y usuarios del depósito.
const { app, pool } = require('../core.js');
const base = require('../base.js');
const { db, requireDb } = require('../base.js');
const { crearToken, leerToken, claveNombre, tokenDeRequest, hashPin, comprobarHash, pinFormatoValido, pinAleatorio, requireAdmin, intentosLogin, bloqueadoPorIntentos, registrarFallo } = require('../auth.js');
const { choferesVisibles } = require('./choferes.js');
const { ESTILO, crearXlsx, enviarXlsx } = require('../xlsx.js');
const { hoyArgentina, fechaValida } = require('./documentacion.js');

// =====================================================================
//  CONTROL DE RETORNO DEL CAMIÓN (Encargado de Depósito)
//  Cuando el camión vuelve de la ruta, el encargado anota qué mercadería regresó (por notas de crédito o descuentos)
//  y cuántas cajas en buen estado trajo. La carga del reparto se consulta en Gescom (solo lectura); lo anotado se guarda en Supabase.
//  El encargado entra con su propio usuario y PIN (lo crea el administrador); el administrador también puede ver todo.
// =====================================================================
const HORAS_SESION_DEPOSITO = 12;

async function requireDepAdmin(req, res, next) {
    const datos = leerToken(tokenDeRequest(req));
    if (datos && datos.r === 'admin') { req.operador = 'ADMIN'; req.esAdmin = true; return next(); }
    if (!datos || datos.r !== 'deposito') return res.status(401).json({ error: 'Sesión no válida o vencida' });
    if (!base.dbListo) return res.status(503).json({ error: 'La base de datos no está disponible todavía. Probá de nuevo en unos segundos.' });
    try {
        const r = await db.query('SELECT nombre, activo, sesion_desde FROM flota_deposito WHERE clave = $1', [datos.n]);
        const f = r.rows[0];
        if (!f || !f.activo) return res.status(401).json({ error: 'Tu usuario está desactivado. Consultá con el administrador.' });
        if ((datos.iat || 0) < new Date(f.sesion_desde).getTime()) return res.status(401).json({ error: 'Tu sesión se cerró. Ingresá de nuevo con tu PIN.' });
        req.operador = f.nombre; req.esAdmin = false;
        next();
    } catch (err) {
        res.status(503).json({ error: 'La base de datos no está disponible todavía. Probá de nuevo en unos segundos.' });
    }
}

// ---- Usuarios del depósito ----
app.get('/api/deposito/usuarios', requireDb, async (req, res) => {
    try {
        const r = await db.query('SELECT nombre FROM flota_deposito WHERE activo = true ORDER BY nombre');
        res.json(r.rows.map(f => f.nombre));
    } catch (err) { res.status(500).json({ error: 'No se pudo leer la lista' }); }
});

app.post('/api/deposito/login', requireDb, async (req, res) => {
    const { nombre, pin } = req.body || {};
    const clave = claveNombre(nombre);
    const llave = `${req.ip}|DEP|${clave}`;
    if (bloqueadoPorIntentos(llave)) return res.status(429).json({ error: 'Demasiados intentos. Probá de nuevo en 5 minutos.' });
    try {
        const r = await db.query('SELECT clave, nombre, pin_hash, activo FROM flota_deposito WHERE clave = $1', [clave]);
        const f = r.rows[0];
        if (!f || !pinFormatoValido(String(pin || '').trim()) || !(await comprobarHash(String(pin).trim(), f.pin_hash))) {
            registrarFallo(llave);
            return res.status(401).json({ error: 'Usuario o PIN incorrecto' });
        }
        if (!f.activo) return res.status(403).json({ error: 'Tu usuario está desactivado. Consultá con el administrador.' });
        intentosLogin.delete(llave);
        await db.query('UPDATE flota_deposito SET ultimo_ingreso = $2 WHERE clave = $1', [f.clave, new Date()]);
        res.json({ token: crearToken({ r: 'deposito', n: f.clave }, HORAS_SESION_DEPOSITO), nombre: f.nombre });
    } catch (err) {
        console.error('❌ Error en el login de depósito:', err.message);
        res.status(500).json({ error: 'No se pudo iniciar sesión' });
    }
});

app.get('/api/retorno/me', requireDepAdmin, (req, res) => res.json({ nombre: req.operador, admin: !!req.esAdmin }));

// Administración de usuarios del depósito (el PIN solo se muestra una vez: en la base queda como hash)
app.get('/api/admin/deposito', requireAdmin, requireDb, async (req, res) => {
    try {
        const r = await db.query('SELECT clave, nombre, activo, creado, ultimo_ingreso FROM flota_deposito ORDER BY nombre');
        res.json(r.rows);
    } catch (err) { res.status(500).json({ error: 'No se pudo leer la lista' }); }
});
app.post('/api/admin/deposito', requireAdmin, requireDb, async (req, res) => {
    const nombre = String((req.body || {}).nombre || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (nombre.length < 2) return res.status(400).json({ error: 'Escribí el nombre del encargado.' });
    try {
        const pin = pinAleatorio();
        const r = await db.query(
            `INSERT INTO flota_deposito (clave, nombre, pin_hash) VALUES ($1, $2, $3) ON CONFLICT (clave) DO NOTHING RETURNING clave`,
            [claveNombre(nombre), nombre, await hashPin(pin)]);
        if (!r.rows.length) return res.status(409).json({ error: 'Ya existe un usuario con ese nombre.' });
        res.status(201).json({ exito: true, nombre, pin });
    } catch (err) {
        console.error('❌ Error al crear usuario de depósito:', err.message);
        res.status(500).json({ error: 'No se pudo crear el usuario' });
    }
});
app.post('/api/admin/deposito/pin', requireAdmin, requireDb, async (req, res) => {
    try {
        const pin = pinAleatorio();
        const r = await db.query(`UPDATE flota_deposito SET pin_hash = $2, sesion_desde = now() WHERE clave = $1 RETURNING nombre`,
            [claveNombre((req.body || {}).clave), await hashPin(pin)]);
        if (!r.rows.length) return res.status(404).json({ error: 'Ese usuario no existe.' });
        res.json({ exito: true, nombre: r.rows[0].nombre, pin });
    } catch (err) { res.status(500).json({ error: 'No se pudo cambiar el PIN' }); }
});
app.post('/api/admin/deposito/activo', requireAdmin, requireDb, async (req, res) => {
    try {
        const r = await db.query(`UPDATE flota_deposito SET activo = $2, sesion_desde = now() WHERE clave = $1 RETURNING clave`,
            [claveNombre((req.body || {}).clave), (req.body || {}).activo !== false]);
        if (!r.rows.length) return res.status(404).json({ error: 'Ese usuario no existe.' });
        res.json({ exito: true });
    } catch (err) { res.status(500).json({ error: 'No se pudo guardar' }); }
});

// ---- Datos de Gescom (solo lectura) ----
app.get('/api/retorno/choferes', requireDepAdmin, async (req, res) => {
    try { res.json(await choferesVisibles()); }
    catch (err) { res.status(502).json({ error: 'No se pudo leer la lista de choferes de Gescom' }); }
});

let promesaFiltroAnuladas = null;
function filtroAnuladas() {
    if (!promesaFiltroAnuladas) {
        promesaFiltroAnuladas = pool.query(`/*RETORNO*/ SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'venta' AND column_name IN ('anulada', 'anulado')`)
            .then(r => r.rows.map(c => ` AND COALESCE(v.${c.column_name}::int, 0) = 0`).join(''))
            .catch(err => { promesaFiltroAnuladas = null; return ''; });
    }
    return promesaFiltroAnuladas;
}
let promesaColumnaItem = null;
function columnaCodigoItem() {
    if (!promesaColumnaItem) {
        promesaColumnaItem = pool.query(`/*RETORNO*/ SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'item' AND column_name IN ('codigo', 'item_codigo', 'cod')`)
            .then(r => {
                const nombres = r.rows.map(c => c.column_name);
                const col = ['codigo', 'item_codigo', 'cod'].find(c => nombres.includes(c));
                return col ? `it.${col}` : `(SELECT vi.item_codigo FROM venta_item vi WHERE vi.item_id = it.id LIMIT 1)`;
            })
            .catch(err => { promesaColumnaItem = null; return `(SELECT vi.item_codigo FROM venta_item vi WHERE vi.item_id = it.id LIMIT 1)`; });
    }
    return promesaColumnaItem;
}

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const SQL_RETORNO = `SELECT id::int AS id, to_char(fecha, 'YYYY-MM-DD') AS fecha, chofer, reparto, dominio, cajas, observaciones, items,
        total_unidades::float8 AS total_unidades, cargado_por, creado, actualizado FROM flota_retorno`;

// Carga del reparto de un chofer en un día (lo que salió en el camión) + lo que ya se anotó de retorno
app.get('/api/retorno/carga', requireDepAdmin, requireDb, async (req, res) => {
    const chofer = String(req.query.chofer || '').trim();
    const fecha = String(req.query.fecha || '');
    if (!chofer || !RE_FECHA.test(fecha) || !fechaValida(fecha)) return res.status(400).json({ error: 'Elegí el chofer y la fecha.' });
    const salida = { fecha, chofer, repartos: [], existentes: [], gescom: true };
    try {
        const filtro = await filtroAnuladas();
        const r = await pool.query(`/*RETORNO*/
            SELECT COALESCE(v.reparto_codigo::text, '') AS reparto, vi.item_codigo AS codigo,
                   COALESCE(it.descripcion, vi.item_codigo) AS descripcion, SUM(vi.cantidad) AS cantidad
            FROM venta v
            JOIN venta_item vi ON vi.venta_id = v.id AND vi.tenant_id = v.tenant_id
            LEFT JOIN item it ON it.id = vi.item_id AND it.tenant_id = vi.tenant_id
            WHERE v.empleado_chofer_nombre = $1 AND v.fecha_entrega::date = $2
              AND COALESCE(v.tipo_comprobante_codigo, '') NOT IN ('REME', 'REMI')
              AND COALESCE(v.tipo_comprobante_codigo, '') NOT LIKE 'NC%'${filtro}
            GROUP BY 1, 2, 3
            HAVING SUM(vi.cantidad) > 0
            ORDER BY 1, 3`, [chofer, fecha]);
        const porReparto = new Map();
        r.rows.forEach(f => {
            if (!porReparto.has(f.reparto)) porReparto.set(f.reparto, []);
            porReparto.get(f.reparto).push({ codigo: String(f.codigo), descripcion: f.descripcion, cantidad: Number(f.cantidad) });
        });
        salida.repartos = [...porReparto].map(([reparto, items]) => ({ reparto, items }));
    } catch (err) {
        console.error('⚠️ No se pudo leer la carga del reparto en Gescom:', err.message);
        salida.gescom = false;
    }
    try {
        const e = await db.query(`${SQL_RETORNO} WHERE fecha = $1 AND chofer = $2 ORDER BY reparto`, [fecha, claveNombre(chofer)]);
        salida.existentes = e.rows;
    } catch (err) { /* si falla se muestra igual la carga */ }
    res.json(salida);
});

// Aviso al encargado: repartos de los últimos días (Gescom) que todavía no tienen retorno cargado.
// Se compara (fecha, chofer, reparto) de Gescom contra lo guardado en flota_retorno. Los repartos de hoy se marcan aparte
// porque el camión puede seguir en ruta. Solo cuentan los choferes visibles (los ocultos y repartos sin chofer no generan aviso).
app.get('/api/retorno/pendientes', requireDepAdmin, requireDb, async (req, res) => {
    const dias = Math.min(14, Math.max(1, parseInt(req.query.dias, 10) || 5));
    const hoy = hoyArgentina();
    const desde = new Date(Date.parse(hoy + 'T00:00:00Z') - dias * 86400000).toISOString().slice(0, 10);
    try {
        const [filtro, visibles] = await Promise.all([filtroAnuladas(), choferesVisibles()]);
        const permitidos = new Set(visibles.map(claveNombre));
        const g = await pool.query(`/*RETORNO*/
            SELECT to_char(v.fecha_entrega::date, 'YYYY-MM-DD') AS fecha, v.empleado_chofer_nombre AS chofer,
                   COALESCE(v.reparto_codigo::text, '') AS reparto, COUNT(DISTINCT v.cliente_id)::int AS clientes
            FROM venta v
            WHERE v.fecha_entrega::date BETWEEN $1::date AND $2::date
              AND COALESCE(v.empleado_chofer_nombre, '') <> ''
              AND COALESCE(v.tipo_comprobante_codigo, '') NOT IN ('REME', 'REMI')
              AND COALESCE(v.tipo_comprobante_codigo, '') NOT LIKE 'NC%'${filtro}
            GROUP BY 1, 2, 3
            ORDER BY 1 DESC, 2, 3`, [desde, hoy]);
        const r = await db.query(`SELECT to_char(fecha, 'YYYY-MM-DD') AS fecha, chofer, reparto FROM flota_retorno WHERE fecha BETWEEN $1::date AND $2::date`, [desde, hoy]);
        const cargados = new Set(r.rows.map(f => `${f.fecha}|${f.chofer}|${f.reparto}`));
        const pendientes = g.rows
            .filter(f => permitidos.has(claveNombre(f.chofer)) && !cargados.has(`${f.fecha}|${claveNombre(f.chofer)}|${f.reparto}`))
            .map(f => ({ fecha: f.fecha, chofer: f.chofer, reparto: f.reparto, clientes: f.clientes, esHoy: f.fecha === hoy }));
        res.json({ desde, hasta: hoy, gescom: true, pendientes });
    } catch (err) {
        console.error('⚠️ No se pudieron calcular los retornos pendientes:', err.message);
        res.json({ desde, hasta: hoy, gescom: false, pendientes: [] });
    }
});

// Buscador de artículos (para agregar algo que no estaba en la carga)
app.get('/api/retorno/articulos', requireDepAdmin, async (req, res) => {
    const palabras = String(req.query.q || '').trim().split(/\s+/).filter(Boolean).slice(0, 4);
    if (!palabras.length || palabras.join('').length < 2) return res.json([]);
    try {
        const col = await columnaCodigoItem();
        const params = palabras.map(p => '%' + p.replace(/[\\%_]/g, m => '\\' + m) + '%');
        const cond = params.map((_, i) => `(it.descripcion ILIKE $${i + 1} OR ${col}::text ILIKE $${i + 1})`).join(' AND ');
        const r = await pool.query(`/*RETORNO*/ SELECT ${col}::text AS codigo, it.descripcion FROM item it WHERE ${cond} ORDER BY it.descripcion LIMIT 25`, params);
        res.json(r.rows.filter(f => f.codigo).map(f => ({ codigo: f.codigo, descripcion: f.descripcion })));
    } catch (err) {
        console.error('⚠️ Búsqueda de artículos:', err.message);
        res.status(502).json({ error: 'No se pudo buscar en Gescom' });
    }
});

function cantidadValida(v) {
    const n = Number(String(v).replace(',', '.'));
    return Number.isFinite(n) && n >= 0 && n <= 99999 ? Math.round(n * 100) / 100 : NaN;
}

// Guarda (o corrige) el retorno de un chofer en un día y reparto
app.put('/api/retorno', requireDepAdmin, requireDb, async (req, res) => {
    const b = req.body || {};
    const fecha = String(b.fecha || '');
    const chofer = claveNombre(b.chofer).slice(0, 80);
    const reparto = String(b.reparto || '').trim().slice(0, 20);
    if (!chofer) return res.status(400).json({ error: 'Elegí el chofer.' });
    if (!RE_FECHA.test(fecha) || !fechaValida(fecha)) return res.status(400).json({ error: 'La fecha no es válida.' });
    if (fecha > hoyArgentina()) return res.status(400).json({ error: 'La fecha no puede ser futura.' });
    const cajas = b.cajas === '' || b.cajas === undefined || b.cajas === null ? 0 : cantidadValida(b.cajas);
    if (!Number.isInteger(cajas)) return res.status(400).json({ error: 'Las cajas tienen que ser un número entero.' });
    if (!Array.isArray(b.items) || b.items.length > 400) return res.status(400).json({ error: 'La lista de artículos no es válida.' });
    const porCodigo = new Map();
    for (const it of b.items) {
        const codigo = String(it && it.codigo || '').trim().slice(0, 40);
        const descripcion = String(it && it.descripcion || '').trim().slice(0, 120);
        const retorno = cantidadValida(it && it.retorno);
        if (!codigo) return res.status(400).json({ error: 'Hay un artículo sin código.' });
        if (Number.isNaN(retorno)) return res.status(400).json({ error: `La cantidad de "${descripcion || codigo}" no es válida.` });
        if (retorno === 0) continue;
        const cargada = it.cargada === null || it.cargada === undefined || it.cargada === '' ? null : cantidadValida(it.cargada);
        const ya = porCodigo.get(codigo);
        if (ya) ya.retorno = Math.round((ya.retorno + retorno) * 100) / 100;
        else porCodigo.set(codigo, { codigo, descripcion: descripcion || codigo, cargada: Number.isNaN(cargada) ? null : cargada, retorno });
    }
    const items = [...porCodigo.values()];
    const total = Math.round(items.reduce((s, i) => s + i.retorno, 0) * 100) / 100;
    try {
        const r = await db.query(
            `INSERT INTO flota_retorno (fecha, chofer, reparto, dominio, cajas, observaciones, items, total_unidades, cargado_por)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
             ON CONFLICT (fecha, chofer, reparto) DO UPDATE SET dominio = EXCLUDED.dominio, cajas = EXCLUDED.cajas,
                observaciones = EXCLUDED.observaciones, items = EXCLUDED.items, total_unidades = EXCLUDED.total_unidades,
                cargado_por = EXCLUDED.cargado_por, actualizado = now()
             RETURNING id`,
            [fecha, chofer, reparto, String(b.dominio || '').trim().toUpperCase().slice(0, 12) || null, cajas,
             String(b.observaciones || '').trim().slice(0, 500) || null, JSON.stringify(items), total, req.operador]);
        res.json({ exito: true, id: Number(r.rows[0].id), articulos: items.length, unidades: total });
    } catch (err) {
        console.error('❌ Error al guardar el retorno:', err.message);
        res.status(500).json({ error: 'No se pudo guardar el retorno' });
    }
});

// Historial con filtros: fechas, chofer, reparto y texto (artículo, código, dominio…)
async function consultarRetornos(q) {
    const hoy = hoyArgentina();
    const haceUnMes = new Date(Date.parse(hoy + 'T00:00:00Z') - 30 * 86400000).toISOString().slice(0, 10);
    const desde = RE_FECHA.test(q.desde || '') ? q.desde : haceUnMes;
    const hasta = RE_FECHA.test(q.hasta || '') ? q.hasta : hoy;
    if (!fechaValida(desde) || !fechaValida(hasta) || hasta < desde || (Date.parse(hasta) - Date.parse(desde)) > 366 * 86400000)
        return { error: 'Revisá las fechas (máximo 1 año).' };
    const params = [desde, hasta];
    let sql = `${SQL_RETORNO} WHERE fecha BETWEEN $1 AND $2`;
    if (String(q.chofer || '').trim()) { params.push(claveNombre(q.chofer)); sql += ` AND chofer = $${params.length}`; }
    if (String(q.reparto || '').trim()) { params.push(String(q.reparto).trim()); sql += ` AND reparto = $${params.length}`; }
    const texto = String(q.q || '').trim().slice(0, 60);
    let patron = null;
    if (texto) {
        patron = '%' + texto.replace(/[\\%_]/g, m => '\\' + m) + '%';
        params.push(patron);
        const i = params.length;
        sql += ` AND (chofer ILIKE $${i} OR reparto ILIKE $${i} OR COALESCE(dominio, '') ILIKE $${i} OR COALESCE(observaciones, '') ILIKE $${i}
                 OR EXISTS (SELECT 1 FROM jsonb_array_elements(items) e WHERE e->>'descripcion' ILIKE $${i} OR e->>'codigo' ILIKE $${i}))`;
    }
    sql += ` ORDER BY fecha DESC, chofer, reparto LIMIT 500`;
    const r = await db.query(sql, params);
    return { desde, hasta, texto, filas: r.rows };
}
app.get('/api/retorno/historial', requireDepAdmin, requireDb, async (req, res) => {
    try {
        const r = await consultarRetornos(req.query);
        if (r.error) return res.status(400).json({ error: r.error });
        res.json(r.filas);
    } catch (err) {
        console.error('❌ Error al leer el historial de retornos:', err.message);
        res.status(500).json({ error: 'No se pudo leer el historial' });
    }
});

// Excel: resumen por retorno, detalle por artículo y total por artículo del período
app.get('/api/retorno/exportar', requireDepAdmin, requireDb, async (req, res) => {
    try {
        const r = await consultarRetornos(req.query);
        if (r.error) return res.status(400).json({ error: r.error });
        const fmt = f => f.split('-').reverse().join('/');
        const num = (v, s) => ({ v: Number(v) || 0, s: s || ESTILO.numero });
        const resumen = [['Fecha', 'Chofer', 'Reparto', 'Dominio', 'Cajas en buen estado', 'Unidades que volvieron', 'Artículos distintos', 'Cargó', 'Observaciones']];
        const detalle = [['Fecha', 'Chofer', 'Reparto', 'Código', 'Artículo', 'Salió en el camión', 'Volvió', 'Cargó']];
        const totales = new Map();
        const coincide = it => !r.texto || (String(it.descripcion).toLowerCase().includes(r.texto.toLowerCase()) || String(it.codigo).toLowerCase().includes(r.texto.toLowerCase()));
        r.filas.forEach(f => {
            resumen.push([fmt(f.fecha), f.chofer, f.reparto, f.dominio || '', num(f.cajas), num(f.total_unidades), num(f.items.length), f.cargado_por, f.observaciones || '']);
            f.items.forEach(it => {
                detalle.push([fmt(f.fecha), f.chofer, f.reparto, it.codigo, it.descripcion,
                    it.cargada === null || it.cargada === undefined ? '' : num(it.cargada),
                    it.retorno > (it.cargada === null || it.cargada === undefined ? Infinity : it.cargada) ? num(it.retorno, ESTILO.falla) : num(it.retorno), f.cargado_por]);
                if (coincide(it)) {
                    const t = totales.get(it.codigo) || { codigo: it.codigo, descripcion: it.descripcion, total: 0, veces: 0 };
                    t.total = Math.round((t.total + it.retorno) * 100) / 100; t.veces += 1; totales.set(it.codigo, t);
                }
            });
        });
        const porArticulo = [['Código', 'Artículo', 'Total que volvió', 'En cuántos retornos']];
        [...totales.values()].sort((a, b) => b.total - a.total).forEach(t => porArticulo.push([t.codigo, t.descripcion, num(t.total), num(t.veces)]));
        enviarXlsx(res, `retornos_${r.desde}_a_${r.hasta}.xlsx`, crearXlsx([
            { nombre: 'Resumen', filas: resumen, anchos: [12, 28, 10, 12, 14, 16, 14, 20, 40] },
            { nombre: 'Detalle', filas: detalle, anchos: [12, 28, 10, 14, 44, 16, 12, 20] },
            { nombre: 'Total por artículo', filas: porArticulo, anchos: [14, 44, 16, 16] }
        ]));
    } catch (err) {
        console.error('❌ Error al exportar los retornos:', err.message);
        res.status(500).json({ error: 'No se pudo generar el Excel' });
    }
});

app.delete('/api/retorno/:id', requireAdmin, requireDb, async (req, res) => {
    try {
        await db.query('DELETE FROM flota_retorno WHERE id = $1', [Number(req.params.id) || 0]);
        res.json({ exito: true });
    } catch (err) { res.status(500).json({ error: 'No se pudo borrar' }); }
});



module.exports = { HORAS_SESION_DEPOSITO, requireDepAdmin, filtroAnuladas, columnaCodigoItem, RE_FECHA, SQL_RETORNO, cantidadValida, consultarRetornos };
