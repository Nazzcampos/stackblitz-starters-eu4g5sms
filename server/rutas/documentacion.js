// Documentación de camiones y choferes (vencimientos, avisos).
const { app } = require('../core.js');
const { db, requireDb } = require('../base.js');
const { claveNombre, requireChofer, requireAdmin } = require('../auth.js');
const { ESTILO, crearXlsx, enviarXlsx, TZ_AR } = require('../xlsx.js');

// =====================================================================
//  DOCUMENTACIÓN CON VENCIMIENTO (obligatoria para Pepsico)
//  - Cada chofer completa una vez por mes la documentación propia y la del camión que maneja.
//  - Avisos: desde 29 días antes ("cuidado"), desde 15 días antes ("último aviso"), y vencido.
//  - Cada carga queda en un historial: el mes siguiente se ve si se actualizó el vencimiento o no.
//  - Si se carga algo ya vencido (o con una fecha menor a la anterior), queda marcado para el administrador.
// =====================================================================
const DIAS_AVISO_DOC = Number(process.env.DOCS_DIAS_AVISO) || 29;
const DIAS_ULTIMO_DOC = Number(process.env.DOCS_DIAS_ULTIMO) || 15;

function hoyArgentina() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }); }
function diasEntre(desde, hasta) { // AAAA-MM-DD → días de diferencia (hasta - desde)
    const a = Date.parse(desde + 'T00:00:00Z'), b = Date.parse(hasta + 'T00:00:00Z');
    return Math.round((b - a) / 86400000);
}
function fechaValida(f) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(f || ''))) return false;
    const t = Date.parse(f + 'T00:00:00Z');
    if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== f) return false;
    return f >= '2000-01-01' && f <= (Number(hoyArgentina().slice(0, 4)) + 20) + '-12-31';
}
function normalizarDominio(d) { return String(d || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10); }

// Estado de un documento: ok / aviso (≤29 días) / ultimo (≤15 días) / vencido / falta / na
function estadoDocumento(v, hoy) {
    if (v && v.sin_fecha === 'no_vence') return { estado: 'ok', dias: null, texto: 'No vence' };
    if (v && v.sin_fecha === 'no_aplica') return { estado: 'na', dias: null, texto: 'No aplica' };
    if (!v || !v.fecha) return { estado: 'falta', dias: null, texto: 'Sin cargar' };
    const dias = diasEntre(hoy, v.fecha);
    const estado = dias < 0 ? 'vencido' : dias <= DIAS_ULTIMO_DOC ? 'ultimo' : dias <= DIAS_AVISO_DOC ? 'aviso' : 'ok';
    return { estado, dias, texto: null };
}
const GRAVEDAD_DOC = { vencido: 0, falta: 1, ultimo: 2, aviso: 3, ok: 9, na: 9 };

async function tiposDocumento(soloActivos) {
    const r = await db.query(
        `SELECT clave, nombre, aplica, orden::int AS orden, activo, permite_sin_fecha
         FROM flota_doc_tipo ${soloActivos ? 'WHERE activo = true' : ''} ORDER BY aplica, orden, nombre`);
    return r.rows;
}
function mapaValores(filas, hoy) {
    const m = new Map();
    filas.forEach(f => m.set(f.aplica + '|' + f.sujeto + '|' + f.tipo, { ...f, ...estadoDocumento(f, hoy) }));
    return m;
}
function docsDeSujeto(tipos, aplica, sujeto, valores, hoy) {
    return tipos.filter(t => t.aplica === aplica).map(t => {
        const v = valores.get(aplica + '|' + sujeto + '|' + t.clave);
        const est = v || { ...estadoDocumento(null, hoy), fecha: null, sin_fecha: null, actualizado: null, actualizado_por: null };
        return { tipo: t.clave, nombre: t.nombre, permite_sin_fecha: !!t.permite_sin_fecha,
                 fecha: est.fecha || null, sin_fecha: est.sin_fecha || null, estado: est.estado, dias: est.dias, texto: est.texto,
                 actualizado: est.actualizado || null, por: est.actualizado_por || null };
    });
}
const SQL_VALORES = `SELECT aplica, sujeto, tipo, to_char(fecha, 'YYYY-MM-DD') AS fecha, sin_fecha, actualizado, actualizado_por FROM flota_doc_valor`;

