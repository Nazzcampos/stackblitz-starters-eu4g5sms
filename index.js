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
-- Resumen de kilómetros por día y vehículo: se conserva siempre (los puntos GPS sueltos se borran a los 30 días)
CREATE TABLE IF NOT EXISTS flota_odometro_dia (
    fecha date NOT NULL,
    vehiculo text NOT NULL,
    chofer text NOT NULL,
    km numeric NOT NULL DEFAULT 0,
    primera timestamptz NOT NULL DEFAULT now(),
    ultima timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (fecha, vehiculo)
);
INSERT INTO flota_odometro_dia (fecha, vehiculo, chofer, km, primera, ultima)
SELECT (creado AT TIME ZONE 'America/Argentina/Buenos_Aires')::date, vehiculo, string_agg(DISTINCT chofer, ', '),
       max(distancia_total_km), min(creado), max(creado)
FROM flota_posicion WHERE creado >= now() - interval '30 days'
GROUP BY 1, 2
ON CONFLICT (fecha, vehiculo) DO NOTHING;
CREATE INDEX IF NOT EXISTS flota_posicion_creado_idx ON flota_posicion (creado);
CREATE INDEX IF NOT EXISTS flota_posicion_veh_idx ON flota_posicion (vehiculo, id DESC);
CREATE INDEX IF NOT EXISTS flota_checklist_creado_idx ON flota_checklist (creado);
CREATE INDEX IF NOT EXISTS flota_combustible_creado_idx ON flota_combustible (creado);
CREATE TABLE IF NOT EXISTS flota_orden_propuesta (
    id bigserial PRIMARY KEY,
    creado timestamptz NOT NULL DEFAULT now(),
    actualizado timestamptz NOT NULL DEFAULT now(),
    enviado timestamptz,
    resuelto timestamptz,
    chofer text NOT NULL,
    ruta text NOT NULL,
    dia text NOT NULL DEFAULT '',
    estado text NOT NULL DEFAULT 'borrador',
    cambios integer NOT NULL DEFAULT 0,
    nota text,
    items jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS flota_orden_borrador_uq ON flota_orden_propuesta (chofer, ruta, dia) WHERE estado = 'borrador';
CREATE INDEX IF NOT EXISTS flota_orden_estado_idx ON flota_orden_propuesta (estado, id DESC);
-- Seguridad: nadie puede leer estas tablas desde la API pública de Supabase; solo este servidor
ALTER TABLE flota_chofer ENABLE ROW LEVEL SECURITY;
ALTER TABLE flota_checklist ENABLE ROW LEVEL SECURITY;
ALTER TABLE flota_combustible ENABLE ROW LEVEL SECURITY;
ALTER TABLE flota_posicion ENABLE ROW LEVEL SECURITY;
ALTER TABLE flota_odometro_dia ENABLE ROW LEVEL SECURITY;
ALTER TABLE flota_orden_propuesta ENABLE ROW LEVEL SECURITY;
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

// Limpieza diaria: los puntos GPS sueltos se conservan 30 días (cuida el espacio del plan gratuito).
// Los kilómetros por día y vehículo se guardan aparte y no se borran.
async function limpiarHistorial() {
    if (!dbListo) return;
    try {
        const r = await db.query(`DELETE FROM flota_posicion WHERE creado < now() - interval '30 days'`);
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
// Un pedido recién facturado figura en la cuenta corriente pero todavía no corresponde cobrarlo:
// los débitos con menos de DIAS_DEUDA_RECIENTE días (por defecto 7) se informan aparte como "pedido reciente".
// Se puede cambiar con la variable de entorno DIAS_DEUDA_RECIENTE en Render.
const DIAS_DEUDA_RECIENTE = Math.max(0, Number(process.env.DIAS_DEUDA_RECIENTE) || 7);
const HOY_AR_SQL = `(now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date`;
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
                       SUM(CASE WHEN cc.es_credito THEN -cc.importe ELSE cc.importe END) AS saldo,
                       SUM(CASE WHEN NOT cc.es_credito AND cc.fecha_comprobante::date > (${HOY_AR_SQL} - $1::int)
                                THEN cc.importe ELSE 0 END) AS reciente
                FROM cta_cte_cliente cc
                WHERE cc.fecha_sync = (SELECT f FROM ultima)
                GROUP BY cc.cliente_id
            `, [DIAS_DEUDA_RECIENTE]);

            const mapa = new Map();
            const codigos = new Map();
            const recientes = new Map();
            r.rows.forEach(row => {
                mapa.set(String(row.cliente_id), Number(row.saldo));
                recientes.set(String(row.cliente_id), Number(row.reciente) || 0);
                if (row.cliente_codigo) codigos.set(String(row.cliente_id), row.cliente_codigo);
            });
            const datos = { mapa, codigos, recientes, fecha: r.rows[0] ? r.rows[0].fecha : null };

            cacheDeudas.datos = datos;
            cacheDeudas.ts = Date.now();
            return datos;
        } finally {
            cacheDeudas.pendiente = null;
        }
    })();

    return cacheDeudas.pendiente;
}

// --- EXHIBIDORES EN COMODATO ---
// Se registran como remitos en ventas: REME = se entregó el exhibidor (+cantidad), REMI = se devolvió (-cantidad).
// Lo que tiene hoy cada cliente es la suma por ítem. Se consulta solo para los clientes de la hoja de ruta y se guarda 10 minutos.
// Opcional en Render: EXHIBIDOR_EXCLUIR_RECHAZADAS=1 ignora los remitos marcados como rechazados.
const cacheExhibidores = new Map(); // cliente_id -> { items, ts }
let promesaFiltroRemitos = null;
function filtroRemitos() {
    if (!promesaFiltroRemitos) {
        promesaFiltroRemitos = pool.query(`
            SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'venta' AND column_name IN ('anulada', 'anulado')
        `).then(r => {
            // no_entregada = 1 significa que el remito no se llegó a entregar; los anulados tampoco cuentan
            let filtro = ' AND COALESCE(v.no_entregada::int, 0) = 0';
            r.rows.forEach(c => { filtro += ` AND COALESCE(v.${c.column_name}::int, 0) = 0`; });
            if (/^(1|true|si)$/i.test(process.env.EXHIBIDOR_EXCLUIR_RECHAZADAS || '')) filtro += ' AND COALESCE(v.rechazada::int, 0) = 0';
            return filtro;
        }).catch(err => {
            console.error('⚠️ No se pudieron detectar las columnas de venta:', err.message);
            promesaFiltroRemitos = null;
            return ' AND COALESCE(v.no_entregada::int, 0) = 0';
        });
    }
    return promesaFiltroRemitos;
}
async function obtenerExhibidores(ids) {
    const unicos = [...new Set(ids.map(String).filter(id => /^\d+$/.test(id)))];
    const ahora = Date.now();
    const faltan = unicos.filter(id => { const c = cacheExhibidores.get(id); return !c || ahora - c.ts > TTL_DEUDAS_MS; });
    if (faltan.length) {
        const filtro = await filtroRemitos();
        const r = await pool.query(`
            SELECT v.cliente_id::text AS cliente_id, vi.item_codigo,
                   COALESCE(it.descripcion, vi.item_codigo) AS descripcion,
                   SUM(CASE WHEN v.tipo_comprobante_codigo = 'REME' THEN vi.cantidad ELSE -vi.cantidad END) AS cantidad
            FROM venta v
            JOIN venta_item vi ON vi.venta_id = v.id AND vi.tenant_id = v.tenant_id
            LEFT JOIN item it ON it.id = vi.item_id AND it.tenant_id = vi.tenant_id
            WHERE v.cliente_id = ANY($1::bigint[])
              AND v.tipo_comprobante_codigo IN ('REME', 'REMI')${filtro}
            GROUP BY v.cliente_id, vi.item_codigo, COALESCE(it.descripcion, vi.item_codigo)
            HAVING SUM(CASE WHEN v.tipo_comprobante_codigo = 'REME' THEN vi.cantidad ELSE -vi.cantidad END) > 0
            ORDER BY 3
        `, [faltan]);
        const porCliente = new Map();
        r.rows.forEach(f => {
            if (!porCliente.has(f.cliente_id)) porCliente.set(f.cliente_id, []);
            porCliente.get(f.cliente_id).push({ codigo: f.item_codigo, descripcion: f.descripcion, cantidad: Number(f.cantidad) });
        });
        faltan.forEach(id => cacheExhibidores.set(id, { items: porCliente.get(id) || [], ts: ahora }));
    }
    return new Map(unicos.map(id => [id, cacheExhibidores.get(id).items]));
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
        let mapaRecientes = new Map();
        try {
            const deudas = await obtenerDeudas();
            mapaDeudas = deudas.mapa;
            mapaCodigos = deudas.codigos;
            mapaRecientes = deudas.recientes;
        } catch (errDeuda) {
            console.error("⚠️ No se pudo obtener la deuda, se devuelve la ruta sin saldos:", errDeuda.message);
        }

        // orden_planeado de Gescom llega siempre en 1, así que se numera según
        // la secuencia de la ruta del cliente (cliente_ruta_hist.orden)
        // Exhibidores en comodato de cada cliente (si falla la consulta, la ruta sale igual y sin ese dato)
        let mapaExhibidores = null;
        try {
            mapaExhibidores = await obtenerExhibidores(resultado.rows.map(f => f.id));
        } catch (errExh) {
            console.error("⚠️ No se pudieron obtener los exhibidores:", errExh.message);
        }

        // saldo_deuda = total de la cuenta corriente; deuda_cobrar = lo que ya corresponde cobrar;
        // deuda_reciente = pedidos de los últimos días que todavía no se cobran (se descuentan los créditos de lo más viejo primero)
        const filas = resultado.rows.map((f, i) => {
            const total = mapaDeudas.get(String(f.id)) || 0;
            const reciente = mapaRecientes.get(String(f.id)) || 0;
            const redondear = n => Number(n.toFixed(2));
            return {
                ...f,
                orden: i + 1,
                cliente_codigo: f.cliente_codigo || mapaCodigos.get(String(f.id)) || null,
                saldo_deuda: redondear(total),
                deuda_cobrar: total > 0 ? redondear(Math.max(0, total - reciente)) : 0,
                deuda_reciente: total > 0 ? redondear(Math.min(reciente, total)) : 0,
                dias_reciente: DIAS_DEUDA_RECIENTE,
                exhibidores: mapaExhibidores ? (mapaExhibidores.get(String(f.id)) || []) : null
            };
        });

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
                   (NOT es_credito AND fecha_comprobante::date > (${HOY_AR_SQL} - $3::int)) AS reciente,
                   detalle
            FROM cta_cte_cliente
            WHERE cliente_id = $1
              AND fecha_sync = $2::date
            ORDER BY es_credito, fecha_comprobante, numero_comprobante, numero_cuota;
        `;

        const resultado = await pool.query(query, [clienteId, fecha, DIAS_DEUDA_RECIENTE]);
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
        await db.query(
            `INSERT INTO flota_odometro_dia (fecha, vehiculo, chofer, km)
             VALUES ((now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date, $1, $2, $3)
             ON CONFLICT (fecha, vehiculo) DO UPDATE SET
                km = GREATEST(flota_odometro_dia.km, EXCLUDED.km),
                ultima = now(),
                chofer = CASE WHEN position(EXCLUDED.chofer in flota_odometro_dia.chofer) > 0
                              THEN flota_odometro_dia.chofer
                              ELSE flota_odometro_dia.chofer || ', ' || EXCLUDED.chofer END`,
            [vehiculo, chofer, km]);
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

// =====================================================================
//  EXPORTAR A EXCEL (.xlsx) — sin librerías externas: se arma el archivo directamente
// =====================================================================
const zlib = require('zlib');
const TABLA_CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
})();
function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = TABLA_CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}
function crearZip(archivos) { // archivos: [{ nombre, datos: Buffer }]
    const locales = [], centrales = [];
    let offset = 0;
    const d = new Date();
    const hora = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const fecha = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    archivos.forEach(a => {
        const nombre = Buffer.from(a.nombre, 'utf8');
        const comp = zlib.deflateRawSync(a.datos);
        const crc = crc32(a.datos);
        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
        lh.writeUInt16LE(hora, 10); lh.writeUInt16LE(fecha, 12); lh.writeUInt32LE(crc, 14);
        lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(a.datos.length, 22); lh.writeUInt16LE(nombre.length, 26); lh.writeUInt16LE(0, 28);
        locales.push(lh, nombre, comp);
        const ch = Buffer.alloc(46);
        ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
        ch.writeUInt16LE(hora, 12); ch.writeUInt16LE(fecha, 14); ch.writeUInt32LE(crc, 16);
        ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(a.datos.length, 24); ch.writeUInt16LE(nombre.length, 28);
        ch.writeUInt32LE(offset, 42);
        centrales.push(ch, nombre);
        offset += lh.length + nombre.length + comp.length;
    });
    const dirCentral = Buffer.concat(centrales);
    const fin = Buffer.alloc(22);
    fin.writeUInt32LE(0x06054b50, 0); fin.writeUInt16LE(archivos.length, 8); fin.writeUInt16LE(archivos.length, 10);
    fin.writeUInt32LE(dirCentral.length, 12); fin.writeUInt32LE(offset, 16);
    return Buffer.concat([...locales, dirCentral, fin]);
}
function xmlTexto(t) {
    return String(t == null ? '' : t).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function letraColumna(n) { let s = ''; n++; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }

// Estilos (índice en cellXfs): 0 normal · 1 encabezado · 2 número 0,00 · 3 falla (rojo) · 4 ok (verde) · 5 negrita · 6 negrita 0,00
const ESTILO = { normal: 0, encabezado: 1, numero: 2, falla: 3, ok: 4, negrita: 5, negritaNumero: 6 };
function hojaXml(filas, anchos) {
    const maxCol = Math.max(...filas.map(f => f.length), 1);
    const cols = anchos.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
    const datos = filas.map((fila, r) => {
        const celdas = fila.map((c, i) => {
            if (c === null || c === undefined || c === '') return '';
            const ref = letraColumna(i) + (r + 1);
            const celda = (typeof c === 'object') ? c : { v: c };
            const s = celda.s || (r === 0 ? ESTILO.encabezado : 0);
            if (typeof celda.v === 'number' && Number.isFinite(celda.v)) return `<c r="${ref}" s="${s}"><v>${celda.v}</v></c>`;
            return `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${xmlTexto(celda.v)}</t></is></c>`;
        }).join('');
        return `<row r="${r + 1}"${r === 0 ? ' ht="28" customHeight="1"' : ''}>${celdas}</row>`;
    }).join('');
    const rango = `A1:${letraColumna(maxCol - 1)}${Math.max(filas.length, 1)}`;
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${cols}</cols><sheetData>${datos}</sheetData><autoFilter ref="${rango}"/></worksheet>`;
}
function crearXlsx(hojas) { // hojas: [{ nombre, filas, anchos }]
    const estilos = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="4"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FF9C0006"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF4F46E5"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFC7CE"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFC6EFCE"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFD0D0D0"/></left><right style="thin"><color rgb="FFD0D0D0"/></right><top style="thin"><color rgb="FFD0D0D0"/></top><bottom style="thin"><color rgb="FFD0D0D0"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="7">
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="2" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
<xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf>
<xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf>
<xf numFmtId="0" fontId="3" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>
<xf numFmtId="2" fontId="3" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>
</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
    const archivos = [
        { nombre: '[Content_Types].xml', datos: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${hojas.map((h, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` },
        { nombre: '_rels/.rels', datos: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
        { nombre: 'xl/workbook.xml', datos: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${hojas.map((h, i) => `<sheet name="${xmlTexto(h.nombre.replace(/[\\\/\?\*\[\]:]/g, ' ').slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` },
        { nombre: 'xl/_rels/workbook.xml.rels', datos: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${hojas.map((h, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${hojas.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
        { nombre: 'xl/styles.xml', datos: estilos },
        ...hojas.map((h, i) => ({ nombre: `xl/worksheets/sheet${i + 1}.xml`, datos: hojaXml(h.filas, h.anchos) }))
    ].map(a => ({ nombre: a.nombre, datos: Buffer.from(a.datos, 'utf8') }));
    return crearZip(archivos);
}
function enviarXlsx(res, nombreArchivo, buffer) {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${nombreArchivo}"`);
    res.end(buffer);
}
// Rango de fechas AAAA-MM-DD (máximo 1 año)
function rangoFechas(q) {
    const re = /^\d{4}-\d{2}-\d{2}$/;
    if (!re.test(q.desde || '') || !re.test(q.hasta || '')) return null;
    const a = Date.parse(q.desde), b = Date.parse(q.hasta);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b < a || (b - a) > 366 * 86400000) return null;
    return { desde: q.desde, hasta: q.hasta };
}
const TZ_AR = "'America/Argentina/Buenos_Aires'";

// Check-lists del período: una fila por check-list y una columna por cada ítem (Falla en rojo)
app.get('/api/admin/exportar/checklists', requireAdmin, requireDb, async (req, res) => {
    const rango = rangoFechas(req.query);
    if (!rango) return res.status(400).json({ error: 'Indicá desde y hasta (AAAA-MM-DD, máximo 1 año).' });
    try {
        const r = await db.query(
            `SELECT to_char(creado AT TIME ZONE ${TZ_AR}, 'DD/MM/YYYY') AS fecha,
                    to_char(creado AT TIME ZONE ${TZ_AR}, 'HH24:MI') AS hora,
                    chofer, dominio, tipo_vehiculo, respuestas, observaciones
             FROM flota_checklist
             WHERE creado >= ($1::date)::timestamp AT TIME ZONE ${TZ_AR}
               AND creado < (($2::date + 1)::timestamp AT TIME ZONE ${TZ_AR})
             ORDER BY id ASC LIMIT 20000`, [rango.desde, rango.hasta]);
        const items = [];
        r.rows.forEach(f => Object.keys(f.respuestas || {}).forEach(k => { if (!items.includes(k)) items.push(k); }));
        const encabezado = ['Fecha', 'Hora', 'Chofer', 'Dominio', 'Tipo de vehículo', ...items, 'Resultado', 'Observaciones'];
        const filas = [encabezado];
        r.rows.forEach(f => {
            const resp = f.respuestas || {};
            const fallas = Object.values(resp).filter(v => v === 'Falla').length;
            filas.push([
                f.fecha, f.hora, f.chofer, f.dominio, f.tipo_vehiculo || '',
                ...items.map(k => resp[k] === undefined ? '' : { v: resp[k], s: resp[k] === 'Falla' ? ESTILO.falla : ESTILO.ok }),
                fallas ? { v: fallas + (fallas === 1 ? ' falla' : ' fallas'), s: ESTILO.falla } : { v: 'Sin fallas', s: ESTILO.ok },
                f.observaciones || ''
            ]);
        });
        const anchos = [12, 8, 28, 12, 18, ...items.map(() => 14), 14, 40];
        enviarXlsx(res, `checklists_${rango.desde}_a_${rango.hasta}.xlsx`, crearXlsx([{ nombre: 'Check-lists', filas, anchos }]));
    } catch (err) {
        console.error("❌ Error al exportar check-lists:", err.message);
        res.status(500).json({ error: 'No se pudo generar el Excel' });
    }
});

// Odómetro del período: kilómetros por día y vehículo, más un resumen por vehículo
app.get('/api/admin/exportar/odometro', requireAdmin, requireDb, async (req, res) => {
    const rango = rangoFechas(req.query);
    if (!rango) return res.status(400).json({ error: 'Indicá desde y hasta (AAAA-MM-DD, máximo 1 año).' });
    try {
        const r = await db.query(
            `SELECT to_char(fecha, 'DD/MM/YYYY') AS fecha, vehiculo, chofer, km::float8 AS km,
                    to_char(primera AT TIME ZONE ${TZ_AR}, 'HH24:MI') AS desde,
                    to_char(ultima AT TIME ZONE ${TZ_AR}, 'HH24:MI') AS hasta
             FROM flota_odometro_dia
             WHERE fecha BETWEEN $1::date AND $2::date
             ORDER BY flota_odometro_dia.fecha ASC, vehiculo ASC`, [rango.desde, rango.hasta]);
        const detalle = [['Fecha', 'Vehículo', 'Chofer', 'Km recorridos', 'Primer registro', 'Último registro']];
        const porVehiculo = new Map();
        r.rows.forEach(f => {
            const km = Number(Number(f.km).toFixed(2));
            detalle.push([f.fecha, f.vehiculo, f.chofer, { v: km, s: ESTILO.numero }, f.desde, f.hasta]);
            const acc = porVehiculo.get(f.vehiculo) || { dias: 0, km: 0 };
            acc.dias += 1; acc.km += km;
            porVehiculo.set(f.vehiculo, acc);
        });
        const resumen = [['Vehículo', 'Días con recorrido', 'Km totales', 'Km promedio por día']];
        let totalKm = 0;
        [...porVehiculo.entries()].sort((a, b) => a[0].localeCompare(b[0])).forEach(([veh, a]) => {
            totalKm += a.km;
            resumen.push([veh, a.dias, { v: Number(a.km.toFixed(2)), s: ESTILO.numero }, { v: Number((a.km / a.dias).toFixed(2)), s: ESTILO.numero }]);
        });
        if (porVehiculo.size) resumen.push([{ v: 'TOTAL FLOTA', s: ESTILO.negrita }, '', { v: Number(totalKm.toFixed(2)), s: ESTILO.negritaNumero }, '']);
        enviarXlsx(res, `odometro_${rango.desde}_a_${rango.hasta}.xlsx`, crearXlsx([
            { nombre: 'Km por día', filas: detalle, anchos: [12, 14, 30, 15, 16, 16] },
            { nombre: 'Resumen por vehículo', filas: resumen, anchos: [16, 20, 14, 20] }
        ]));
    } catch (err) {
        console.error("❌ Error al exportar odómetro:", err.message);
        res.status(500).json({ error: 'No se pudo generar el Excel' });
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
        JOIN cliente_hist c ON c.id = rh.cliente_id AND c.actual = true
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

// Clientes de una zona (opcionalmente solo los de un día) con su orden actual en Gescom
async function clientesDeRuta(ruta, dia) {
    const filtroDia = dia ? ` AND rh.${dia} = 1` : '';
    const r = await pool.query(`
        SELECT rh.cliente_id::text AS id, c.razon_social AS nombre, c.direccion, c.localidad, rh.orden::int AS orden
        FROM cliente_ruta_hist rh
        JOIN cliente_hist c ON c.id = rh.cliente_id AND c.actual = true
        WHERE rh.actual = true AND rh.ruta_codigo::text = $1${filtroDia}
        ORDER BY rh.orden ASC NULLS FIRST, c.razon_social ASC
        LIMIT ${MAX_CLIENTES_ORDEN}`, [ruta]);
    let codigos = new Map();
    try { codigos = (await obtenerDeudas()).codigos; } catch (e) { /* el código es solo informativo */ }
    return r.rows.map(f => ({
        id: String(f.id),
        codigo: codigos.get(String(f.id)) || null,
        nombre: f.nombre || '',
        direccion: f.direccion || '',
        localidad: f.localidad || '',
        orden: f.orden === null || f.orden === undefined ? null : Number(f.orden),
        sin_ubicar: f.orden === null || f.orden === undefined || Number(f.orden) <= 0   // alta reciente: todavía sin lugar en el recorrido
    }));
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

const COLS_PROPUESTA = `id::int AS id, chofer, ruta, dia, estado, cambios::int AS cambios, nota,
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
        const vigente = prop && ['borrador', 'enviada', 'aprobada'].includes(prop.estado) ? prop : null;
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
            await db.query(`UPDATE flota_orden_propuesta SET items = $1::jsonb, cambios = $2, actualizado = now() WHERE id = $3`,
                [JSON.stringify(items), cambios, prop.id]);
        } else {
            await db.query(`INSERT INTO flota_orden_propuesta (chofer, ruta, dia, estado, cambios, items) VALUES ($1, $2, $3, 'borrador', $4, $5::jsonb)`,
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

app.post('/api/admin/orden/:id/estado', requireAdmin, requireDb, async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'id inválido' });
    const estado = String((req.body || {}).estado || '');
    const nota = String((req.body || {}).nota || '').trim().slice(0, 300);
    const permitido = { aprobada: ['enviada'], rechazada: ['enviada', 'aprobada'], aplicada: ['aprobada'] };
    if (!permitido[estado]) return res.status(400).json({ error: 'Estado inválido' });
    try {
        const r = await db.query(
            `UPDATE flota_orden_propuesta SET estado = $1, nota = $2, resuelto = now(), actualizado = now()
             WHERE id = $3 AND estado = ANY($4::text[]) RETURNING id`,
            [estado, nota, req.params.id, permitido[estado]]);
        if (!r.rows.length) return res.status(409).json({ error: 'La propuesta cambió de estado. Actualizá la lista.' });
        res.json({ exito: true });
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
        const enc = ['Zona', 'Día', 'Código cliente', 'ID cliente', 'Cliente', 'Dirección', 'Localidad', 'Orden anterior', 'Orden nuevo', 'Qué cambió', 'Chofer', 'Propuesta N°'];
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
        const anchos = [8, 11, 14, 12, 34, 30, 18, 14, 13, 12, 24, 12];
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

app.listen(PORT, () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});