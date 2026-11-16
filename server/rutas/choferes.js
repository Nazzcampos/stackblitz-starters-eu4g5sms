// Choferes: lista desde Gescom, alta/baja, PIN, login del chofer.
const { app, pool } = require('../core.js');
const { db, requireDb } = require('../base.js');
const { HORAS_SESION_CHOFER, HORAS_SESION_ADMIN, ADMIN_PASSWORD, crearToken, claveNombre, pinDeChofer, iguales, hashPin, comprobarHash, pinFormatoValido, pinDebil, pinAleatorio, olvidarEstadoChofer, requireChofer, requireAdmin, intentosLogin, bloqueadoPorIntentos, registrarFallo } = require('../auth.js');
const { TTL_DEUDAS_MS } = require('../gescom.js');

// --- MÓDULO DE CHOFERES ---
// La lista sale de venta (tabla grande), por eso se guarda en caché 10 minutos.
let cacheChoferes = { lista: null, ts: 0, pendiente: null };
async function obtenerChoferes() {
    if (cacheChoferes.lista && Date.now() - cacheChoferes.ts < TTL_DEUDAS_MS) return cacheChoferes.lista;
    if (cacheChoferes.pendiente) return cacheChoferes.pendiente;
    cacheChoferes.pendiente = (async () => {
        try {
            const r = await pool.query(`
                SELECT DISTINCT empleado_chofer_nombre AS nombre
                FROM venta
                WHERE empleado_chofer_nombre IS NOT NULL
                  AND TRIM(empleado_chofer_nombre) != ''
                ORDER BY empleado_chofer_nombre ASC;
            `);
            cacheChoferes.lista = r.rows.map(x => x.nombre);
            cacheChoferes.ts = Date.now();
            return cacheChoferes.lista;
        } finally {
            cacheChoferes.pendiente = null;
        }
    })();
    return cacheChoferes.pendiente;
}

// Choferes que el administrador sacó de la lista (empleados que figuran en Gescom pero no manejan)
async function clavesOcultas() {
    if (!db) return new Set();
    try {
        const r = await db.query('SELECT clave FROM flota_chofer WHERE oculto = true');
        return new Set(r.rows.map(f => f.clave));
    } catch (e) { return new Set(); }
}
async function choferesVisibles() {
    const [lista, ocultos] = await Promise.all([obtenerChoferes(), clavesOcultas()]);
    return lista.filter(n => !ocultos.has(claveNombre(n)));
}

// Lista para el desplegable del login (solo nombres)
app.get('/api/choferes', async (req, res) => {
    try {
        const lista = await choferesVisibles();
        res.json(lista.map(nombre => ({ nombre })));
    } catch (err) {
        console.error("❌ Error al obtener la lista de choferes:", err.message);
        res.status(500).json({ error: "No se pudo obtener la lista de choferes" });
    }
});

// Crea (si hace falta) la ficha del chofer en Supabase y la devuelve
async function asegurarChofer(nombreReal) {
    const r = await db.query(
        `INSERT INTO flota_chofer (clave, nombre) VALUES ($1, $2)
         ON CONFLICT (clave) DO UPDATE SET nombre = EXCLUDED.nombre
         RETURNING *`, [claveNombre(nombreReal), nombreReal]);
    return r.rows[0];
}
async function pinCorrecto(fila, nombreReal, pin) {
    const p = String(pin || '').trim();
    if (!pinFormatoValido(p)) return false;
    if (fila.pin_personalizado && fila.pin_hash) return comprobarHash(p, fila.pin_hash);
    return iguales(p, pinDeChofer(nombreReal));
}

// Login del chofer: nombre + PIN
app.post('/api/login', requireDb, async (req, res) => {
    const { nombre, pin } = req.body || {};
    const clave = `${req.ip}|${claveNombre(nombre)}`;
    if (bloqueadoPorIntentos(clave)) {
        return res.status(429).json({ error: 'Demasiados intentos. Probá de nuevo en 5 minutos.' });
    }
    try {
        const lista = await obtenerChoferes();
        const nombreReal = lista.find(n => claveNombre(n) === claveNombre(nombre));
        if (!nombreReal) {
            registrarFallo(clave);
            return res.status(401).json({ error: 'Chofer o PIN incorrecto' });
        }
        const fila = await asegurarChofer(nombreReal);
        if (!(await pinCorrecto(fila, nombreReal, pin))) {
            registrarFallo(clave);
            return res.status(401).json({ error: 'Chofer o PIN incorrecto' });
        }
        if (!fila.activo) {
            return res.status(403).json({ error: 'Tu usuario está desactivado. Consultá con el administrador.' });
        }
        intentosLogin.delete(clave);
        await db.query('UPDATE flota_chofer SET ultimo_ingreso = $2 WHERE clave = $1', [fila.clave, new Date()]);
        olvidarEstadoChofer(nombreReal);
        res.json({
            token: crearToken({ r: 'chofer', n: nombreReal }, HORAS_SESION_CHOFER),
            nombre: nombreReal,
            pinPersonalizado: fila.pin_personalizado
        });
    } catch (err) {
        console.error("❌ Error en el login:", err.message);
        res.status(500).json({ error: 'No se pudo iniciar sesión' });
    }
});

