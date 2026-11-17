// Acompañantes y planificación de repartos: mantenedor, asignación diaria (la arma el supervisor) y vista del acompañante.
const { app } = require('../core.js');
const base = require('../base.js');
const { db, requireDb } = require('../base.js');
const { crearToken, leerToken, claveNombre, tokenDeRequest, hashPin, comprobarHash, pinFormatoValido, pinAleatorio, requireAdmin, intentosLogin, bloqueadoPorIntentos, registrarFallo } = require('../auth.js');
const { hoyArgentina, fechaValida } = require('./documentacion.js');
const { consultarVentaCamion, claveTextoVenta } = require('./venta-por-camion.js');
const { SQL_DOMINIO } = require('./jornadas.js');
const { normalizarDominio } = require('./documentacion.js');

// =====================================================================
//  ACOMPAÑANTES Y PLANIFICACIÓN DE REPARTOS
//  Los acompañantes salen a ayudar en los repartos pesados (muchos clientes, kilos o kilómetros).
//  Gescom no tiene este dato, así que se maneja acá: el supervisor ve la carga de cada camión del día,
//  asigna a cada acompañante y ellos entran con su PIN a ver "mañana salís con ...".
//  Si Gescom todavía no tiene los repartos de ese día, se muestra la carga del mismo día de la semana anterior (marcada como estimada).
// =====================================================================
const HORAS_SESION_ACOMP = 12;
const hoyAR = hoyArgentina;
const sumarDias = (f, n) => new Date(Date.parse(f + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const nombreLimpio = t => String(t || '').trim().replace(/\s+/g, ' ');

// ---------- Sesión del acompañante ----------
async function requireAcomp(req, res, next) {
    const datos = leerToken(tokenDeRequest(req));
    if (!datos || datos.r !== 'acomp') return res.status(401).json({ error: 'Sesión no válida o vencida' });
    if (!base.dbListo) return res.status(503).json({ error: 'La base de datos no está disponible todavía. Probá de nuevo en unos segundos.' });
    try {
        const r = await db.query('SELECT nombre, activo, sesion_desde FROM flota_acompanante WHERE clave = $1', [datos.n]);
        const f = r.rows[0];
        if (!f || !f.activo) return res.status(401).json({ error: 'Tu usuario está desactivado. Consultá con el supervisor.' });
        if ((datos.iat || 0) < new Date(f.sesion_desde).getTime()) return res.status(401).json({ error: 'Tu sesión se cerró. Ingresá de nuevo con tu PIN.' });
        req.acomp = { clave: datos.n, nombre: f.nombre };
        next();
    } catch (err) { res.status(503).json({ error: 'La base de datos no está disponible todavía. Probá de nuevo en unos segundos.' }); }
}

app.get('/api/acomp/usuarios', requireDb, async (req, res) => {
    try { res.json((await db.query('SELECT nombre FROM flota_acompanante WHERE activo = true ORDER BY nombre')).rows.map(f => f.nombre)); }
    catch (err) { res.status(500).json({ error: 'No se pudo leer la lista' }); }
});
app.post('/api/acomp/login', requireDb, async (req, res) => {
    const { nombre, pin } = req.body || {};
    const clave = claveNombre(nombre);
    const llave = `${req.ip}|ACO|${clave}`;
    if (bloqueadoPorIntentos(llave)) return res.status(429).json({ error: 'Demasiados intentos. Probá de nuevo en 5 minutos.' });
    try {
        const f = (await db.query('SELECT clave, nombre, pin_hash, activo FROM flota_acompanante WHERE clave = $1', [clave])).rows[0];
        if (!f || !pinFormatoValido(String(pin || '').trim()) || !(await comprobarHash(String(pin).trim(), f.pin_hash))) {
            registrarFallo(llave);
            return res.status(401).json({ error: 'Usuario o PIN incorrecto' });
        }
        if (!f.activo) return res.status(403).json({ error: 'Tu usuario está desactivado. Consultá con el supervisor.' });
        intentosLogin.delete(llave);
        await db.query('UPDATE flota_acompanante SET ultimo_ingreso = now() WHERE clave = $1', [f.clave]);
        res.json({ token: crearToken({ r: 'acomp', n: f.clave }, HORAS_SESION_ACOMP), nombre: f.nombre });
    } catch (err) {
        console.error('❌ Login de acompañante:', err.message);
        res.status(500).json({ error: 'No se pudo iniciar sesión' });
    }
});

// Lo que ve el acompañante: sus salidas de hoy en adelante (con la carga guardada al asignar)
app.get('/api/acomp/mi-plan', requireAcomp, async (req, res) => {
    try {
        const hoy = hoyAR();
        const r = await db.query(
            `SELECT to_char(fecha, 'YYYY-MM-DD') AS fecha, rol, camion, dominio, chofer, clientes, kg::float8 AS kg, importe::float8 AS importe,
                    km::float8 AS km, estimado, nota, visto
             FROM flota_plan WHERE acompanante = $1 AND fecha >= $2::date AND fecha <= $2::date + 14 ORDER BY fecha, camion`, [req.acomp.clave, hoy]);
        res.json({ nombre: req.acomp.nombre, hoy, salidas: r.rows });
    } catch (err) { res.status(500).json({ error: 'No se pudo leer tu planificación' }); }
});
app.post('/api/acomp/visto', requireAcomp, async (req, res) => {
    const fecha = String((req.body || {}).fecha || '');
    if (!fechaValida(fecha)) return res.status(400).json({ error: 'Fecha no válida' });
    try {
        await db.query(`UPDATE flota_plan SET visto = now() WHERE acompanante = $1 AND fecha = $2::date AND visto IS NULL`, [req.acomp.clave, fecha]);
        res.json({ exito: true });
    } catch (err) { res.status(500).json({ error: 'No se pudo guardar' }); }
});

// ---------- Mantenedor de acompañantes (el PIN solo se muestra una vez) ----------
app.get('/api/admin/acompanantes', requireAdmin, requireDb, async (req, res) => {
    try { res.json((await db.query('SELECT clave, nombre, activo, creado, ultimo_ingreso FROM flota_acompanante ORDER BY nombre')).rows); }
    catch (err) { res.status(500).json({ error: 'No se pudo leer la lista' }); }
});
app.post('/api/admin/acompanantes', requireAdmin, requireDb, async (req, res) => {
    const nombre = nombreLimpio((req.body || {}).nombre).slice(0, 40);
    if (nombre.length < 2) return res.status(400).json({ error: 'Escribí el nombre del acompañante.' });
    try {
        const pin = pinAleatorio();
        const r = await db.query(`INSERT INTO flota_acompanante (clave, nombre, pin_hash) VALUES ($1, $2, $3) ON CONFLICT (clave) DO NOTHING RETURNING clave`,
            [claveNombre(nombre), nombre, await hashPin(pin)]);
        if (!r.rows.length) return res.status(409).json({ error: 'Ya existe un acompañante con ese nombre.' });
        res.status(201).json({ exito: true, nombre, pin });
    } catch (err) {
        console.error('❌ Crear acompañante:', err.message);
        res.status(500).json({ error: 'No se pudo crear el acompañante' });
    }
});
app.post('/api/admin/acompanantes/pin', requireAdmin, requireDb, async (req, res) => {
    try {
        const pin = pinAleatorio();
        const r = await db.query(`UPDATE flota_acompanante SET pin_hash = $2, sesion_desde = now() WHERE clave = $1 RETURNING nombre`,
            [claveNombre((req.body || {}).clave), await hashPin(pin)]);
        if (!r.rows.length) return res.status(404).json({ error: 'Ese acompañante no existe.' });
        res.json({ exito: true, nombre: r.rows[0].nombre, pin });
    } catch (err) { res.status(500).json({ error: 'No se pudo cambiar el PIN' }); }
});
app.post('/api/admin/acompanantes/activo', requireAdmin, requireDb, async (req, res) => {
    try {
        const r = await db.query(`UPDATE flota_acompanante SET activo = $2, sesion_desde = now() WHERE clave = $1 RETURNING clave`,
            [claveNombre((req.body || {}).clave), (req.body || {}).activo !== false]);
        if (!r.rows.length) return res.status(404).json({ error: 'Ese acompañante no existe.' });
        res.json({ exito: true });
    } catch (err) { res.status(500).json({ error: 'No se pudo guardar' }); }
});

// ---------- Planificación del día ----------
// Carga de cada camión (un día de Gescom agrupado por camión) con km promedio del GPS y un puntaje de "peso" de la salida.
async function cargaDelDia(fecha) {
    const d = await consultarVentaCamion({ desde: fecha, hasta: fecha, sinCostos: '1' });
    if (d.error) throw new Error(d.error);
    const por = new Map();
    d.filas.forEach(f => {
        const k = f.clave || claveTextoVenta(f.camion);
        const t = por.get(k) || { clave: k, camion: f.camion, dominio: f.dominio || '', chofer: f.chofer, clientes: 0, kg: 0, importe: 0, repartos: [] };
        t.clientes += f.clientes; t.kg += f.kg; t.importe += f.importe; t.repartos.push(f.reparto);
        por.set(k, t);
    });
    return [...por.values()];
}
async function kmPromedio(dominios) {
    const mapa = new Map();
    try {
        const r = await db.query(`SELECT ${SQL_DOMINIO('vehiculo')} AS clave, AVG(km) FILTER (WHERE km > 0)::float8 AS km
            FROM flota_odometro_dia WHERE fecha >= CURRENT_DATE - 45 GROUP BY 1`);
        r.rows.forEach(f => { if (f.km) mapa.set(f.clave, f.km); });
    } catch (e) {}
    return d => mapa.get(String(d || '').toUpperCase().replace(/[^A-Z0-9]/g, '')) || null;
}
function puntuar(lista) {
    const max = k => Math.max(0, ...lista.map(x => Number(x[k]) || 0));
    const m = { clientes: max('clientes'), kg: max('kg'), km: max('km') };
    const pesos = { clientes: 0.4, kg: 0.35, km: 0.25 };
    lista.forEach(x => {
        let suma = 0, peso = 0;
        Object.keys(pesos).forEach(k => { if (m[k] > 0 && x[k] !== null && x[k] !== undefined) { suma += pesos[k] * (Number(x[k]) / m[k]); peso += pesos[k]; } });
        x.puntaje = peso ? Math.round(suma / peso * 100) : 0;
        x.nivel = x.puntaje >= 75 ? 'alta' : x.puntaje >= 50 ? 'media' : 'baja';
    });
    return lista;
}

app.get('/api/admin/plan', requireAdmin, requireDb, async (req, res) => {
    const fecha = String(req.query.fecha || '');
    if (!fechaValida(fecha)) return res.status(400).json({ error: 'Elegí una fecha válida.' });
    try {
        const out = { fecha, origen: 'vacio', fechaBase: null, errorGescom: null, repartos: [] };
        try {
            let lista = await cargaDelDia(fecha);
            if (lista.length) { out.origen = 'real'; out.fechaBase = fecha; }
            else {
                // Todavía no está armado en Gescom: se usa el mismo día de la semana anterior (y la anterior a esa)
                for (const n of [7, 14]) {
                    const fechaRef = sumarDias(fecha, -n);
                    lista = await cargaDelDia(fechaRef);
                    if (lista.length) { out.origen = 'estimado'; out.fechaBase = fechaRef; break; }
                }
            }
            const kmDe = await kmPromedio();
            lista.forEach(x => {
                x.kg = Number(x.kg.toFixed(1)); x.importe = Number(x.importe.toFixed(2));
                const km = kmDe(x.dominio); x.km = km ? Number(km.toFixed(1)) : null;
            });
            out.repartos = puntuar(lista).sort((a, b) => b.puntaje - a.puntaje);
        } catch (err) {
            console.error('⚠ Planificación (Gescom):', err.message);
            out.errorGescom = 'No se pudo leer la carga de Gescom. ' + String(err.message || '').slice(0, 200);
        }
        const [ac, asig] = await Promise.all([
            db.query('SELECT clave, nombre, activo FROM flota_acompanante ORDER BY nombre'),
            db.query(`SELECT acompanante, rol, camion_clave, camion, dominio, chofer, clientes, kg::float8 AS kg, importe::float8 AS importe, km::float8 AS km,
                             estimado, nota, visto, asignado_por FROM flota_plan WHERE fecha = $1::date`, [fecha])
        ]);
        const asignados = new Map(asig.rows.map(f => [f.acompanante, f]));
        // ¿Algún acompañante figura como chofer en Gescom ese día? (ej: el que sabe manejar)
        const maneja = new Map();
        if (out.origen === 'real') out.repartos.forEach(r => { maneja.set(claveTextoVenta(r.chofer), r.camion); });
        out.acompanantes = ac.rows.map(f => ({ clave: f.clave, nombre: f.nombre, activo: f.activo, asignacion: asignados.get(f.clave) || null, manejaReparto: maneja.get(claveTextoVenta(f.nombre)) || null }));
        // Asignaciones de acompañantes dados de baja o camiones que ya no están: igual se muestran
        const tablaCamion = new Map(out.repartos.map(r => [r.clave, r]));
        out.repartos.forEach(r => { r.acompanantes = asig.rows.filter(a => a.camion_clave === r.clave).map(a => a.acompanante); });
        out.asignacionesHuerfanas = asig.rows.filter(a => !tablaCamion.has(a.camion_clave)).map(a => ({ acompanante: a.acompanante, camion: a.camion, rol: a.rol }));
        res.json(out);
    } catch (err) {
        console.error('❌ Planificación:', err.message);
        res.status(500).json({ error: 'No se pudo armar la planificación', detalle: String(err.message || '').slice(0, 300) });
    }
});

const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
app.post('/api/admin/plan/asignar', requireAdmin, requireDb, async (req, res) => {
    const b = req.body || {};
    const fecha = String(b.fecha || '');
    if (!fechaValida(fecha)) return res.status(400).json({ error: 'Fecha no válida' });
    const acomp = claveNombre(b.acompanante);
    const camionClave = String(b.camionClave || '').slice(0, 80);
    const camion = nombreLimpio(b.camion).slice(0, 80);
    if (!acomp || !camionClave || !camion) return res.status(400).json({ error: 'Falta el acompañante o el camión.' });
    const rol = b.rol === 'chofer' ? 'chofer' : 'acompanante';
    try {
        const a = await db.query('SELECT activo FROM flota_acompanante WHERE clave = $1', [acomp]);
        if (!a.rows.length) return res.status(404).json({ error: 'Ese acompañante no existe.' });
        if (!a.rows[0].activo) return res.status(409).json({ error: 'Ese acompañante está desactivado.' });
        // Si ya estaba asignado al mismo camión con lo mismo, no se vuelve a marcar como "no visto"
        await db.query(`INSERT INTO flota_plan (fecha, acompanante, rol, camion_clave, camion, dominio, chofer, clientes, kg, importe, km, estimado, nota, asignado_por)
            VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'ADMIN')
            ON CONFLICT (fecha, acompanante) DO UPDATE SET rol = EXCLUDED.rol, camion_clave = EXCLUDED.camion_clave, camion = EXCLUDED.camion, dominio = EXCLUDED.dominio,
                chofer = EXCLUDED.chofer, clientes = EXCLUDED.clientes, kg = EXCLUDED.kg, importe = EXCLUDED.importe, km = EXCLUDED.km, estimado = EXCLUDED.estimado, nota = EXCLUDED.nota,
                visto = CASE WHEN flota_plan.camion_clave = EXCLUDED.camion_clave AND flota_plan.rol = EXCLUDED.rol THEN flota_plan.visto ELSE NULL END,
                actualizado = now()`,
            [fecha, acomp, rol, camionClave, camion, normalizarDominio(b.dominio) || '', nombreLimpio(b.chofer).slice(0, 80), Math.round(num(b.clientes) || 0), num(b.kg) || 0, num(b.importe) || 0,
                num(b.km), !!b.estimado, nombreLimpio(b.nota).slice(0, 200)]);
        res.json({ exito: true });
    } catch (err) {
        console.error('❌ Asignar acompañante:', err.message);
        res.status(500).json({ error: 'No se pudo guardar la asignación' });
    }
});
app.post('/api/admin/plan/quitar', requireAdmin, requireDb, async (req, res) => {
    const fecha = String((req.body || {}).fecha || '');
    if (!fechaValida(fecha)) return res.status(400).json({ error: 'Fecha no válida' });
    try {
        await db.query('DELETE FROM flota_plan WHERE fecha = $1::date AND acompanante = $2', [fecha, claveNombre((req.body || {}).acompanante)]);
        res.json({ exito: true });
    } catch (err) { res.status(500).json({ error: 'No se pudo quitar la asignación' }); }
});

module.exports = { requireAcomp, HORAS_SESION_ACOMP };
