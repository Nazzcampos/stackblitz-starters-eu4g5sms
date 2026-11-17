// Base propia (Supabase): conexión (db), tablas que se crean solas (MIGRACION), limpieza diaria y requireDb.
const { Pool } = require('pg');
const { app } = require('./core.js');

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
ALTER TABLE flota_chofer ADD COLUMN IF NOT EXISTS oculto boolean NOT NULL DEFAULT false;
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
-- base = 'reparto': el orden parte del "Orden de reparto" importado de Gescom (antes partía del orden de visita del vendedor: 'ruta')
ALTER TABLE flota_orden_propuesta ADD COLUMN IF NOT EXISTS base text NOT NULL DEFAULT 'ruta';
CREATE UNIQUE INDEX IF NOT EXISTS flota_orden_borrador_uq ON flota_orden_propuesta (chofer, ruta, dia) WHERE estado = 'borrador';
CREATE INDEX IF NOT EXISTS flota_orden_estado_idx ON flota_orden_propuesta (estado, id DESC);
-- Documentación con vencimiento (camión y chofer)
CREATE TABLE IF NOT EXISTS flota_doc_tipo (
    clave text PRIMARY KEY,
    nombre text NOT NULL,
    aplica text NOT NULL,
    orden integer NOT NULL DEFAULT 0,
    activo boolean NOT NULL DEFAULT true,
    permite_sin_fecha boolean NOT NULL DEFAULT false
);
INSERT INTO flota_doc_tipo (clave, nombre, aplica, orden, permite_sin_fecha) VALUES
    ('tarjeta_verde', 'Tarjeta Verde', 'camion', 1, true),
    ('senasa', 'SENASA', 'camion', 2, false),
    ('itv', 'ITV / VTV / RTO', 'camion', 3, false),
    ('seguro_camion', 'Seguro del camión', 'camion', 4, false),
    ('matafuegos', 'Matafuegos', 'camion', 5, false),
    ('carnet_conducir', 'Carnet de Conducir', 'chofer', 1, false),
    ('carnet_alimentos', 'Carnet de Manipulación de Alimentos', 'chofer', 2, false),
    ('cnrt_cargas', 'CNRT Cargas Generales', 'chofer', 3, true),
    ('cnrt_psicofisico', 'CNRT Psicofísico', 'chofer', 4, false),
    ('seguro_art', 'Seguro de Accidente o ART', 'chofer', 5, false)
