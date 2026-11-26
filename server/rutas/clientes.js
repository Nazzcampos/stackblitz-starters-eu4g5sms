// ================================================================
//  MÓDULO PROVISORIO: Seguimiento de clientes y cobertura de marcas  ->  /clientes
//  Para QUITARLO: borrar este archivo, gestion.html (en la raíz)
//  y la línea  require('./server/rutas/clientes.js');  de index.js.
//  (Opcional) en Supabase: DROP TABLE clientes_objetivo_marca;
//
//  Variables de entorno (Render > Environment):
//      CLIENTES_PIN   -> PIN de acceso del supervisor de ventas (obligatoria)
//      GESCOM_TENANT  -> tenant de BIDO en Gescom (por defecto 116)
//
//  FECHA DE ALTA: Gescom no la guarda (la primera versión de todo cliente
//  figura con fecha 2000-01-01). Se estima con el número correlativo hist_id.
//
//  COBERTURA DE MARCAS (igual que la planilla Batalla de Marcas):
//   - Mes = comprobantes con FECHA DE ENTREGA dentro del mes.
//   - Se suman las unidades por cliente y marca: facturas suman, notas de crédito restan.
//   - Cliente cubierto = 3 unidades o más de la marca en el mes (DROP_MINIMO).
//     Con 1 o 2 unidades queda como "oportunidad".
//   - Fecha de corte (por defecto, el último día con ventas cargadas): se compara lo cargado hasta
//     el corte contra lo cargado hasta el día anterior con ventas (ej. lunes 16 vs viernes 14).
//   - El vendedor es el vendedor actual del cliente (ruta vigente en Gescom).
// ================================================================
const path = require('path');
const { app, pool } = require('../core.js');
const { db } = require('../base.js');
const { ESTILO, crearXlsx, enviarXlsx } = require('../xlsx.js');

const TENANT = Number(process.env.GESCOM_TENANT || 116);
const CACHE_MS = 10 * 60 * 1000; // 10 minutos, para no cargar a Gescom en cada visita
const DROP_MINIMO = 3;           // unidades mínimas en el mes para contar al cliente como cubierto

// Comprobantes que NO cuentan como compra para las altas (remitos de comodato y notas de crédito)
const EXCLUIR_COMPROBANTES = ['REM%', 'NC%'];

// Submarcas que Gescom guarda dentro de otra marca: se reconocen por la descripción del artículo.
// Para sumar otra, agregar una línea { nombre, patron } (patron usa % como comodín).
const SUBMARCAS = [
    { nombre: 'Dinamita', patron: '%dinamita%' },
    { nombre: 'Sweet Chili', patron: '%sweet chil%' }
];

// El PIN se lee en cada pedido y sin espacios (por si quedó un espacio al cargarlo en Render)
//  Tres niveles de acceso:
//   1) PIN de entrada a la web (CLIENTES_PIN, por defecto 5940)
//   2) Supervisor: código SUPERVISOR_PIN (por defecto 1234) -> seguimiento de altas, cobertura, stock y ruteo
//   3) Vendedor: su código de vendedor de Gescom (VENDEDORES_CODIGOS, separados por coma) -> solo su ruta
const leerPin = () => String(process.env.CLIENTES_PIN || '5940').trim();
const leerPinSupervisor = () => String(process.env.SUPERVISOR_PIN || '1234').trim();
const leerPinEncargado = () => String(process.env.ENCARGADO_PIN || '1234').trim();
const leerPinBodeguista = () => String(process.env.BODEGUISTA_PIN || '1234').trim();
const leerPinAdm = () => String(process.env.ADMINISTRACION_PIN || '1234').trim();
const codigosVendedores = () => String(process.env.VENDEDORES_CODIGOS || '21,22,23,24,25,27,31,32,33,34')
    .split(',').map(c => c.trim()).filter(Boolean);
const sinCeros = c => String(c == null ? '' : c).trim().replace(/^0+(?=\d)/, '');

function controlPin(req, res, next) {
    if (String(req.get('x-pin') || '').trim() !== leerPin()) return res.status(401).json({ error: 'PIN incorrecto' });
    next();
}
function controlSupervisor(req, res, next) {
    controlPin(req, res, () => {
        if (String(req.get('x-sup') || '').trim() !== leerPinSupervisor()) return res.status(403).json({ error: 'Código de supervisor incorrecto' });
        next();
    });
}
function controlEncargado(req, res, next) {
    controlPin(req, res, () => {
        if (String(req.get('x-enc') || '').trim() !== leerPinEncargado()) return res.status(403).json({ error: 'Código de encargado incorrecto' });
        next();
    });
}
function controlAdministracion(req, res, next) {
    controlPin(req, res, () => {
        if (String(req.get('x-adm') || '').trim() !== leerPinAdm()) return res.status(403).json({ error: 'Código de administración incorrecto' });
        next();
    });
}
// Bodeguista: solo lectura de la tabla mensual y los errores (no tiene acceso a ninguna escritura)
function controlLectorDeposito(req, res, next) {
    controlPin(req, res, () => {
        if (String(req.get('x-enc') || '').trim() === leerPinEncargado()) { req.esEncargado = true; return next(); }
        if (String(req.get('x-bod') || '').trim() === leerPinBodeguista()) return next();
        return res.status(403).json({ error: 'Código incorrecto' });
    });
}
function controlVendedor(req, res, next) {
    controlPin(req, res, () => {
        const cod = sinCeros(req.get('x-vendedor'));
        if (!cod || !codigosVendedores().some(c => sinCeros(c) === cod)) return res.status(403).json({ error: 'Código de vendedor incorrecto' });
        req.vendedor = cod;
        next();
    });
}

const hoyAR = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }); // YYYY-MM-DD

// =====================================================================
//  CLIENTES: activos, vendedor, ramo, alta estimada, primera compra
// =====================================================================
const SQL_CLIENTES = `
WITH h AS (
  SELECT id, hist_id, fecha_inicio
  FROM cliente_hist
  WHERE tenant_id = $1
),
primera AS (
  SELECT id, MIN(hist_id) AS h0 FROM h GROUP BY id
),
eventos AS (
  SELECT h0 AS hid, id, NULL::timestamp AS f FROM primera
  UNION ALL
  SELECT hist_id, NULL::bigint, fecha_inicio FROM h WHERE fecha_inicio > '2001-01-01'
),
estim AS (
  SELECT id, MIN(f) OVER (ORDER BY hid DESC, (f IS NULL) ROWS UNBOUNDED PRECEDING) AS alta
  FROM eventos
),
inicio AS (
  SELECT MIN(fecha_inicio) AS f0 FROM h WHERE fecha_inicio > '2001-01-01'
),
alta AS (
  SELECT e.id,
         CASE WHEN COALESCE(e.alta, now()) < (SELECT f0 FROM inicio) + interval '7 days' THEN NULL
              ELSE COALESCE(e.alta, now()) END AS fecha_alta
  FROM estim e
  WHERE e.id IS NOT NULL
),
cli AS (
  SELECT c.id, c.codigo, c.nombre, c.localidad,
         COALESCE(NULLIF(c.ramo_descripcion, ''), 'Sin ramo') AS ramo,
         COALESCE(c.subramo_descripcion, '') AS subramo,
         COALESCE(c.segmento_cliente_descripcion, '') AS segmento,
         COALESCE(c.activo, false) AS activo
  FROM cliente_hist c
  WHERE c.actual AND c.tenant_id = $1
),
ruta AS (
  SELECT DISTINCT ON (r.cliente_id) r.cliente_id, r.vendedor_codigo, r.vendedor_nombre
  FROM cliente_ruta_hist r
  WHERE r.actual AND r.tenant_id = $1
  ORDER BY r.cliente_id, (r.fuerza_venta = 'Principal') DESC NULLS LAST, r.vendedor_codigo
),
pc AS (
  SELECT v.cliente_id, MIN(v.fecha_comprobante) AS primera_compra
  FROM venta v
  WHERE v.tenant_id = $1
    AND v.fecha_comprobante IS NOT NULL
    AND NOT (COALESCE(v.tipo_comprobante_codigo, '') ILIKE ANY ($2::text[]))
  GROUP BY v.cliente_id
)
SELECT cli.codigo, cli.nombre, cli.localidad, cli.ramo, cli.subramo, cli.segmento, cli.activo,
       ruta.vendedor_codigo, ruta.vendedor_nombre,
       to_char(alta.fecha_alta, 'YYYY-MM-DD') AS alta,
       to_char(pc.primera_compra, 'YYYY-MM-DD') AS primera_compra
FROM cli
LEFT JOIN ruta ON ruta.cliente_id = cli.id
LEFT JOIN alta ON alta.id = cli.id
LEFT JOIN pc   ON pc.cliente_id = cli.id
ORDER BY cli.nombre;
`;

let cacheClientes = { t: 0, data: null, pendiente: null };

async function obtenerClientes(forzar) {
    if (!forzar && cacheClientes.data && Date.now() - cacheClientes.t < CACHE_MS) return cacheClientes.data;
    if (cacheClientes.pendiente) return cacheClientes.pendiente;
    cacheClientes.pendiente = (async () => {
        try {
            const { rows } = await pool.query(SQL_CLIENTES, [TENANT, EXCLUIR_COMPROBANTES]);
            cacheClientes.data = rows;
            cacheClientes.t = Date.now();
            return rows;
        } finally {
            cacheClientes.pendiente = null;
        }
    })();
    return cacheClientes.pendiente;
}

// =====================================================================
//  COBERTURA DE MARCAS: por vendedor, marca y día en que el cliente llegó al drop
// =====================================================================
const SQL_MARCAS = `
WITH ruta AS (
  SELECT DISTINCT ON (r.cliente_id) r.cliente_id, r.vendedor_codigo, r.vendedor_nombre
  FROM cliente_ruta_hist r
  WHERE r.actual AND r.tenant_id = $1
  ORDER BY r.cliente_id, (r.fuerza_venta = 'Principal') DESC NULLS LAST, r.vendedor_codigo
),
lineas AS (
  SELECT v.cliente_id,
         COALESCE(v.fecha_carga, v.fecha_creacion, v.fecha_comprobante)::date AS dia,
         i.marca_desc,
         COALESCE(i.descripcion, '') AS descripcion,
         vi.cantidad * COALESCE(NULLIF(vi.unidad_factor, 0), 1)
           * CASE WHEN v.tipo_comprobante_codigo ILIKE 'NC%' THEN -1 ELSE 1 END AS u
  FROM venta v
  JOIN venta_item vi ON vi.venta_id = v.id AND vi.tenant_id = v.tenant_id
  JOIN item i        ON i.id = vi.item_id  AND i.tenant_id = v.tenant_id
  WHERE v.tenant_id = $1
    AND v.fecha_entrega >= $2::date AND v.fecha_entrega < $3::date
    AND (v.tipo_comprobante_codigo ILIKE 'FAC%' OR v.tipo_comprobante_codigo ILIKE 'NC%')
),
fechas AS (
  SELECT COALESCE($8::date, (SELECT MAX(dia) FROM lineas WHERE dia <= $4::date), $4::date) AS corte
),
fechas2 AS (
  SELECT corte, (SELECT MAX(dia) FROM lineas WHERE dia < (SELECT corte FROM fechas)) AS base FROM fechas
),
por_marca AS (
  SELECT cliente_id, dia, COALESCE(NULLIF(trim(marca_desc), ''), 'Sin marca') AS marca, u FROM lineas
  UNION ALL
  SELECT l.cliente_id, l.dia, s.nombre, l.u
  FROM lineas l
  JOIN unnest($5::text[], $6::text[]) AS s(nombre, patron) ON l.descripcion ILIKE s.patron
),
diario AS (
  SELECT cliente_id, marca, dia, SUM(u) AS u
  FROM por_marca
  WHERE dia <= (SELECT corte FROM fechas2)
  GROUP BY 1, 2, 3
),
acum AS (
  SELECT cliente_id, marca, dia, u,
         SUM(u) OVER (PARTITION BY cliente_id, marca ORDER BY dia) AS acu
  FROM diario
),
cli AS (
  SELECT cliente_id, marca,
         SUM(u) AS u_total,
         COALESCE(SUM(u) FILTER (WHERE dia < (SELECT corte FROM fechas2)), 0) AS u_ayer,
         MIN(dia) FILTER (WHERE acu >= $7) AS dia_cruce
  FROM acum
  GROUP BY 1, 2
)
SELECT r.vendedor_codigo,
       COALESCE(r.vendedor_nombre, 'Sin vendedor') AS vendedor_nombre,
       c.marca,
       to_char(c.dia_cruce, 'YYYY-MM-DD') AS dia,
       (COUNT(*) FILTER (WHERE c.u_total >= $7))::int AS hoy,
       (COUNT(*) FILTER (WHERE c.u_ayer  >= $7))::int AS ayer,
       (COUNT(*) FILTER (WHERE c.u_total > 0 AND c.u_total < $7))::int AS oport
FROM cli c
LEFT JOIN ruta r ON r.cliente_id = c.cliente_id
GROUP BY 1, 2, 3, 4;
`;