// Guarda un lote de valores y su historial (un solo pedido por tabla)
async function guardarLoteDocumentos(lote, periodo, por) {
    if (!lote.length) return;
    const json = JSON.stringify(lote.map(i => ({ aplica: i.aplica, sujeto: i.sujeto, tipo: i.tipo, fecha: i.fecha || null, sin_fecha: i.sin_fecha || null,
        accion: i.accion, fecha_anterior: i.fecha_anterior || null, alerta: i.alerta || null, por })));
    await db.query(
        `INSERT INTO flota_doc_valor (aplica, sujeto, tipo, fecha, sin_fecha, actualizado, actualizado_por)
         SELECT x.aplica, x.sujeto, x.tipo, x.fecha::date, x.sin_fecha, now(), x.por
         FROM jsonb_to_recordset($1::jsonb) AS x(aplica text, sujeto text, tipo text, fecha text, sin_fecha text, por text)
         ON CONFLICT (aplica, sujeto, tipo) DO UPDATE SET fecha = EXCLUDED.fecha, sin_fecha = EXCLUDED.sin_fecha,
            actualizado = now(), actualizado_por = EXCLUDED.actualizado_por`, [json]);
    await db.query(
        `INSERT INTO flota_doc_historial (periodo, aplica, sujeto, tipo, accion, fecha_anterior, fecha_nueva, sin_fecha, por, alerta)
         SELECT $2, x.aplica, x.sujeto, x.tipo, x.accion, x.fecha_anterior::date, x.fecha::date, x.sin_fecha, x.por, x.alerta
         FROM jsonb_to_recordset($1::jsonb) AS x(aplica text, sujeto text, tipo text, fecha text, sin_fecha text, accion text, fecha_anterior text, alerta text, por text)`,
        [json, periodo]);
}

// Calcula qué se guarda para un documento según lo que eligió quien carga
function resolverCarga(item, tipo, previo, hoy) {
    const accion = String(item.accion || '');
    const salida = { aplica: tipo.aplica, tipo: tipo.clave, fecha_anterior: previo && previo.fecha ? previo.fecha : null };
    if (accion === 'confirmar') {
        if (!previo || (!previo.fecha && !previo.sin_fecha)) return { error: `${tipo.nombre}: todavía no tiene fecha cargada. Ingresala.` };
        if (previo.fecha && previo.fecha < hoy) return { error: `${tipo.nombre} está vencido (${previo.fecha.split('-').reverse().join('/')}). Cargá la fecha nueva.` };
        return { ...salida, fecha: previo.fecha || null, sin_fecha: previo.sin_fecha || null, accion: 'confirmo' };
    }
    if (accion === 'no_vence' || accion === 'no_aplica') {
        if (!tipo.permite_sin_fecha) return { error: `${tipo.nombre} necesita una fecha de vencimiento.` };
        return { ...salida, fecha: null, sin_fecha: accion, accion: previo && previo.sin_fecha === accion ? 'confirmo' : 'actualizo' };
    }
    if (accion === 'fecha') {
        if (!fechaValida(item.fecha)) return { error: `${tipo.nombre}: la fecha no es válida.` };
        let alerta = null;
        if (item.fecha < hoy) alerta = 'vencida_al_cargar';
        else if (previo && previo.fecha && item.fecha < previo.fecha) alerta = 'fecha_menor';
        const igual = previo && previo.fecha === item.fecha;
        return { ...salida, fecha: item.fecha, sin_fecha: null, accion: igual ? 'confirmo' : (previo && (previo.fecha || previo.sin_fecha) ? 'actualizo' : 'nuevo'), alerta };
    }
    return { error: `${tipo.nombre}: falta elegir una opción.` };
}