// Permite a la app recuperar la sesión al recargar la página
app.get('/api/me', requireChofer, (req, res) => {
    res.json({ nombre: req.chofer });
});

// El chofer cambia su propio PIN (4 a 8 dígitos). Devuelve una sesión nueva; las demás quedan cerradas.
app.post('/api/cambiar-pin', requireChofer, async (req, res) => {
    const { pinActual, pinNuevo } = req.body || {};
    const clave = `${req.ip}|PIN|${claveNombre(req.chofer)}`;
    if (bloqueadoPorIntentos(clave)) {
        return res.status(429).json({ error: 'Demasiados intentos. Probá de nuevo en 5 minutos.' });
    }
    if (!pinFormatoValido(pinNuevo)) {
        return res.status(400).json({ error: 'El PIN nuevo debe tener entre 4 y 8 números.' });
    }
    if (pinDebil(pinNuevo)) {
        return res.status(400).json({ error: 'Ese PIN es muy fácil de adivinar (1234, 0000, 1111…). Elegí otro.' });
    }
    try {
        const fila = await asegurarChofer(req.chofer);
        if (!(await pinCorrecto(fila, req.chofer, pinActual))) {
            registrarFallo(clave);
            return res.status(403).json({ error: 'El PIN actual no es correcto.' });
        }
        intentosLogin.delete(clave);
        const ahora = Date.now();
        await db.query(
            `UPDATE flota_chofer SET pin_hash = $2, pin_personalizado = true, sesion_desde = $3 WHERE clave = $1`,
            [fila.clave, await hashPin(String(pinNuevo)), new Date(ahora)]);
        olvidarEstadoChofer(req.chofer);
        res.json({ exito: true, token: crearToken({ r: 'chofer', n: req.chofer }, HORAS_SESION_CHOFER), nombre: req.chofer });
    } catch (err) {
        console.error("❌ Error al cambiar el PIN:", err.message);
        res.status(500).json({ error: 'No se pudo cambiar el PIN' });
    }
});

// Login del administrador
app.post('/api/admin/login', (req, res) => {
    const clave = `${req.ip}|ADMIN`;
    if (bloqueadoPorIntentos(clave)) {
        return res.status(429).json({ error: 'Demasiados intentos. Probá de nuevo en 5 minutos.' });
    }
    if (!iguales((req.body || {}).password || '', ADMIN_PASSWORD)) {
        registrarFallo(clave);
        return res.status(401).json({ error: 'Clave incorrecta' });
    }
    intentosLogin.delete(clave);
    res.json({ token: crearToken({ r: 'admin' }, HORAS_SESION_ADMIN) });
});

// Lista de choferes con su estado (solo administrador).
// El PIN solo se muestra mientras sea el inicial; uno personalizado ya no se puede ver, solo cambiar.
app.get('/api/admin/choferes', requireAdmin, requireDb, async (req, res) => {
    try {
        const lista = await obtenerChoferes();
        const r = await db.query('SELECT * FROM flota_chofer');
        const filas = new Map(r.rows.map(f => [f.clave, f]));
        res.json(lista.map(nombre => {
            const f = filas.get(claveNombre(nombre));
            const personalizado = !!(f && f.pin_personalizado);
            return {
                nombre,
                oculto: !!(f && f.oculto),
                activo: f ? f.activo : true,
                pinPersonalizado: personalizado,
                pin: personalizado ? null : pinDeChofer(nombre),
                ultimoIngreso: f && f.ultimo_ingreso ? f.ultimo_ingreso : null
            };
        }));
    } catch (err) {
        console.error("❌ Error al listar choferes:", err.message);
        res.status(500).json({ error: 'No se pudo obtener la lista de choferes' });
    }
});