// Fecha de corte por defecto y anterior con ventas, aunque todavía no haya filas de marcas
const SQL_FECHAS = `
WITH dias AS (
  SELECT DISTINCT COALESCE(v.fecha_carga, v.fecha_creacion, v.fecha_comprobante)::date AS dia
  FROM venta v
  WHERE v.tenant_id = $1
    AND v.fecha_entrega >= $2::date AND v.fecha_entrega < $3::date
    AND (v.tipo_comprobante_codigo ILIKE 'FAC%' OR v.tipo_comprobante_codigo ILIKE 'NC%')
),
f AS (SELECT COALESCE($5::date, (SELECT MAX(dia) FROM dias WHERE dia <= $4::date), $4::date) AS corte)
SELECT to_char(f.corte, 'YYYY-MM-DD') AS corte,
       to_char((SELECT MAX(dia) FROM dias WHERE dia < f.corte), 'YYYY-MM-DD') AS base,
       to_char((SELECT MIN(dia) FROM dias), 'YYYY-MM-DD') AS primero,
       to_char((SELECT MAX(dia) FROM dias), 'YYYY-MM-DD') AS ultimo
FROM f;
`;

const cacheMarcas = new Map(); // mes|fecha -> { t, data, fechas, pendiente }

function rangoMes(mes) {
    const [y, m] = mes.split('-').map(Number);
    const desde = `${y}-${String(m).padStart(2, '0')}-01`;
    const sig = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
    return { desde, hasta: sig };
}

async function obtenerMarcas(mes, fecha, forzar) {
    const clave = mes + '|' + (fecha || '');
    const c = cacheMarcas.get(clave) || {};
    if (!forzar && c.data && Date.now() - c.t < CACHE_MS) return c;
    if (c.pendiente) return c.pendiente;
    const { desde, hasta } = rangoMes(mes);
    const hoy = hoyAR();
    c.pendiente = (async () => {
        try {
            const [{ rows }, f] = await Promise.all([
                pool.query(SQL_MARCAS, [
                    TENANT, desde, hasta, hoy,
                    SUBMARCAS.map(s => s.nombre), SUBMARCAS.map(s => s.patron),
                    DROP_MINIMO, fecha || null
                ]),
                pool.query(SQL_FECHAS, [TENANT, desde, hasta, hoy, fecha || null])
            ]);
            const nuevo = { t: Date.now(), data: rows, hoy, fechas: f.rows[0] || {} };
            cacheMarcas.set(clave, nuevo);
            return nuevo;
        } finally {
            c.pendiente = null;
        }
    })();
    cacheMarcas.set(clave, c);
    return c.pendiente;
}

// =====================================================================
//  OBJETIVOS DE COBERTURA POR MARCA (se cargan desde la página, quedan en Supabase)
// =====================================================================
let tablaObjetivosLista = false;
async function asegurarTablaObjetivos() {
    if (!db) throw new Error('La base propia (Supabase) no está configurada.');
    if (tablaObjetivosLista) return;
    await db.query(`CREATE TABLE IF NOT EXISTS clientes_objetivo_marca (
        mes text NOT NULL,
        marca text NOT NULL,
        objetivo numeric NOT NULL,
        actualizado timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (mes, marca)
    )`);
    tablaObjetivosLista = true;
}

const mesValido = m => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ''));

// =====================================================================
//  RUTAS
// =====================================================================
app.get('/gestion', (req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'gestion.html'));
});
// El nombre anterior sigue funcionando (marcadores viejos)
app.get('/clientes', (req, res) => res.redirect(301, '/gestion'));