async function dominiosOcultos() {
    const r = await db.query(`SELECT dominio FROM flota_camion_oculto`);
    return new Set(r.rows.map(x => x.dominio));
}

// --- Chofer: su estado, el aviso de su camión (solo lectura: lo carga el administrador) y si ya hizo el check-list del mes ---
app.get('/api/docs/mi-estado', requireChofer, requireDb, async (req, res) => {
    try {
        const hoy = hoyArgentina(), periodo = hoy.slice(0, 7);
        const clave = claveNombre(req.chofer);
        const rec = await db.query(
            `SELECT dominio, max(creado) AS ultimo FROM flota_checklist WHERE chofer = $1 AND creado > now() - interval '120 days'
             GROUP BY dominio ORDER BY 2 DESC LIMIT 12`, [req.chofer]);
        const ocultos = await dominiosOcultos();
        const sugeridos = [];
        rec.rows.forEach(f => { const d = normalizarDominio(f.dominio); if (d && !ocultos.has(d) && !sugeridos.includes(d)) sugeridos.push(d); });
        const dominio = sugeridos[0] || '';
        const tipos = await tiposDocumento(true);
        const vals = await db.query(`${SQL_VALORES} WHERE (aplica = 'chofer' AND sujeto = $1) OR (aplica = 'camion' AND sujeto = $2)`, [clave, dominio || '-']);
        const valores = mapaValores(vals.rows, hoy);
        const mens = await db.query(`SELECT to_char(creado AT TIME ZONE ${TZ_AR}, 'DD/MM/YYYY') AS cuando FROM flota_doc_mensual WHERE chofer = $1 AND periodo = $2`, [clave, periodo]);
        const propios = docsDeSujeto(tipos, 'chofer', clave, valores, hoy);
        const camion = dominio ? docsDeSujeto(tipos, 'camion', dominio, valores, hoy) : [];
        const avisos = [];
        propios.forEach(d => { if (['vencido', 'ultimo', 'aviso'].includes(d.estado)) avisos.push({ ...d, de: 'chofer', sujeto: req.chofer }); });
        camion.forEach(d => { if (['vencido', 'ultimo', 'aviso'].includes(d.estado)) avisos.push({ ...d, de: 'camion', sujeto: dominio }); });
        avisos.sort((a, b) => GRAVEDAD_DOC[a.estado] - GRAVEDAD_DOC[b.estado] || (a.dias ?? 0) - (b.dias ?? 0));
        res.json({ hoy, periodo, dominio, dominios: sugeridos, chofer: propios, camion,
                   mensual: { hecho: mens.rows.length > 0, cuando: mens.rows[0] ? mens.rows[0].cuando : null },
                   avisos, diasAviso: DIAS_AVISO_DOC, diasUltimo: DIAS_ULTIMO_DOC });
    } catch (err) {
        console.error('❌ Error al leer documentación del chofer:', err.message);
        res.status(500).json({ error: 'No se pudo cargar tu documentación' });
    }
});

