// Servidor Express, páginas estáticas y conexión de SOLO LECTURA a Gescom (pool).
const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const app = express();

// Solo se entregan las dos páginas de la app (antes se servía toda la carpeta, incluido index.js)
app.get(['/', '/index.html'], (req, res) => res.sendFile(path.join(__dirname, '..', 'index.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, '..', 'admin.html')));
app.use('/public', express.static(path.join(__dirname, '..', 'public')));
app.get('/deposito.html', (req, res) => res.sendFile(path.join(__dirname, '..', 'deposito.html')));
const PORT = process.env.PORT || 3000;

// Render usa un proxy: así req.ip es la IP real del cliente
app.set('trust proxy', 1);

// Middleware para entender JSON
app.use(express.json());

// --- CONFIGURACIÓN DE CONEXIÓN A GESCOM (PostgreSQL, SOLO LECTURA) ---
// La contraseña NUNCA va en el código: se carga como variable de entorno DB_PASSWORD en Render
// (Environment). Usuario, servidor y base no son secretos y tienen valor por defecto.
if (!process.env.DB_PASSWORD) {
    console.error('⛔ Falta la variable DB_PASSWORD (contraseña de Gescom). Cargala en Render > Environment: sin ella no se pueden leer los repartos.');
}
const pool = new Pool({
    user: process.env.DB_USER || 'gcw-bido',
    host: process.env.DB_HOST || 'bi.data.gescom.online',
    database: process.env.DB_NAME || 'gcwbi',
    password: process.env.DB_PASSWORD || undefined,
    port: Number(process.env.DB_PORT) || 5432,
    ssl: {
        rejectUnauthorized: false
    }
});


module.exports = { app, pool, PORT };
