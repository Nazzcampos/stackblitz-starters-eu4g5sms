// ================================================================
//  MÓDULO PROVISORIO: Seguimiento de clientes y cobertura de marcas  ->  /clientes
//  Para QUITARLO: borrar este archivo, clientes.html (en la raíz)
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
app.get('/clientes', (req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'clientes.html'));
});

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

console.log('📊 Módulo provisorio de seguimiento de clientes y cobertura de marcas activo en /clientes');

module.exports = {};