const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const app = express();

// Solo se entregan las dos páginas de la app (antes se servía toda la carpeta, incluido index.js)
app.get(['/', '/index.html'], (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
const PORT = process.env.PORT || 3000;

// Render usa un proxy: así req.ip es la IP real del cliente
app.set('trust proxy', 1);

// Middleware para entender JSON
app.use(express.json());

// --- CONFIGURACIÓN DE CONEXIÓN A GESCOM (PostgreSQL, SOLO LECTURA) ---
// Si existen variables de entorno en Render se usan; si no, toma los valores de abajo.
const pool = new Pool({
    user: process.env.DB_USER || 'gcw-bido',
    host: process.env.DB_HOST || 'bi.data.gescom.online',
    database: process.env.DB_NAME || 'gcwbi',
    password: process.env.DB_PASSWORD || 'f1dqTqpo9Iwf4wTJ8ziUnDubh',
    port: Number(process.env.DB_PORT) || 5432,
    ssl: {
        rejectUnauthorized: false
    }
});

// =====================================================================
//  BASE DE DATOS PROPIA (Supabase / PostgreSQL) — guarda choferes, check-lists, combustible y GPS
//  Se conecta con la variable de entorno DATABASE_URL (Session pooler) cargada en Render.
//  Las tablas se crean solas al arrancar. Nunca se escribe la contraseña en el código.
// =====================================================================
const db = process.env.DATABASE_URL
    ? new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        max: 5,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000
    })
    : null;
if (db) db.on('error', (err) => console.error('⚠️ Supabase (conexión inactiva):', err.message));
let dbListo = false;

const MIGRACION = `
CREATE TABLE IF NOT EXISTS flota_chofer (
    clave text PRIMARY KEY,
    nombre text NOT NULL,
    pin_hash text,
    pin_personalizado boolean NOT NULL DEFAULT false,
    activo boolean NOT NULL DEFAULT true,
    sesion_desde timestamptz NOT NULL DEFAULT to_timestamp(0),
    ultimo_ingreso timestamptz,
    creado timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS flota_checklist (
    id bigserial PRIMARY KEY,
    creado timestamptz NOT NULL DEFAULT now(),
    chofer text NOT NULL,
    dominio text NOT NULL,
    tipo_vehiculo text,
    respuestas jsonb NOT NULL DEFAULT '{}'::jsonb,
    observaciones text
);
CREATE TABLE IF NOT EXISTS flota_combustible (
    id bigserial PRIMARY KEY,
    creado timestamptz NOT NULL DEFAULT now(),
    chofer text NOT NULL,
    dominio text NOT NULL,
    litros numeric NOT NULL,
    costo_total numeric,
    odometro numeric
);
CREATE TABLE IF NOT EXISTS flota_posicion (
    id bigserial PRIMARY KEY,
    creado timestamptz NOT NULL DEFAULT now(),
    chofer text NOT NULL,
    vehiculo text NOT NULL,
    latitud double precision NOT NULL,
    longitud double precision NOT NULL,
    distancia_total_km numeric NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS flota_posicion_creado_idx ON flota_posicion (creado);
CREATE INDEX IF NOT EXISTS flota_posicion_veh_idx ON flota_posicion (vehiculo, id DESC);
CREATE INDEX IF NOT EXISTS flota_checklist_creado_idx ON flota_checklist (creado);
CREATE INDEX IF NOT EXISTS flota_combustible_creado_idx ON flota_combustible (creado);
-- Seguridad: nadie puede leer estas tablas desde la API pública de Supabase; solo este servidor
ALTER TABLE flota_chofer ENABLE ROW LEVEL SECURITY;
ALTER TABLE flota_checklist ENABLE ROW LEVEL SECURITY;
ALTER TABLE flota_combustible ENABLE ROW LEVEL SECURITY;
ALTER TABLE flota_posicion ENABLE ROW LEVEL SECURITY;
`;

async function iniciarBase() {
    if (!db) {
        console.error('❌ Falta la variable DATABASE_URL en Render: sin ella no hay login ni se guardan datos.');
        return;
    }
    try {
        await db.query(MIGRACION);
        dbListo = true;
        console.log('✅ Supabase conectado: tablas de la flota listas.');
    } catch (err) {
        dbListo = false;
        console.error('❌ No se pudo conectar a Supabase (reintento en 30 s):', err.message);
        setTimeout(iniciarBase, 30000);
    }
}
iniciarBase();

