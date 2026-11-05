// Configuración de la app Android.
// La app abre la web de la flota (Render) dentro del celular, así cada mejora que se despliegue en Render
// le llega sola a los choferes, sin instalar un APK nuevo.
// La dirección se toma de la variable APP_URL de GitHub (Settings > Secrets and variables > Actions > Variables).
const direccion = process.env.APP_URL;
if (!direccion) {
    throw new Error('Falta la variable APP_URL. Cargala en GitHub: Settings > Secrets and variables > Actions > Variables (ej: https://mi-flota.onrender.com)');
}
let destino;
try {
    destino = new URL(direccion);
} catch (e) {
    throw new Error('APP_URL no es una dirección válida: ' + direccion);
}

module.exports = {
    appId: 'app.flota.piloto',
    appName: 'BeniQ',
    webDir: 'www',
    server: {
        url: destino.origin,
        cleartext: false,
        allowNavigation: [destino.host]
    },
    android: {
        // Necesario para que el GPS no se corte a los 5 minutos con la app en segundo plano
        useLegacyBridge: true
    }
};