// Chofer: envía el check-list mensual (confirma o actualiza cada documento)
app.post('/api/docs/mensual', requireChofer, requireDb, async (req, res) => {
    const b = req.body || {};
    const hoy = hoyArgentina(), periodo = hoy.slice(0, 7);
    const clave = claveNombre(req.chofer);
    const dominio = normalizarDominio(b.dominio);
    if (!Array.isArray(b.items) || b.items.length > 60) return res.status(400).json({ error: 'Faltan datos' });
    try {
        // El chofer confirma solo sus documentos personales; los del camión los carga el administrador
        const tipos = (await tiposDocumento(true)).filter(t => t.aplica === 'chofer');
        const vals = await db.query(`${SQL_VALORES} WHERE aplica = 'chofer' AND sujeto = $1`, [clave]);
        const previos = new Map(vals.rows.map(f => [f.aplica + '|' + f.sujeto + '|' + f.tipo, f]));
        const porClave = new Map(b.items.map(i => [String(i.aplica) + '|' + String(i.tipo), i]));
        const lote = [], faltan = [], errores = [];
        tipos.forEach(t => {
            const it = porClave.get(t.aplica + '|' + t.clave);
            if (!it) { faltan.push(t.nombre); return; }
            const sujeto = clave;
            const r = resolverCarga(it, t, previos.get(t.aplica + '|' + sujeto + '|' + t.clave), hoy);
            if (r.error) errores.push(r.error); else lote.push({ ...r, sujeto });
        });
        if (faltan.length) return res.status(400).json({ error: 'Falta completar: ' + faltan.join(', ') + '.' });
        if (errores.length) return res.status(400).json({ error: errores[0], errores });
        await guardarLoteDocumentos(lote, periodo, req.chofer);
        await db.query(
            `INSERT INTO flota_doc_mensual (chofer, periodo, dominio) VALUES ($1, $2, $3)
             ON CONFLICT (chofer, periodo) DO UPDATE SET dominio = EXCLUDED.dominio, creado = now()`, [clave, periodo, dominio || null]);
        const alertas = lote.filter(i => i.alerta).map(i => ({ tipo: i.tipo, alerta: i.alerta }));
        res.status(201).json({ exito: true, alertas });
    } catch (err) {
        console.error('❌ Error al guardar la documentación mensual:', err.message);
        res.status(500).json({ error: 'No se pudo guardar la documentación' });
    }
});

// --- Administración ---
async function armarResumenDocumentos() {
    const hoy = hoyArgentina(), periodo = hoy.slice(0, 7);
    const tipos = await tiposDocumento(true);
    const vals = await db.query(SQL_VALORES);
    const valores = mapaValores(vals.rows, hoy);
    const chof = await db.query(`SELECT clave, nombre, activo FROM flota_chofer ORDER BY nombre`);
    const nombres = new Map(chof.rows.map(c => [c.clave, c.nombre]));
    const mens = await db.query(`SELECT chofer, dominio FROM flota_doc_mensual WHERE periodo = $1`, [periodo]);
    const mensuales = new Map(mens.rows.map(m => [m.chofer, m.dominio]));
    const doms = new Set(vals.rows.filter(v => v.aplica === 'camion').map(v => v.sujeto));
    const rec = await db.query(`SELECT DISTINCT dominio FROM flota_checklist WHERE creado > now() - interval '180 days'`);
    rec.rows.forEach(f => { const d = normalizarDominio(f.dominio); if (d.length >= 5) doms.add(d); });
    const ocultosSet = await dominiosOcultos();
    const camionesOcultos = [...ocultosSet].sort();
    const camiones = [...doms].filter(d => !ocultosSet.has(d)).sort().map(d => ({ dominio: d, docs: docsDeSujeto(tipos, 'camion', d, valores, hoy) }));
    const choferes = chof.rows.filter(c => c.activo).map(c => ({
        clave: c.clave, nombre: c.nombre, docs: docsDeSujeto(tipos, 'chofer', c.clave, valores, hoy),
        mensual: { hecho: mensuales.has(c.clave), dominio: mensuales.get(c.clave) || null }
    }));
    // Qué atender: todo lo vencido, por vencer o sin cargar
    const atencion = [];
    const sumar = (de, sujeto, nombre, docs) => docs.forEach(d => {
        if (['vencido', 'ultimo', 'aviso', 'falta'].includes(d.estado)) atencion.push({ de, sujeto, nombre, tipo: d.tipo, doc: d.nombre, fecha: d.fecha, estado: d.estado, dias: d.dias });
    });
    camiones.forEach(c => sumar('camion', c.dominio, c.dominio, c.docs));
    choferes.forEach(c => sumar('chofer', c.clave, c.nombre, c.docs));
    atencion.sort((a, b) => GRAVEDAD_DOC[a.estado] - GRAVEDAD_DOC[b.estado] || (a.dias ?? -9999) - (b.dias ?? -9999));
    const al = await db.query(
        `SELECT id::int AS id, creado, aplica, sujeto, tipo, accion, to_char(fecha_anterior, 'YYYY-MM-DD') AS fecha_anterior,
                to_char(fecha_nueva, 'YYYY-MM-DD') AS fecha_nueva, por, alerta
         FROM flota_doc_historial WHERE alerta IS NOT NULL AND creado > now() - interval '60 days' ORDER BY id DESC LIMIT 100`);
    const nombreTipo = new Map(tipos.map(t => [t.clave, t.nombre]));
    const alertas = al.rows.map(a => ({ ...a, doc: nombreTipo.get(a.tipo) || a.tipo, nombre: a.aplica === 'chofer' ? (nombres.get(a.sujeto) || a.sujeto) : a.sujeto }));
    const cuenta = e => atencion.filter(a => a.estado === e).length;
    return { hoy, periodo, tipos, camiones, camionesOcultos, choferes, atencion, alertas,
             contadores: { vencidos: cuenta('vencido'), ultimo: cuenta('ultimo'), aviso: cuenta('aviso'), faltan: cuenta('falta'),
                           sinMensual: choferes.filter(c => !c.mensual.hecho).length, alertasCarga: alertas.length },
             diasAviso: DIAS_AVISO_DOC, diasUltimo: DIAS_ULTIMO_DOC };
}

