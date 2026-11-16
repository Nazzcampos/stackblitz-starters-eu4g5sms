// Consultas a Gescom compartidas: deudas, exhibidores en comodato, columna "código de cliente", distancia.
const { app, pool } = require('./core.js');
const base = require('./base.js');
const { db } = require('./base.js');

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
        db: base.dbListo ? 'ok' : (db ? 'conectando' : 'sin_configurar')
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
        // /api/esquema?token=...&tabla=venta → columnas de esa tabla (solo nombre y tipo, sin datos)
        // /api/esquema?token=...&columna=orden → tablas que tienen una columna cuyo nombre contiene ese texto
        if (req.query.columna) {
            const c = String(req.query.columna).toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 40);
            // &todo=1 → busca en todos los esquemas y también en tablas sin permiso de lectura (solo nombres)
            if (req.query.todo) {
                const r2 = await pool.query(
                    `SELECT n.nspname AS esquema, cl.relname AS tabla, a.attname AS columna, format_type(a.atttypid, a.atttypmod) AS tipo,
                            has_table_privilege(cl.oid, 'SELECT') AS puedo_leer
                     FROM pg_attribute a JOIN pg_class cl ON cl.oid = a.attrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
                     WHERE a.attnum > 0 AND NOT a.attisdropped AND cl.relkind IN ('r', 'v', 'm', 'p', 'f')
                       AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') AND a.attname LIKE $1
                     ORDER BY 1, 2, a.attnum LIMIT 200`, ['%' + c + '%']);
                return res.json({ buscado: c, resultados: r2.rows });
            }
            const r = await pool.query(
                `SELECT table_name AS tabla, column_name AS columna, data_type AS tipo FROM information_schema.columns
                 WHERE table_schema = 'public' AND column_name LIKE $1 ORDER BY table_name, ordinal_position`, ['%' + c + '%']);
            return res.json({ buscado: c, resultados: r.rows });
        }
        if (req.query.tabla) {
            const t = String(req.query.tabla).toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 60);
            const cols = await pool.query(
                `SELECT column_name AS columna, data_type AS tipo FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [t]);
            return res.json({ tabla: t, columnas: cols.rows });
        }
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


module.exports = { probarConexionYListarTablas, calcularDistancia, DIAS_DEUDA_RECIENTE, HOY_AR_SQL, TTL_DEUDAS_MS, obtenerDeudas, cacheExhibidores, filtroRemitos, obtenerExhibidores, detectarColumnasCodigo };