// Nombre válido según Gescom (evita crear fichas con nombres inventados)
async function nombreDeLista(nombre) {
    const lista = await obtenerChoferes();
    return lista.find(n => claveNombre(n) === claveNombre(nombre)) || null;
}

// Administrador: definir PIN {nombre, pin} | generar uno al azar {nombre, generar:true} | volver al inicial {nombre, restablecer:true}
app.post('/api/admin/chofer/pin', requireAdmin, requireDb, async (req, res) => {
    const { nombre, pin, generar, restablecer } = req.body || {};
    try {
        const nombreReal = await nombreDeLista(nombre);
        if (!nombreReal) return res.status(404).json({ error: 'Chofer no encontrado' });
        const fila = await asegurarChofer(nombreReal);
        const ahora = new Date();
        if (restablecer) {
            await db.query(`UPDATE flota_chofer SET pin_hash = NULL, pin_personalizado = false, sesion_desde = $2 WHERE clave = $1`, [fila.clave, ahora]);
            olvidarEstadoChofer(nombreReal);
            return res.json({ exito: true, pin: pinDeChofer(nombreReal), personalizado: false });
        }
        const nuevo = generar ? pinAleatorio() : String(pin || '').trim();
        if (!pinFormatoValido(nuevo)) return res.status(400).json({ error: 'El PIN debe tener entre 4 y 8 números.' });
        if (!generar && pinDebil(nuevo)) return res.status(400).json({ error: 'Ese PIN es muy fácil de adivinar. Elegí otro.' });
        await db.query(
            `UPDATE flota_chofer SET pin_hash = $2, pin_personalizado = true, sesion_desde = $3 WHERE clave = $1`,
            [fila.clave, await hashPin(nuevo), ahora]);
        olvidarEstadoChofer(nombreReal);
        res.json({ exito: true, pin: nuevo, personalizado: true });
    } catch (err) {
        console.error("❌ Error al cambiar el PIN (admin):", err.message);
        res.status(500).json({ error: 'No se pudo cambiar el PIN' });
    }
});

// Administrador: quitar de la lista a alguien que no es chofer {nombre, oculto:true} o volver a mostrarlo {nombre, oculto:false}.
// Al quitarlo también se desactiva (no puede ingresar); al restaurarlo vuelve activo.
app.post('/api/admin/chofer/oculto', requireAdmin, requireDb, async (req, res) => {
    const { nombre, oculto } = req.body || {};
    if (typeof oculto !== 'boolean') return res.status(400).json({ error: 'Falta indicar oculto: true o false' });
    try {
        const nombreReal = await nombreDeLista(nombre);
        if (!nombreReal) return res.status(404).json({ error: 'Chofer no encontrado' });
        const fila = await asegurarChofer(nombreReal);
        await db.query(`UPDATE flota_chofer SET oculto = $2, activo = $3, sesion_desde = $4 WHERE clave = $1`, [fila.clave, oculto, !oculto, new Date()]);
        olvidarEstadoChofer(nombreReal);
        res.json({ exito: true, oculto });
    } catch (err) {
        console.error("❌ Error al ocultar/restaurar chofer:", err.message);
        res.status(500).json({ error: 'No se pudo actualizar el chofer' });
    }
});

// Administrador: activar / desactivar un chofer {nombre, activo}
app.post('/api/admin/chofer/activo', requireAdmin, requireDb, async (req, res) => {
    const { nombre, activo } = req.body || {};
    if (typeof activo !== 'boolean') return res.status(400).json({ error: 'Falta indicar activo: true o false' });
    try {
        const nombreReal = await nombreDeLista(nombre);
        if (!nombreReal) return res.status(404).json({ error: 'Chofer no encontrado' });
        const fila = await asegurarChofer(nombreReal);
        await db.query(`UPDATE flota_chofer SET activo = $2, sesion_desde = $3 WHERE clave = $1`, [fila.clave, activo, new Date()]);
        olvidarEstadoChofer(nombreReal);
        res.json({ exito: true, activo });
    } catch (err) {
        console.error("❌ Error al activar/desactivar chofer:", err.message);
        res.status(500).json({ error: 'No se pudo actualizar el chofer' });
    }
});


module.exports = { obtenerChoferes, clavesOcultas, choferesVisibles, asegurarChofer, pinCorrecto, nombreDeLista };
