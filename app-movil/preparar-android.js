// Se ejecuta después de "npx cap add android": agrega al AndroidManifest los permisos que necesita la app
// (ubicación, servicio en segundo plano, notificaciones). Se puede correr varias veces sin duplicar nada.
const fs = require('fs');
const ruta = 'android/app/src/main/AndroidManifest.xml';
if (!fs.existsSync(ruta)) {
    console.error('No existe ' + ruta + '. Primero hay que correr: npx cap add android');
    process.exit(1);
}
let xml = fs.readFileSync(ruta, 'utf8');
const permisos = [
    'ACCESS_FINE_LOCATION',
    'ACCESS_COARSE_LOCATION',
    'ACCESS_BACKGROUND_LOCATION',
    'FOREGROUND_SERVICE',
    'FOREGROUND_SERVICE_LOCATION',
    'POST_NOTIFICATIONS',
    'VIBRATE',
    'WAKE_LOCK'
];
let agregados = 0;
const lineas = [];
permisos.forEach(p => {
    if (!xml.includes('android.permission.' + p + '"')) {
        lineas.push('    <uses-permission android:name="android.permission.' + p + '" />');
        agregados++;
    }
});
if (agregados > 0) {
    if (!xml.includes('</manifest>')) {
        console.error('El AndroidManifest.xml no tiene el formato esperado.');
        process.exit(1);
    }
    xml = xml.replace('</manifest>', lineas.join('\n') + '\n</manifest>');
    fs.writeFileSync(ruta, xml);
}
console.log('Permisos agregados: ' + agregados);
