// BeniQ — punto de arranque. Cada tema vive en su propio archivo dentro de /server.
// (el orden de los require es el orden en que se registran las rutas)
const { app, PORT } = require('./server/core');
require('./server/base.js');
require('./server/auth.js');
require('./server/gescom.js');
require('./server/rutas/choferes.js');
require('./server/rutas/hoja-de-ruta.js');
require('./server/rutas/gps-y-checklist.js');
require('./server/xlsx.js');
require('./server/rutas/combustible.js');
require('./server/rutas/orden-de-reparto.js');
require('./server/rutas/documentacion.js');
require('./server/rutas/deposito.js');
require('./server/rutas/jornadas.js');
require('./server/rutas/venta-por-camion.js');
require('./server/rutas/importar-orden.js');
require('./server/rutas/ruta-sugerida.js');
require('./server/rutas/comprobantes.js');
require('./server/rutas/notificaciones.js');
require('./server/rutas/planificacion.js');
require('./server/rutas/clientes.js');

app.listen(PORT, () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});