// Limpieza diaria: el historial de GPS se conserva 60 días (cuida el espacio del plan gratuito)
async function limpiarHistorial() {
    if (!dbListo) return;
    try {
        const r = await db.query(`DELETE FROM flota_posicion WHERE creado < now() - interval '60 days'`);
        if (r.rowCount) console.log(`🧹 Historial GPS: se borraron ${r.rowCount} puntos viejos.`);
    } catch (err) { console.error('⚠️ Limpieza de historial:', err.message); }
}
setInterval(limpiarHistorial, 24 * 3600 * 1000).unref();
setTimeout(limpiarHistorial, 60 * 1000).unref();

function requireDb(req, res, next) {
    if (!dbListo) return res.status(503).json({ error: 'La base de datos no está disponible todavía. Probá de nuevo en unos segundos.' });
    next();
}
process.on('unhandledRejection', (err) => console.error('⚠️ Error no controlado:', err && err.message ? err.message : err));

// Inicio del día de hoy en Argentina (para el odómetro diario, sin depender de la hora del servidor)
const INICIO_DIA_AR = `((date_trunc('day', now() AT TIME ZONE 'America/Argentina/Buenos_Aires')) AT TIME ZONE 'America/Argentina/Buenos_Aires')`;

// =====================================================================
//  AUTENTICACIÓN
//  - Cada chofer entra con su PIN. Mientras no lo cambie, es el PIN inicial calculado a partir de su
//    nombre y de AUTH_SECRET (el administrador lo ve en la pestaña "Choferes"). Cuando el chofer o el
//    administrador definen uno propio, se guarda en Supabase solo como hash (scrypt), nunca en claro.
//  - Las sesiones son tokens firmados con vencimiento; el servidor además consulta si el chofer sigue
//    activo y si su sesión no fue invalidada (cambio de PIN, desactivación).
//  Variables de entorno recomendadas en Render: AUTH_SECRET, ADMIN_PASSWORD (y PIN_VERSION para renovar los PIN iniciales).
// =====================================================================
const crypto = require('crypto');
const AUTH_SECRET = process.env.AUTH_SECRET || ('flota-temporal-' + pool.options.password);
const PIN_VERSION = process.env.PIN_VERSION || '1';
const HORAS_SESION_CHOFER = 12;
const HORAS_SESION_ADMIN = 12;

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ||
    crypto.createHmac('sha256', AUTH_SECRET).update('admin').digest('hex').slice(0, 10);
if (!process.env.AUTH_SECRET || !process.env.ADMIN_PASSWORD) {
    console.log('⚠️ Seguridad básica: definí AUTH_SECRET y ADMIN_PASSWORD en las variables de entorno de Render.');
    if (!process.env.ADMIN_PASSWORD) console.log('🔑 Clave temporal del administrador: ' + ADMIN_PASSWORD);
}