app.get('/api/admin/docs/resumen', requireAdmin, requireDb, async (req, res) => {
    try { res.json(await armarResumenDocumentos()); }
    catch (err) { console.error('❌ Error al armar el resumen de documentación:', err.message); res.status(500).json({ error: 'No se pudo cargar la documentación' }); }
});

// Administrador: quitar un camión de la lista de documentación {dominio, oculto:true} o volver a mostrarlo {dominio, oculto:false}
app.post('/api/admin/docs/camion-oculto', requireAdmin, requireDb, async (req, res) => {
    const dominio = normalizarDominio((req.body || {}).dominio);
    const oculto = (req.body || {}).oculto;
    if (dominio.length < 5 || typeof oculto !== 'boolean') return res.status(400).json({ error: 'Faltan datos' });
    try {
        if (oculto) await db.query(`INSERT INTO flota_camion_oculto (dominio) VALUES ($1) ON CONFLICT DO NOTHING`, [dominio]);
        else await db.query(`DELETE FROM flota_camion_oculto WHERE dominio = $1`, [dominio]);
        res.json({ exito: true, oculto });
    } catch (err) {
        console.error('❌ Error al ocultar/restaurar camión:', err.message);
        res.status(500).json({ error: 'No se pudo actualizar el camión' });
    }
});

