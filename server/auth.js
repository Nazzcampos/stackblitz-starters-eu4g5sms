// Autenticación: tokens, PIN de choferes, login de administrador, bloqueo por intentos, requireChofer / requireAdmin.
const { pool } = require('./core.js');
const base = require('./base.js');
const { db } = require('./base.js');

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
const AUTH_SECRET = process.env.AUTH_SECRET || ('flota-temporal-' + (pool.options.password || ''));
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
        if (!base.dbListo) throw new Error('db no lista');
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


module.exports = { crypto, AUTH_SECRET, PIN_VERSION, HORAS_SESION_CHOFER, HORAS_SESION_ADMIN, ADMIN_PASSWORD, firmar, crearToken, leerToken, claveNombre, pinDeChofer, iguales, tokenDeRequest, scryptAsync, hashPin, comprobarHash, pinFormatoValido, pinDebil, pinAleatorio, cacheEstadoChofer, estadoChofer, olvidarEstadoChofer, requireChofer, requireAdmin, intentosLogin, bloqueadoPorIntentos, registrarFallo, clientesPermitidos };
