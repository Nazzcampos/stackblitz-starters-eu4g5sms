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
    password: 'f1dqTqpo9Iwf4wTJ8ziUnDubh', // Contraseña corregida con comillas
    port: 5432,
    ssl: {
        rejectUnauthorized: false // Requerido para aceptar el certificado SSL del servidor remoto
    }
});

// Memoria temporal para el prototipo
let choferesUbicaciones = [];
let checkListsEnviados = [];
let cargasCombustible = [];

// Objeto para llevar le registro de kilometraje por vehículo
let estadisticasVehiculos = {};

// Función matemática de Haversine para calcular distancia en km entre dos coordenadas GPS
function calcularDistancia(lat1, lon1, lat2, lon2) {
    const R = 6371; // Radio de la Tierra en kilómetros
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = 
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c; // Retorna la distancia en kilómetros
}

// Ruta de Bienvenida
app.get('/', (req, res) => {
    res.json({ mensaje: "¡API de Gestión de Flota PepsiCo conectada a Gescom funcionando! 🚚⛽" });
});

// --- 1. MÓDULO DE CLIENTES Y HOJA DE RUTA REAL (GESCOM - POSTGRESQL) ---
app.get('/api/clientes/:dia', async (req, res) => {
    const diaSeleccionado = req.params.dia.toUpperCase(); // 'LU', 'MA', 'MI', 'JU', 'VI'

    try {
        // Consulta SQL directa a la base de datos PostgreSQL de Gescom
        const query = `
            SELECT 
                cliente_id AS id, 
                razon_social AS nombre, 
                direccion, 
                latitud AS lat, 
                longitud AS lon 
            FROM clientes_ruta 
            WHERE dia_visita = $1
        `;

        const resultado = await pool.query(query, [diaSeleccionado]);
        res.json(resultado.rows);

    } catch (err) {
        console.error("Error al consultar la base de datos de Gescom:", err);
        res.status(500).json({ error: "No se pudo conectar con la tabla de rutas de Gescom. Verifique nombres de tablas/columnas." });
    }
});

// --- 2. MÓDULO DE UBICACIÓN GPS Y DISTANCIA RECORRIDA ---
app.post('/api/ubicacion', (req, res) => {
    const { chofer_id, vehiculo, latitud, longitud } = req.body;
    
    if (!chofer_id || !latitud || !longitud) {
        return res.status(400).json({ error: "Faltan datos obligatorios (chofer_id, latitud, longitud)" });
    }

    const vehiculoKey = vehiculo || "Sin asignar";

    if (!estadisticasVehiculos[vehiculoKey]) {
        estadisticasVehiculos[vehiculoKey] = {
            chofer: chofer_id,
            distanciaKm: 0,
            ultimaLat: null,
            ultimaLon: null
        };
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

    const nuevaUbicacion = {
        chofer_id,
        vehiculo: vehiculoKey,
        latitud,
        longitud,
        distanciaTotalKm: distanciaTotalRedondeada,
        fecha_hora: new Date()
    };

    choferesUbicaciones.push(nuevaUbicacion);
    
    console.log(`📍 GPS de ${chofer_id} [${vehiculoKey}] | Distancia acumulada: ${distanciaTotalRedondeada} km`);
    res.status(201).json({ 
        exito: true, 
        mensaje: "Ubicación y distancia registradas", 
        distanciaTotalKm: distanciaTotalRedondeada 
    });
});

app.get('/api/ubicaciones', (req, res) => {
    res.json(choferesUbicaciones);
});

app.get('/api/estadisticas', (req, res) => {
    const listaEstadisticas = Object.keys(estadisticasVehiculos).map(vehiculo => ({
        vehiculo,
        chofer: estadisticasVehiculos[vehiculo].chofer,
        distanciaTotalKm: Number(estadisticasVehiculos[vehiculo].distanciaKm.toFixed(2)),
        ultimaLat: estadisticasVehiculos[vehiculo].ultimaLat,
        ultimaLon: estadisticasVehiculos[vehiculo].ultimaLon
    }));
    res.json(listaEstadisticas);
});

// --- 3. MÓDULO DE CHECK-LIST OBLIGATORIO ---
app.post('/api/checklist', (req, res) => {
    const { dominio, chofer, tipo_vehiculo, respuestas, observaciones } = req.body;

    if (!dominio || !chofer) {
        return res.status(400).json({ error: "El dominio y el chofer son obligatorios" });
    }

    const nuevoChecklist = {
        id: checkListsEnviados.length + 1,
        marca_temporal: new Date(),
        dominio,
        chofer,
        tipo_vehiculo: tipo_vehiculo || "Vehículo (Auto o Camioneta)",
        respuestas: respuestas || {},
        observaciones: observaciones || ""
    };

    checkListsEnviados.push(nuevoChecklist);

    console.log(`📋 Check-list recibido de ${chofer} para el vehículo ${dominio}`);
    res.status(201).json({ exito: true, mensaje: "Check-list guardado correctamente", id: nuevoChecklist.id });
});

app.get('/api/checklists', (req, res) => {
    res.json(checkListsEnviados);
});

app.delete('/api/checklist/:id', (req, res) => {
    const id = Number(req.params.id);
    checkListsEnviados = checkListsEnviados.filter(c => c.id !== id);
    res.json({ exito: true, mensaje: "Check-list eliminado" });
});

// --- 4. MÓDULO DE CONTROL DE COMBUSTIBLE ---
app.post('/api/combustible', (req, res) => {
    const { chofer, dominio, litros, costoTotal, odometroActual } = req.body;

    if (!chofer || !dominio || !litros || !odometroActual) {
        return res.status(400).json({ error: "Faltan datos obligatorios para registrar la carga" });
    }

    const cargasPrevias = cargasCombustible.filter(c => c.dominio === dominio);
    let rendimientoKmLitros = 0;

    if (cargasPrevias.length > 0) {
        const ultimaCarga = cargasPrevias[cargasPrevias.length - 1];
        const distanciaRecorrida = Number(odometroActual) - Number(ultimaCarga.odometroActual);
        if (distanciaRecorrida > 0 && Number(litros) > 0) {
            rendimientoKmLitros = Number((distanciaRecorrida / Number(litros)).toFixed(2));
        }
    }

    const nuevaCarga = {
        id: cargasCombustible.length + 1,
        fecha: new Date(),
        chofer,
        dominio,
        litros: Number(litros),
        costoTotal: Number(costoTotal || 0),
        odometroActual: Number(odometroActual),
        rendimientoKmLitros
    };

    cargasCombustible.push(nuevaCarga);

    console.log(`⛽ Carga registrada [${dominio}] por ${chofer}: ${litros}L | Rendimiento: ${rendimientoKmLitros} Km/L`);
    res.status(201).json({
        exito: true,
        mensaje: "Carga de combustible registrada exitosamente",
        rendimientoKmLitros
    });
});

app.get('/api/combustible', (req, res) => {
    res.json(cargasCombustible);
});

app.delete('/api/combustible/:id', (req, res) => {
    const id = Number(req.params.id);
    cargasCombustible = cargasCombustible.filter(c => c.id !== id);
    res.json({ exito: true, mensaje: "Registro de combustible eliminado" });
});

// Levantar el servidor
app.listen(PORT, () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});