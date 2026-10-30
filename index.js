const express = require('express');
const { Pool } = require('pg');
const app = express();
app.use(express.static('.'));
const PORT = process.env.PORT || 3000;

// Middleware para entender JSON
app.use(express.json());

// --- CONFIGURACIÓN DE CONEXIÓN A GESCOM (PostgreSQL) ---
const pool = new Pool({
    user: 'gcw-bido',
    host: 'bi.data.gescom.online',
    database: 'gcwbi',
    password: 'f1dqTqpo9Iwf4wTJ8ziUnDubh',
    port: 5432,
    ssl: {
        rejectUnauthorized: false
    }
});

// --- AUTODIAGNÓSTICO INICIAL AL ARRANCAR EL SERVIDOR ---
async function probarConexionYListarTablas() {
    try {
        console.log("🔍 Intentando conectar al servidor de Gescom (bi.data.gescom.online)...");
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

let choferesUbicaciones = [];
let checkListsEnviados = [];
let cargasCombustible = [];
let estadisticasVehiculos = {};

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

app.get('/', (req, res) => {
    res.json({ mensaje: "¡API de Gestión de Flota PepsiCo conectada a Gescom funcionando! 🚚⛽" });
});

app.get('/api/esquema', async (req, res) => {
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

// --- MÓDULO DE HOJA DE RUTA REAL POR CHOFER Y FECHA CON SALDO REAL DE CTA CTE ---
app.get('/api/ventas-chofer/:nombre', async (req, res) => {
    const choferNombre = decodeURIComponent(req.params.nombre);
    const fechaSeleccionada = req.query.fecha;

    try {
        let query = `
            SELECT DISTINCT
                v.cliente_id AS id,
                v.razon_social AS nombre,
                c.direccion,
                c.localidad,
                rh.latitud AS lat,
                rh.longitud AS lon,
                v.orden_planeado AS orden,
                v.reparto_codigo,
                v.empleado_chofer_nombre AS chofer,
                v.fecha_entrega,
                COALESCE((
                    SELECT SUM(cc.importe) 
                    FROM cta_cte_cliente cc 
                    WHERE cc.cliente_id = v.cliente_id
                ), 0) AS saldo_deuda
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

        query += ` ORDER BY v.orden_planeado ASC;`;

        const resultado = await pool.query(query, params);
        res.json(resultado.rows);

    } catch (err) {
        console.error("❌ Error al consultar las ventas del chofer en Gescom:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// --- MÓDULO DE CUENTA CORRIENTE (GESCOM - CTA_CTE_CLIENTE) ---
app.get('/api/cta-cte/:cliente_id', async (req, res) => {
    const clienteId = req.params.cliente_id;

    try {
        const query = `
            SELECT 
                tipo_comprobante_codigo,
                punto_venta_codigo,
                numero_comprobante,
                fecha_comprobante,
                fecha_vencimiento,
                importe_original,
                importe AS saldo_pendiente,
                detalle
            FROM cta_cte_cliente
            WHERE cliente_id = $1
              AND importe > 0
            ORDER BY fecha_vencimiento ASC;
        `;

        const resultado = await pool.query(query, [clienteId]);
        res.json(resultado.rows);

    } catch (err) {
        console.error("Error al consultar la cuenta corriente en Gescom:", err);
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
    const nuevo = { id: checkListsEnviados.length + 1, marca_temporal: new Date(), ...req.body };
    checkListsEnviados.push(nuevo);
    res.status(201).json({ exito: true, id: nuevo.id });
});

app.get('/api/checklists', (req, res) => { res.json(checkListsEnviados); });
app.delete('/api/checklist/:id', (req, res) => {
    checkListsEnviados = checkListsEnviados.filter(c => c.id !== Number(req.params.id));
    res.json({ exito: true });
});

app.post('/api/combustible', (req, res) => {
    const nueva = { id: cargasCombustible.length + 1, fecha: new Date(), ...req.body };
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