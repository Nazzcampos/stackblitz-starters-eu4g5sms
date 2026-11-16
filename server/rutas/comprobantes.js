// Comprobantes del reparto en PDF (copia informativa).
const { app, pool } = require('../core.js');
const { requireChofer } = require('../auth.js');
const { hoyArgentina, fechaValida } = require('./documentacion.js');
const { filtroAnuladas, RE_FECHA } = require('./deposito.js');

// --- COMPROBANTES DEL REPARTO (copia informativa en PDF, solo lectura de Gescom) ---
// Gescom no guarda el PDF fiscal (CAE): se arma una copia con los datos de la boleta y así se aclara en el documento.
const COLS_COMPROBANTE = `v.id::text AS id, v.tipo_comprobante_codigo AS tipo, v.punto_venta_codigo AS pv, v.numero_comprobante AS numero,
    to_char(v.fecha_comprobante, 'DD/MM/YYYY') AS fecha, to_char(v.fecha_entrega, 'DD/MM/YYYY') AS entrega,
    v.razon_social AS cliente, v.condpago_descripcion AS condicion, v.reparto_codigo AS reparto, v.empresa_nombre AS empresa,
    v.importe_neto AS neto, v.importe_iva AS iva, v.importe_exento AS exento, v.importe_tributos AS tributos,
    v.descuento_global AS descuento, v.importe_total AS total`;