// El administrador puede corregir o cargar una fecha directamente
app.post('/api/admin/docs/valor', requireAdmin, requireDb, async (req, res) => {
    const b = req.body || {};
    const aplica = b.aplica === 'camion' ? 'camion' : b.aplica === 'chofer' ? 'chofer' : null;
    if (!aplica) return res.status(400).json({ error: 'Indicá si es de un camión o de un chofer.' });
    const sujeto = aplica === 'camion' ? normalizarDominio(b.sujeto) : String(b.sujeto || '');
    if (aplica === 'camion' ? sujeto.length < 5 : !sujeto) return res.status(400).json({ error: 'Falta el dominio o el chofer.' });
    try {
        const hoy = hoyArgentina();
        const tipos = (await tiposDocumento(false)).filter(t => t.clave === b.tipo && t.aplica === aplica);
        if (!tipos[0]) return res.status(404).json({ error: 'Ese documento no existe.' });
        if (aplica === 'chofer') {
            const c = await db.query(`SELECT 1 FROM flota_chofer WHERE clave = $1`, [sujeto]);
            if (!c.rows.length) return res.status(404).json({ error: 'Ese chofer no existe.' });
        }
        const pv = await db.query(`${SQL_VALORES} WHERE aplica = $1 AND sujeto = $2 AND tipo = $3`, [aplica, sujeto, tipos[0].clave]);
        const r = resolverCarga({ accion: b.accion === 'fecha' || b.accion === 'no_vence' || b.accion === 'no_aplica' ? b.accion : '', fecha: b.fecha }, tipos[0], pv.rows[0], hoy);
        if (r.error) return res.status(400).json({ error: r.error });
        await guardarLoteDocumentos([{ ...r, sujeto, alerta: null }], hoy.slice(0, 7), 'ADMIN');
        res.json({ exito: true });
    } catch (err) {
        console.error('❌ Error al guardar documento (admin):', err.message);
        res.status(500).json({ error: 'No se pudo guardar' });
    }
});

// Tipos de documento: el administrador puede agregar, renombrar o desactivar
app.get('/api/admin/docs/tipos', requireAdmin, requireDb, async (req, res) => {
    try { res.json(await tiposDocumento(false)); }
    catch (err) { res.status(500).json({ error: 'No se pudieron leer los documentos' }); }
});
app.post('/api/admin/docs/tipos', requireAdmin, requireDb, async (req, res) => {
    const b = req.body || {};
    const nombre = String(b.nombre || '').trim().slice(0, 60);
    const aplica = b.aplica === 'camion' ? 'camion' : b.aplica === 'chofer' ? 'chofer' : null;
    if (nombre.length < 2 || !aplica) return res.status(400).json({ error: 'Poné un nombre y elegí si es de camión o de chofer.' });
    let clave = String(b.clave || '').trim();
    if (!clave) clave = nombre.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
    if (!/^[a-z0-9_]{2,40}$/.test(clave)) return res.status(400).json({ error: 'Nombre inválido.' });
    try {
        const ex = await db.query(`SELECT aplica FROM flota_doc_tipo WHERE clave = $1`, [clave]);
        if (ex.rows[0] && ex.rows[0].aplica !== aplica) return res.status(409).json({ error: 'Ya existe un documento con ese nombre para otro tipo.' });
        await db.query(
            `INSERT INTO flota_doc_tipo (clave, nombre, aplica, orden, activo, permite_sin_fecha) VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (clave) DO UPDATE SET nombre = EXCLUDED.nombre, orden = EXCLUDED.orden, activo = EXCLUDED.activo, permite_sin_fecha = EXCLUDED.permite_sin_fecha`,
            [clave, nombre, aplica, Number.isFinite(Number(b.orden)) ? Math.max(0, Math.min(999, Math.round(Number(b.orden)))) : 50, b.activo !== false, !!b.permite_sin_fecha]);
        res.json({ exito: true, clave });
    } catch (err) {
        console.error('❌ Error al guardar el tipo de documento:', err.message);
        res.status(500).json({ error: 'No se pudo guardar' });
    }
});

// Historial de un camión o chofer (qué se cargó y cuándo)
app.get('/api/admin/docs/historial', requireAdmin, requireDb, async (req, res) => {
    const aplica = req.query.aplica === 'camion' ? 'camion' : 'chofer';
    const sujeto = aplica === 'camion' ? normalizarDominio(req.query.sujeto) : String(req.query.sujeto || '');
    if (!sujeto) return res.status(400).json({ error: 'Falta el camión o chofer.' });
    try {
        const r = await db.query(
            `SELECT creado, periodo, tipo, accion, to_char(fecha_anterior, 'YYYY-MM-DD') AS fecha_anterior, to_char(fecha_nueva, 'YYYY-MM-DD') AS fecha_nueva,
                    sin_fecha, por, alerta FROM flota_doc_historial WHERE aplica = $1 AND sujeto = $2 ORDER BY id DESC LIMIT 200`, [aplica, sujeto]);
        const tipos = await tiposDocumento(false);
        const nt = new Map(tipos.map(t => [t.clave, t.nombre]));
        res.json(r.rows.map(f => ({ ...f, doc: nt.get(f.tipo) || f.tipo })));
    } catch (err) { res.status(500).json({ error: 'No se pudo leer el historial' }); }
});