app.get('/api/seguimiento-clientes/datos', controlSupervisor, async (req, res) => {
    try {
        const filas = await obtenerClientes(req.query.refresh === '1');
        res.json({ actualizado: new Date(cacheClientes.t).toISOString(), filas });
    } catch (err) {
        console.error('❌ [clientes] Error en consulta de clientes:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/seguimiento-clientes/marcas', controlSupervisor, async (req, res) => {
    const mes = mesValido(req.query.mes) ? req.query.mes : hoyAR().slice(0, 7);
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.fecha || '')) ? req.query.fecha : null;
    try {
        const r = await obtenerMarcas(mes, fecha, req.query.refresh === '1');
        res.json({
            mes, hoy: r.hoy, drop: DROP_MINIMO,
            corte: r.fechas.corte, base: r.fechas.base, primero: r.fechas.primero, ultimo: r.fechas.ultimo,
            submarcas: SUBMARCAS.map(s => s.nombre),
            actualizado: new Date(r.t).toISOString(),
            filas: r.data
        });
    } catch (err) {
        console.error('❌ [clientes] Error en consulta de marcas:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/seguimiento-clientes/objetivos', controlSupervisor, async (req, res) => {
    const mes = mesValido(req.query.mes) ? req.query.mes : hoyAR().slice(0, 7);
    try {
        await asegurarTablaObjetivos();
        const { rows } = await db.query(`SELECT marca, objetivo::float AS objetivo FROM clientes_objetivo_marca WHERE mes = $1`, [mes]);
        const obj = {};
        rows.forEach(r => { obj[r.marca] = r.objetivo; });
        res.json({ mes, objetivos: obj });
    } catch (err) {
        res.json({ mes, objetivos: {}, aviso: err.message });
    }
});

app.post('/api/seguimiento-clientes/objetivos', controlSupervisor, async (req, res) => {
    const { mes, objetivos } = req.body || {};
    if (!mesValido(mes) || !objetivos || typeof objetivos !== 'object') {
        return res.status(400).json({ error: 'Datos inválidos' });
    }
    try {
        await asegurarTablaObjetivos();
        for (const [marca, valor] of Object.entries(objetivos)) {
            const m = String(marca).slice(0, 60);
            if (valor === null || valor === '' || !Number.isFinite(Number(valor))) {
                await db.query(`DELETE FROM clientes_objetivo_marca WHERE mes = $1 AND marca = $2`, [mes, m]);
            } else {
                const v = Math.max(0, Math.min(100, Number(valor)));
                await db.query(`INSERT INTO clientes_objetivo_marca (mes, marca, objetivo) VALUES ($1, $2, $3)
                    ON CONFLICT (mes, marca) DO UPDATE SET objetivo = EXCLUDED.objetivo, actualizado = now()`, [mes, m, v]);
            }
        }
        res.json({ exito: true });
    } catch (err) {
        console.error('❌ [clientes] Error guardando objetivos:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// =====================================================================
//  STOCK EN VIVO (pestaña "Stock"): como el Inventario de Gescom, una fila por artículo y depósito
//  (Picking, Almacenamiento, Vencidos, Roturas...). El filtrado y la suma por depósito se hacen en la página.
//  Las columnas de las tablas item y stock se descubren solas (information_schema), así que sirve
//  aunque Gescom las llame distinto. Con ?diagnostico=1 devuelve las columnas y unas filas de muestra.
// =====================================================================
const CACHE_STOCK_MS = 60 * 1000;
let metaStock = null;
let cacheStock = { t: 0, data: null, pendiente: null };

const qi = id => '"' + String(id).replace(/"/g, '""') + '"'; // el nombre sale de information_schema, no del usuario
const etiquetaCol = c => { const t = String(c).replace(/_/g, ' ').trim(); return t.charAt(0).toUpperCase() + t.slice(1); };
const NUMERICOS = /^(integer|bigint|smallint|numeric|double precision|real)$/;
const TEXTOS = /^(character varying|text|character)$/;

async function descubrirStock() {
    if (metaStock) return metaStock;
    const { rows } = await pool.query(`SELECT table_name, column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name IN ('stock', 'item') ORDER BY table_name, ordinal_position`);
    const stock = rows.filter(r => r.table_name === 'stock');
    const item = rows.filter(r => r.table_name === 'item');
    if (!stock.length) throw new Error('Gescom no tiene la tabla stock en esta conexión.');
    if (!item.length) throw new Error('Gescom no tiene la tabla item en esta conexión.');
    const sNombres = stock.map(c => c.column_name), iNombres = item.map(c => c.column_name);
    // El stock de Gescom enlaza el artículo por item_id o, si no existe, por item_codigo (lo que usa esta base)
    const enlace = sNombres.includes('item_id') && iNombres.includes('id') ? { s: 'item_id', i: 'id' }
        : (sNombres.includes('item_codigo') && iNombres.includes('codigo') ? { s: 'item_codigo', i: 'codigo' } : null);
    if (!enlace) throw new Error('No se puede enlazar stock con item (columnas de stock: ' + sNombres.join(', ') + ').');

    // Cantidades del stock: cada columna numérica que no es un id. Se reconoce si es cantidad, disponible o reserva, en bultos o en unidades
    const cantidades = stock.filter(c => NUMERICOS.test(c.data_type) && !/(^|_)id$|tenant|^orden$|factor|sede|sector|codigo/i.test(c.column_name)).map(c => {
        const n = c.column_name;
        return { nombre: n, rol: /disponible/i.test(n) ? 'disp' : /reserv/i.test(n) ? 'reserva' : 'cant', tipo: /bulto/i.test(n) ? 'bultos' : /unidad/i.test(n) ? 'unidades' : 'unica' };
    });
    // Gescom guarda "cantidad" (bultos) y "unidades" (sueltas) como dos columnas
    if (cantidades.some(c => c.nombre === 'cantidad') && cantidades.some(c => c.nombre === 'unidades')) {
        cantidades.find(c => c.nombre === 'cantidad').tipo = 'bultos';
        cantidades.find(c => c.nombre === 'unidades').tipo = 'unidades';
    }
    // Clasificaciones del artículo (rubro, subrubro, marca...): texto, sin ids ni códigos
    const clasif = item.filter(c => TEXTOS.test(c.data_type) && /rubro|marca|familia|categoria|linea|clasific|grupo|segmento/i.test(c.column_name)
        && !/(_id|_codigo|_cod|codigo_)$/i.test(c.column_name)).map(c => c.column_name)
        .sort((x, y) => (/_desc$/i.test(y) ? 1 : 0) - (/_desc$/i.test(x) ? 1 : 0)).filter((c, _, todas) => !todas.some(o => /_desc$/i.test(o)) || /_desc$/i.test(c));
    const textoDep = stock.filter(c => /deposito/i.test(c.column_name) && TEXTOS.test(c.data_type));
    const unidadStock = stock.find(c => TEXTOS.test(c.data_type) && /unidad|presentacion/i.test(c.column_name) && !/(_id|_codigo)$/i.test(c.column_name));
    const unidadItem = item.find(c => TEXTOS.test(c.data_type) && /unidad|presentacion/i.test(c.column_name) && !/(_id|_codigo)$/i.test(c.column_name));
    metaStock = {
        sNombres, iNombres, cantidades, clasif, enlace,
        descStock: sNombres.includes('item_descripcion') ? 'item_descripcion' : null,
        dep: (textoDep.find(c => /desc|nombre/i.test(c.column_name)) || textoDep[0] || {}).column_name || null,
        unidad: unidadStock ? { tabla: 's', col: unidadStock.column_name } : (unidadItem ? { tabla: 'i', col: unidadItem.column_name } : null),
        fecha: stock.find(c => /^fecha/i.test(c.column_name) && /date|timestamp/.test(c.data_type)) || null,
        actual: stock.find(c => c.column_name === 'actual') || null,
        activoItem: item.find(c => c.column_name === 'activo') || null,
        tenantStock: sNombres.includes('tenant_id'), tenantItem: iNombres.includes('tenant_id'),
        codigo: iNombres.includes('codigo') ? 'codigo' : null,
        descripcion: iNombres.includes('descripcion') ? 'descripcion' : (iNombres.find(c => /desc|nombre/i.test(c)) || null)
    };
    return metaStock;
}

async function obtenerStock(forzar) {
    if (!forzar && cacheStock.data && Date.now() - cacheStock.t < CACHE_STOCK_MS) return cacheStock.data;
    if (cacheStock.pendiente) return cacheStock.pendiente;
    cacheStock.pendiente = (async () => {
        try {
            const m = await descubrirStock();
            if (!m.cantidades.length) throw new Error('La tabla stock no tiene columnas de cantidad (columnas: ' + m.sNombres.join(', ') + ').');
            const sel = [m.enlace.s === 'item_codigo' ? `s.item_codigo::text AS codigo` : (m.codigo ? `i.${qi(m.codigo)}::text AS codigo` : `i.id::text AS codigo`),
                         m.descStock ? `s.${qi(m.descStock)} AS descripcion` : (m.descripcion ? `i.${qi(m.descripcion)} AS descripcion` : `i.id::text AS descripcion`),
                         m.dep ? `s.${qi(m.dep)} AS deposito` : `'Todos'::text AS deposito`,
                         m.unidad ? `${m.unidad.tabla === 's' ? 's' : 'i'}.${qi(m.unidad.col)} AS unidad` : `NULL::text AS unidad`];
            m.clasif.forEach((c, k) => sel.push(`i.${qi(c)} AS ${qi('c' + k)}`));
            m.cantidades.forEach((c, k) => sel.push(`COALESCE(s.${qi(c.nombre)}, 0)::float8 AS ${qi('n' + k)}`));
            const where = [];
            const params = [];
            if (m.tenantStock) { params.push(TENANT); where.push(`s.tenant_id = $${params.length}`); }
            else if (m.tenantItem) { params.push(TENANT); where.push(`i.tenant_id = $${params.length}`); }
            if (m.actual) where.push(`s.${qi('actual')} = true`);
            else if (m.fecha) where.push(`s.${qi(m.fecha.column_name)} = (SELECT MAX(x.${qi(m.fecha.column_name)}) FROM stock x${m.tenantStock && m.tenantItem ? ' WHERE x.tenant_id = $1' : ''})`);
            if (m.activoItem) where.push(`COALESCE(i.activo::int, 1) = 1`);
            const sql = `/*STOCK*/ SELECT ${sel.join(', ')} FROM stock s LEFT JOIN item i ON i.${qi(m.enlace.i)} = s.${qi(m.enlace.s)}${m.tenantStock && m.tenantItem ? ' AND s.tenant_id = i.tenant_id' : ''}
                ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY 2, 3 LIMIT 30000`;
            const { rows } = await pool.query(sql, params);
            const datos = {
                actualizado: new Date().toISOString(),
                clasif: m.clasif.map((c, k) => ({ clave: 'c' + k, etiqueta: etiquetaCol(c.replace(/_desc(ripcion)?$/i, '')) })),
                cantidades: m.cantidades.map((c, k) => ({ clave: 'n' + k, nombre: c.nombre, etiqueta: etiquetaCol(c.nombre), rol: c.rol, tipo: c.tipo })),
                filas: rows.map(r => {
                    const f = { codigo: r.codigo, descripcion: r.descripcion, deposito: r.deposito == null ? '' : String(r.deposito).trim(), unidad: r.unidad == null ? '' : String(r.unidad).trim() };
                    m.clasif.forEach((c, k) => { f['c' + k] = r['c' + k] == null ? '' : String(r['c' + k]).trim(); });
                    m.cantidades.forEach((c, k) => { f['n' + k] = r['n' + k]; });
                    return f;
                })
            };
            cacheStock.data = datos;
            cacheStock.t = Date.now();
            return datos;
        } finally {
            cacheStock.pendiente = null;
        }
    })();
    return cacheStock.pendiente;
}

app.get('/api/seguimiento-clientes/stock', controlSupervisor, async (req, res) => {
    try {
        if (req.query.diagnostico === '1') {
            const m = await descubrirStock();
            const muestra = await pool.query(`SELECT * FROM stock LIMIT 3`);
            return res.json({ meta: m, muestra_stock: muestra.rows });
        }
        res.json(await obtenerStock(req.query.refresh === '1'));
    } catch (err) {
        console.error('❌ [clientes] Error en consulta de stock:', err.message);
        res.status(500).json({ error: err.message });
    }
});


// =====================================================================
//  ACCESO: la página pregunta qué perfil sos y este pedido valida el código
// =====================================================================
app.get('/api/acceso/verificar', controlPin, async (req, res) => {
    const rol = String(req.query.rol || '');
    if (rol === 'supervisor') {
        if (String(req.get('x-sup') || '').trim() !== leerPinSupervisor()) return res.status(403).json({ error: 'Código de supervisor incorrecto' });
        return res.json({ ok: true, rol });
    }
    if (rol === 'encargado') {
        if (String(req.get('x-enc') || '').trim() !== leerPinEncargado()) return res.status(403).json({ error: 'Código de encargado incorrecto' });
        return res.json({ ok: true, rol });
    }
    if (rol === 'administracion') {
        if (String(req.get('x-adm') || '').trim() !== leerPinAdm()) return res.status(403).json({ error: 'Código de administración incorrecto' });
        return res.json({ ok: true, rol });
    }
    if (rol === 'bodeguista') {
        if (String(req.get('x-bod') || '').trim() !== leerPinBodeguista()) return res.status(403).json({ error: 'Código de bodeguista incorrecto' });
        return res.json({ ok: true, rol });
    }
    if (rol === 'vendedor') {
        const cod = sinCeros(req.get('x-vendedor'));
        if (!cod || !codigosVendedores().some(c => sinCeros(c) === cod)) return res.status(403).json({ error: 'Ese código de vendedor no existe' });
        let nombre = '';
        try { nombre = (await nombreVendedor(cod)) || ''; } catch (e) { /* solo informativo */ }
        return res.json({ ok: true, rol, codigo: cod, nombre });
    }
    res.json({ ok: true });
});

// =====================================================================
//  RUTEO DEL VENDEDOR: ordena su recorrido (arrastrar y soltar). Queda guardado en Supabase y se baja a Excel.
//  Gescom NO se toca: el Excel sirve para cargar el orden allá.
// =====================================================================
const DIAS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'];
const DIA_ETIQ = { lunes: 'Lunes', martes: 'Martes', miercoles: 'Miércoles', jueves: 'Jueves', viernes: 'Viernes', sabado: 'Sábado', domingo: 'Domingo' };
const MAX_RUTA = 1500;

let tablaRutaLista = false;
async function asegurarTablaRuta() {
    if (!db) throw new Error('La base propia (Supabase) no está configurada.');
    if (tablaRutaLista) return;
    await db.query(`CREATE TABLE IF NOT EXISTS clientes_orden_vendedor (
        vendedor text NOT NULL,
        dia text NOT NULL,
        ruta text NOT NULL DEFAULT '',
        cliente_id text NOT NULL,
        cliente_codigo text,
        orden int NOT NULL,
        actualizado timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (vendedor, dia, ruta, cliente_id)
    )`);
    // Versión anterior (sin zona): se agrega la columna y la clave nueva. Lo guardado antes era de prueba y se descarta.
    const col = await db.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'clientes_orden_vendedor' AND column_name = 'ruta'`);
    if (!col.rows.length) {
        await db.query(`DELETE FROM clientes_orden_vendedor`);
        await db.query(`ALTER TABLE clientes_orden_vendedor ADD COLUMN ruta text NOT NULL DEFAULT ''`);
        await db.query(`ALTER TABLE clientes_orden_vendedor DROP CONSTRAINT IF EXISTS clientes_orden_vendedor_pkey`);
        await db.query(`ALTER TABLE clientes_orden_vendedor ADD PRIMARY KEY (vendedor, dia, ruta, cliente_id)`);
    }
    tablaRutaLista = true;
}

async function nombreVendedor(cod) {
    const r = await pool.query(`SELECT MAX(vendedor_nombre) AS n FROM cliente_ruta_hist
        WHERE actual = true AND tenant_id = $1 AND ltrim(vendedor_codigo::text, '0') = $2`, [TENANT, sinCeros(cod)]);
    return r.rows[0] && r.rows[0].n;
}

// Nombre de la zona, si cliente_ruta_hist lo trae (ruta_descripcion, ruta_nombre...)
let colNombreRuta;
async function columnaNombreRuta() {
    if (colNombreRuta !== undefined) return colNombreRuta;
    try {
        const r = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'cliente_ruta_hist' AND column_name ~ '^ruta_(desc|nombre)' ORDER BY column_name LIMIT 1`);
        colNombreRuta = r.rows[0] ? r.rows[0].column_name : null;
    } catch (e) { colNombreRuta = null; }
    return colNombreRuta;
}

// Clientes del vendedor (opcionalmente solo de un día), con su zona y el orden que tienen hoy en Gescom
async function clientesDelVendedor(cod, dia) {
    const filtro = dia ? ` AND rh.${dia} = 1` : '';
    const cn = await columnaNombreRuta();
    const r = await pool.query(`
        SELECT DISTINCT ON (rh.cliente_id) rh.cliente_id::text AS id, c.codigo::text AS codigo,
               COALESCE(rh.ruta_codigo::text, '') AS ruta, ${cn ? `rh.${cn}::text` : `NULL::text`} AS ruta_nombre,
               COALESCE(NULLIF(c.nombre, ''), c.razon_social) AS nombre, c.direccion, c.localidad, rh.orden::int AS orden,
               ${DIAS.map(d => `COALESCE(rh.${d}, 0)::int AS ${d}`).join(', ')}
        FROM cliente_ruta_hist rh
        JOIN cliente_hist c ON c.id = rh.cliente_id AND c.actual = true AND COALESCE(c.activo, true) = true
        WHERE rh.actual = true AND rh.tenant_id = $1 AND ltrim(rh.vendedor_codigo::text, '0') = $2${filtro}
        ORDER BY rh.cliente_id, (rh.fuerza_venta = 'Principal') DESC NULLS LAST
        LIMIT ${MAX_RUTA}`, [TENANT, sinCeros(cod)]);
    return r.rows.map(f => ({
        id: f.id, ruta: f.ruta || '', ruta_nombre: f.ruta_nombre || '', codigo: f.codigo || '', nombre: f.nombre || '', direccion: f.direccion || '', localidad: f.localidad || '',
        orden: f.orden == null || f.orden <= 0 ? null : f.orden,
        dias: DIAS.filter(d => f[d] === 1)
    }));
}

// Orden de Gescom: primero los que tienen número (de menor a mayor), después los que no tienen
const ordenGescom = (a, b) => ((a.orden == null) - (b.orden == null)) || ((a.orden || 0) - (b.orden || 0)) || a.nombre.localeCompare(b.nombre, 'es');

// Aplica el orden guardado por el vendedor (si hay) sobre los clientes de un día
async function rutaDelDia(cod, dia, ruta, todos) {
    const lista = (todos || await clientesDelVendedor(cod, dia)).filter(c => c.dias.includes(dia) && c.ruta === ruta).sort(ordenGescom);
    lista.forEach((c, i) => { c.posGescom = i + 1; });
    let guardado = null;
    try {
        await asegurarTablaRuta();
        const g = await db.query(`SELECT cliente_id, orden, actualizado FROM clientes_orden_vendedor WHERE vendedor = $1 AND dia = $2 AND ruta = $3`, [sinCeros(cod), dia, ruta]);
        if (g.rows.length) {
            const pos = new Map(g.rows.map(f => [f.cliente_id, f.orden]));
            guardado = g.rows.reduce((m, f) => (!m || f.actualizado > m ? f.actualizado : m), null);
            lista.forEach(c => { c.nuevo = !pos.has(c.id); });
            lista.sort((a, b) => ((a.nuevo ? 1 : 0) - (b.nuevo ? 1 : 0)) || ((pos.get(a.id) || 0) - (pos.get(b.id) || 0)) || ordenGescom(a, b));
        }
    } catch (e) { console.error('⚠️ [clientes] Leyendo orden guardado:', e.message); }
    return { lista, guardado };
}

app.get('/api/vendedor/ruta', controlVendedor, async (req, res) => {
    try {
        const cod = req.vendedor;
        const todos = await clientesDelVendedor(cod);
        const dias = DIAS.map(d => ({ dia: d, etiqueta: DIA_ETIQ[d], clientes: todos.filter(c => c.dias.includes(d)).length }));
        let dia = String(req.query.dia || '').toLowerCase();
        if (!DIAS.includes(dia)) {
            const hoy = { Monday: 'lunes', Tuesday: 'martes', Wednesday: 'miercoles', Thursday: 'jueves', Friday: 'viernes', Saturday: 'sabado', Sunday: 'domingo' }[
                new Date().toLocaleDateString('en-US', { timeZone: 'America/Argentina/Buenos_Aires', weekday: 'long' })];
            dia = ((dias.find(d => d.dia === hoy && d.clientes > 0)) || dias.find(d => d.clientes > 0) || dias[0]).dia;
        }
        // Zonas de ese día (un día puede tener más de una, por ejemplo zonas quincenales que se alternan)
        const mapaZ = new Map();
        todos.filter(c => c.dias.includes(dia)).forEach(c => {
            const z = mapaZ.get(c.ruta) || { ruta: c.ruta, nombre: c.ruta_nombre, clientes: 0 };
            z.clientes++; if (!z.nombre && c.ruta_nombre) z.nombre = c.ruta_nombre; mapaZ.set(c.ruta, z);
        });
        const zonas = [...mapaZ.values()].sort((a, b) => String(a.ruta).localeCompare(String(b.ruta), 'es', { numeric: true }));
        let ruta = req.query.ruta == null ? null : String(req.query.ruta);
        if (ruta === null || !mapaZ.has(ruta)) ruta = zonas.length ? zonas[0].ruta : '';
        const { lista, guardado } = await rutaDelDia(cod, dia, ruta, todos);
        res.json({ vendedor: { codigo: cod, nombre: (await nombreVendedor(cod)) || '' }, dias, dia, zonas, ruta, guardado, clientes: lista });
    } catch (err) {
        console.error('❌ [clientes] Ruta del vendedor:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/vendedor/ruta', controlVendedor, async (req, res) => {
    let cli;
    try {
        const dia = String((req.body || {}).dia || '').toLowerCase();
        const ruta = String((req.body || {}).ruta == null ? '' : req.body.ruta);
        const ids = Array.isArray((req.body || {}).ids) ? req.body.ids.map(String) : [];
        if (!DIAS.includes(dia) || !ids.length || ids.length > MAX_RUTA) return res.status(400).json({ error: 'Datos inválidos' });
        // Solo se aceptan clientes que de verdad están en la ruta de ese vendedor ese día
        const validos = new Map((await clientesDelVendedor(req.vendedor, dia)).filter(c => c.ruta === ruta).map(c => [c.id, c]));
        const filtrados = [...new Set(ids)].filter(id => validos.has(id));
        if (!filtrados.length) return res.status(400).json({ error: 'Ningún cliente válido' });
        await asegurarTablaRuta();
        cli = await db.connect();
        await cli.query('BEGIN');
        await cli.query(`DELETE FROM clientes_orden_vendedor WHERE vendedor = $1 AND dia = $2 AND ruta = $3`, [sinCeros(req.vendedor), dia, ruta]);
        await cli.query(`INSERT INTO clientes_orden_vendedor (vendedor, dia, ruta, cliente_id, cliente_codigo, orden)
            SELECT $1, $2, $3, x.id, x.cod, x.ord FROM unnest($4::text[], $5::text[], $6::int[]) AS x(id, cod, ord)`,
            [sinCeros(req.vendedor), dia, ruta, filtrados, filtrados.map(id => validos.get(id).codigo), filtrados.map((_, i) => i + 1)]);
        await cli.query('COMMIT');
        res.json({ exito: true, guardados: filtrados.length });
    } catch (err) {
        if (cli) { try { await cli.query('ROLLBACK'); } catch (e) { /* ya cerrada */ } }
        console.error('❌ [clientes] Guardando ruta del vendedor:', err.message);
        res.status(500).json({ error: err.message });
    } finally {
        if (cli) cli.release();
    }
});

app.delete('/api/vendedor/ruta', controlVendedor, async (req, res) => {
    try {
        const dia = String(req.query.dia || '').toLowerCase();
        if (!DIAS.includes(dia)) return res.status(400).json({ error: 'Día inválido' });
        await asegurarTablaRuta();
        await db.query(`DELETE FROM clientes_orden_vendedor WHERE vendedor = $1 AND dia = $2 AND ruta = $3`, [sinCeros(req.vendedor), dia, String(req.query.ruta || '')]);
        res.json({ exito: true });
    } catch (err) {
        console.error('❌ [clientes] Restaurando ruta del vendedor:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Excel con la ruta de uno o varios vendedores (todos los días, con el orden guardado o, si no hay, el de Gescom)
async function excelRuteo(codigos) {
    const cabecera = ['Cód. vendedor', 'Vendedor', 'Día', 'Zona', 'Orden nuevo', 'Orden en Gescom', 'Cód. cliente', 'Cliente', 'Dirección', 'Localidad', 'Cambió de lugar'];
    const filas = [cabecera];
    const cambios = [cabecera];
    for (const cod of codigos) {
        const nombre = (await nombreVendedor(cod)) || '';
        const todos = await clientesDelVendedor(cod);
        for (const dia of DIAS) {
            const zonas = [...new Set(todos.filter(c => c.dias.includes(dia)).map(c => c.ruta))].sort((a, b) => String(a).localeCompare(String(b), 'es', { numeric: true }));
            for (const zona of zonas) {
              const { lista } = await rutaDelDia(cod, dia, zona, todos.map(c => ({ ...c })));
              lista.forEach((c, i) => {
                const cambio = c.posGescom !== i + 1;
                const fila = [sinCeros(cod), nombre, DIA_ETIQ[dia], (c.ruta_nombre ? c.ruta + ' - ' + c.ruta_nombre : c.ruta), i + 1, c.posGescom, c.codigo, c.nombre, c.direccion, c.localidad, cambio ? 'Sí' : 'No'];
                filas.push(fila);
                if (cambio) cambios.push(fila);
              });
            }
        }
    }
    const anchos = [12, 24, 12, 18, 11, 14, 12, 36, 30, 18, 12];
    return crearXlsx([{ nombre: 'Ruta completa', filas, anchos }, { nombre: 'Solo lo que cambió', filas: cambios, anchos }]);
}

app.get('/api/vendedor/excel', controlVendedor, async (req, res) => {
    try {
        enviarXlsx(res, `ruta_vendedor_${req.vendedor}_${hoyAR()}.xlsx`, await excelRuteo([req.vendedor]));
    } catch (err) {
        console.error('❌ [clientes] Excel de ruta:', err.message);
        res.status(500).json({ error: 'No se pudo generar el Excel' });
    }
});

// Supervisor: quién ya ordenó su ruta y descarga del Excel (de uno o de todos)
app.get('/api/seguimiento-clientes/ruteo/resumen', controlSupervisor, async (req, res) => {
    try {
        await asegurarTablaRuta();
        const g = await db.query(`SELECT vendedor, COUNT(DISTINCT dia || '|' || ruta)::int AS dias, COUNT(*)::int AS clientes, MAX(actualizado) AS ultima FROM clientes_orden_vendedor GROUP BY vendedor`);
        const guardado = new Map(g.rows.map(f => [f.vendedor, f]));
        const filas = [];
        for (const cod of codigosVendedores()) {
            const todos = await clientesDelVendedor(cod);
            const x = guardado.get(sinCeros(cod)) || {};
            filas.push({ codigo: cod, nombre: (await nombreVendedor(cod)) || '', clientes: todos.length,
                diasConRuta: new Set(todos.flatMap(c => c.dias.map(d => d + '|' + c.ruta))).size,
                diasOrdenados: x.dias || 0, ultima: x.ultima || null });
        }
        res.json({ filas });
    } catch (err) {
        console.error('❌ [clientes] Resumen de ruteo:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/seguimiento-clientes/ruteo/excel', controlSupervisor, async (req, res) => {
    try {
        const v = String(req.query.vendedor || 'todos');
        const lista = v === 'todos' ? codigosVendedores() : codigosVendedores().filter(c => sinCeros(c) === sinCeros(v));
        if (!lista.length) return res.status(400).json({ error: 'Vendedor inválido' });
        enviarXlsx(res, `ruteo_${v === 'todos' ? 'vendedores' : 'vendedor_' + sinCeros(v)}_${hoyAR()}.xlsx`, await excelRuteo(lista));
    } catch (err) {
        console.error('❌ [clientes] Excel de ruteo:', err.message);
        res.status(500).json({ error: 'No se pudo generar el Excel' });
    }
});


// =====================================================================
//  COMBOS PEHUAMAR: seguimiento de los clientes elegidos por Pepsico (lista en server/datos/combos-clientes.json)
//  Se leen de Gescom las ventas con combo (venta_item.combo_codigo / combo_desc / combo_cantidad) SOLO de esos clientes.
//  Un combo vendido = un combo por comprobante (la cantidad del combo se repite en cada línea de ese comprobante).
//  Cuentan facturas (FAC) y pedidos todavía sin facturar (VEN), igual que el reporte de bajada de combos de Gescom.
//   COMBOS_DESDE        fecha desde la que se mira (por defecto 2026-09-01)
//   COMBOS_SEGUIMIENTO  combos que se marcan por defecto en la pantalla (por defecto 450010021,450010016)
// =====================================================================
const _fsCombos = require('fs');
const _pathCombos = require('path');
const { filtroAnuladas } = require('./deposito.js');
let listaCombos = null;
function leerListaCombos() {
    if (!listaCombos) listaCombos = JSON.parse(_fsCombos.readFileSync(_pathCombos.join(__dirname, '..', 'datos', 'combos-clientes.json'), 'utf8'));
    return listaCombos;
}
let cacheCombos = { t: 0, data: null };
// Gescom no siempre guarda el nombre del combo en la venta: se completa con los nombres del reporte de bajada de combos
function nombresCombos() {
    try { return JSON.parse(_fsCombos.readFileSync(_pathCombos.join(__dirname, '..', 'datos', 'combos-nombres.json'), 'utf8')); } catch (e) { return {}; }
}

async function obtenerCombos(forzar) {
    if (!forzar && cacheCombos.data && Date.now() - cacheCombos.t < 5 * 60 * 1000) return cacheCombos.data;
    const lista = leerListaCombos();
    const desde = /^\d{4}-\d{2}-\d{2}$/.test(process.env.COMBOS_DESDE || '') ? process.env.COMBOS_DESDE : '2026-09-01';
    const filtro = await filtroAnuladas();
    const r = await pool.query(`
        SELECT c.codigo::text AS cliente,
               to_char(COALESCE(v.fecha_comprobante, v.fecha_entrega), 'YYYY-MM-DD') AS fecha,
               vi.combo_codigo::text AS combo, MAX(vi.combo_desc) AS combo_desc,
               COALESCE(MAX(vi.combo_cantidad), 1) AS cantidad,
               v.tipo_comprobante_codigo AS tipo, v.punto_venta_codigo::text AS pv, v.numero_comprobante::text AS numero
        FROM venta v
        JOIN venta_item vi ON vi.venta_id = v.id AND vi.tenant_id = v.tenant_id
        JOIN cliente_hist c ON c.id = v.cliente_id AND c.tenant_id = v.tenant_id AND c.actual = true
        WHERE v.tenant_id = $1
          AND COALESCE(vi.combo_codigo, '') <> ''
          AND (v.tipo_comprobante_codigo ILIKE 'FAC%' OR v.tipo_comprobante_codigo = 'VEN')
          AND COALESCE(v.fecha_comprobante, v.fecha_entrega)::date >= $2::date
          AND c.codigo::text = ANY($3::text[])${filtro}
        GROUP BY v.id, c.codigo, COALESCE(v.fecha_comprobante, v.fecha_entrega), vi.combo_codigo,
                 v.tipo_comprobante_codigo, v.punto_venta_codigo, v.numero_comprobante
        ORDER BY 2, 1`, [TENANT, desde, lista.map(x => x.c)]);
    // Gescom guarda el combo en la venta recién desde cierta fecha (fines de octubre). Antes de esa fecha los combos salen del
    // reporte de bajada de combos de Gescom cargado en server/datos/combos-historico.json (solo comprobantes de los clientes del listado).
    const mn = await pool.query(`SELECT to_char(MIN(COALESCE(v.fecha_comprobante, v.fecha_entrega)), 'YYYY-MM-DD') AS corte
        FROM venta v JOIN venta_item vi ON vi.venta_id = v.id AND vi.tenant_id = v.tenant_id
        WHERE v.tenant_id = $1 AND COALESCE(vi.combo_codigo, '') <> '' AND COALESCE(v.fecha_comprobante, v.fecha_entrega)::date >= $2::date`, [TENANT, desde]);
    const corte = (mn.rows[0] && mn.rows[0].corte) || null;
    let historico = [];
    try {
        historico = JSON.parse(_fsCombos.readFileSync(_pathCombos.join(__dirname, '..', 'datos', 'combos-historico.json'), 'utf8'))
            .filter(x => x.f >= desde && (!corte || x.f < corte));
    } catch (e) { console.error('⚠️ [clientes] Histórico de combos:', e.message); }
    const nom = await pool.query(`SELECT ltrim(vendedor_codigo::text, '0') AS cod, MAX(vendedor_nombre) AS nombre
        FROM cliente_ruta_hist WHERE actual = true AND tenant_id = $1 AND ltrim(vendedor_codigo::text, '0') = ANY($2::text[]) GROUP BY 1`,
        [TENANT, [...new Set(lista.map(x => sinCeros(x.v)))]]);
    const data = {
        actualizado: new Date().toISOString(),
        desde,
        porDefecto: String(process.env.COMBOS_SEGUIMIENTO || '450010021,450010016').split(',').map(x => x.trim()).filter(Boolean),
        nombres: nombresCombos(),
        vendedores: Object.fromEntries(nom.rows.map(f => [f.cod, f.nombre || ''])),
        clientes: lista,
        corte,
        compras: [...historico.map(x => ({ c: x.c, f: x.f, k: x.k, kd: '', n: x.n, cp: x.cp })), ...r.rows.map(f => ({
            c: f.cliente, f: f.fecha, k: f.combo, kd: f.combo_desc || '', n: Number(f.cantidad) || 1,
            cp: [f.tipo, f.pv, f.numero].filter(Boolean).join(' ')
        }))]
    };
    cacheCombos = { t: Date.now(), data };
    return data;
}

app.get('/api/seguimiento-clientes/combos', controlSupervisor, async (req, res) => {
    try {
        res.json(await obtenerCombos(req.query.refresh === '1'));
    } catch (err) {
        console.error('❌ [clientes] Combos:', err.message);
        res.status(500).json({ error: err.message });
    }
});


// =====================================================================
//  DEPÓSITO · cartelera de indicadores por bodeguista (reemplaza el Excel hecho a mano)
//  - Unidades y pedidos: ventas preparadas (fecha_preparacion) con artículos del proveedor 100 (PEPSICO).
//  - Errores: líneas de notas de crédito con motivo de error de armado; cuentan en el día de ARMADO del pedido original
//    y para el preparador que lo armó (no el día en que vuelve la NC).
//  - Minutos: no están en Gescom; se cargan en la web (tandas) y se guardan en la base propia.
//  Gescom es de solo lectura: acá solo se consulta.
// =====================================================================
const DEP_PROVEEDOR = String(process.env.DEPOSITO_PROVEEDOR || '100').trim();
const DEP_BODEGUISTAS = String(process.env.DEPOSITO_BODEGUISTAS || 'CAMPILLAY,BULACIO,BARRERA,ODARDA,MENNA')
    .split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
const DEP_MOTIVOS = String(process.env.DEPOSITO_MOTIVOS ||
    'No se cargó producto|Error de Armado: Diferencia de unidades|Error de Armado: Codigo cambiado')
    .split('|').map(x => x.trim()).filter(Boolean);
const sinAcentos = t => String(t == null ? '' : t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const DEP_MOTIVOS_N = new Set(DEP_MOTIVOS.map(sinAcentos));
const claveBod = nombre => String(nombre || '').trim().split(/\s+/)[0].toUpperCase();
const cacheDeposito = new Map();
// Incentivo mensual (hoja Resumen del Excel): premio base por bodeguista y escalas de alcance
const DEP_INCENTIVO = {
    base: Number(process.env.DEPOSITO_PREMIO_BASE || 65832),
    minUxh: 600, maxErr: 0.4, errExtra: 0.1, pesoErr: 0.6, pesoUxh: 0.4,
    escalaUxh: [[0,0],[550,0.05],[600,0.15],[650,0.2],[700,0.3],[750,0.35],[800,0.45],[850,0.5],[900,0.75],[950,0.85],[1000,1]],
    escalaErr: [[0,1.5],[0.02,1.45],[0.04,1.4],[0.06,1.35],[0.08,1.3],[0.1,1.25],[0.12,1.2],[0.14,1.15],[0.16,1.1],[0.18,1.05],[0.2,1],
        [0.22,0.9],[0.24,0.8],[0.26,0.7],[0.28,0.6],[0.3,0.5],[0.32,0.4],[0.34,0.3],[0.36,0.2],[0.38,0.1],[0.4,0]]
};

async function asegurarTablaMinutos() {
    if (!db) throw new Error('Sin base propia (DATABASE_URL): no se pueden guardar los minutos');
    await db.query(`CREATE TABLE IF NOT EXISTS deposito_minutos (
        fecha date NOT NULL, bodeguista text NOT NULL,
        ini1 text, fin1 text, ini2 text, fin2 text,
        descuento integer NOT NULL DEFAULT 0, minutos integer NOT NULL DEFAULT 0,
        actualizado timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (fecha, bodeguista))`);
}

async function asegurarTablaGescomMin() {
    if (!db) throw new Error('Sin base propia (DATABASE_URL): no se pueden guardar los minutos');
    await db.query(`CREATE TABLE IF NOT EXISTS deposito_gescom (
        fecha date NOT NULL, bodeguista text NOT NULL, minutos integer NOT NULL DEFAULT 0,
        importado timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (fecha, bodeguista))`);
}

async function asegurarTablasErrores() {
    if (!db) throw new Error('Sin base propia (DATABASE_URL): no se pueden guardar los ajustes');
    await db.query(`CREATE TABLE IF NOT EXISTS deposito_error_excluir (
        linea text PRIMARY KEY, nc text, nota text, actualizado timestamptz NOT NULL DEFAULT now())`);
    await db.query(`CREATE TABLE IF NOT EXISTS deposito_errores_ajuste (
        fecha date NOT NULL, bodeguista text NOT NULL, errores integer NOT NULL DEFAULT 0,
        actualizado timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (fecha, bodeguista))`);
}

async function obtenerDeposito(mes, forzar) {
    const c = cacheDeposito.get(mes);
    if (!forzar && c && Date.now() - c.t < 2 * 60 * 1000) return c.data;
    const [a, m] = mes.split('-').map(Number);
    const desde = `${mes}-01`;
    const hasta = m === 12 ? `${a + 1}-01-01` : `${a}-${String(m + 1).padStart(2, '0')}-01`;

    const pick = await pool.query(`
        SELECT to_char(v.fecha_preparacion::date, 'YYYY-MM-DD') AS f, v.empleado_preparador_nombre AS prep,
               COUNT(DISTINCT v.id)::int AS pedidos, COALESCE(SUM(vi.cantidad), 0)::float AS unid
        FROM venta v
        JOIN venta_item vi ON vi.venta_id = v.id AND vi.tenant_id = v.tenant_id
        JOIN item i ON i.codigo = vi.item_codigo AND i.tenant_id = v.tenant_id
        WHERE v.tenant_id = $1 AND i.prov_codigo = $2
          AND v.fecha_preparacion >= $3::date AND v.fecha_preparacion < $4::date
          AND v.tipo_comprobante_codigo IN ('VEN','FAC-A','FAC-B')
        GROUP BY 1, 2 ORDER BY 1, 2`, [TENANT, DEP_PROVEEDOR, desde, hasta]);

    const err = await pool.query(`
        SELECT to_char(o.fecha_preparacion::date, 'YYYY-MM-DD') AS f,
               COALESCE(o.empleado_preparador_nombre, n.empleado_preparador_nombre) AS prep,
               n.motivo_rechazo_desc AS motivo,
               n.tipo_comprobante_codigo AS tipo, n.punto_venta_codigo::text AS pv, n.numero_comprobante::text AS numero,
               o.numero_comprobante::text AS orig, n.razon_social AS cliente,
               i.descripcion AS articulo, ABS(vi.cantidad)::float AS cant,
               to_char(n.fecha_comprobante::date, 'YYYY-MM-DD') AS fnc, n.reparto_codigo::text AS reparto,
               (n.id::text || '|' || vi.item_codigo::text) AS linea
        FROM venta n
        JOIN venta o ON o.id = n.venta_referenciada_id AND o.tenant_id = n.tenant_id
        JOIN venta_item vi ON vi.venta_id = n.id AND vi.tenant_id = n.tenant_id
        JOIN item i ON i.codigo = vi.item_codigo AND i.tenant_id = n.tenant_id AND i.prov_codigo = $4
        WHERE n.tenant_id = $1 AND n.tipo_comprobante_codigo LIKE 'NCR%'
          AND COALESCE(n.motivo_rechazo_desc, '') <> ''
          AND o.fecha_preparacion >= $2::date AND o.fecha_preparacion < $3::date
        ORDER BY 1, 2, n.numero_comprobante`, [TENANT, desde, hasta, DEP_PROVEEDOR]);

    const seguir = new Set(DEP_BODEGUISTAS);
    const otros = new Set();
    const dias = pick.rows.filter(r => {
        const k = claveBod(r.prep);
        if (!seguir.has(k)) { if (k) otros.add(k); return false; }
        return true;
    }).map(r => ({ f: r.f, b: claveBod(r.prep), unid: r.unid, ped: r.pedidos }));

    const motivos = new Map();
    const errores = [];
    err.rows.forEach(r => {
        motivos.set(r.motivo, (motivos.get(r.motivo) || 0) + r.cant);
        if (!DEP_MOTIVOS_N.has(sinAcentos(r.motivo))) return;
        const k = claveBod(r.prep);
        if (!seguir.has(k)) return;
        errores.push({ f: r.f, b: k, cant: r.cant, motivo: r.motivo, nc: [r.tipo, r.pv, r.numero].filter(Boolean).join(' '),
            orig: r.orig, cliente: r.cliente || '', articulo: r.articulo || '', fnc: r.fnc, reparto: r.reparto || '', linea: r.linea });
    });

    let minutos = [], gescom = [], ajustes = [], avisoMin = '';
    const excluidas = new Map();
    try {
        await asegurarTablaMinutos();
        await asegurarTablaGescomMin();
        const gg = await db.query(`SELECT to_char(fecha,'YYYY-MM-DD') AS f, bodeguista AS b, minutos AS min
            FROM deposito_gescom WHERE fecha >= $1::date AND fecha < $2::date`, [desde, hasta]);
        gescom = gg.rows;
        await asegurarTablasErrores();
        (await db.query(`SELECT linea, nota FROM deposito_error_excluir`)).rows.forEach(r => excluidas.set(r.linea, r.nota || ''));
        ajustes = (await db.query(`SELECT to_char(fecha,'YYYY-MM-DD') AS f, bodeguista AS b, errores FROM deposito_errores_ajuste
            WHERE fecha >= $1::date AND fecha < $2::date`, [desde, hasta])).rows;
        const mm = await db.query(`SELECT to_char(fecha,'YYYY-MM-DD') AS f, bodeguista AS b, minutos
            FROM deposito_minutos WHERE fecha >= $1::date AND fecha < $2::date`, [desde, hasta]);
        minutos = mm.rows;
    } catch (e) { avisoMin = e.message; }

    const data = {
        actualizado: new Date().toISOString(), mes, bodeguistas: DEP_BODEGUISTAS,
        proveedor: DEP_PROVEEDOR, motivosContados: DEP_MOTIVOS,
        motivosVistos: [...motivos].map(([m, n]) => ({ m, n, cuenta: DEP_MOTIVOS_N.has(sinAcentos(m)) })).sort((x, y) => y.n - x.n),
        otros: [...otros], dias, errores: errores.map(e => ({ ...e, excl: excluidas.has(e.linea), nota: excluidas.get(e.linea) || '' })), minutos, gescom, ajustes, avisoMin,
        objetivos: { uxh: 1000, err: 0.2 },
        incentivo: DEP_INCENTIVO
    };
    cacheDeposito.set(mes, { t: Date.now(), data });
    return data;
}

app.get('/api/seguimiento-clientes/deposito', controlLectorDeposito, async (req, res) => {
    try {
        const mes = String(req.query.mes || hoyAR().slice(0, 7));
        if (!mesValido(mes)) return res.status(400).json({ error: 'Mes inválido' });
        const d = await obtenerDeposito(mes, req.query.refresh === '1' && !!req.esEncargado);
        // El bodeguista no ve el incentivo ($) de nadie
        res.json(req.esEncargado ? d : Object.assign({}, d, { incentivo: null, soloLectura: true }));
    } catch (err) {
        console.error('❌ [clientes] Depósito:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Importa el reporte "Picking Bodeguista/Fecha" de Gescom (el navegador lo lee y manda solo fecha, nombre y minutos).
// Re-importar el mismo día actualiza el valor de Gescom; las correcciones manuales no se tocan.
app.post('/api/seguimiento-clientes/deposito/importar', controlEncargado, async (req, res) => {
    try {
        const filas = Array.isArray(req.body && req.body.filas) ? req.body.filas : [];
        if (!filas.length || filas.length > 5000) return res.status(400).json({ error: 'El archivo no trae filas de "Preparados"' });
        await asegurarTablaGescomMin();
        let n = 0, desde = null, hasta = null; const ignorados = new Set();
        for (const f of filas) {
            const fecha = String(f.f || '').slice(0, 10), b = claveBod(f.nombre), min = Math.round(Number(f.min));
            if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || !(min >= 0 && min <= 1440 * 2)) continue;
            if (!DEP_BODEGUISTAS.includes(b)) { if (b) ignorados.add(b); continue; }
            await db.query(`INSERT INTO deposito_gescom (fecha, bodeguista, minutos, importado) VALUES ($1,$2,$3, now())
                ON CONFLICT (fecha, bodeguista) DO UPDATE SET minutos=$3, importado=now()`, [fecha, b, min]);
            n++; if (!desde || fecha < desde) desde = fecha; if (!hasta || fecha > hasta) hasta = fecha;
        }
        cacheDeposito.clear();
        res.json({ ok: true, cargados: n, desde, hasta, ignorados: [...ignorados] });
    } catch (err) {
        console.error('❌ [clientes] Importar minutos Gescom:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// El encargado saca (o devuelve) una línea de error: por ejemplo cuando no fue del bodeguista sino del camión.
app.post('/api/seguimiento-clientes/deposito/error-excluir', controlEncargado, async (req, res) => {
    try {
        const linea = String((req.body && req.body.linea) || '').slice(0, 100);
        if (!linea) return res.status(400).json({ error: 'Falta la línea' });
        await asegurarTablasErrores();
        if (req.body.excluir) {
            await db.query(`INSERT INTO deposito_error_excluir (linea, nc, nota, actualizado) VALUES ($1,$2,$3, now())
                ON CONFLICT (linea) DO UPDATE SET nota=$3, actualizado=now()`,
                [linea, String(req.body.nc || '').slice(0, 60), String(req.body.nota || '').slice(0, 200)]);
        } else {
            await db.query(`DELETE FROM deposito_error_excluir WHERE linea = $1`, [linea]);
        }
        cacheDeposito.clear();
        res.json({ ok: true });
    } catch (err) {
        console.error('❌ [clientes] Excluir error depósito:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/seguimiento-clientes/deposito/minutos', controlEncargado, async (req, res) => {
    try {
        const fecha = String((req.body && req.body.fecha) || '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return res.status(400).json({ error: 'Fecha inválida' });
        const filas = Array.isArray(req.body.filas) ? req.body.filas : [];
        await asegurarTablaMinutos();
        await asegurarTablasErrores();
        for (const f of filas) {
            const b = String(f.bodeguista || '').toUpperCase();
            if (!DEP_BODEGUISTAS.includes(b)) continue;
            if ('minutos' in f) {
                if (f.minutos === '' || f.minutos == null) {   // vacío = vuelve a usar el tiempo de Gescom
                    await db.query(`DELETE FROM deposito_minutos WHERE fecha = $1 AND bodeguista = $2`, [fecha, b]);
                } else {
                    const min = Math.round(Number(f.minutos));
                    if (!(min >= 0 && min <= 1440)) return res.status(400).json({ error: 'Minutos inválidos en ' + b });
                    await db.query(`INSERT INTO deposito_minutos (fecha, bodeguista, minutos, actualizado) VALUES ($1,$2,$3, now())
                        ON CONFLICT (fecha, bodeguista) DO UPDATE SET minutos=$3, actualizado=now()`, [fecha, b, min]);
                }
            }
            if ('errores' in f) {
                if (f.errores === '' || f.errores == null) {   // vacío = vuelve al cálculo automático
                    await db.query(`DELETE FROM deposito_errores_ajuste WHERE fecha = $1 AND bodeguista = $2`, [fecha, b]);
                } else {
                    const er = Math.round(Number(f.errores));
                    if (!(er >= 0 && er <= 100000)) return res.status(400).json({ error: 'Errores inválidos en ' + b });
                    await db.query(`INSERT INTO deposito_errores_ajuste (fecha, bodeguista, errores, actualizado) VALUES ($1,$2,$3, now())
                        ON CONFLICT (fecha, bodeguista) DO UPDATE SET errores=$3, actualizado=now()`, [fecha, b, er]);
                }
            }
        }
        cacheDeposito.clear();
        res.json({ ok: true });
    } catch (err) {
        console.error('❌ [clientes] Minutos depósito:', err.message);
        res.status(500).json({ error: err.message });
    }
});


// =====================================================================
//  CCC PEPSICO: clientes que compraron 3 unidades o más de productos PEPSICO en el mes
//  - Unidades: cantidad de artículos del proveedor 100 en facturas y notas de crédito (las NC restan), por fecha de entrega.
//  - Saldo: el neto del mes (facturas menos NC) tiene que ser positivo (más de $1).
//  - Base: clientes activos con ruta de cada vendedor. Objetivo por vendedor: se carga acá (queda en Supabase).
//  Gescom es de solo lectura.
// =====================================================================
const CCC_MIN_UNIDADES = Number(process.env.CCC_MIN_UNIDADES || 3);
const CCC_OBJETIVO_CODIGO = String(process.env.CCC_OBJETIVO_CODIGO || '15').trim();   // objetivo de Gescom (grupo Pepsico, medida Cantidad)
const cacheCCC = new Map();

async function asegurarTablaCCC() {
    if (!db) throw new Error('Sin base propia (DATABASE_URL): no se pueden guardar los objetivos');
    await db.query(`CREATE TABLE IF NOT EXISTS ccc_objetivo (
        mes text NOT NULL, vendedor text NOT NULL, objetivo integer NOT NULL,
        actualizado timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (mes, vendedor))`);
}

async function obtenerCCC(mes, forzar) {
    const c = cacheCCC.get(mes);
    if (!forzar && c && Date.now() - c.t < 2 * 60 * 1000) return c.data;
    const [a, m] = mes.split('-').map(Number);
    const desde = `${mes}-01`;
    const hasta = m === 12 ? `${a + 1}-01-01` : `${a}-${String(m + 1).padStart(2, '0')}-01`;
    const cods = codigosVendedores().map(sinCeros);
    const cn = await columnaNombreRuta();
    const filtro = await filtroAnuladas();

    const base = await pool.query(`
        SELECT DISTINCT ON (rh.cliente_id) rh.cliente_id::text AS id, c.codigo::text AS codigo,
               ltrim(rh.vendedor_codigo::text, '0') AS vend, rh.vendedor_nombre AS vend_nombre,
               COALESCE(rh.ruta_codigo::text, '') AS ruta, ${cn ? `rh.${cn}::text` : `NULL::text`} AS ruta_nombre,
               COALESCE(NULLIF(c.nombre, ''), c.razon_social) AS nombre, c.localidad, rh.orden::int AS orden,
               ${DIAS.map(d => `COALESCE(rh.${d}, 0)::int AS ${d}`).join(', ')}
        FROM cliente_ruta_hist rh
        JOIN cliente_hist c ON c.id = rh.cliente_id AND c.actual = true AND COALESCE(c.activo, true) = true
        WHERE rh.actual = true AND rh.tenant_id = $1 AND ltrim(rh.vendedor_codigo::text, '0') = ANY($2::text[])
        ORDER BY rh.cliente_id, (rh.fuerza_venta = 'Principal') DESC NULLS LAST`, [TENANT, cods]);

    const ventas = await pool.query(`
        SELECT v.cliente_id::text AS id, SUM(vi.cantidad)::float AS u, SUM(vi.importe_total_c_imp)::float AS m
        FROM venta v
        JOIN venta_item vi ON vi.venta_id = v.id AND vi.tenant_id = v.tenant_id
        JOIN item i ON i.codigo = vi.item_codigo AND i.tenant_id = v.tenant_id AND i.prov_codigo = $4
        WHERE v.tenant_id = $1 AND (v.tipo_comprobante_codigo LIKE 'FAC%' OR v.tipo_comprobante_codigo LIKE 'NCR%')
          AND v.fecha_entrega >= $2::date AND v.fecha_entrega < $3::date${filtro}
        GROUP BY 1`, [TENANT, desde, hasta, DEP_PROVEEDOR]);
    const vm = new Map(ventas.rows.map(r => [r.id, r]));

    const clientes = base.rows.map(r => {
        const v = vm.get(r.id) || { u: 0, m: 0 };
        const u = Math.round((v.u || 0) * 100) / 100, saldo = Math.round((v.m || 0) * 100) / 100;
        return { id: r.id, codigo: r.codigo || '', vend: r.vend, nombre: r.nombre || '', localidad: r.localidad || '',
            ruta: r.ruta || '', ruta_nombre: r.ruta_nombre || '', orden: r.orden == null || r.orden <= 0 ? null : r.orden,
            dias: DIAS.filter(d => r[d] === 1), u, saldo, ccc: u >= CCC_MIN_UNIDADES && saldo > 1 };
    });

    const nombres = {};
    base.rows.forEach(r => { if (r.vend_nombre && !nombres[r.vend]) nombres[r.vend] = r.vend_nombre; });
    let objetivos = {}, avisoObj = '';
    try {
        await asegurarTablaCCC();
        (await db.query(`SELECT vendedor, objetivo FROM ccc_objetivo WHERE mes = $1`, [mes])).rows.forEach(r => { objetivos[r.vendedor] = r.objetivo; });
    } catch (e) { avisoObj = e.message; }

    // Objetivo individual cargado en Gescom (objetivo 15). Lo escrito a mano en la web tiene prioridad.
    const objGescom = {}; let periodoObj = null;
    try {
        const og = await pool.query(`
            SELECT ltrim(d.vendedor_codigo::text, '0') AS vend, SUM(d.cantidad)::float AS cant,
                   to_char(MIN(o.fecha_desde), 'YYYY-MM-DD') AS desde, to_char(MAX(o.fecha_fin), 'YYYY-MM-DD') AS hasta
            FROM objetivo_detalle d
            LEFT JOIN objetivo o ON o.codigo = d.objetivo_codigo AND o.tenant_id = d.tenant_id
            WHERE d.tenant_id = $1 AND d.objetivo_codigo = $2
            GROUP BY 1`, [TENANT, CCC_OBJETIVO_CODIGO]);
        og.rows.forEach(r => { objGescom[r.vend] = Math.round(r.cant); if (r.desde) periodoObj = { desde: r.desde, hasta: r.hasta }; });
    } catch (e) { avisoObj = (avisoObj ? avisoObj + ' · ' : '') + 'Objetivo de Gescom: ' + e.message; }

    const vendedores = cods.map(cod => {
        const mios = clientes.filter(x => x.vend === cod);
        const ccc = mios.filter(x => x.ccc).length;
        const manual = objetivos[cod] != null, gesc = objGescom[cod] != null ? objGescom[cod] : null;
        return { cod, nombre: nombres[cod] || '', base: mios.length, ccc, objetivo: manual ? objetivos[cod] : gesc, objetivoGescom: gesc, manual };
    });
    const data = { mes, actualizado: new Date().toISOString(), minUnidades: CCC_MIN_UNIDADES, proveedor: DEP_PROVEEDOR,
        vendedores, clientes, avisoObj, periodoObj, objetivoCodigo: CCC_OBJETIVO_CODIGO };
    cacheCCC.set(mes, { t: Date.now(), data });
    return data;
}

app.get('/api/seguimiento-clientes/ccc', controlSupervisor, async (req, res) => {
    try {
        const mes = String(req.query.mes || hoyAR().slice(0, 7));
        if (!mesValido(mes)) return res.status(400).json({ error: 'Mes inválido' });
        res.json(await obtenerCCC(mes, req.query.refresh === '1'));
    } catch (err) {
        console.error('❌ [clientes] CCC:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/seguimiento-clientes/ccc/objetivos', controlSupervisor, async (req, res) => {
    try {
        const { mes, objetivos } = req.body || {};
        if (!mesValido(mes) || !objetivos || typeof objetivos !== 'object') return res.status(400).json({ error: 'Datos inválidos' });
        await asegurarTablaCCC();
        const cods = codigosVendedores().map(sinCeros);
        for (const [cod, valor] of Object.entries(objetivos)) {
            const v = sinCeros(cod);
            if (!cods.includes(v)) continue;
            if (valor === '' || valor == null) { await db.query(`DELETE FROM ccc_objetivo WHERE mes = $1 AND vendedor = $2`, [mes, v]); continue; }
            const n = Math.round(Number(valor));
            if (!(n >= 0 && n <= 100000)) return res.status(400).json({ error: 'Objetivo inválido para ' + v });
            await db.query(`INSERT INTO ccc_objetivo (mes, vendedor, objetivo) VALUES ($1,$2,$3)
                ON CONFLICT (mes, vendedor) DO UPDATE SET objetivo = $3, actualizado = now()`, [mes, v, n]);
        }
        cacheCCC.clear();
        res.json({ ok: true });
    } catch (err) {
        console.error('❌ [clientes] Objetivos CCC:', err.message);
        res.status(500).json({ error: err.message });
    }
});


// =====================================================================
//  ADMINISTRACIÓN: resúmenes de cuenta corriente en PDF (perfil "Administración", código ADMINISTRACION_PIN, por defecto 1234)
//  Gescom trae mal los saldos de su reporte, así que se arma el resumen con los movimientos reales:
//    - Facturas / notas de crédito / notas de débito: tabla venta (fecha del comprobante, importe total)
//    - Cobros: caja_movimiento "Cobro de cliente <código>" confirmados (varios medios de pago = un solo cobro)
//    - Ajustes de deuda (DAJ) y de crédito (CAJ): asiento_movimiento (Gescom los guarda desde julio de 2026)
//  El saldo se ancla a la foto diaria de cta_cte_cliente (saldo pendiente al cierre del día, desde CTA_FOTOS_DESDE):
//  lo que no se puede detallar (ajustes anteriores a las fotos) queda como "Saldo anterior". Y se controla el saldo
//  calculado contra la foto de la fecha final: si no coincide, la pantalla avisa.
//  Los grupos de clientes asociados (sucursales / bocas) se guardan en la base propia: tabla adm_grupos.
// =====================================================================
const CTA_FOTOS_DESDE = /^\d{4}-\d{2}-\d{2}$/.test(process.env.CTA_FOTOS_DESDE || '') ? process.env.CTA_FOTOS_DESDE : '2026-07-27';
const fechaValida = f => /^\d{4}-\d{2}-\d{2}$/.test(String(f || ''));
const sumarDias = (f, n) => { const d = new Date(f + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const redondear = n => Math.round((Number(n) || 0) * 100) / 100;

let tablaGruposLista = false;
async function asegurarTablaGrupos() {
    if (!db) throw new Error('Sin base propia (DATABASE_URL): no se pueden guardar los grupos de clientes');
    if (tablaGruposLista) return;
    await db.query(`CREATE TABLE IF NOT EXISTS adm_grupos (
        nombre text PRIMARY KEY, codigos text[] NOT NULL, actualizado timestamptz NOT NULL DEFAULT now())`);
    tablaGruposLista = true;
}

app.get('/api/administracion/grupos', controlAdministracion, async (req, res) => {
    try {
        await asegurarTablaGrupos();
        res.json((await db.query(`SELECT nombre, codigos FROM adm_grupos ORDER BY lower(nombre)`)).rows);
    } catch (err) { console.error('❌ [admin] grupos:', err.message); res.status(500).json({ error: err.message }); }
});
app.post('/api/administracion/grupos', controlAdministracion, async (req, res) => {
    try {
        const nombre = String((req.body || {}).nombre || '').trim().slice(0, 80);
        const codigos = [...new Set(((req.body || {}).codigos || []).map(c => sinCeros(String(c).trim())).filter(c => /^\d{1,10}$/.test(c)))];
        if (!nombre) return res.status(400).json({ error: 'Poné un nombre para el grupo' });
        if (!codigos.length) return res.status(400).json({ error: 'El grupo necesita al menos un cliente' });
        await asegurarTablaGrupos();
        await db.query(`INSERT INTO adm_grupos (nombre, codigos) VALUES ($1, $2)
            ON CONFLICT (nombre) DO UPDATE SET codigos = $2, actualizado = now()`, [nombre, codigos]);
        res.json({ ok: true });
    } catch (err) { console.error('❌ [admin] guardar grupo:', err.message); res.status(500).json({ error: err.message }); }
});
app.delete('/api/administracion/grupos', controlAdministracion, async (req, res) => {
    try {
        await asegurarTablaGrupos();
        await db.query(`DELETE FROM adm_grupos WHERE nombre = $1`, [String(req.query.nombre || '')]);
        res.json({ ok: true });
    } catch (err) { console.error('❌ [admin] borrar grupo:', err.message); res.status(500).json({ error: err.message }); }
});

// Buscador de clientes por código, nombre o CUIT. Con ?cuit=<código> trae los clientes que comparten CUIT con ese código (sugerencia de asociados)
app.get('/api/administracion/buscar', controlAdministracion, async (req, res) => {
    try {
        const q = String(req.query.q || '').trim().slice(0, 60);
        const cols = `ltrim(c.codigo::text, '0') AS codigo, COALESCE(NULLIF(c.nombre, ''), c.razon_social) AS nombre,
                      c.razon_social, c.documento, c.localidad, COALESCE(c.activo, true) AS activo`;
        let r;
        if (req.query.cuit) {
            r = await pool.query(`
                SELECT ${cols} FROM cliente_hist c
                WHERE c.tenant_id = $1 AND c.actual = true AND c.documento IS NOT NULL AND c.documento <> ''
                  AND c.documento = (SELECT documento FROM cliente_hist WHERE tenant_id = $1 AND actual = true AND ltrim(codigo::text, '0') = $2 LIMIT 1)
                ORDER BY c.codigo::text LIMIT 60`, [TENANT, sinCeros(req.query.cuit)]);
        } else {
            if (q.length < 2) return res.json([]);
            r = await pool.query(`
                SELECT ${cols} FROM cliente_hist c
                WHERE c.tenant_id = $1 AND c.actual = true
                  AND (ltrim(c.codigo::text, '0') = $2 OR c.razon_social ILIKE $3 OR c.nombre ILIKE $3 OR c.documento ILIKE $3)
                ORDER BY c.razon_social LIMIT 40`, [TENANT, sinCeros(q), '%' + q + '%']);
        }
        res.json(r.rows);
    } catch (err) { console.error('❌ [admin] buscar:', err.message); res.status(500).json({ error: err.message }); }
});

// Saldo pendiente de los clientes según la foto diaria de la cta. cte.; null si ese día no hay foto
async function saldoFoto(ids, fecha) {
    const hay = await pool.query(`SELECT 1 FROM cta_cte_cliente WHERE fecha_sync = $1::date LIMIT 1`, [fecha]);
    if (!hay.rows.length) return null;
    const r = await pool.query(`
        SELECT COALESCE(SUM(CASE WHEN es_credito THEN -importe ELSE importe END), 0)::float AS saldo
        FROM cta_cte_cliente WHERE fecha_sync = $1::date AND cliente_id = ANY($2::bigint[])`, [fecha, ids]);
    return redondear(r.rows[0].saldo);
}

async function armarResumen(codigos, desde, hasta) {
    const cods = [...new Set(codigos.map(c => sinCeros(String(c).trim())).filter(Boolean))];
    const cl = await pool.query(`
        SELECT c.id::text AS id, ltrim(c.codigo::text, '0') AS codigo, COALESCE(NULLIF(c.nombre, ''), c.razon_social) AS nombre,
               c.razon_social, c.documento
        FROM cliente_hist c WHERE c.tenant_id = $1 AND c.actual = true AND ltrim(c.codigo::text, '0') = ANY($2::text[])`, [TENANT, cods]);
    if (!cl.rows.length) throw new Error('No se encontraron esos clientes en Gescom');
    const ids = cl.rows.map(c => c.id);
    const porId = new Map(cl.rows.map(c => [c.id, c.codigo]));
    const filtro = await filtroAnuladas();
    const tope = hasta > CTA_FOTOS_DESDE ? hasta : CTA_FOTOS_DESDE;   // siempre se trae hasta la primera foto, que es donde se ancla el saldo

    const mov = [];
    // 1) Facturas, notas de crédito y de débito
    const v = await pool.query(`
        SELECT v.cliente_id::text AS cid, to_char(v.fecha_comprobante, 'YYYY-MM-DD') AS f, v.tipo_comprobante_codigo AS tipo,
               v.punto_venta_codigo::text AS pv, v.numero_comprobante::text AS num, v.importe_total::float AS imp,
               v.motivo_rechazo_desc AS m_rech, v.motivo_cambio_desc AS m_camb
        FROM venta v
        WHERE v.tenant_id = $1 AND v.cliente_id = ANY($2::bigint[])
          AND (v.tipo_comprobante_codigo LIKE 'FAC%' OR v.tipo_comprobante_codigo LIKE 'NCR%' OR v.tipo_comprobante_codigo LIKE 'NDB%')
          AND v.fecha_comprobante < ($3::date + 1)${filtro}`, [TENANT, ids, tope]);
    v.rows.forEach(r => {
        const nc = /^NCR/.test(r.tipo);
        const concepto = nc ? (r.m_rech ? 'Devolución por Rechazo' : r.m_camb ? 'Devolución por Canje' : 'Nota de crédito')
            : /^NDB/.test(r.tipo) ? 'Nota de débito' : 'Venta';
        mov.push({ f: r.f, ord: nc ? 1 : 0, cod: porId.get(r.cid), tipo: r.tipo, num: String(r.pv || '').padStart(4, '0') + '-' + String(r.num || '').padStart(8, '0'),
            concepto, debe: nc ? 0 : redondear(r.imp), haber: nc ? redondear(r.imp) : 0 });
    });
    // 2) Cobros (un cobro puede tener varios medios de pago: se suman)
    const cobDet = cods.map(c => 'Cobro de cliente ' + c);
    const cb = await pool.query(`
        SELECT m.operacion_id::text AS op, m.operacion_detalle AS det, to_char(MIN(m.fecha_ejecucion), 'YYYY-MM-DD') AS f,
               SUM(m.importe)::float AS imp, string_agg(DISTINCT m.tipo_valor_descripcion, ', ') AS medio
        FROM caja_movimiento m
        WHERE m.tenant_id = $1 AND m.caja_mov_estado = 'Confirmado' AND m.tipo_movimiento = 'Ingreso'
          AND m.operacion_detalle = ANY($2::text[]) AND m.fecha_ejecucion < ($3::date + 1)
        GROUP BY 1, 2`, [TENANT, cobDet, tope]);
    cb.rows.forEach(r => {
        mov.push({ f: r.f, ord: 3, cod: sinCeros(String(r.det).replace('Cobro de cliente ', '')), tipo: 'COB', num: '',
            concepto: 'Cobro' + (r.medio ? ' · ' + r.medio : ''), debe: 0, haber: redondear(r.imp) });
    });
    // 3) Ajustes de deuda y de crédito
    const pat = cods.map(c => 'Cliente ' + c + ' - %');
    const aj = await pool.query(`
        SELECT a.tipo_entity AS te, a.entity_id::text AS eid, MIN(a.entity_desc) AS d, to_char(MIN(a.fecha), 'YYYY-MM-DD') AS f,
               MAX(a.valor)::float AS imp, MIN(a.asiento_comentario) AS com
        FROM asiento_movimiento a
        WHERE a.tenant_id = $1 AND a.tipo_entity IN ('deuda-ajuste-cliente', 'credito-ajuste-cliente')
          AND a.asiento_comentario LIKE ANY($2::text[]) AND a.fecha < ($3::date + 1)
        GROUP BY 1, 2`, [TENANT, pat, tope]);
    aj.rows.forEach(r => {
        const deuda = r.te === 'deuda-ajuste-cliente';
        const m = /(DAJ|CAJ)\s+(\S+)/.exec(r.d || '');
        const cm = /^Cliente\s+(\S+)\s+-/.exec(r.com || '');
        mov.push({ f: r.f, ord: 2, cod: cm ? sinCeros(cm[1]) : '', tipo: m ? m[1] : (deuda ? 'DAJ' : 'CAJ'), num: m ? m[2] : '',
            concepto: deuda ? 'Deuda por ajuste' : 'Crédito por ajuste', debe: deuda ? redondear(r.imp) : 0, haber: deuda ? 0 : redondear(r.imp) });
    });
    mov.sort((a, b) => a.f < b.f ? -1 : a.f > b.f ? 1 : a.ord - b.ord || String(a.num).localeCompare(String(b.num)));
    const acum = f => redondear(mov.filter(m => m.f <= f).reduce((t, m) => t + m.debe - m.haber, 0));

    // Anclaje con las fotos de la cuenta corriente
    let brecha = 0, avisoAncla = '';
    const fotoAncla = await saldoFoto(ids, CTA_FOTOS_DESDE);
    if (fotoAncla == null) avisoAncla = 'No hay foto de cuenta corriente del ' + CTA_FOTOS_DESDE + ': el saldo se calcula solo con los movimientos.';
    else brecha = redondear(fotoAncla - acum(CTA_FOTOS_DESDE));
    const anterior = desde ? mov.filter(m => m.f < desde) : [];
    const apertura = redondear(brecha + anterior.reduce((t, m) => t + m.debe - m.haber, 0));
    const filas = mov.filter(m => (!desde || m.f >= desde) && m.f <= hasta);
    let saldo = apertura;
    filas.forEach(m => { saldo = redondear(saldo + m.debe - m.haber); m.saldo = saldo; });

    // Control: saldo calculado vs. foto de la última fecha disponible hasta "hasta"
    let control = { estado: 'sin-control', texto: 'No hay fotos de cuenta corriente para esa fecha (empiezan el ' + CTA_FOTOS_DESDE + '): el saldo no se pudo controlar.' };
    if (fotoAncla != null) {
        const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
        let d = hasta > hoy ? hoy : hasta;
        for (let i = 0; i < 6 && d >= CTA_FOTOS_DESDE; i++, d = sumarDias(d, -1)) {
            const foto = await saldoFoto(ids, d);
            if (foto == null) continue;
            const calc = redondear(brecha + acum(d));
            control = { estado: Math.abs(calc - foto) < 1 ? 'ok' : 'difiere', fecha: d, calculado: calc, foto, diferencia: redondear(calc - foto) };
            break;
        }
    }
    return {
        clientes: cl.rows.map(c => ({ codigo: c.codigo, nombre: c.nombre, razon_social: c.razon_social, documento: c.documento })),
        faltan: cods.filter(c => !cl.rows.some(x => x.codigo === c)),
        desde: desde || '', hasta, apertura, brecha, avisoAncla, filas, saldoFinal: saldo, control,
        totales: { debe: redondear(filas.reduce((t, m) => t + m.debe, 0)), haber: redondear(filas.reduce((t, m) => t + m.haber, 0)) }
    };
}

app.get('/api/administracion/resumen', controlAdministracion, async (req, res) => {
    try {
        const codigos = String(req.query.codigos || '').split(',').map(c => c.trim()).filter(Boolean).slice(0, 60);
        const hasta = String(req.query.hasta || '');
        const desde = String(req.query.desde || '');
        if (!codigos.length) return res.status(400).json({ error: 'Elegí un cliente o un grupo' });
        if (!fechaValida(hasta) || (desde && !fechaValida(desde))) return res.status(400).json({ error: 'Fechas inválidas' });
        res.json(await armarResumen(codigos, desde, hasta));
    } catch (err) { console.error('❌ [admin] resumen:', err.message); res.status(500).json({ error: err.message }); }
});


// =====================================================================
//  ARTÍCULOS Y CARTELES DE RACK
//  Bodeguistas (y encargado) buscan un artículo activo por nombre o código para saber cuál es al contar stock, y pueden
//  "Pedir cartel". Administración ve los pedidos y genera el PDF con los carteles (código grande + nombre) para imprimir.
//  Los pedidos se guardan en la base propia: tabla cartel_pedidos.
// =====================================================================
let promesaActivoItem = null;
function condicionItemActivo() {
    if (!promesaActivoItem) {
        promesaActivoItem = pool.query(`/*RETORNO*/ SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'item' AND column_name IN ('activo', 'inactivo', 'habilitado', 'baja', 'dado_de_baja')`)
            .then(r => {
                const n = r.rows.map(c => c.column_name);
                if (n.includes('activo')) return { sql: ` AND COALESCE(i.activo::text, 'true') NOT IN ('false', 'f', '0')`, col: 'activo' };
                if (n.includes('habilitado')) return { sql: ` AND COALESCE(i.habilitado::text, 'true') NOT IN ('false', 'f', '0')`, col: 'habilitado' };
                const baja = ['inactivo', 'baja', 'dado_de_baja'].find(c => n.includes(c));
                if (baja) return { sql: ` AND COALESCE(i.${baja}::text, 'false') IN ('false', 'f', '0')`, col: baja };
                return { sql: '', col: '' };
            })
            .catch(() => { promesaActivoItem = null; return { sql: '', col: '' }; });
    }
    return promesaActivoItem;
}

let tablaCartelesLista = false;
async function asegurarTablaCarteles() {
    if (!db) throw new Error('Sin base propia (DATABASE_URL): no se pueden guardar los pedidos de cartel');
    if (tablaCartelesLista) return;
    await db.query(`CREATE TABLE IF NOT EXISTS cartel_pedidos (
        id serial PRIMARY KEY, codigo text NOT NULL, nombre text NOT NULL,
        estado text NOT NULL DEFAULT 'pendiente', pedido timestamptz NOT NULL DEFAULT now(), impreso timestamptz)`);
    tablaCartelesLista = true;
}

app.get('/api/seguimiento-clientes/articulos', controlLectorDeposito, async (req, res) => {
    try {
        const palabras = String(req.query.q || '').trim().split(/\s+/).filter(Boolean).slice(0, 5).map(w => w.slice(0, 40));
        if (!palabras.length || palabras.join('').length < 2) return res.json({ articulos: [] });
        const act = await condicionItemActivo();
        const params = [TENANT]; const conds = [];
        palabras.forEach(w => { params.push('%' + w.replace(/[%_\\]/g, '\\$&') + '%'); conds.push(`(i.descripcion ILIKE $${params.length} OR i.codigo::text ILIKE $${params.length})`); });
        const r = await pool.query(`
            SELECT DISTINCT ON (i.codigo) i.codigo::text AS codigo, i.descripcion, COALESCE(i.prov_razonsocial, '') AS proveedor
            FROM item i
            WHERE i.tenant_id = $1${act.sql} AND ${conds.join(' AND ')}
            ORDER BY i.codigo, i.descripcion
            LIMIT 400`, params);
        const q1 = palabras[0].toLowerCase();
        const filas = r.rows.sort((a, b) =>
            (a.codigo.toLowerCase() === q1 ? 0 : a.codigo.toLowerCase().startsWith(q1) ? 1 : 2) - (b.codigo.toLowerCase() === q1 ? 0 : b.codigo.toLowerCase().startsWith(q1) ? 1 : 2)
            || String(a.descripcion).localeCompare(String(b.descripcion))).slice(0, 60);
        let pendientes = new Set();
        try {
            await asegurarTablaCarteles();
            (await db.query(`SELECT codigo FROM cartel_pedidos WHERE estado = 'pendiente' AND codigo = ANY($1::text[])`, [filas.map(f => f.codigo)])).rows.forEach(x => pendientes.add(x.codigo));
        } catch (e) { /* sin base propia: igual se puede buscar */ }
        res.json({ articulos: filas.map(f => ({ ...f, pedido: pendientes.has(f.codigo) })), filtroActivo: act.col || null, hayMas: r.rows.length > 60 });
    } catch (err) { console.error('❌ [articulos] buscar:', err.message); res.status(500).json({ error: err.message }); }
});

app.post('/api/seguimiento-clientes/articulos/pedir-cartel', controlLectorDeposito, async (req, res) => {
    try {
        const codigo = String((req.body || {}).codigo || '').trim().slice(0, 40);
        if (!codigo) return res.status(400).json({ error: 'Falta el código' });
        const r = await pool.query(`SELECT i.codigo::text AS codigo, i.descripcion FROM item i WHERE i.tenant_id = $1 AND i.codigo::text = $2 LIMIT 1`, [TENANT, codigo]);
        if (!r.rows.length) return res.status(404).json({ error: 'Ese artículo no existe en Gescom' });
        await asegurarTablaCarteles();
        const ya = await db.query(`SELECT 1 FROM cartel_pedidos WHERE codigo = $1 AND estado = 'pendiente' LIMIT 1`, [codigo]);
        if (!ya.rows.length) await db.query(`INSERT INTO cartel_pedidos (codigo, nombre) VALUES ($1, $2)`, [codigo, String(r.rows[0].descripcion || '').trim()]);
        res.json({ ok: true, yaPedido: !!ya.rows.length });
    } catch (err) { console.error('❌ [articulos] pedir cartel:', err.message); res.status(500).json({ error: err.message }); }
});

// Administración: pedidos de cartel
app.get('/api/administracion/carteles', controlAdministracion, async (req, res) => {
    try {
        await asegurarTablaCarteles();
        const estado = req.query.estado === 'impreso' ? 'impreso' : 'pendiente';
        const r = await db.query(`
            SELECT id, codigo, nombre, estado, to_char(pedido AT TIME ZONE 'America/Argentina/Buenos_Aires', 'YYYY-MM-DD HH24:MI') AS pedido,
                   to_char(impreso AT TIME ZONE 'America/Argentina/Buenos_Aires', 'YYYY-MM-DD HH24:MI') AS impreso
            FROM cartel_pedidos WHERE estado = $1 ORDER BY ${estado === 'impreso' ? 'impreso DESC LIMIT 60' : 'pedido'}`, [estado]);
        const cant = await db.query(`SELECT count(*)::int AS n FROM cartel_pedidos WHERE estado = 'pendiente'`);
        res.json({ carteles: r.rows, pendientes: cant.rows[0].n });
    } catch (err) { console.error('❌ [admin] carteles:', err.message); res.status(500).json({ error: err.message }); }
});
app.post('/api/administracion/carteles/impreso', controlAdministracion, async (req, res) => {
    try {
        const ids = ((req.body || {}).ids || []).map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 500);
        if (!ids.length) return res.status(400).json({ error: 'No hay carteles elegidos' });
        await asegurarTablaCarteles();
        await db.query(`UPDATE cartel_pedidos SET estado = 'impreso', impreso = now() WHERE id = ANY($1::int[]) AND estado = 'pendiente'`, [ids]);
        res.json({ ok: true });
    } catch (err) { console.error('❌ [admin] carteles impreso:', err.message); res.status(500).json({ error: err.message }); }
});
app.delete('/api/administracion/carteles', controlAdministracion, async (req, res) => {
    try {
        await asegurarTablaCarteles();
        await db.query(`DELETE FROM cartel_pedidos WHERE id = $1`, [Number(req.query.id) || 0]);
        res.json({ ok: true });
    } catch (err) { console.error('❌ [admin] carteles borrar:', err.message); res.status(500).json({ error: err.message }); }
});

console.log('📊 Módulo provisorio de seguimiento de clientes y cobertura de marcas activo en /clientes');

module.exports = {};