ON CONFLICT (clave) DO NOTHING;
-- Valor vigente de cada documento (uno por camión/chofer y tipo)
CREATE TABLE IF NOT EXISTS flota_doc_valor (
    aplica text NOT NULL,
    sujeto text NOT NULL,
    tipo text NOT NULL,
    fecha date,
    sin_fecha text,
    actualizado timestamptz NOT NULL DEFAULT now(),
    actualizado_por text,
    PRIMARY KEY (aplica, sujeto, tipo)
);
-- Cada carga queda registrada: así se ve si el mes siguiente se actualizó o no el vencimiento
CREATE TABLE IF NOT EXISTS flota_doc_historial (
    id bigserial PRIMARY KEY,
    creado timestamptz NOT NULL DEFAULT now(),
    periodo text NOT NULL,
    aplica text NOT NULL,
    sujeto text NOT NULL,
    tipo text NOT NULL,
    accion text NOT NULL,
    fecha_anterior date,
    fecha_nueva date,
    sin_fecha text,
    por text NOT NULL,
    alerta text
);
CREATE INDEX IF NOT EXISTS flota_doc_historial_sujeto_idx ON flota_doc_historial (aplica, sujeto, tipo, id DESC);
CREATE INDEX IF NOT EXISTS flota_doc_historial_alerta_idx ON flota_doc_historial (creado) WHERE alerta IS NOT NULL;
-- Check-list mensual de documentación: una fila por chofer y mes
CREATE TABLE IF NOT EXISTS flota_doc_mensual (
    chofer text NOT NULL,
    periodo text NOT NULL,
    dominio text,
    creado timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (chofer, periodo)
);
-- Camiones que el administrador quitó de la lista de documentación (ej. vehículos de prueba)
CREATE TABLE IF NOT EXISTS flota_camion_oculto (
    dominio text PRIMARY KEY,
    creado timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE flota_camion_oculto ENABLE ROW LEVEL SECURITY;
-- Equivalencia entre el camión de Gescom (vehiculo_codigo) y la patente usada en la app
CREATE TABLE IF NOT EXISTS flota_camion_gescom (
    vehiculo_codigo text PRIMARY KEY,
    dominio text NOT NULL,
    creado timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE flota_camion_gescom ENABLE ROW LEVEL SECURITY;
-- "Orden de reparto" de cada cliente (el que carga Gescom en la pestaña Entrega). Gescom no lo expone en la base de lectura: se importa desde su export
CREATE TABLE IF NOT EXISTS flota_orden_cliente (
    cliente_codigo text PRIMARY KEY,
    orden integer NOT NULL,
    actualizado timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE flota_orden_cliente ENABLE ROW LEVEL SECURITY;
-- Seguridad: nadie puede leer estas tablas desde la API pública de Supabase; solo este servidor
ALTER TABLE flota_chofer ENABLE ROW LEVEL SECURITY;
ALTER TABLE flota_checklist ENABLE ROW LEVEL SECURITY;
ALTER TABLE flota_combustible ENABLE ROW LEVEL SECURITY;
ALTER TABLE flota_posicion ENABLE ROW LEVEL SECURITY;
ALTER TABLE flota_odometro_dia ENABLE ROW LEVEL SECURITY;
ALTER TABLE flota_orden_propuesta ENABLE ROW LEVEL SECURITY;
ALTER TABLE flota_doc_tipo ENABLE ROW LEVEL SECURITY;
ALTER TABLE flota_doc_valor ENABLE ROW LEVEL SECURITY;
ALTER TABLE flota_doc_historial ENABLE ROW LEVEL SECURITY;
ALTER TABLE flota_doc_mensual ENABLE ROW LEVEL SECURITY;
-- Control de retorno del camión (Encargado de Depósito)
CREATE TABLE IF NOT EXISTS flota_deposito (
    clave text PRIMARY KEY,
    nombre text NOT NULL,
    pin_hash text NOT NULL,
    activo boolean NOT NULL DEFAULT true,
    sesion_desde timestamptz NOT NULL DEFAULT now(),
    creado timestamptz NOT NULL DEFAULT now(),
    ultimo_ingreso timestamptz
);
CREATE TABLE IF NOT EXISTS flota_retorno (
    id bigserial PRIMARY KEY,
    fecha date NOT NULL,
    chofer text NOT NULL,
    reparto text NOT NULL DEFAULT '',
    dominio text,
    cajas integer NOT NULL DEFAULT 0,
    observaciones text,
    items jsonb NOT NULL DEFAULT '[]'::jsonb,
    total_unidades numeric NOT NULL DEFAULT 0,
    cargado_por text NOT NULL,
    creado timestamptz NOT NULL DEFAULT now(),
    actualizado timestamptz NOT NULL DEFAULT now(),
    UNIQUE (fecha, chofer, reparto)
);
CREATE INDEX IF NOT EXISTS flota_retorno_fecha_idx ON flota_retorno (fecha DESC, chofer);
CREATE TABLE IF NOT EXISTS flota_notificacion (
    id bigserial PRIMARY KEY,
    destino text NOT NULL,
    clave text NOT NULL,
    tipo text NOT NULL,
    nivel text NOT NULL DEFAULT 'info',
    titulo text NOT NULL,
    mensaje text NOT NULL DEFAULT '',
    creado timestamptz NOT NULL DEFAULT now(),
    actualizado timestamptz NOT NULL DEFAULT now(),
    leida timestamptz,
    archivada timestamptz,
    resuelta boolean NOT NULL DEFAULT false,
    UNIQUE (destino, clave)
);
CREATE INDEX IF NOT EXISTS flota_notificacion_destino_idx ON flota_notificacion (destino, archivada, actualizado DESC);
ALTER TABLE flota_notificacion ENABLE ROW LEVEL SECURITY;
ALTER TABLE flota_deposito ENABLE ROW LEVEL SECURITY;
-- Acompañantes (ayudantes de reparto) y su planificación diaria
CREATE TABLE IF NOT EXISTS flota_acompanante (
    clave text PRIMARY KEY,
    nombre text NOT NULL,
    pin_hash text NOT NULL,
    activo boolean NOT NULL DEFAULT true,
    sesion_desde timestamptz NOT NULL DEFAULT now(),
    creado timestamptz NOT NULL DEFAULT now(),
    ultimo_ingreso timestamptz
);
CREATE TABLE IF NOT EXISTS flota_plan (
    fecha date NOT NULL,
    acompanante text NOT NULL,
    rol text NOT NULL DEFAULT 'acompanante',
    camion_clave text NOT NULL,
    camion text NOT NULL,
    dominio text NOT NULL DEFAULT '',
    chofer text NOT NULL DEFAULT '',
    clientes integer NOT NULL DEFAULT 0,
    kg numeric NOT NULL DEFAULT 0,
    importe numeric NOT NULL DEFAULT 0,
    km numeric,
    estimado boolean NOT NULL DEFAULT false,
    nota text NOT NULL DEFAULT '',
    asignado_por text NOT NULL DEFAULT '',
    visto timestamptz,
    actualizado timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (fecha, acompanante)
);
CREATE INDEX IF NOT EXISTS flota_plan_acomp_idx ON flota_plan (acompanante, fecha);
ALTER TABLE flota_acompanante ENABLE ROW LEVEL SECURITY;
ALTER TABLE flota_plan ENABLE ROW LEVEL SECURITY;
ALTER TABLE flota_retorno ENABLE ROW LEVEL SECURITY;
CREATE TABLE IF NOT EXISTS flota_jornada (
    id bigserial PRIMARY KEY,
    chofer text NOT NULL,
    vehiculo text NOT NULL,
    inicio timestamptz NOT NULL DEFAULT now(),
    fin timestamptz,
    cierre text,
    km numeric NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS flota_jornada_chofer_idx ON flota_jornada (chofer, inicio DESC);
CREATE INDEX IF NOT EXISTS flota_jornada_inicio_idx ON flota_jornada (inicio);
CREATE UNIQUE INDEX IF NOT EXISTS flota_jornada_abierta_idx ON flota_jornada (chofer) WHERE fin IS NULL;
ALTER TABLE flota_jornada ENABLE ROW LEVEL SECURITY;
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


module.exports = { db, MIGRACION, requireDb, INICIO_DIA_AR, get dbListo() { return dbListo; } };