// Excel: estado de toda la documentación (rojo = vencido o sin cargar, amarillo = por vencer)
app.get('/api/admin/exportar/documentos', requireAdmin, requireDb, async (req, res) => {
    try {
        const r = await armarResumenDocumentos();
        const celda = d => {
            const fmt = f => f.split('-').reverse().join('/');
            if (d.estado === 'falta') return { v: 'FALTA', s: ESTILO.falla };
            if (d.estado === 'na') return { v: 'NO APLICA', s: ESTILO.normal };
            if (d.sin_fecha === 'no_vence') return { v: 'NO VENCE', s: ESTILO.normal };
            if (d.estado === 'vencido') return { v: fmt(d.fecha) + ' (VENCIDO)', s: ESTILO.falla };
            if (d.estado === 'ultimo' || d.estado === 'aviso') return { v: fmt(d.fecha), s: ESTILO.aviso };
            return fmt(d.fecha);
        };
        const tc = r.tipos.filter(t => t.aplica === 'camion'), th = r.tipos.filter(t => t.aplica === 'chofer');
        const cam = [['Dominio', ...tc.map(t => t.nombre)]];
        r.camiones.forEach(c => cam.push([c.dominio, ...tc.map(t => celda(c.docs.find(d => d.tipo === t.clave)))]));
        const cho = [['Chofer', ...th.map(t => t.nombre), 'Check-list del mes']];
        r.choferes.forEach(c => cho.push([c.nombre, ...th.map(t => celda(c.docs.find(d => d.tipo === t.clave))),
            c.mensual.hecho ? { v: 'Hecho', s: ESTILO.ok } : { v: 'Pendiente', s: ESTILO.falla }]));
        const aten = [['Corresponde a', 'Quién', 'Documento', 'Vence', 'Días', 'Estado']];
        const nombreEstado = { vencido: 'VENCIDO', falta: 'SIN CARGAR', ultimo: 'ÚLTIMO AVISO', aviso: 'POR VENCER' };
        r.atencion.forEach(a => aten.push([a.de === 'camion' ? 'Camión' : 'Chofer', a.nombre, a.doc, a.fecha ? a.fecha.split('-').reverse().join('/') : '',
            a.dias === null || a.dias === undefined ? '' : { v: a.dias, s: ESTILO.numero },
            { v: nombreEstado[a.estado], s: a.estado === 'vencido' || a.estado === 'falta' ? ESTILO.falla : ESTILO.aviso }]));
        enviarXlsx(res, `documentacion_${r.hoy}.xlsx`, crearXlsx([
            { nombre: 'Qué atender', filas: aten, anchos: [14, 30, 34, 14, 8, 16] },
            { nombre: 'Camiones', filas: cam, anchos: [14, ...tc.map(() => 20)] },
            { nombre: 'Choferes', filas: cho, anchos: [30, ...th.map(() => 22), 18] }
        ]));
    } catch (err) {
        console.error('❌ Error al exportar la documentación:', err.message);
        res.status(500).json({ error: 'No se pudo generar el Excel' });
    }
});


module.exports = { DIAS_AVISO_DOC, DIAS_ULTIMO_DOC, hoyArgentina, diasEntre, fechaValida, normalizarDominio, estadoDocumento, GRAVEDAD_DOC, tiposDocumento, mapaValores, docsDeSujeto, SQL_VALORES, guardarLoteDocumentos, resolverCarga, dominiosOcultos, armarResumenDocumentos };
