// Generador de planillas Excel (.xlsx) sin librerías externas y utilidades de fechas/rangos.
const { app } = require('./core.js');
const { db, requireDb } = require('./base.js');
const { requireAdmin } = require('./auth.js');

// =====================================================================
//  EXPORTAR A EXCEL (.xlsx) — sin librerías externas: se arma el archivo directamente
// =====================================================================
const zlib = require('zlib');
const TABLA_CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
})();
function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = TABLA_CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}
function crearZip(archivos) { // archivos: [{ nombre, datos: Buffer }]
    const locales = [], centrales = [];
    let offset = 0;
    const d = new Date();
    const hora = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const fecha = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    archivos.forEach(a => {
        const nombre = Buffer.from(a.nombre, 'utf8');
        const comp = zlib.deflateRawSync(a.datos);
        const crc = crc32(a.datos);
        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
        lh.writeUInt16LE(hora, 10); lh.writeUInt16LE(fecha, 12); lh.writeUInt32LE(crc, 14);
        lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(a.datos.length, 22); lh.writeUInt16LE(nombre.length, 26); lh.writeUInt16LE(0, 28);
        locales.push(lh, nombre, comp);
        const ch = Buffer.alloc(46);
        ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
        ch.writeUInt16LE(hora, 12); ch.writeUInt16LE(fecha, 14); ch.writeUInt32LE(crc, 16);
        ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(a.datos.length, 24); ch.writeUInt16LE(nombre.length, 28);
        ch.writeUInt32LE(offset, 42);
        centrales.push(ch, nombre);
        offset += lh.length + nombre.length + comp.length;
    });
    const dirCentral = Buffer.concat(centrales);
    const fin = Buffer.alloc(22);
    fin.writeUInt32LE(0x06054b50, 0); fin.writeUInt16LE(archivos.length, 8); fin.writeUInt16LE(archivos.length, 10);
    fin.writeUInt32LE(dirCentral.length, 12); fin.writeUInt32LE(offset, 16);
    return Buffer.concat([...locales, dirCentral, fin]);
}
function xmlTexto(t) {
    return String(t == null ? '' : t).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function letraColumna(n) { let s = ''; n++; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }

// Estilos (índice en cellXfs): 0 normal · 1 encabezado · 2 número 0,00 · 3 falla (rojo) · 4 ok (verde) · 5 negrita · 6 negrita 0,00
const ESTILO = { normal: 0, encabezado: 1, numero: 2, falla: 3, ok: 4, negrita: 5, negritaNumero: 6, aviso: 7 };
function hojaXml(filas, anchos) {
    const maxCol = Math.max(...filas.map(f => f.length), 1);
    const cols = anchos.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
    const datos = filas.map((fila, r) => {
        const celdas = fila.map((c, i) => {
            if (c === null || c === undefined || c === '') return '';
            const ref = letraColumna(i) + (r + 1);
            const celda = (typeof c === 'object') ? c : { v: c };
            const s = celda.s || (r === 0 ? ESTILO.encabezado : 0);
            if (typeof celda.v === 'number' && Number.isFinite(celda.v)) return `<c r="${ref}" s="${s}"><v>${celda.v}</v></c>`;
            return `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${xmlTexto(celda.v)}</t></is></c>`;
        }).join('');
        return `<row r="${r + 1}"${r === 0 ? ' ht="28" customHeight="1"' : ''}>${celdas}</row>`;
    }).join('');
    const rango = `A1:${letraColumna(maxCol - 1)}${Math.max(filas.length, 1)}`;
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${cols}</cols><sheetData>${datos}</sheetData><autoFilter ref="${rango}"/></worksheet>`;
}
function crearXlsx(hojas) { // hojas: [{ nombre, filas, anchos }]
    const estilos = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="4"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FF9C0006"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="6"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF4F46E5"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFC7CE"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFC6EFCE"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF2A8"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFD0D0D0"/></left><right style="thin"><color rgb="FFD0D0D0"/></right><top style="thin"><color rgb="FFD0D0D0"/></top><bottom style="thin"><color rgb="FFD0D0D0"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="8">
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="2" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
<xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf>
<xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf>
<xf numFmtId="0" fontId="3" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>
<xf numFmtId="2" fontId="3" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>
<xf numFmtId="0" fontId="0" fillId="5" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf>
</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
    const archivos = [
        { nombre: '[Content_Types].xml', datos: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${hojas.map((h, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` },
        { nombre: '_rels/.rels', datos: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
        { nombre: 'xl/workbook.xml', datos: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${hojas.map((h, i) => `<sheet name="${xmlTexto(h.nombre.replace(/[\\\/\?\*\[\]:]/g, ' ').slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` },
        { nombre: 'xl/_rels/workbook.xml.rels', datos: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${hojas.map((h, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${hojas.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
        { nombre: 'xl/styles.xml', datos: estilos },
        ...hojas.map((h, i) => ({ nombre: `xl/worksheets/sheet${i + 1}.xml`, datos: hojaXml(h.filas, h.anchos) }))
    ].map(a => ({ nombre: a.nombre, datos: Buffer.from(a.datos, 'utf8') }));
    return crearZip(archivos);
}
function enviarXlsx(res, nombreArchivo, buffer) {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${nombreArchivo}"`);
    res.end(buffer);
}
// Rango de fechas AAAA-MM-DD (máximo 1 año)
function rangoFechas(q) {
    const re = /^\d{4}-\d{2}-\d{2}$/;
    if (!re.test(q.desde || '') || !re.test(q.hasta || '')) return null;
    const a = Date.parse(q.desde), b = Date.parse(q.hasta);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b < a || (b - a) > 366 * 86400000) return null;
    return { desde: q.desde, hasta: q.hasta };
}
const TZ_AR = "'America/Argentina/Buenos_Aires'";

// Check-lists del período: una fila por check-list y una columna por cada ítem (Falla en rojo)
app.get('/api/admin/exportar/checklists', requireAdmin, requireDb, async (req, res) => {
    const rango = rangoFechas(req.query);
    if (!rango) return res.status(400).json({ error: 'Indicá desde y hasta (AAAA-MM-DD, máximo 1 año).' });
    try {
        const r = await db.query(
            `SELECT to_char(creado AT TIME ZONE ${TZ_AR}, 'DD/MM/YYYY') AS fecha,
                    to_char(creado AT TIME ZONE ${TZ_AR}, 'HH24:MI') AS hora,
                    chofer, dominio, tipo_vehiculo, respuestas, observaciones
             FROM flota_checklist
             WHERE creado >= ($1::date)::timestamp AT TIME ZONE ${TZ_AR}
               AND creado < (($2::date + 1)::timestamp AT TIME ZONE ${TZ_AR})
             ORDER BY id ASC LIMIT 20000`, [rango.desde, rango.hasta]);
        const items = [];
        r.rows.forEach(f => Object.keys(f.respuestas || {}).forEach(k => { if (!items.includes(k)) items.push(k); }));
        const encabezado = ['Fecha', 'Hora', 'Chofer', 'Dominio', 'Tipo de vehículo', ...items, 'Resultado', 'Observaciones'];
        const filas = [encabezado];
        r.rows.forEach(f => {
            const resp = f.respuestas || {};
            const fallas = Object.values(resp).filter(v => v === 'Falla').length;
            filas.push([
                f.fecha, f.hora, f.chofer, f.dominio, f.tipo_vehiculo || '',
                ...items.map(k => resp[k] === undefined ? '' : { v: resp[k], s: resp[k] === 'Falla' ? ESTILO.falla : ESTILO.ok }),
                fallas ? { v: fallas + (fallas === 1 ? ' falla' : ' fallas'), s: ESTILO.falla } : { v: 'Sin fallas', s: ESTILO.ok },
                f.observaciones || ''
            ]);
        });
        const anchos = [12, 8, 28, 12, 18, ...items.map(() => 14), 14, 40];
        enviarXlsx(res, `checklists_${rango.desde}_a_${rango.hasta}.xlsx`, crearXlsx([{ nombre: 'Check-lists', filas, anchos }]));
    } catch (err) {
        console.error("❌ Error al exportar check-lists:", err.message);
        res.status(500).json({ error: 'No se pudo generar el Excel' });
    }
});

// Odómetro del período: kilómetros por día y vehículo, más un resumen por vehículo
app.get('/api/admin/exportar/odometro', requireAdmin, requireDb, async (req, res) => {
    const rango = rangoFechas(req.query);
    if (!rango) return res.status(400).json({ error: 'Indicá desde y hasta (AAAA-MM-DD, máximo 1 año).' });
    try {
        const r = await db.query(
            `SELECT to_char(fecha, 'DD/MM/YYYY') AS fecha, vehiculo, chofer, km::float8 AS km,
                    to_char(primera AT TIME ZONE ${TZ_AR}, 'HH24:MI') AS desde,
                    to_char(ultima AT TIME ZONE ${TZ_AR}, 'HH24:MI') AS hasta
             FROM flota_odometro_dia
             WHERE fecha BETWEEN $1::date AND $2::date
             ORDER BY flota_odometro_dia.fecha ASC, vehiculo ASC`, [rango.desde, rango.hasta]);
        const detalle = [['Fecha', 'Vehículo', 'Chofer', 'Km recorridos', 'Primer registro', 'Último registro']];
        const porVehiculo = new Map();
        r.rows.forEach(f => {
            const km = Number(Number(f.km).toFixed(2));
            detalle.push([f.fecha, f.vehiculo, f.chofer, { v: km, s: ESTILO.numero }, f.desde, f.hasta]);
            const acc = porVehiculo.get(f.vehiculo) || { dias: 0, km: 0 };
            acc.dias += 1; acc.km += km;
            porVehiculo.set(f.vehiculo, acc);
        });
        const resumen = [['Vehículo', 'Días con recorrido', 'Km totales', 'Km promedio por día']];
        let totalKm = 0;
        [...porVehiculo.entries()].sort((a, b) => a[0].localeCompare(b[0])).forEach(([veh, a]) => {
            totalKm += a.km;
            resumen.push([veh, a.dias, { v: Number(a.km.toFixed(2)), s: ESTILO.numero }, { v: Number((a.km / a.dias).toFixed(2)), s: ESTILO.numero }]);
        });
        if (porVehiculo.size) resumen.push([{ v: 'TOTAL FLOTA', s: ESTILO.negrita }, '', { v: Number(totalKm.toFixed(2)), s: ESTILO.negritaNumero }, '']);
        enviarXlsx(res, `odometro_${rango.desde}_a_${rango.hasta}.xlsx`, crearXlsx([
            { nombre: 'Km por día', filas: detalle, anchos: [12, 14, 30, 15, 16, 16] },
            { nombre: 'Resumen por vehículo', filas: resumen, anchos: [16, 20, 14, 20] }
        ]));
    } catch (err) {
        console.error("❌ Error al exportar odómetro:", err.message);
        res.status(500).json({ error: 'No se pudo generar el Excel' });
    }
});


module.exports = { zlib, TABLA_CRC, crc32, crearZip, xmlTexto, letraColumna, ESTILO, hojaXml, crearXlsx, enviarXlsx, rangoFechas, TZ_AR };
