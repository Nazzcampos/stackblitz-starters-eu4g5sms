const express = require('express');
const app = express();
app.use(express.static('.'));
const PORT = process.env.PORT || 3000;

// Middleware para entender JSON
app.use(express.json());

// Memoria temporal para el prototipo
let choferesUbicaciones = [];
let checkListsEnviados = [];

// Objeto para llevar el registro de kilometraje por vehículo
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
    res.json({ mensaje: "¡API de Gestión de Flota con Odómetro funcionando! 🚚" });
});

// --- 1. MÓDULO DE UBICACIÓN GPS Y DISTANCIA RECORRIDA ---
app.post('/api/ubicacion', (req, res) => {
    const { chofer_id, vehiculo, latitud, longitud } = req.body;
    
    if (!chofer_id || !latitud || !longitud) {
        return res.status(400).json({ error: "Faltan datos obligatorios (chofer_id, latitud, longitud)" });
    }

    const vehiculoKey = vehiculo || "Sin asignar";

    // Si el vehículo no tiene registro previo, lo inicializamos
    if (!estadisticasVehiculos[vehiculoKey]) {
        estadisticasVehiculos[vehiculoKey] = {
            chofer: chofer_id,
            distanciaKm: 0,
            ultimaLat: null,
            ultimaLon: null
        };
    }

    const vehStats = estadisticasVehiculos[vehiculoKey];
    vehStats.chofer = chofer_id; // Actualizamos el chofer actual

    // Si hay una ubicación anterior registrada, calculamos el tramo recorrido
    if (vehStats.ultimaLat !== null && vehStats.ultimaLon !== null) {
        const distanciaTramo = calcularDistancia(vehStats.ultimaLat, vehStats.ultimaLon, latitud, longitud);
        
        // Filtro de seguridad: descartar saltos erróneos de GPS mayores a 10 km o micro-saltos menores a 1 metro
        if (distanciaTramo < 10 && distanciaTramo > 0.001) {
            vehStats.distanciaKm += distanciaTramo;
        }
    }

    // Actualizamos la última posición conocida del vehículo
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

// El Admin consulta las ubicaciones actuales
app.get('/api/ubicaciones', (req, res) => {
    res.json(choferesUbicaciones);
});

// Endpoint consolidado para consultar estadísticas de kilometraje por vehículo en formato array
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


// --- 2. MÓDULO DE CHECK-LIST OBLIGATORIO ---
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

// Levantar el servidor (compatible con puertos locales y de la nube como Render)
app.listen(PORT, () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});