function firmar(texto) {
    return crypto.createHmac('sha256', AUTH_SECRET).update(texto).digest('base64url');
}
function crearToken(datos, horas) {
    const payload = Buffer.from(JSON.stringify({ ...datos, iat: Date.now(), exp: Date.now() + horas * 3600 * 1000 })).toString('base64url');
    return payload + '.' + firmar(payload);
}
function leerToken(token) {
    if (!token || typeof token !== 'string') return null;
    const [payload, firma] = token.split('.');
    if (!payload || !firma) return null;
    const a = Buffer.from(firma), b = Buffer.from(firmar(payload));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
        const datos = JSON.parse(Buffer.from(payload, 'base64url').toString());
        return datos.exp && datos.exp > Date.now() ? datos : null;
    } catch (e) { return null; }
}
function claveNombre(n) {
    return String(n || '').trim().replace(/\s+/g, ' ').toUpperCase();
}
function pinDeChofer(nombre) {
    const h = crypto.createHmac('sha256', AUTH_SECRET).update('pin:' + PIN_VERSION + ':' + claveNombre(nombre)).digest();
    return String(h.readUInt32BE(0) % 10000).padStart(4, '0');
}
function iguales(a, b) {
    const x = Buffer.from(String(a)), y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function tokenDeRequest(req) {
    const m = (req.headers.authorization || '').match(/^Bearer (.+)$/);
    return m ? m[1] : null;
}
// --- PIN propio: se guarda como hash scrypt + sal + AUTH_SECRET (aunque se filtrara la base, no se puede adivinar sin el secreto)
function scryptAsync(pin, sal) {
    return new Promise((ok, ko) => crypto.scrypt(String(pin), Buffer.concat([sal, Buffer.from(AUTH_SECRET)]), 32, (e, k) => e ? ko(e) : ok(k)));
}
async function hashPin(pin) {
    const sal = crypto.randomBytes(16);
    const h = await scryptAsync(pin, sal);
    return 's1$' + sal.toString('base64') + '$' + h.toString('base64');
}
async function comprobarHash(pin, guardado) {
    const [v, s, h] = String(guardado || '').split('$');
    if (v !== 's1' || !s || !h) return false;
    const calc = await scryptAsync(pin, Buffer.from(s, 'base64'));
    const esperado = Buffer.from(h, 'base64');
    return calc.length === esperado.length && crypto.timingSafeEqual(calc, esperado);
}
function pinFormatoValido(pin) {
    return /^\d{4,8}$/.test(String(pin || ''));
}
// Rechaza PIN triviales: 0000, 1111, 1234, 4321...
function pinDebil(pin) {
    const p = String(pin);
    if (/^(\d)\1+$/.test(p)) return true;
    const d = p.split('').map(Number);
    const sube = d.every((x, i) => i === 0 || x === d[i - 1] + 1);
    const baja = d.every((x, i) => i === 0 || x === d[i - 1] - 1);
    return sube || baja;
}
function pinAleatorio() {
    let pin;
    do { pin = String(crypto.randomInt(0, 10000)).padStart(4, '0'); } while (pinDebil(pin));
    return pin;
}

// Estado del chofer en la base (activo / sesión invalidada). Caché de 30 s; si Supabase falla se usa el último dato conocido.
const cacheEstadoChofer = new Map();
async function estadoChofer(nombre) {
    const clave = claveNombre(nombre);
    const c = cacheEstadoChofer.get(clave);
    if (c && Date.now() - c.ts < 30000) return c;
    try {
        if (!dbListo) throw new Error('db no lista');
        const r = await db.query('SELECT activo, sesion_desde FROM flota_chofer WHERE clave = $1', [clave]);
        const est = r.rows[0]
            ? { activo: r.rows[0].activo, sesionDesdeMs: new Date(r.rows[0].sesion_desde).getTime(), ts: Date.now() }
            : { activo: true, sesionDesdeMs: 0, ts: Date.now() };
        cacheEstadoChofer.set(clave, est);
        return est;
    } catch (err) {
        if (c) return c;
        throw err;
    }
}
function olvidarEstadoChofer(nombre) { cacheEstadoChofer.delete(claveNombre(nombre)); }

async function requireChofer(req, res, next) {
    const datos = leerToken(tokenDeRequest(req));
    if (!datos || datos.r !== 'chofer') return res.status(401).json({ error: 'Sesión no válida o vencida' });
    try {
        const est = await estadoChofer(datos.n);
        if (!est.activo) return res.status(401).json({ error: 'Tu usuario está desactivado. Consultá con el administrador.' });
        if ((datos.iat || 0) < est.sesionDesdeMs) return res.status(401).json({ error: 'Tu sesión se cerró. Ingresá de nuevo con tu PIN.' });
        req.chofer = datos.n;
        next();
    } catch (err) {
        res.status(503).json({ error: 'La base de datos no está disponible todavía. Probá de nuevo en unos segundos.' });
    }
}
function requireAdmin(req, res, next) {
    const datos = leerToken(tokenDeRequest(req));
    if (!datos || datos.r !== 'admin') return res.status(401).json({ error: 'Se requiere clave de administrador' });
    next();
}

// Límite de intentos: 5 errores seguidos bloquean 5 minutos ese chofer desde esa conexión
const intentosLogin = new Map();
function bloqueadoPorIntentos(clave) {
    const r = intentosLogin.get(clave);
    return !!(r && r.hasta && r.hasta > Date.now());
}
function registrarFallo(clave) {
    const r = intentosLogin.get(clave) || { n: 0, hasta: 0 };
    r.n += 1;
    if (r.n >= 5) { r.hasta = Date.now() + 5 * 60 * 1000; r.n = 0; }
    intentosLogin.set(clave, r);
}

// Clientes que cada chofer ya recibió en su hoja de ruta: solo esos puede consultar en cuenta corriente
const clientesPermitidos = new Map();

// --- AUTODIAGNÓSTICO INICIAL AL ARRANCAR EL SERVIDOR ---
async function probarConexionYListarTablas() {
    try {
        console.log("🔍 Intentando conectar al servidor de Gescom...");
        const client = await pool.connect();
        console.log("✅ ¡Conexión exitosa a la base de datos gcwbi!");

        const queryTablas = `
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public'
            ORDER BY table_name;
        `;
        const resultado = await client.query(queryTablas);
        client.release();

        console.log("📋 --- TABLAS DISPONIBLES EN GESCOM (BIDO SRL) ---");
        if (resultado.rows.length === 0) {
            console.log("⚠️ La conexión fue exitosa, pero el esquema 'public' no devolvió tablas.");
        } else {
            resultado.rows.forEach((row, index) => {
                console.log(`    ${index + 1}. ${row.table_name}`);
            });
        }
        console.log("--------------------------------------------------");
    } catch (err) {
        console.error("❌ Error al conectar o consultar Gescom:", err.message);
    }
}

probarConexionYListarTablas();

function calcularDistancia(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = 
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

// --- DEUDA POR CLIENTE ---
// cta_cte_cliente guarda una "foto" completa por día (fecha_sync).
// Solo sirve la foto más reciente. Saldo = débitos - créditos (es_credito = true).
// Se guarda en caché 10 minutos para no recorrer la tabla (2,5 GB) en cada pantalla.
const TTL_DEUDAS_MS = 10 * 60 * 1000;
let cacheDeudas = { datos: null, ts: 0, pendiente: null };

async function obtenerDeudas() {
    const ahora = Date.now();
    if (cacheDeudas.datos && ahora - cacheDeudas.ts < TTL_DEUDAS_MS) {
        return cacheDeudas.datos;
    }
    // Si ya hay una consulta en curso, se espera a esa en vez de lanzar otra
    if (cacheDeudas.pendiente) return cacheDeudas.pendiente;

    cacheDeudas.pendiente = (async () => {
        try {
            const r = await pool.query(`
                WITH ultima AS (
                    SELECT MAX(fecha_sync) AS f
                    FROM cta_cte_cliente
                    WHERE fecha_sync >= CURRENT_DATE - 7
                )
                SELECT cc.cliente_id,
                       MAX(cc.cliente_codigo) AS cliente_codigo,
                       to_char((SELECT f FROM ultima), 'YYYY-MM-DD') AS fecha,
                       SUM(CASE WHEN cc.es_credito THEN -cc.importe ELSE cc.importe END) AS saldo
                FROM cta_cte_cliente cc
                WHERE cc.fecha_sync = (SELECT f FROM ultima)
                GROUP BY cc.cliente_id
            `);

            const mapa = new Map();
            const codigos = new Map();
            r.rows.forEach(row => {
                mapa.set(String(row.cliente_id), Number(row.saldo));
                if (row.cliente_codigo) codigos.set(String(row.cliente_id), row.cliente_codigo);
            });
            const datos = { mapa, codigos, fecha: r.rows[0] ? r.rows[0].fecha : null };

            cacheDeudas.datos = datos;
            cacheDeudas.ts = Date.now();
            return datos;
        } finally {
            cacheDeudas.pendiente = null;
        }
    })();

    return cacheDeudas.pendiente;
}

// --- CÓDIGO DE CLIENTE (el "Número" que se ve en Gescom) ---
// Se detecta una sola vez qué columnas existen, para no romper la hoja de ruta si cambia el esquema.
let promesaColumnasCodigo = null;
function detectarColumnasCodigo() {
    if (!promesaColumnasCodigo) {
        promesaColumnasCodigo = pool.query(`
            SELECT table_name, column_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND ((table_name = 'venta' AND column_name = 'cliente_codigo')
                OR (table_name = 'cliente_hist' AND column_name = 'codigo'))
        `).then(r => {
            const tiene = (t, c) => r.rows.some(x => x.table_name === t && x.column_name === c);
            const partes = [];
            if (tiene('venta', 'cliente_codigo')) partes.push('v.cliente_codigo::text');
            if (tiene('cliente_hist', 'codigo')) partes.push('c.codigo::text');
            console.log('ℹ️ Fuentes del código de cliente:', partes.length ? partes.join(', ') : 'solo cta_cte_cliente');
            return partes.length ? `COALESCE(${partes.join(', ')})` : 'NULL::text';
        }).catch(err => {
            console.error('⚠️ No se pudo detectar la columna de código de cliente:', err.message);
            promesaColumnasCodigo = null;
            return 'NULL::text';
        });
    }
    return promesaColumnasCodigo;
}

app.get('/api/estado', (req, res) => {
    res.json({
        mensaje: "¡API de Gestión de Flota PepsiCo funcionando! 🚚⛽",
        db: dbListo ? 'ok' : (db ? 'conectando' : 'sin_configurar')
    });
});

// Protegido: solo funciona si definís la variable ADMIN_TOKEN en Render
// y llamás a /api/esquema?token=TU_TOKEN
app.get('/api/esquema', async (req, res) => {
    const tokenAdmin = process.env.ADMIN_TOKEN;
    if (!tokenAdmin || req.query.token !== tokenAdmin) {
        return res.status(404).json({ error: "No encontrado" });
    }
    try {
        const queryTablas = `
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public'
        `;
        const resultado = await pool.query(queryTablas);
        res.json({
            mensaje: "¡Conexión a Gescom exitosa! Estas son las tablas disponibles en BIDO SRL:",
            tablas: resultado.rows
        });
    } catch (err) {
        console.error("Error al consultar el esquema:", err);
        res.status(500).json({ error: err.message });
    }
});

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

// Lista para el desplegable del login (solo nombres)
app.get('/api/choferes', async (req, res) => {
    try {
        const lista = await obtenerChoferes();
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

// --- MÓDULO DE HOJA DE RUTA CON SALDO TOTAL (DÉBITOS - CRÉDITOS) ---
app.get('/api/ventas-chofer/:nombre', requireChofer, async (req, res) => {
    // Cada chofer solo puede ver su propio reparto
    if (claveNombre(decodeURIComponent(req.params.nombre)) !== claveNombre(req.chofer)) {
        return res.status(403).json({ error: 'No tenés acceso al reparto de otro chofer' });
    }
    const choferNombre = req.chofer;
    const fechaSeleccionada = req.query.fecha;

    try {
        const exprCodigo = await detectarColumnasCodigo();
        let query = `
            SELECT DISTINCT
                v.cliente_id AS id,
                ${exprCodigo} AS cliente_codigo,
                v.razon_social AS nombre,
                c.direccion,
                c.localidad,
                rh.latitud AS lat,
                rh.longitud AS lon,
                v.orden_planeado AS orden_planeado,
                rh.orden AS orden_ruta,
                v.reparto_codigo,
                v.empleado_chofer_nombre AS chofer,
                v.fecha_entrega
            FROM venta v
            JOIN cliente_hist c ON v.cliente_id = c.id AND c.actual = true
            JOIN cliente_ruta_hist rh ON v.cliente_id = rh.cliente_id AND rh.actual = true
            WHERE v.empleado_chofer_nombre = $1
              AND rh.latitud IS NOT NULL 
              AND rh.latitud != 0 
              AND rh.longitud IS NOT NULL 
              AND rh.longitud != 0
        `;

        let params = [choferNombre];

        if (fechaSeleccionada) {
            query += ` AND v.fecha_entrega::date = $2 `;
            params.push(fechaSeleccionada);
        } else {
            query += ` AND v.fecha_entrega::date = CURRENT_DATE `;
        }

        query += ` ORDER BY reparto_codigo, orden_ruta ASC NULLS LAST, orden_planeado ASC;`;

        const resultado = await pool.query(query, params);

        // Se recuerda qué clientes recibió este chofer para limitar luego la consulta de cuenta corriente
        const claveChofer = claveNombre(choferNombre);
        if (!clientesPermitidos.has(claveChofer)) clientesPermitidos.set(claveChofer, new Set());
        resultado.rows.forEach(f => clientesPermitidos.get(claveChofer).add(String(f.id)));

        // La deuda se trae una sola vez para todos los clientes (con caché)
        let mapaDeudas = new Map();
        let mapaCodigos = new Map();
        try {
            const deudas = await obtenerDeudas();
            mapaDeudas = deudas.mapa;
            mapaCodigos = deudas.codigos;
        } catch (errDeuda) {
            console.error("⚠️ No se pudo obtener la deuda, se devuelve la ruta sin saldos:", errDeuda.message);
        }

        // orden_planeado de Gescom llega siempre en 1, así que se numera según
        // la secuencia de la ruta del cliente (cliente_ruta_hist.orden)
        const filas = resultado.rows.map((f, i) => ({
            ...f,
            orden: i + 1,
            cliente_codigo: f.cliente_codigo || mapaCodigos.get(String(f.id)) || null,
            saldo_deuda: mapaDeudas.get(String(f.id)) || 0
        }));

        res.json(filas);

    } catch (err) {
        console.error("❌ Error al consultar las ventas del chofer en Gescom:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// --- MÓDULO DE CUENTA CORRIENTE DETALLADA (ÚLTIMA FOTO, CON CRÉDITOS EN NEGATIVO) ---
app.get('/api/cta-cte/:cliente_id', requireChofer, async (req, res) => {
    const clienteId = req.params.cliente_id;

    if (!/^\d+$/.test(clienteId)) {
        return res.status(400).json({ error: "cliente_id inválido" });
    }
    const permitidos = clientesPermitidos.get(claveNombre(req.chofer));
    if (!permitidos || !permitidos.has(clienteId)) {
        return res.status(403).json({ error: "Ese cliente no figura en tu reparto. Actualizá la hoja de ruta." });
    }

    try {
        const { fecha } = await obtenerDeudas();
        if (!fecha) return res.json([]);

        const query = `
            SELECT tipo_comprobante_codigo,
                   punto_venta_codigo,
                   numero_comprobante,
                   numero_cuota,
                   to_char(fecha_comprobante, 'YYYY-MM-DD') AS fecha_comprobante,
                   to_char(fecha_vencimiento, 'YYYY-MM-DD') AS fecha_vencimiento,
                   importe_original,
                   CASE WHEN es_credito THEN -importe ELSE importe END AS saldo_pendiente,
                   es_credito,
                   detalle
            FROM cta_cte_cliente
            WHERE cliente_id = $1
              AND fecha_sync = $2::date
            ORDER BY es_credito, fecha_comprobante, numero_comprobante, numero_cuota;
        `;

        const resultado = await pool.query(query, [clienteId, fecha]);
        res.json(resultado.rows);

    } catch (err) {
        console.error("Error al consultar la cuenta corriente en Gescom:", err.message);
        res.status(500).json({ error: "Error interno al obtener la cuenta corriente" });
    }
});

app.get('/api/clientes/:dia', requireAdmin, async (req, res) => {
    const diaParam = req.params.dia.toUpperCase();
    const mapaDias = {
        'LU': 'lunes',
        'MA': 'martes',
        'MI': 'miercoles',
        'JU': 'jueves',
        'VI': 'viernes',
        'SA': 'sabado',
        'DO': 'domingo'
    };
    const columnaDia = mapaDias[diaParam] || 'lunes';

    try {
        const query = `
            SELECT 
                c.id AS id,
                c.razon_social AS nombre,
                c.direccion,
                c.localidad,
                rh.latitud AS lat,
                rh.longitud AS lon,
                rh.ruta_codigo,
                rh.orden
            FROM cliente_ruta_hist rh
            JOIN cliente_hist c ON rh.cliente_id = c.id AND c.actual = true
            WHERE rh.actual = true 
              AND rh.${columnaDia} = 1
            ORDER BY rh.orden ASC;
        `;
        const resultado = await pool.query(query);
        res.json(resultado.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

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

app.listen(PORT, () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});