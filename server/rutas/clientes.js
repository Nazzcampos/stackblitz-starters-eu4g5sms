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
const leerPin = () => String(process.env.CLIENTES_PIN || '').trim();

function controlPin(req, res, next) {
    const PIN = leerPin();
    if (!PIN) return res.status(500).json({ error: 'Falta configurar CLIENTES_PIN en Render.' });
    if (String(req.get('x-pin') || '').trim() !== PIN) return res.status(401).json({ error: 'PIN incorrecto' });
    next();
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

app.get('/api/seguimiento-clientes/datos', controlPin, async (req, res) => {
    try {
        const filas = await obtenerClientes(req.query.refresh === '1');
        res.json({ actualizado: new Date(cacheClientes.t).toISOString(), filas });
    } catch (err) {
        console.error('❌ [clientes] Error en consulta de clientes:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/seguimiento-clientes/marcas', controlPin, async (req, res) => {
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

app.get('/api/seguimiento-clientes/objetivos', controlPin, async (req, res) => {
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

app.post('/api/seguimiento-clientes/objetivos', controlPin, async (req, res) => {
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
    if (!sNombres.includes('item_id')) throw new Error('La tabla stock no tiene la columna item_id (columnas: ' + sNombres.join(', ') + ').');

    // Cantidades del stock: cada columna numérica que no es un id. Se reconoce si es cantidad, disponible o reserva, en bultos o en unidades
    const cantidades = stock.filter(c => NUMERICOS.test(c.data_type) && !/(^|_)id$|tenant|^orden$|factor|sede|sector/i.test(c.column_name)).map(c => {
        const n = c.column_name;
        return { nombre: n, rol: /disponible/i.test(n) ? 'disp' : /reserv/i.test(n) ? 'reserva' : 'cant', tipo: /bulto/i.test(n) ? 'bultos' : /unidad/i.test(n) ? 'unidades' : 'unica' };
    });
    // Clasificaciones del artículo (rubro, subrubro, marca...): texto, sin ids ni códigos
    const clasif = item.filter(c => TEXTOS.test(c.data_type) && /rubro|marca|familia|categoria|linea|clasific|grupo|segmento/i.test(c.column_name)
        && !/(_id|_codigo|codigo_)$/i.test(c.column_name)).map(c => c.column_name);
    const textoDep = stock.filter(c => /deposito/i.test(c.column_name) && TEXTOS.test(c.data_type));
    const unidadStock = stock.find(c => TEXTOS.test(c.data_type) && /unidad|presentacion/i.test(c.column_name) && !/(_id|_codigo)$/i.test(c.column_name));
    const unidadItem = item.find(c => TEXTOS.test(c.data_type) && /unidad|presentacion/i.test(c.column_name) && !/(_id|_codigo)$/i.test(c.column_name));
    metaStock = {
        sNombres, iNombres, cantidades, clasif,
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
            const sel = [m.codigo ? `i.${qi(m.codigo)}::text AS codigo` : `i.id::text AS codigo`,
                         m.descripcion ? `i.${qi(m.descripcion)} AS descripcion` : `i.id::text AS descripcion`,
                         m.dep ? `s.${qi(m.dep)} AS deposito` : `'Todos'::text AS deposito`,
                         m.unidad ? `${m.unidad.tabla === 's' ? 's' : 'i'}.${qi(m.unidad.col)} AS unidad` : `NULL::text AS unidad`];
            m.clasif.forEach((c, k) => sel.push(`i.${qi(c)} AS ${qi('c' + k)}`));
            m.cantidades.forEach((c, k) => sel.push(`COALESCE(s.${qi(c.nombre)}, 0)::float8 AS ${qi('n' + k)}`));
            const where = [];
            const params = [];
            if (m.tenantItem) { params.push(TENANT); where.push(`i.tenant_id = $${params.length}`); }
            if (m.actual) where.push(`s.${qi('actual')} = true`);
            else if (m.fecha) where.push(`s.${qi(m.fecha.column_name)} = (SELECT MAX(x.${qi(m.fecha.column_name)}) FROM stock x${m.tenantStock && m.tenantItem ? ' WHERE x.tenant_id = $1' : ''})`);
            if (m.activoItem) where.push(`COALESCE(i.activo::int, 1) = 1`);
            const sql = `/*STOCK*/ SELECT ${sel.join(', ')} FROM item i JOIN stock s ON s.item_id = i.id${m.tenantStock && m.tenantItem ? ' AND s.tenant_id = i.tenant_id' : ''}
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

app.get('/api/seguimiento-clientes/stock', controlPin, async (req, res) => {
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

console.log('📊 Módulo provisorio de seguimiento de clientes y cobertura de marcas activo en /clientes');

module.exports = {};