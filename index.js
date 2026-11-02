const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const app = express();

// Solo se entregan las dos páginas de la app (antes se servía toda la carpeta, incluido index.js)
app.get(['/', '/index.html'], (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
const PORT = process.env.PORT || 3000;

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

// --- DATOS EN MEMORIA (se pierden al reiniciar el servidor) ---
const MAX_UBICACIONES = 5000; // límite para que el historial de GPS no crezca sin fin
let choferesUbicaciones = [];
let checkListsEnviados = [];
let cargasCombustible = [];
let estadisticasVehiculos = {};
let siguienteIdChecklist = 1;
let siguienteIdCombustible = 1;

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
    res.json({ mensaje: "¡API de Gestión de Flota PepsiCo conectada a Gescom funcionando! 🚚⛽" });
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
app.get('/api/choferes', async (req, res) => {
    try {
        const query = `
            SELECT DISTINCT empleado_chofer_nombre AS nombre
            FROM venta
            WHERE empleado_chofer_nombre IS NOT NULL
              AND TRIM(empleado_chofer_nombre) != ''
            ORDER BY empleado_chofer_nombre ASC;
        `;
        const resultado = await pool.query(query);
        res.json(resultado.rows);
    } catch (err) {
        console.error("❌ Error al obtener la lista de choferes:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// --- MÓDULO DE HOJA DE RUTA CON SALDO TOTAL (DÉBITOS - CRÉDITOS) ---
app.get('/api/ventas-chofer/:nombre', async (req, res) => {
    const choferNombre = decodeURIComponent(req.params.nombre);
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
            WHERE v.empleado_chofer_nombre ILIKE $1
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
app.get('/api/cta-cte/:cliente_id', async (req, res) => {
    const clienteId = req.params.cliente_id;

    if (!/^\d+$/.test(clienteId)) {
        return res.status(400).json({ error: "cliente_id inválido" });
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

app.get('/api/clientes/:dia', async (req, res) => {
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

app.post('/api/ubicacion', (req, res) => {
    const { chofer_id, vehiculo, latitud, longitud } = req.body;
    if (!chofer_id || !latitud || !longitud) {
        return res.status(400).json({ error: "Faltan datos obligatorios" });
    }
    const vehiculoKey = vehiculo || "Sin asignar";
    if (!estadisticasVehiculos[vehiculoKey]) {
        estadisticasVehiculos[vehiculoKey] = { chofer: chofer_id, distanciaKm: 0, ultimaLat: null, ultimaLon: null };
    }
    const vehStats = estadisticasVehiculos[vehiculoKey];
    vehStats.chofer = chofer_id;
    if (vehStats.ultimaLat !== null && vehStats.ultimaLon !== null) {
        const distanciaTramo = calcularDistancia(vehStats.ultimaLat, vehStats.ultimaLon, latitud, longitud);
        if (distanciaTramo < 10 && distanciaTramo > 0.001) {
            vehStats.distanciaKm += distanciaTramo;
        }
    }
    vehStats.ultimaLat = latitud;
    vehStats.ultimaLon = longitud;
    const distanciaTotalRedondeada = Number(vehStats.distanciaKm.toFixed(2));
    choferesUbicaciones.push({ chofer_id, vehiculo: vehiculoKey, latitud, longitud, distanciaTotalKm: distanciaTotalRedondeada, fecha_hora: new Date() });
    if (choferesUbicaciones.length > MAX_UBICACIONES) {
        choferesUbicaciones.splice(0, choferesUbicaciones.length - MAX_UBICACIONES);
    }
    res.status(201).json({ exito: true, distanciaTotalKm: distanciaTotalRedondeada });
});

app.get('/api/ubicaciones', (req, res) => { res.json(choferesUbicaciones); });
app.get('/api/estadisticas', (req, res) => {
    const lista = Object.keys(estadisticasVehiculos).map(v => ({
        vehiculo: v,
        chofer: estadisticasVehiculos[v].chofer,
        distanciaTotalKm: Number(estadisticasVehiculos[v].distanciaKm.toFixed(2))
    }));
    res.json(lista);
});

app.post('/api/checklist', (req, res) => {
    const { dominio, chofer } = req.body;
    if (!dominio || !chofer) return res.status(400).json({ error: "Faltan datos obligatorios" });
    const nuevo = { id: siguienteIdChecklist++, marca_temporal: new Date(), ...req.body };
    checkListsEnviados.push(nuevo);
    res.status(201).json({ exito: true, id: nuevo.id });
});

app.get('/api/checklists', (req, res) => { res.json(checkListsEnviados); });
app.delete('/api/checklist/:id', (req, res) => {
    checkListsEnviados = checkListsEnviados.filter(c => c.id !== Number(req.params.id));
    res.json({ exito: true });
});

app.post('/api/combustible', (req, res) => {
    const nueva = { id: siguienteIdCombustible++, fecha: new Date(), ...req.body };
    cargasCombustible.push(nueva);
    res.status(201).json({ exito: true });
});

app.get('/api/combustible', (req, res) => { res.json(cargasCombustible); });
app.delete('/api/combustible/:id', (req, res) => {
    cargasCombustible = cargasCombustible.filter(c => c.id !== Number(req.params.id));
    res.json({ exito: true });
});

app.listen(PORT, () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});