function numAR(n, dec = 2) {
    const x = Number(n);
    if (!isFinite(x)) return '';
    return x.toLocaleString('es-AR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

async function leerComprobantes(chofer, clienteId, fecha, soloId) {
    const filtro = await filtroAnuladas();
    const params = [chofer, fecha];
    let sql = `/*COMPROBANTE*/ SELECT ${COLS_COMPROBANTE} FROM venta v
        WHERE v.empleado_chofer_nombre = $1 AND v.fecha_entrega::date = $2${filtro}`;
    if (soloId) { params.push(soloId); sql += ` AND v.id = $${params.length}::bigint`; }
    else { params.push(clienteId); sql += ` AND v.cliente_id = $${params.length}::bigint`; }
    sql += ` ORDER BY v.id LIMIT 20`;
    const cab = await pool.query(sql, params);
    const salida = [];
    for (const c of cab.rows) {
        const it = await pool.query(`/*COMPROBANTE*/
            SELECT vi.item_codigo AS codigo, COALESCE(it.descripcion, vi.item_codigo) AS descripcion, vi.cantidad, vi.unidad_nombre AS unidad,
                   vi.precio_unitario AS precio, vi.descuento_porciento AS dto, vi.importe_total_c_imp AS importe
            FROM venta_item vi JOIN venta v ON v.id = vi.venta_id AND v.tenant_id = vi.tenant_id
            LEFT JOIN item it ON it.id = vi.item_id AND it.tenant_id = vi.tenant_id
            WHERE v.id = $1::bigint ORDER BY vi.item_numero, vi.id`, [c.id]);
        salida.push({ ...c, items: it.rows });
    }
    return salida;
}

// Escritor de PDF mínimo (sin dependencias): fuente Helvetica, A4, varias páginas
function crearPdfComprobante(c) {
    const W = 595, H = 842, M = 36;
    const paginas = [];
    let ops = [], y = 0;
    const esc = t => String(t == null ? '' : t).replace(/[\\()]/g, m => '\\' + m).replace(/[^\x20-\x7e\xa0-\xff]/g, '?');
    const ancho = (t, sz) => String(t).split('').reduce((a, ch) => a + (/[0-9$]/.test(ch) ? .556 : /[ .,:;]/.test(ch) ? .278 : ch === '-' ? .333 : /[A-Z]/.test(ch) ? .67 : .5), 0) * sz;
    const texto = (x, yy, t, sz = 9, neg = false, der = false) => {
        const xx = der ? x - ancho(t, sz) : x;
        ops.push(`BT /${neg ? 'F2' : 'F1'} ${sz} Tf ${xx.toFixed(1)} ${yy.toFixed(1)} Td (${esc(t)}) Tj ET`);
    };
    const linea = (yy, g = .5) => ops.push(`${g} w ${M} ${yy.toFixed(1)} m ${W - M} ${yy.toFixed(1)} l S`);
    const corta = (t, max, sz) => { t = String(t || ''); while (t.length > 1 && ancho(t, sz) > max) t = t.slice(0, -1); return t; };
    const nuevaPagina = () => {
        if (ops.length) paginas.push(ops.join('\n'));
        ops = []; y = H - M;
    };
    const cabeceraTabla = () => {
        texto(M, y, 'Cód.', 8, true); texto(M + 52, y, 'Descripción', 8, true);
        texto(W - M - 170, y, 'Cant.', 8, true, true); texto(W - M - 95, y, 'P. unit.', 8, true, true);
        texto(W - M - 60, y, 'Dto.%', 8, true, true); texto(W - M, y, 'Importe', 8, true, true);
        y -= 4; linea(y); y -= 12;
    };
    nuevaPagina();
    texto(M, y, c.empresa || 'Comprobante', 13, true); y -= 16;
    texto(M, y, `${c.tipo || 'Comprobante'}  ${String(c.pv || '').padStart(4, '0')}-${String(c.numero || '').padStart(8, '0')}`, 11, true);
    texto(W - M, y, 'COPIA INFORMATIVA', 10, true, true); y -= 13;
    texto(W - M, y, 'No es el comprobante fiscal', 8, false, true); y += 0;
    texto(M, y, `Fecha: ${c.fecha || ''}   Entrega: ${c.entrega || ''}   Reparto: ${c.reparto || ''}`, 9); y -= 14;
    linea(y); y -= 14;
    texto(M, y, 'Cliente: ' + corta(c.cliente, W - 2 * M - 40, 10), 10, true); y -= 13;
    if (c.condicion) { texto(M, y, 'Condición de pago: ' + c.condicion, 9); y -= 13; }
    y -= 4; cabeceraTabla();
    (c.items || []).forEach(i => {
        if (y < 150) { nuevaPagina(); cabeceraTabla(); }
        texto(M, y, corta(i.codigo, 48, 8), 8);
        texto(M + 52, y, corta(i.descripcion, W - M - 170 - 40 - (M + 52), 8), 8);
        texto(W - M - 170, y, numAR(i.cantidad, Number.isInteger(Number(i.cantidad)) ? 0 : 2) + (i.unidad ? ' ' + String(i.unidad).slice(0, 4) : ''), 8, false, true);
        texto(W - M - 95, y, numAR(i.precio), 8, false, true);
        texto(W - M - 60, y, Number(i.dto) ? numAR(i.dto) : '', 8, false, true);
        texto(W - M, y, numAR(i.importe), 8, false, true);
        y -= 12;
    });
    y -= 2; linea(y); y -= 14;
    if (y < 120) { nuevaPagina(); }
    const tot = (r, v, neg) => { texto(W - M - 90, y, r, neg ? 11 : 9, neg, true); texto(W - M, y, '$ ' + numAR(v), neg ? 11 : 9, neg, true); y -= neg ? 16 : 12; };
    if (Number(c.neto)) tot('Neto gravado', c.neto);
    if (Number(c.exento)) tot('Exento', c.exento);
    if (Number(c.iva)) tot('IVA', c.iva);
    if (Number(c.tributos)) tot('Tributos', c.tributos);
    if (Number(c.descuento)) tot('Descuento global', c.descuento);
    tot('TOTAL', c.total, true);
    y -= 10;
    texto(M, y, 'Copia informativa generada por BeniQ con los datos del sistema. No reemplaza al comprobante fiscal.', 7);
    nuevaPagina();
    // Ensamblado del archivo
    const partes = []; const offs = []; let pos = 0;
    const add = b => { const buf = Buffer.isBuffer(b) ? b : Buffer.from(b, 'latin1'); partes.push(buf); pos += buf.length; };
    const obj = (n, cuerpo) => { offs[n] = pos; add(`${n} 0 obj\n`); add(cuerpo); add('\nendobj\n'); };
    add('%PDF-1.4\n');
    const nPag = paginas.length;
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, `<< /Type /Pages /Kids [${paginas.map((_, i) => `${5 + i * 2} 0 R`).join(' ')}] /Count ${nPag} >>`);
    obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    obj(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    paginas.forEach((cont, i) => {
        const datos = Buffer.from(cont, 'latin1');
        obj(5 + i * 2, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`);
        offs[6 + i * 2] = pos; add(`${6 + i * 2} 0 obj\n<< /Length ${datos.length} >>\nstream\n`); add(datos); add('\nendstream\nendobj\n');
    });
    const total = 5 + nPag * 2;
    const xref = pos;
    add(`xref\n0 ${total}\n0000000000 65535 f \n`);
    for (let n = 1; n < total; n++) add(String(offs[n]).padStart(10, '0') + ' 00000 n \n');
    add(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return Buffer.concat(partes);
}

// Comprobantes de un cliente en el día de reparto (solo los de este chofer)
app.get('/api/comprobantes', requireChofer, async (req, res) => {
    const clienteId = String(req.query.cliente_id || '').replace(/\D/g, '');
    const fecha = String(req.query.fecha || '') || hoyArgentina();
    if (!clienteId || !RE_FECHA.test(fecha) || !fechaValida(fecha)) return res.status(400).json({ error: 'Faltan datos' });
    try {
        const lista = await leerComprobantes(req.chofer, clienteId, fecha, null);
        res.json(lista);
    } catch (err) {
        console.error('❌ Error al leer comprobantes:', err.message);
        res.status(500).json({ error: 'No se pudieron leer los comprobantes' });
    }
});

app.get('/api/comprobantes/:id/pdf', requireChofer, async (req, res) => {
    const id = String(req.params.id || '').replace(/\D/g, '');
    const fecha = String(req.query.fecha || '') || hoyArgentina();
    if (!id || !RE_FECHA.test(fecha) || !fechaValida(fecha)) return res.status(400).json({ error: 'Faltan datos' });
    try {
        const lista = await leerComprobantes(req.chofer, null, fecha, id);
        if (!lista.length) return res.status(404).json({ error: 'Comprobante no encontrado en tu reparto' });
        const c = lista[0];
        const nombre = `${(c.tipo || 'comprobante')}_${String(c.pv || '').padStart(4, '0')}-${String(c.numero || '').padStart(8, '0')}.pdf`.replace(/[^A-Za-z0-9_.-]/g, '_');
        res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${nombre}"`, 'Cache-Control': 'no-store' });
        res.send(crearPdfComprobante(c));
    } catch (err) {
        console.error('❌ Error al armar el PDF del comprobante:', err.message);
        res.status(500).json({ error: 'No se pudo armar el comprobante' });
    }
});


module.exports = { COLS_COMPROBANTE, numAR, leerComprobantes, crearPdfComprobante };
