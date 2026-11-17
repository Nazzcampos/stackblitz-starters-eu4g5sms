    function escapeHtml(t) {
        return String(t == null ? '' : t).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    }
    function formatoPesos(n) {
        const v = Number(n);
        if (isNaN(v)) return '-';
        return '$' + v.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    function formatoNumero(n, dec) {
        const v = Number(n);
        if (isNaN(v)) return '-';
        return v.toLocaleString('es-AR', { minimumFractionDigits: dec || 0, maximumFractionDigits: dec || 0 });
    }
    function formatoFechaHora(f) {
        const d = new Date(f);
        return isNaN(d) ? '-' : d.toLocaleString('es-AR');
    }
    function formatoHora(f) {
        const d = new Date(f);
        return isNaN(d) ? '-' : d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
    }

    // ---------- Sesión del administrador ----------
    function leerTokenAdmin() { try { return localStorage.getItem('flota_admin_token'); } catch (e) { return null; } }
    function guardarTokenAdmin(t) { try { localStorage.setItem('flota_admin_token', t); } catch (e) {} }
    function borrarTokenAdmin() { try { localStorage.removeItem('flota_admin_token'); } catch (e) {} }

    function mostrarLoginAdmin() {
        document.getElementById('loginAdmin').classList.add('on');
        setTimeout(() => document.getElementById('claveAdmin').focus(), 50);
    }
    function ocultarLoginAdmin() {
        document.getElementById('loginAdmin').classList.remove('on');
        document.getElementById('errorLoginAdmin').innerText = '';
    }
    function cerrarSesionAdmin() {
        borrarTokenAdmin();
        location.replace('/?cambiar=1');   // vuelve a la pantalla de ingreso para elegir el rol
    }

    // Igual que fetch, pero con la clave de administrador. Si el servidor la rechaza, se pide ingresar de nuevo.
    async function adminFetch(url, opciones) {
        const cfg = Object.assign({}, opciones || {});
        cfg.headers = Object.assign({}, cfg.headers || {});
        const token = leerTokenAdmin();
        if (token) cfg.headers['Authorization'] = 'Bearer ' + token;
        const res = await fetch(url, cfg);
        if (res.status === 401) {
            borrarTokenAdmin();
            mostrarLoginAdmin();
            throw new Error('SESION');
        }
        return res;
    }

    document.getElementById('formLoginAdmin').addEventListener('submit', async (e) => {
        e.preventDefault();
        const campo = document.getElementById('claveAdmin');
        const boton = document.getElementById('btnLoginAdmin');
        const error = document.getElementById('errorLoginAdmin');
        boton.disabled = true;
        error.innerText = '';
        try {
            const res = await fetch('/api/admin/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: campo.value })
            });
            const datos = await res.json().catch(() => ({}));
            if (!res.ok) {
                error.innerText = datos.error || 'No se pudo ingresar.';
                campo.select();
                return;
            }
            guardarTokenAdmin(datos.token);
            campo.value = '';
            ocultarLoginAdmin();
            cargarDatos();
            arrancarCampana();
        } catch (err) {
            error.innerText = 'No se pudo conectar con el servidor.';
        } finally {
            boton.disabled = false;
        }
    });

    // ---------- Choferes y PIN ----------
    let listaChoferes = [];
    async function cargarChoferes() {
        try {
            const res = await adminFetch('/api/admin/choferes');
            if (!res.ok) throw new Error('HTTP ' + res.status);
            listaChoferes = await res.json();
            dibujarChoferes();
        } catch (err) {
            if (err.message === 'SESION') return;
            document.querySelector('#tabla-choferes tbody').innerHTML = '<tr><td colspan="5" class="empty-row">No se pudo obtener la lista de choferes. Revisá que la base de datos esté conectada.</td></tr>';
        }
    }
    function dibujarChoferes() {
        const filtro = document.getElementById('buscarChofer').value.trim().toUpperCase();
        const cuerpo = document.querySelector('#tabla-choferes tbody');
        const verOcultos = document.getElementById('verOcultos').checked;
        const nOcultos = listaChoferes.filter(c => c.oculto).length;
        document.getElementById('txtOcultos').textContent = 'Mostrar los que saqué de la lista (' + nOcultos + ')';
        const filas = listaChoferes.filter(c => c.nombre.toUpperCase().includes(filtro) && (verOcultos || !c.oculto));
        if (filas.length === 0) {
            cuerpo.innerHTML = '<tr><td colspan="5" class="empty-row">No hay choferes para mostrar</td></tr>';
            return;
        }
        cuerpo.innerHTML = '';
        filas.forEach(c => {
            const tr = document.createElement('tr');
            if (!c.activo) tr.className = 'fila-inactiva';
            const pinHtml = c.pinPersonalizado
                ? '<span class="badge badge-info">Personalizado</span><span class="pin-nota">Solo lo conoce el chofer</span>'
                : `<span class="pin-badge">${escapeHtml(c.pin)}</span><span class="pin-nota">PIN inicial</span>`;
            tr.innerHTML = `
                <td><b>${escapeHtml(c.nombre)}</b></td>
                <td>${c.activo ? '<span class="badge badge-ok">Activo</span>' : '<span class="badge badge-falla">Desactivado</span>'}</td>
                <td>${pinHtml}</td>
                <td>${c.ultimoIngreso ? escapeHtml(formatoFechaHora(c.ultimoIngreso)) : '<span style="color: var(--muted);">Nunca</span>'}</td>
                <td><div class="acciones"></div></td>
            `;
            const acc = tr.querySelector('.acciones');
            if (c.oculto) {
                tr.className = 'fila-inactiva';
                tr.querySelector('td:nth-child(2)').innerHTML = '<span class="badge badge-falla">Fuera de la lista</span>';
                const bVolver = document.createElement('button');
                bVolver.type = 'button'; bVolver.className = 'btn-suave'; bVolver.textContent = '↩ Volver a la lista';
                bVolver.onclick = () => cambiarOculto(c, false);
                acc.appendChild(bVolver);
                cuerpo.appendChild(tr);
                return;
            }
            if (!c.pinPersonalizado && c.pin) {
                const bCopiar = document.createElement('button');
                bCopiar.type = 'button'; bCopiar.className = 'btn-suave'; bCopiar.textContent = '📋 Copiar';
                bCopiar.onclick = (ev) => copiarPin(c.pin, ev.currentTarget);
                acc.appendChild(bCopiar);
            }
            const bPin = document.createElement('button');
            bPin.type = 'button'; bPin.className = 'btn-suave'; bPin.textContent = '🔑 Cambiar PIN';
            bPin.onclick = () => abrirModalPin(c);
            acc.appendChild(bPin);
            const bEstado = document.createElement('button');
            bEstado.type = 'button';
            bEstado.className = c.activo ? 'btn-danger' : 'btn-suave';
            bEstado.textContent = c.activo ? '⏸ Desactivar' : '▶ Activar';
            bEstado.onclick = () => cambiarActivo(c, !c.activo);
            acc.appendChild(bEstado);
            const bQuitar = document.createElement('button');
            bQuitar.type = 'button'; bQuitar.className = 'btn-suave'; bQuitar.textContent = '🗑 Quitar de la lista';
            bQuitar.title = 'Para empleados que no son choferes';
            bQuitar.onclick = () => cambiarOculto(c, true);
            acc.appendChild(bQuitar);
            cuerpo.appendChild(tr);
        });
    }
    async function copiarPin(pin, boton) {
        try {
            await navigator.clipboard.writeText(pin);
            const original = boton.innerText;
            boton.innerText = '✔ Copiado';
            setTimeout(() => { boton.innerText = original; }, 1500);
        } catch (e) { /* el navegador no permite copiar: el PIN igual está a la vista */ }
    }

    async function cambiarOculto(chofer, oculto) {
        if (oculto && !confirm('¿Sacar a ' + chofer.nombre + ' de la lista de choferes? Deja de aparecer en el ingreso y en los controles, y no podrá entrar. Podés volver a mostrarlo cuando quieras.')) return;
        try {
            const res = await adminFetch('/api/admin/chofer/oculto', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nombre: chofer.nombre, oculto })
            });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            cargarChoferes();
        } catch (err) {
            if (err.message !== 'SESION') alert('No se pudo actualizar la lista. Probá de nuevo.');
        }
    }

    async function cambiarActivo(chofer, activo) {
        if (!activo && !confirm('¿Desactivar a ' + chofer.nombre + '? Se cierra su sesión y no podrá ingresar hasta que lo actives de nuevo.')) return;
        try {
            const res = await adminFetch('/api/admin/chofer/activo', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nombre: chofer.nombre, activo })
            });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            cargarChoferes();
        } catch (err) {
            if (err.message !== 'SESION') alert('No se pudo actualizar el chofer. Probá de nuevo.');
        }
    }

    // ---------- Ventana para cambiar el PIN ----------
    let choferEnModal = null;
    function abrirModalPin(chofer) {
        choferEnModal = chofer;
        document.getElementById('modalPinTitulo').innerText = 'PIN de ' + chofer.nombre;
        document.getElementById('modalPinInput').value = '';
        document.getElementById('modalPinError').innerText = '';
        document.getElementById('modalPinFormulario').style.display = '';
        document.getElementById('modalPinResultado').style.display = 'none';
        document.getElementById('btnRestablecerPin').style.display = chofer.pinPersonalizado ? '' : 'none';
        document.getElementById('modalPin').classList.add('on');
        setTimeout(() => document.getElementById('modalPinInput').focus(), 50);
    }
    function cerrarModalPin() {
        document.getElementById('modalPin').classList.remove('on');
        document.getElementById('modalPinValor').innerText = '';
        choferEnModal = null;
        cargarChoferes();
    }
    async function enviarPin(cuerpo) {
        const error = document.getElementById('modalPinError');
        error.innerText = '';
        const botones = document.querySelectorAll('#modalPinFormulario button');
        botones.forEach(b => b.disabled = true);
        try {
            const res = await adminFetch('/api/admin/chofer/pin', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(Object.assign({ nombre: choferEnModal.nombre }, cuerpo))
            });
            const datos = await res.json().catch(() => ({}));
            if (!res.ok) { error.innerText = datos.error || 'No se pudo guardar el PIN.'; return; }
            document.getElementById('modalPinValor').innerText = datos.pin;
            document.getElementById('modalPinFormulario').style.display = 'none';
            document.getElementById('modalPinResultado').style.display = '';
        } catch (err) {
            if (err.message !== 'SESION') error.innerText = 'No se pudo conectar con el servidor.';
            else document.getElementById('modalPin').classList.remove('on');
        } finally {
            botones.forEach(b => b.disabled = false);
        }
    }
    document.getElementById('btnGuardarPin').onclick = () => {
        const pin = document.getElementById('modalPinInput').value.trim();
        if (!/^\d{4,8}$/.test(pin)) { document.getElementById('modalPinError').innerText = 'El PIN debe tener entre 4 y 8 números.'; return; }
        enviarPin({ pin });
    };
    document.getElementById('btnGenerarPin').onclick = () => enviarPin({ generar: true });
    document.getElementById('btnRestablecerPin').onclick = () => enviarPin({ restablecer: true });
    document.getElementById('btnCopiarNuevoPin').onclick = (ev) => copiarPin(document.getElementById('modalPinValor').innerText, ev.currentTarget);
    document.getElementById('modalPinInput').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, ''); });
    document.getElementById('modalPinInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('btnGuardarPin').click(); });

    // ---------- Descargar a Excel ----------
    function fechaISO(d) {
        const p = n => String(n).padStart(2, '0');
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    }
    function periodoExport(tipo) {
        const hoy = new Date();
        let desde, hasta;
        if (tipo === 'mesAnterior') {
            desde = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1);
            hasta = new Date(hoy.getFullYear(), hoy.getMonth(), 0);
        } else {
            desde = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
            hasta = hoy;
        }
        document.getElementById('expDesde').value = fechaISO(desde);
        document.getElementById('expHasta').value = fechaISO(hasta);
    }
    periodoExport('mes');

    function irAExportar() {
        cambiarVistaAdmin('checklists', document.querySelectorAll('.nav-btn')[1]);
        setTimeout(() => document.getElementById('tarjetaExportar').scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
    }

    async function exportarExcel(tipo, boton) {
        const estado = document.getElementById('expEstado');
        const desde = document.getElementById('expDesde').value;
        const hasta = document.getElementById('expHasta').value;
        estado.className = 'export-estado';
        if (!desde || !hasta) { estado.className = 'export-estado error'; estado.innerText = 'Elegí las fechas Desde y Hasta.'; return; }
        if (hasta < desde) { estado.className = 'export-estado error'; estado.innerText = 'La fecha Hasta no puede ser anterior a Desde.'; return; }
        const botones = document.querySelectorAll('#tarjetaExportar button');
        botones.forEach(b => b.disabled = true);
        estado.innerText = 'Generando el Excel…';
        try {
            const res = await adminFetch('/api/admin/exportar/' + tipo + '?desde=' + encodeURIComponent(desde) + '&hasta=' + encodeURIComponent(hasta));
            if (!res.ok) {
                const datos = await res.json().catch(() => ({}));
                estado.className = 'export-estado error';
                estado.innerText = datos.error || 'No se pudo generar el Excel.';
                return;
            }
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = (tipo === 'checklists' ? 'checklists_' : 'odometro_') + desde + '_a_' + hasta + '.xlsx';
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
            estado.className = 'export-estado ok';
            estado.innerText = '✔ Descargado: ' + a.download;
        } catch (err) {
            if (err.message !== 'SESION') { estado.className = 'export-estado error'; estado.innerText = 'No se pudo conectar con el servidor.'; }
        } finally {
            botones.forEach(b => b.disabled = false);
        }
    }

    // ---------- Estado de la base de datos ----------
    async function revisarBaseDatos() {
        const pill = document.getElementById('pillDb');
        const txt = document.getElementById('lblDb');
        try {
            const res = await fetch('/api/estado');
            const d = await res.json();
            if (d.db === 'ok') { pill.className = 'live-pill pill-db ok'; txt.innerText = 'Base de datos OK'; }
            else if (d.db === 'conectando') { pill.className = 'live-pill pill-db mal'; txt.innerText = 'Base de datos conectando…'; }
            else { pill.className = 'live-pill pill-db mal'; txt.innerText = 'Falta DATABASE_URL'; }
        } catch (e) {
            pill.className = 'live-pill pill-db mal'; txt.innerText = 'Servidor sin respuesta';
        }
    }
    revisarBaseDatos();
    setInterval(revisarBaseDatos, 30000);

    // =====================================================================
    //  ORDEN DE REPARTO (propuestas de los choferes)
    // =====================================================================
    let listaOrden = [];
    let ordenAbierta = null;
    const ESTADOS_ORDEN = {
        enviada: ['badge badge-warn', 'Para revisar'],
        aprobada: ['badge badge-info', 'Aprobada · falta cargar'],
        aplicada: ['badge badge-ok', 'Cargada en Gescom'],
        rechazada: ['badge badge-falla', 'Rechazada']
    };
    const NOMBRE_DIA = { lunes: 'Lunes', martes: 'Martes', miercoles: 'Miércoles', jueves: 'Jueves', viernes: 'Viernes', sabado: 'Sábado', domingo: 'Domingo' };

    function mensajeOrden(texto, tipo) {
        const e = document.getElementById('ordenEstado');
        e.className = 'export-estado' + (tipo ? ' ' + tipo : '');
        e.innerText = texto || '';
    }

    let ordPagina = 1;
    const ORD_POR_PAGINA = 10;
    function ordFiltrar() { ordPagina = 1; pintarOrden(); }
    async function cargarOrden() {
        const cuerpo = document.querySelector('#tabla-orden tbody');
        try {
            const res = await adminFetch('/api/admin/orden');
            if (!res.ok) throw new Error('HTTP ' + res.status);
            listaOrden = await res.json();
        } catch (err) {
            if (err.message === 'SESION') return;
            cuerpo.innerHTML = '<tr><td colspan="7" class="empty-row">No se pudieron cargar las propuestas. Revisá que la base de datos esté conectada.</td></tr>';
            return;
        }
        const pendientes = listaOrden.filter(p => p.estado === 'enviada').length;
        const btn = document.getElementById('btnOrdenDock');
        if (btn) btn.classList.toggle('con-aviso', pendientes > 0);
        // zonas disponibles para el filtro
        const selZ = document.getElementById('ordFZona');
        if (selZ) {
            const actual = selZ.value;
            const zonas = [...new Set(listaOrden.map(p => p.ruta).filter(Boolean))].sort();
            selZ.innerHTML = '<option value="">Todas las zonas</option>' + zonas.map(z => `<option value="${escapeHtml(z)}">${escapeHtml(z)}</option>`).join('');
            if (zonas.includes(actual)) selZ.value = actual;
        }
        const poner = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
        poner('impRevisar', pendientes);
        poner('impFalta', listaOrden.filter(p => p.estado === 'aprobada').length);
        pintarOrden();
    }
    function pintarOrden() {
        const cuerpo = document.querySelector('#tabla-orden tbody');
        const q = ordImpNorm(document.getElementById('ordBuscar').value);
        const fz = document.getElementById('ordFZona').value;
        const fd = document.getElementById('ordFDia').value;
        const fe = document.getElementById('ordFEstado').value;
        const lista = listaOrden.filter(p =>
            (!q || ordImpNorm(p.chofer + ' ' + p.ruta).includes(q)) &&
            (!fz || p.ruta === fz) &&
            (!fd || (fd === '__todos' ? !p.dia : p.dia === fd)) &&
            (!fe || p.estado === fe));
        const total = lista.length;
        const paginas = Math.max(1, Math.ceil(total / ORD_POR_PAGINA));
        if (ordPagina > paginas) ordPagina = paginas;
        const desde = (ordPagina - 1) * ORD_POR_PAGINA;
        const info = document.getElementById('ordTotal');
        const pag = document.getElementById('ordPag');
        if (!listaOrden.length) {
            cuerpo.innerHTML = '<tr><td colspan="7" class="empty-row">Todavía no hay propuestas de orden. Cuando un chofer envíe una, aparece acá.</td></tr>';
            info.textContent = ''; pag.innerHTML = ''; return;
        }
        if (!total) {
            cuerpo.innerHTML = '<tr><td colspan="7" class="empty-row">Ninguna propuesta coincide con los filtros.</td></tr>';
            info.textContent = '0 de ' + listaOrden.length + ' propuestas'; pag.innerHTML = ''; return;
        }
        cuerpo.innerHTML = '';
        lista.slice(desde, desde + ORD_POR_PAGINA).forEach(p => {
            const [clase, texto] = ESTADOS_ORDEN[p.estado] || ['badge', p.estado];
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><span class="${clase}">${escapeHtml(texto)}</span></td>
                <td><b>${escapeHtml(p.chofer)}</b></td>
                <td>${escapeHtml(p.ruta)}</td>
                <td>${p.dia ? escapeHtml(NOMBRE_DIA[p.dia] || p.dia) : 'Todos'}</td>
                <td class="num">${Number(p.cambios)}</td>
                <td>${p.enviado ? escapeHtml(formatoFechaHora(p.enviado)) : '-'}</td>
                <td><div class="acciones"></div></td>`;
            const acc = tr.querySelector('.acciones');
            const bVer = document.createElement('button');
            bVer.type = 'button'; bVer.className = 'btn-suave btn-mini'; bVer.textContent = '👁 Ver';
            bVer.onclick = () => abrirOrden(p.id);
            acc.appendChild(bVer);
            if (p.estado === 'aprobada' || p.estado === 'aplicada') {
                const bX = document.createElement('button');
                bX.type = 'button'; bX.className = 'btn-suave btn-mini'; bX.textContent = '📥 Excel';
                bX.onclick = (ev) => descargarOrden(p.id, ev.currentTarget);
                acc.appendChild(bX);
            }
            cuerpo.appendChild(tr);
        });
        info.textContent = `Mostrando ${desde + 1}–${Math.min(desde + ORD_POR_PAGINA, total)} de ${total} propuestas`;
        pag.innerHTML = '';
        if (paginas > 1) {
            const mk = (txt, pg, act, dis) => {
                const b = document.createElement('button');
                b.type = 'button'; b.textContent = txt; b.className = 'pag-btn' + (act ? ' act' : '');
                b.disabled = !!dis; b.onclick = () => { ordPagina = pg; pintarOrden(); };
                pag.appendChild(b);
            };
            mk('‹', ordPagina - 1, false, ordPagina === 1);
            for (let i = 1; i <= paginas; i++) mk(String(i), i, i === ordPagina);
            mk('›', ordPagina + 1, false, ordPagina === paginas);
        }
    }

    async function abrirOrden(id) {
        try {
            const res = await adminFetch('/api/admin/orden/' + id);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            ordenAbierta = await res.json();
        } catch (err) {
            if (err.message !== 'SESION') mensajeOrden('No se pudo abrir la propuesta.', 'error');
            return;
        }
        const p = ordenAbierta;
        const items = p.items || [];
        const cambian = items.filter(i => i.cambio || i.baja);
        document.getElementById('ordenTitulo').innerText = 'Zona ' + p.ruta + (p.dia ? ' · ' + (NOMBRE_DIA[p.dia] || p.dia) : '') + ' · ' + p.chofer;
        document.getElementById('ordenSub').innerText = cambian.length + ' de ' + items.length + ' clientes cambian de lugar o se dan de baja.';
        const altas = items.filter(i => (i.antes === null || i.antes <= 0) && !i.baja).length;
        const bajas = items.filter(i => i.baja).length;
        document.getElementById('ordenResumen').innerHTML =
            `<span class="${(ESTADOS_ORDEN[p.estado] || ['badge'])[0]}">${escapeHtml((ESTADOS_ORDEN[p.estado] || ['', p.estado])[1])}</span>` +
            (altas ? `<span class="badge badge-warn">${altas} cliente${altas > 1 ? 's' : ''} sin orden, ubicado${altas > 1 ? 's' : ''}</span>` : '') +
            (bajas ? `<span class="badge badge-falla">🚫 ${bajas} baja${bajas > 1 ? 's' : ''}</span>` : '') +
            (p.nota ? `<span class="badge">Nota: ${escapeHtml(p.nota)}</span>` : '');
        const filas = document.getElementById('ordenFilas');
        filas.innerHTML = '';
        if (!cambian.length) filas.innerHTML = '<tr><td colspan="5" class="empty-row">Sin cambios.</td></tr>';
        cambian.forEach(i => {
            const tr = document.createElement('tr');
            tr.className = 'ord-cambio-fila';
            const antes = i.antes === null || i.antes === undefined ? '-' : (i.antes <= 0 ? i.antes + ' (sin orden)' : i.antes);
            const que = i.baja ? '<span class="ord-baja-txt">BAJA</span>' : (i.antes === null || i.antes <= 0 ? '<span class="ord-sube">Sin orden → ubicado</span>' : (i.nuevo < i.antes ? '<span class="ord-sube">▲ Sube</span>' : '▼ Baja de lugar'));
            tr.innerHTML = `<td><b>${escapeHtml(i.nombre)}</b>${i.codigo ? '<br><span style="color:var(--muted);font-size:.75rem;">Cód. ' + escapeHtml(i.codigo) + '</span>' : ''}</td>
                <td>${escapeHtml([i.direccion, i.localidad].filter(Boolean).join(' · '))}</td>
                <td class="num">${escapeHtml(String(antes))}</td>
                <td class="num"><b>${i.nuevo === null || i.nuevo === undefined ? '-' : i.nuevo}</b></td>
                <td>${que}</td>`;
            filas.appendChild(tr);
        });
        // Acciones según el estado
        const acc = document.getElementById('ordenAcciones');
        acc.innerHTML = '';
        const boton = (txt, clase, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = clase; b.textContent = txt; b.onclick = fn; acc.appendChild(b); };
        document.getElementById('ordenNota').value = '';
        document.getElementById('ordenNotaWrap').style.display = p.estado === 'enviada' || p.estado === 'aprobada' ? '' : 'none';
        if (p.estado === 'enviada') {
            boton('✔ Aprobar', '', () => cambiarEstadoOrden('aprobada'));
            boton('✖ Rechazar', 'btn-suave', () => cambiarEstadoOrden('rechazada'));
        } else if (p.estado === 'aprobada') {
            boton('📥 Bajar Excel', '', (ev) => descargarOrden(p.id, ev.currentTarget));
            boton('✔ Ya la cargué en Gescom', 'btn-suave', () => cambiarEstadoOrden('aplicada'));
            boton('✖ Rechazar', 'btn-suave', () => cambiarEstadoOrden('rechazada'));
        } else if (p.estado === 'aplicada') {
            boton('📥 Bajar Excel', 'btn-suave', (ev) => descargarOrden(p.id, ev.currentTarget));
        }
        document.getElementById('modalOrden').classList.add('on');
    }
    function cerrarOrden() { document.getElementById('modalOrden').classList.remove('on'); ordenAbierta = null; }

    async function cambiarEstadoOrden(estado) {
        if (!ordenAbierta) return;
        const nota = document.getElementById('ordenNota').value.trim();
        try {
            const res = await adminFetch('/api/admin/orden/' + ordenAbierta.id + '/estado', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ estado, nota })
            });
            const d = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(d.error || 'No se pudo actualizar');
            cerrarOrden();
            mensajeOrden(estado === 'aprobada' ? '✔ Aprobada. Ya podés bajar el Excel.' : estado === 'aplicada' ? '✔ Marcada como cargada en Gescom.' : '✔ Rechazada. El chofer va a ver tu nota.', 'ok');
            cargarOrden();
        } catch (err) {
            if (err.message !== 'SESION') mensajeOrden(err.message || 'No se pudo actualizar.', 'error');
        }
    }

    async function descargarOrden(id, boton) {
        if (boton) boton.disabled = true;
        mensajeOrden('Generando el Excel…');
        try {
            const res = await adminFetch('/api/admin/exportar/orden' + (id ? '?id=' + id : '?estado=aprobada'));
            if (!res.ok) {
                const d = await res.json().catch(() => ({}));
                mensajeOrden(d.error || 'No se pudo generar el Excel.', 'error');
                return;
            }
            const blob = await res.blob();
            const m = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '');
            const nombre = m ? m[1] : 'orden_reparto.xlsx';
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = nombre;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
            mensajeOrden('✔ Descargado: ' + nombre, 'ok');
        } catch (err) {
            if (err.message !== 'SESION') mensajeOrden('No se pudo conectar con el servidor.', 'error');
        } finally {
            if (boton) boton.disabled = false;
        }
    }

    // =====================================================================
    //  DOCUMENTACIÓN: panel por camión y por chofer
    // =====================================================================
    let docsAdm = null, docEdit = null;
    const DOC_ETIQ = { vencido: '⛔ Vencido', ultimo: '🚨 Último aviso', aviso: '⚠ Por vencer', falta: 'Sin cargar', ok: 'Vigente', na: 'No aplica' };

    function docFecha(f) { return f ? f.split('-').reverse().join('/') : ''; }
    function docMensajeAdm(t, tipo) { const e = document.getElementById('docsEstadoAdm'); e.className = 'export-estado' + (tipo ? ' ' + tipo : ''); e.innerText = t || ''; }

    async function cargarDocs() {
        try {
            const res = await adminFetch('/api/admin/docs/resumen');
            if (!res.ok) throw new Error('HTTP ' + res.status);
            docsAdm = await res.json();
        } catch (err) {
            if (err.message === 'SESION') return;
            document.getElementById('docsAtencion').innerHTML = '<tr><td colspan="4" class="empty-row">No se pudo cargar la documentación. Revisá que la base de datos esté conectada.</td></tr>';
            return;
        }
        const d = docsAdm, c = d.contadores;
        const btn = document.getElementById('btnDocsDock');
        if (btn) btn.classList.toggle('con-aviso', c.vencidos + c.ultimo + c.alertasCarga > 0);
        document.getElementById('docsContadores').innerHTML =
            `<span class="badge badge-falla">⛔ ${c.vencidos} vencido${c.vencidos === 1 ? '' : 's'}</span>` +
            `<span class="badge badge-falla">🚨 ${c.ultimo} último aviso (≤${d.diasUltimo} días)</span>` +
            `<span class="badge badge-warn">⚠ ${c.aviso} por vencer (≤${d.diasAviso} días)</span>` +
            `<span class="badge">Sin cargar: ${c.faltan}</span>` +
            `<span class="badge ${c.sinMensual ? 'badge-warn' : 'badge-ok'}">Choferes sin check-list de ${escapeHtml(d.periodo)}: ${c.sinMensual}</span>`;
        document.getElementById('docsAlertas').innerHTML = d.alertas.length
            ? '<div class="doc-sub">🔔 Cargas con alerta (últimos 60 días)</div>' + d.alertas.map(a =>
                `<div class="doc-alerta"><b>${escapeHtml(a.nombre)}</b> · ${escapeHtml(a.doc)}: ${a.alerta === 'vencida_al_cargar' ? 'se cargó una fecha YA VENCIDA' : 'se cargó una fecha MENOR a la anterior'} (${escapeHtml(docFecha(a.fecha_nueva))}${a.fecha_anterior ? ', antes ' + escapeHtml(docFecha(a.fecha_anterior)) : ''})<small>${escapeHtml(formatoFechaHora(a.creado))} · por ${escapeHtml(a.por || '')}</small></div>`).join('')
            : '';
        document.getElementById('docsAtencion').innerHTML = d.atencion.length ? d.atencion.map(a => {
            const cls = a.estado === 'aviso' ? 'badge-warn' : a.estado === 'falta' ? '' : 'badge-falla';
            const cuando = a.estado === 'falta' ? '—' : docFecha(a.fecha) + (a.dias < 0 ? ` (hace ${-a.dias} d)` : ` (en ${a.dias} d)`);
            return `<tr><td><span class="badge ${cls}">${DOC_ETIQ[a.estado]}</span></td><td>${escapeHtml(a.de === 'camion' ? '🚚 ' + a.nombre : '👤 ' + a.nombre)}</td><td>${escapeHtml(a.doc)}</td><td>${cuando}</td></tr>`;
        }).join('') : '<tr><td colspan="4" class="empty-row">✅ Todo vigente. No hay nada para atender.</td></tr>';
        const tCam = d.tipos.filter(t => t.aplica === 'camion'), tCho = d.tipos.filter(t => t.aplica === 'chofer');
        const celda = (aplica, sujeto, nombre, x) => {
            const txt = x.estado === 'falta' ? 'Sin cargar' : x.estado === 'na' ? 'No aplica' : x.sin_fecha === 'no_vence' ? 'No vence' : docFecha(x.fecha);
            const sub = x.dias != null && x.fecha ? (x.dias < 0 ? `hace ${-x.dias} d` : x.dias + ' d') : '';
            return `<td><span class="doc-celda ${x.estado}" onclick="abrirDoc('${aplica}','${escapeHtml(sujeto).replace(/'/g, '&#39;')}','${x.tipo}')">${escapeHtml(txt)}${sub ? '<small>' + sub + '</small>' : ''}</span></td>`;
        };
        document.getElementById('docsTablaCamiones').innerHTML = d.camiones.length
            ? '<thead><tr><th>Camión</th>' + tCam.map(t => `<th>${escapeHtml(t.nombre)}</th>`).join('') + '<th></th></tr></thead><tbody>' +
              d.camiones.map(c => `<tr><td><b>${escapeHtml(c.dominio)}</b></td>${c.docs.map(x => celda('camion', c.dominio, c.dominio, x)).join('')}<td><button type="button" class="btn-suave" onclick="verHistorialDoc('camion','${escapeHtml(c.dominio)}','${escapeHtml(c.dominio)}')">Historial</button> <button type="button" class="btn-suave" onclick="quitarCamionDoc('${escapeHtml(c.dominio)}', true)">Quitar</button></td></tr>`).join('') + '</tbody>'
            : '<tbody><tr><td class="empty-row">Todavía no hay camiones. Aparecen cuando un chofer hace un check-list o carga documentación.</td></tr></tbody>';
        document.getElementById('docsCamionesOcultos').innerHTML = (d.camionesOcultos || []).length
            ? '<small style="color:var(--muted)">Quitados de la lista:</small> ' + d.camionesOcultos.map(x => `<button type="button" class="btn-suave" onclick="quitarCamionDoc('${escapeHtml(x)}', false)">↩ ${escapeHtml(x)}</button>`).join(' ')
            : '';
        document.getElementById('docsTablaChoferes').innerHTML = d.choferes.length
            ? '<thead><tr><th>Chofer</th><th>Check-list del mes</th>' + tCho.map(t => `<th>${escapeHtml(t.nombre)}</th>`).join('') + '<th></th></tr></thead><tbody>' +
              d.choferes.map(c => `<tr><td><b>${escapeHtml(c.nombre)}</b></td><td>${c.mensual.hecho ? '<span class="badge badge-ok">✔ Hecho' + (c.mensual.dominio ? ' · ' + escapeHtml(c.mensual.dominio) : '') + '</span>' : '<span class="badge badge-warn">Pendiente</span>'}</td>${c.docs.map(x => celda('chofer', c.clave, c.nombre, x)).join('')}<td><button type="button" class="btn-suave" onclick="verHistorialDoc('chofer','${escapeHtml(c.clave)}','${escapeHtml(c.nombre)}')">Historial</button></td></tr>`).join('') + '</tbody>'
            : '<tbody><tr><td class="empty-row">No hay choferes activos.</td></tr></tbody>';
    }

    async function quitarCamionDoc(dominio, oculto) {
        if (oculto && !confirm('¿Quitar ' + dominio + ' de la lista de documentación? Deja de aparecer en los controles y avisos. Podés volver a mostrarlo cuando quieras.')) return;
        try {
            const res = await adminFetch('/api/admin/docs/camion-oculto', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dominio, oculto }) });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            cargarDocs();
        } catch (err) { if (err.message !== 'SESION') alert('No se pudo actualizar el camión.'); }
    }

    function abrirDoc(aplica, sujeto, tipo) {
        const lista = aplica === 'camion' ? docsAdm.camiones.find(c => c.dominio === sujeto) : docsAdm.choferes.find(c => c.clave === sujeto);
        const x = lista && lista.docs.find(d => d.tipo === tipo);
        if (!x) return;
        const nombre = aplica === 'camion' ? sujeto : lista.nombre;
        docEdit = { aplica, sujeto, tipo };
        document.getElementById('docModalFecha').style.display = '';
        document.getElementById('docModalTitulo').innerText = x.nombre;
        document.getElementById('docModalSub').innerText = (aplica === 'camion' ? 'Camión ' : 'Chofer ') + nombre + ' · ' + (x.estado === 'falta' ? 'sin cargar' : x.estado === 'na' ? 'no aplica' : x.sin_fecha === 'no_vence' ? 'no vence' : 'vence el ' + docFecha(x.fecha));
        document.getElementById('docModalFecha').value = x.fecha || '';
        document.getElementById('docModalError').innerText = '';
        document.getElementById('docModalAcciones').innerHTML =
            '<button type="button" onclick="guardarDocAdm(\'fecha\')">Guardar fecha</button>' +
            (x.permite_sin_fecha ? '<button type="button" class="btn-suave" onclick="guardarDocAdm(\'no_vence\')">No vence</button><button type="button" class="btn-suave" onclick="guardarDocAdm(\'no_aplica\')">No aplica</button>' : '');
        document.getElementById('docModalHist').innerHTML = '';
        document.getElementById('modalDoc').classList.add('on');
        cargarHistorialDoc(aplica, sujeto, tipo);
    }
    function cerrarModalDoc() { document.getElementById('modalDoc').classList.remove('on'); }
    async function cargarHistorialDoc(aplica, sujeto, tipo) {
        try {
            const r = await adminFetch('/api/admin/docs/historial?aplica=' + aplica + '&sujeto=' + encodeURIComponent(sujeto));
            const h = (await r.json()).filter(f => !tipo || f.tipo === tipo);
            const acc = { nuevo: 'Cargó', actualizo: 'Actualizó', confirmo: 'Confirmó' };
            document.getElementById('docModalHist').innerHTML = h.length ? '<b>Historial</b>' + h.map(f =>
                `<div>${escapeHtml(formatoFechaHora(f.creado))} · ${escapeHtml(tipo ? '' : f.doc + ' · ')}${acc[f.accion] || f.accion} ${f.sin_fecha ? escapeHtml(f.sin_fecha === 'no_vence' ? '"no vence"' : '"no aplica"') : escapeHtml(docFecha(f.fecha_nueva))} (${escapeHtml(f.por || '')})${f.alerta ? ' 🔔' : ''}</div>`).join('') : 'Sin movimientos todavía.';
        } catch (e) { if (e.message !== 'SESION') document.getElementById('docModalHist').innerText = 'No se pudo leer el historial.'; }
    }
    function verHistorialDoc(aplica, sujeto, nombre) {
        docEdit = null;
        document.getElementById('docModalTitulo').innerText = 'Historial';
        document.getElementById('docModalSub').innerText = nombre;
        document.getElementById('docModalFecha').style.display = 'none';
        document.getElementById('docModalAcciones').innerHTML = '';
        document.getElementById('docModalError').innerText = '';
        document.getElementById('modalDoc').classList.add('on');
        cargarHistorialDoc(aplica, sujeto, '');
    }
    async function guardarDocAdm(accion) {
        if (!docEdit) return;
        const fecha = document.getElementById('docModalFecha').value;
        try {
            const r = await adminFetch('/api/admin/docs/valor', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...docEdit, accion, fecha }) });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) { document.getElementById('docModalError').innerText = d.error || 'No se pudo guardar'; return; }
            cerrarModalDoc();
            cargarDocs();
        } catch (e) { if (e.message !== 'SESION') document.getElementById('docModalError').innerText = 'No se pudo conectar con el servidor.'; }
    }

    async function descargarDocs(boton) {
        boton.disabled = true; docMensajeAdm('Generando el Excel…');
        try {
            const res = await adminFetch('/api/admin/exportar/documentos');
            if (!res.ok) { const d = await res.json().catch(() => ({})); docMensajeAdm(d.error || 'No se pudo generar el Excel.', 'error'); return; }
            const blob = await res.blob();
            const m = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '');
            const nombre = m ? m[1] : 'documentacion.xlsx';
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = url; a.download = nombre;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
            docMensajeAdm('✔ Descargado: ' + nombre, 'ok');
        } catch (e) { if (e.message !== 'SESION') docMensajeAdm('No se pudo conectar con el servidor.', 'error'); }
        finally { boton.disabled = false; }
    }

    // ---- Documentos a controlar (tipos) ----
    async function abrirTiposDoc() {
        document.getElementById('docTiposError').innerText = '';
        document.getElementById('modalDocTipos').classList.add('on');
        await pintarTiposDoc();
    }
    async function pintarTiposDoc() {
        try {
            const r = await adminFetch('/api/admin/docs/tipos');
            const t = await r.json();
            document.getElementById('docTiposLista').innerHTML = t.map(x =>
                `<div class="doc-tipo-fila"><input type="text" class="campo" value="${escapeHtml(x.nombre)}" maxlength="60" id="dt_${x.clave}">` +
                `<span class="badge badge-info">${x.aplica === 'camion' ? '🚚' : '👤'}</span>` +
                `<button type="button" class="btn-suave" onclick="guardarTipoDoc('${x.clave}','${x.aplica}',${x.orden},${x.permite_sin_fecha ? 'true' : 'false'},${x.activo ? 'false' : 'true'},true)">Renombrar</button>` +
                `<button type="button" class="btn-suave" onclick="guardarTipoDoc('${x.clave}','${x.aplica}',${x.orden},${x.permite_sin_fecha ? 'true' : 'false'},${x.activo ? 'false' : 'true'},false)">${x.activo ? 'Desactivar' : 'Activar'}</button></div>`).join('');
        } catch (e) { if (e.message !== 'SESION') document.getElementById('docTiposError').innerText = 'No se pudieron leer los documentos.'; }
    }
    async function guardarTipoDoc(clave, aplica, orden, permite, nuevoActivoInverso, soloNombre) {
        const nombre = document.getElementById('dt_' + clave).value.trim();
        // nuevoActivoInverso = estado contrario al actual; si solo renombra, se mantiene el actual
        const activoActual = !nuevoActivoInverso;
        const activo = soloNombre ? activoActual : nuevoActivoInverso;
        try {
            const r = await adminFetch('/api/admin/docs/tipos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clave, nombre, aplica, orden, permite_sin_fecha: permite, activo }) });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) { document.getElementById('docTiposError').innerText = d.error || 'No se pudo guardar'; return; }
            await pintarTiposDoc();
        } catch (e) { if (e.message !== 'SESION') document.getElementById('docTiposError').innerText = 'No se pudo conectar.'; }
    }
    async function agregarTipoDoc() {
        const nombre = document.getElementById('docNuevoNombre').value.trim();
        const aplica = document.getElementById('docNuevoAplica').value;
        try {
            const r = await adminFetch('/api/admin/docs/tipos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nombre, aplica, orden: 60 }) });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) { document.getElementById('docTiposError').innerText = d.error || 'No se pudo guardar'; return; }
            document.getElementById('docNuevoNombre').value = '';
            document.getElementById('docTiposError').innerText = '';
            await pintarTiposDoc();
        } catch (e) { if (e.message !== 'SESION') document.getElementById('docTiposError').innerText = 'No se pudo conectar.'; }
    }

    // =====================================================================
    //  RETORNO DE CAMIONES (control del Encargado de Depósito)
    // =====================================================================
    let retornosAdm = [];
    function hoyArAdm() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }); }
    function retMensaje(t, tipo) { const e = document.getElementById('retEstado'); e.className = 'export-estado' + (tipo ? ' ' + tipo : ''); e.innerText = t || ''; }
    function retParams() {
        const p = new URLSearchParams({ desde: document.getElementById('retDesde').value, hasta: document.getElementById('retHasta').value });
        if (document.getElementById('retChofer').value) p.set('chofer', document.getElementById('retChofer').value);
        if (document.getElementById('retTexto').value.trim()) p.set('q', document.getElementById('retTexto').value.trim());
        return p;
    }
    // ---------- Jornadas ----------
    function jorParams() {
        const p = new URLSearchParams({ desde: document.getElementById('jorDesde').value, hasta: document.getElementById('jorHasta').value });
        const c = document.getElementById('jorChofer').value; if (c) p.set('chofer', c);
        return p.toString();
    }
    function jorMensaje(t, clase) { const e = document.getElementById('jorEstado'); e.textContent = t || ''; e.className = 'export-estado' + (clase ? ' ' + clase : ''); }
    async function iniciarJornadas() {
        if (!document.getElementById('jorDesde').value) {
            document.getElementById('jorHasta').value = hoyArAdm();
            document.getElementById('jorDesde').value = new Date(Date.parse(hoyArAdm() + 'T00:00:00Z') - 6 * 86400000).toISOString().slice(0, 10);
            try {
                const r = await adminFetch('/api/retorno/choferes');
                if (r.ok) document.getElementById('jorChofer').innerHTML = '<option value="">Todos los choferes</option>' + (await r.json()).map(n => `<option>${escapeHtml(n)}</option>`).join('');
            } catch (e) {}
        }
        cargarJornadas();
    }
    function fmtHorasMin(min) { min = Math.max(0, Math.round(min)); return Math.floor(min / 60) + ':' + String(min % 60).padStart(2, '0') + ' h'; }
    async function cargarJornadas() {
        const cuerpo = document.querySelector('#tabla-jornadas tbody');
        let d;
        try {
            const res = await adminFetch('/api/admin/jornadas?' + jorParams());
            d = await res.json().catch(() => ({}));
            if (!res.ok) { cuerpo.innerHTML = `<tr><td colspan="8" class="empty-row">${escapeHtml(d.error || 'No se pudo cargar')}</td></tr>`; return; }
        } catch (e) { if (e.message !== 'SESION') cuerpo.innerHTML = '<tr><td colspan="8" class="empty-row">No se pudo conectar con el servidor.</td></tr>'; return; }
        const enCurso = d.filas.filter(f => f.cierre === 'en_curso').length;
        const sinCierre = d.filas.filter(f => f.cierre === 'auto').length;
        jorMensaje(`${d.filas.length} jornada${d.filas.length === 1 ? '' : 's'}` + (enCurso ? ` · ${enCurso} en curso ahora` : '') + (sinCierre ? ` · ${sinCierre} sin finalizar por el chofer` : ''));
        const estado = { en_curso: '<span class="badge badge-ok">En curso</span>', manual: '<span class="badge badge-info">Finalizada</span>', auto: '<span class="badge badge-warn" title="El chofer no la finalizó: se cerró sola con la hora de su última ubicación">Cierre automático</span>', cambio: '<span class="badge badge-info" title="Cambió de camión">Cambió de camión</span>' };
        cuerpo.innerHTML = d.filas.length ? d.filas.map(f =>
            `<tr><td>${escapeHtml(docFecha(f.fecha))}</td><td><b>${escapeHtml(f.chofer)}</b></td><td>${escapeHtml(f.vehiculo)}</td><td>${formatoHora(f.inicio)}</td><td>${f.fin ? formatoHora(f.fin) : '—'}</td>
             <td class="num">${fmtHorasMin(f.minutos)}</td><td class="num">${formatoNumero(f.km, 1)}</td><td>${estado[f.cierre] || escapeHtml(f.cierre)}</td></tr>`).join('')
            : '<tr><td colspan="8" class="empty-row">No hay jornadas en esas fechas.</td></tr>';
    }
    async function descargarJornadas(boton) {
        boton.disabled = true; jorMensaje('Generando el Excel…');
        try {
            const res = await adminFetch('/api/admin/jornadas/exportar?' + jorParams());
            if (!res.ok) { const d = await res.json().catch(() => ({})); jorMensaje(d.error || 'No se pudo generar el Excel.', 'error'); return; }
            const blob = await res.blob();
            const m = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '');
            const nombre = m ? m[1] : 'jornadas.xlsx';
            const url = URL.createObjectURL(blob), a = document.createElement('a');
            a.href = url; a.download = nombre; document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
            jorMensaje('✔ Descargado: ' + nombre, 'ok');
        } catch (e) { if (e.message !== 'SESION') jorMensaje('No se pudo conectar con el servidor.', 'error'); }
        finally { boton.disabled = false; }
    }

    // ---------- Importar orden de reparto (export de Gescom) ----------
    let ordImpDatos = null; // { cab: [...], filas: [[...]] }
    function ordImpMsg(t, clase) { const e = document.getElementById('ordImpEstado'); e.textContent = t || ''; e.className = 'export-estado' + (clase ? ' ' + clase : ''); }
    async function ordImpEstado() {
        const poner = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
        try {
            const r = await adminFetch('/api/admin/orden-reparto/estado');
            if (!r.ok) return;
            const d = await r.json();
            const t = document.getElementById('ordImpEstado');
            if (!d.total) {
                poner('impClientes', '0'); poner('impClientesSub', 'todavía no se importó nada');
                poner('impUltima', 'Nunca'); poner('impUltimaSub', 'subí la planilla de Gescom');
                ordImpMsg('Todavía no se importó ningún orden de reparto.');
                return;
            }
            const f = new Date(d.actualizado);
            const dias = Math.floor((Date.now() - f.getTime()) / 86400000);
            const cuando = dias <= 0 ? 'hoy' : dias === 1 ? 'ayer' : `hace ${dias} días`;
            const fh = f.toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
            poner('impClientes', formatoNumero(d.total)); poner('impClientesSub', 'con orden de reparto cargado');
            poner('impUltima', cuando); poner('impUltimaSub', fh + (dias >= 30 ? ' · conviene reimportar' : ''));
            document.getElementById('impUltima').closest('.imp-stat').classList.toggle('aviso', dias >= 30);
            ordImpMsg(`✔ Último archivo procesado: ${formatoNumero(d.total)} clientes · ${fh}`, 'ok');
        } catch (e) {}
    }
    function ordImpNorm(t) { return String(t == null ? '' : t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim(); }
    async function ordImpLeer(inp) {
        const f = inp.files[0]; if (!f) return;
        if (typeof XLSX === 'undefined') { ordImpMsg('No se pudo cargar el lector de planillas (revisá la conexión).', 'error'); return; }
        try {
            const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
            const filas = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });
            let h = filas.findIndex(r => r.filter(c => String(c).trim() !== '').length >= 2);
            if (h < 0) { ordImpMsg('La planilla está vacía.', 'error'); return; }
            const cab = filas[h].map((c, i) => String(c).trim() || ('Columna ' + (i + 1)));
            ordImpDatos = { cab, filas: filas.slice(h + 1) };
            const n = cab.map(ordImpNorm);
            let iCod = n.findIndex(x => x === 'codigo' || x === 'cod' || x === 'cod.'); if (iCod < 0) iCod = n.findIndex(x => x.includes('codigo') && !x.includes('postal'));
            let iOrd = n.findIndex(x => x.includes('orden') && x.includes('reparto')); if (iOrd < 0) iOrd = n.findIndex(x => x.includes('reparto')); if (iOrd < 0) iOrd = n.findIndex(x => x.includes('orden'));
            const opts = cab.map((c, i) => `<option value="${i}">${escapeHtml(c)}</option>`).join('');
            document.getElementById('ordImpColCod').innerHTML = opts; document.getElementById('ordImpColOrd').innerHTML = opts;
            if (iCod >= 0) document.getElementById('ordImpColCod').value = iCod;
            if (iOrd >= 0) document.getElementById('ordImpColOrd').value = iOrd;
            document.getElementById('ordImpPaso2').style.display = '';
            ordImpMsg(iOrd < 0 ? 'No encontré una columna de "Orden de reparto". Elegila a mano; si no está en la planilla, agregá esa columna en Gescom (ícono ≡ de la grilla) y exportá de nuevo.' : `Planilla leída: ${ordImpDatos.filas.length} filas. Revisá las columnas y tocá Importar.`, iOrd < 0 ? 'error' : '');
            ordImpVista();
        } catch (e) { ordImpMsg('No se pudo leer el archivo: ' + e.message, 'error'); }
    }
    function ordImpPares() {
        const ic = Number(document.getElementById('ordImpColCod').value), io = Number(document.getElementById('ordImpColOrd').value);
        const out = [];
        (ordImpDatos ? ordImpDatos.filas : []).forEach(r => {
            const c = String(r[ic] == null ? '' : r[ic]).trim(), o = Number(String(r[io] == null ? '' : r[io]).replace(',', '.'));
            if (c && String(r[io]).trim() !== '' && Number.isFinite(o) && o > 0) out.push({ codigo: c, orden: o });
        });
        return out;
    }
    function ordImpVista() {
        const p = ordImpPares();
        document.getElementById('ordImpVista').innerHTML = `${p.length} clientes con orden (los de orden 0 se ignoran). Ejemplo: ` + (p.slice(0, 3).map(x => `código <b>${escapeHtml(x.codigo)}</b> → orden <b>${x.orden}</b>`).join(' · ') || '—');
    }
    async function ordImpEnviar(btn) {
        const p = ordImpPares();
        if (!p.length) { ordImpMsg('No hay filas con código y orden numérico.', 'error'); return; }
        btn.disabled = true; let guardados = 0, encontrados = 0;
        try {
            for (let i = 0; i < p.length; i += 2000) {
                ordImpMsg(`Importando… ${Math.min(i + 2000, p.length)} de ${p.length}`);
                const res = await adminFetch('/api/admin/orden-reparto/importar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filas: p.slice(i, i + 2000), primera: i === 0 }) });
                const d = await res.json().catch(() => ({}));
                if (!res.ok) { ordImpMsg(d.error || 'No se pudo importar.', 'error'); return; }
                guardados += d.guardados; encontrados += d.encontrados || 0;
            }
            const mal = guardados && encontrados < guardados * 0.5;
            ordImpMsg(`✔ Importados ${guardados} clientes (${encontrados} coinciden con Gescom).` + (mal ? ' ⚠ Pocos coinciden: revisá que la columna elegida como código sea la correcta.' : ''), mal ? 'error' : 'ok');
        } catch (e) { if (e.message !== 'SESION') ordImpMsg('No se pudo conectar con el servidor.', 'error'); }
        finally { btn.disabled = false; }
    }


    // ---------- Planificación de repartos y acompañantes ----------
    let planDatos = null;
    const NIVEL_CARGA = { alta: ['badge badge-falla', 'Alta'], media: ['badge badge-warn', 'Media'], baja: ['badge badge-ok', 'Baja'] };
    function planMsg(t, clase) { const e = document.getElementById('planEstado'); e.textContent = t || ''; e.className = 'export-estado' + (clase ? ' ' + clase : ''); }
    function planSumarDias(f, n) { return new Date(Date.parse(f + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10); }
    function planFechaTxt(f) {
        const t = new Date(Date.parse(f + 'T12:00:00Z')).toLocaleDateString('es-AR', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
        return t.charAt(0).toUpperCase() + t.slice(1);
    }
    function iniciarPlan() {
        const inp = document.getElementById('planFecha');
        if (!inp.value) inp.value = planSumarDias(hoyArAdm(), 1);
        cargarPlan(); cargarAcompanantes();
    }
    function planIrA(n) { document.getElementById('planFecha').value = planSumarDias(hoyArAdm(), n); cargarPlan(); }
    function planMoverDia(n) { const i = document.getElementById('planFecha'); if (!i.value) return; i.value = planSumarDias(i.value, n); cargarPlan(); }
    async function cargarPlan() {
        const fecha = document.getElementById('planFecha').value;
        const cuerpo = document.querySelector('#tabla-plan tbody');
        if (!fecha) return;
        cuerpo.innerHTML = '<tr><td colspan="7" class="empty-row">Buscando la carga en Gescom…</td></tr>';
        try {
            const res = await adminFetch('/api/admin/plan?fecha=' + fecha);
            const d = await res.json().catch(() => ({}));
            if (!res.ok) { cuerpo.innerHTML = `<tr><td colspan="7" class="empty-row">${escapeHtml(d.error || 'No se pudo cargar')}</td></tr>`; planMsg(d.detalle ? 'Detalle del error: ' + d.detalle : '', 'error'); return; }
            if (document.getElementById('planFecha').value !== fecha) return; // el usuario ya cambió de día
            planDatos = d; pintarPlan();
        } catch (e) { if (e.message !== 'SESION') cuerpo.innerHTML = '<tr><td colspan="7" class="empty-row">No se pudo conectar con el servidor.</td></tr>'; }
    }
    function pintarPlan() {
        const d = planDatos; if (!d) return;
        const cuerpo = document.querySelector('#tabla-plan tbody');
        const activos = d.acompanantes.filter(a => a.activo);
        const asignados = d.acompanantes.filter(a => a.asignacion);
        const libres = activos.filter(a => !a.asignacion);
        // Origen de los datos
        const o = document.getElementById('planOrigen');
        if (d.errorGescom) o.innerHTML = `<div class="plan-aviso err">${escapeHtml(d.errorGescom)}</div>`;
        else if (d.origen === 'estimado') o.innerHTML = `<div class="plan-aviso warn">Gescom todavía no tiene armados los repartos del <b>${escapeHtml(planFechaTxt(d.fecha))}</b>. Se muestra, como referencia, la carga del <b>${escapeHtml(planFechaTxt(d.fechaBase))}</b>. Quien se asigne verá el dato marcado como estimado.</div>`;
        else if (d.origen === 'vacio') o.innerHTML = '<div class="plan-aviso warn">No hay repartos en Gescom para ese día ni en las dos semanas anteriores.</div>';
        else o.innerHTML = '';
        // Sugeridos: los repartos más pesados sin acompañante, tantos como acompañantes libres
        const sugeridos = new Set(d.repartos.filter(r => !r.acompanantes.length && r.nivel !== 'baja').slice(0, libres.length).map(r => r.clave));
        const sinVer = asignados.filter(a => !a.asignacion.visto).length;
        const tile = (l, v, s, cls) => `<div class="imp-stat ${cls || ''}"><span class="l">${l}</span><span class="v">${v}</span><span class="s">${s}</span></div>`;
        document.getElementById('planTiles').innerHTML =
            tile('Camiones en ruta', d.repartos.length, d.origen === 'estimado' ? 'según la semana anterior' : 'con reparto en Gescom')
            + tile('Acompañantes disponibles', libres.length, `de ${activos.length} activos`)
            + tile('Ya asignados', asignados.length, asignados.length ? 'para ese día' : 'todavía ninguno', asignados.length ? '' : 'aviso')
            + tile('Sin ver todavía', sinVer, sinVer ? 'no abrieron su pantalla' : (asignados.length ? 'todos lo vieron ✔' : '—'), sinVer ? 'aviso' : '');
        // Tabla de camiones
        const opciones = r => '<option value="">+ Asignar…</option>'
            + '<optgroup label="Acompaña">' + activos.filter(a => !a.asignacion).map(a => `<option value="${escapeHtml(a.clave)}|acompanante">${escapeHtml(a.nombre)}${a.manejaReparto ? ' (maneja ' + escapeHtml(a.manejaReparto) + ')' : ''}</option>`).join('') + '</optgroup>'
            + '<optgroup label="Cubre como chofer">' + activos.filter(a => !a.asignacion).map(a => `<option value="${escapeHtml(a.clave)}|chofer">${escapeHtml(a.nombre)}</option>`).join('') + '</optgroup>';
        const max = Math.max(1, ...d.repartos.map(r => r.puntaje));
        cuerpo.innerHTML = d.repartos.length ? d.repartos.map((r, i) => {
            const [clase, texto] = NIVEL_CARGA[r.nivel] || NIVEL_CARGA.baja;
            const chips = d.acompanantes.filter(a => a.asignacion && a.asignacion.camion_clave === r.clave).map(a => {
                const ch = a.asignacion.rol === 'chofer';
                return `<span class="plan-chip${ch ? ' chofer' : ''}" title="${a.asignacion.visto ? 'Ya lo vio' : 'Todavía no lo vio'}">${ch ? '🚚' : '🧍'} ${escapeHtml(a.nombre)}${ch ? ' <small>chofer</small>' : ''} <i class="${a.asignacion.visto ? 'ok' : 'no'}">${a.asignacion.visto ? '✔' : '•'}</i><button type="button" onclick="planQuitar('${escapeHtml(a.clave)}')" aria-label="Quitar">×</button></span>`;
            }).join('');
            return `<tr><td><b>${escapeHtml(r.camion)}</b>${r.dominio ? `<div class="plan-sub">${escapeHtml(r.dominio)}</div>` : ''}${sugeridos.has(r.clave) ? ' <span class="plan-sug" title="Carga alta sin acompañante">⭐ Sugerido</span>' : ''}</td>
                <td>${escapeHtml(r.chofer || '—')}</td><td class="num">${formatoNumero(r.clientes)}</td><td class="num">${formatoNumero(r.kg)}</td>
                <td class="num">${r.km ? '~' + formatoNumero(r.km) : '<span style="color:var(--muted)">—</span>'}</td>
                <td><div class="plan-barra" title="Puntaje de carga: ${r.puntaje}/100"><span style="width:${Math.round(r.puntaje / max * 100)}%"></span></div><span class="${clase}">${texto}</span></td>
                <td><div class="plan-asig">${chips}${libres.length ? `<select class="campo plan-sel" onchange="planAsignar(${i}, this)">${opciones(r)}</select>` : (chips ? '' : '<span class="plan-sub">Sin acompañantes libres</span>')}</div></td></tr>`;
        }).join('') : '<tr><td colspan="7" class="empty-row">No hay repartos para mostrar.</td></tr>';
        // Panel de acompañantes
        const cont = document.getElementById('planAcomp');
        cont.innerHTML = d.acompanantes.length ? d.acompanantes.map(a => {
            let est, cls = '';
            if (!a.activo) { est = 'Desactivado'; cls = 'off'; }
            else if (a.asignacion) { est = (a.asignacion.rol === 'chofer' ? 'Maneja ' : 'Va en ') + escapeHtml(a.asignacion.camion) + (a.asignacion.visto ? ' · lo vio ✔' : ' · sin ver'); cls = 'on'; }
            else if (a.manejaReparto) { est = 'Figura como chofer de ' + escapeHtml(a.manejaReparto) + ' en Gescom'; cls = 'chofer'; }
            else est = 'Libre';
            return `<div class="plan-ac ${cls}"><b>${escapeHtml(a.nombre)}</b><span>${est}</span></div>`;
        }).join('') : '<p class="section-sub">Todavía no cargaste acompañantes: creá el primero en "Usuarios de acompañantes", más abajo.</p>';
        if (d.asignacionesHuerfanas && d.asignacionesHuerfanas.length)
            cont.innerHTML += `<p class="section-sub" style="grid-column:1/-1;">⚠ Hay asignaciones a camiones que ya no figuran ese día: ${d.asignacionesHuerfanas.map(a => escapeHtml(a.acompanante + ' → ' + a.camion)).join(', ')}.</p>`;
    }
    async function planAsignar(i, sel) {
        const v = sel.value; if (!v || !planDatos) return;
        const [acomp, rol] = v.split('|'), r = planDatos.repartos[i];
        sel.disabled = true;
        const a = planDatos.acompanantes.find(x => x.clave === acomp);
        if (a && a.manejaReparto && rol === 'acompanante' && !confirm(`${a.nombre} figura como chofer de ${a.manejaReparto} ese día. ¿Asignarlo igual como acompañante?`)) { sel.value = ''; sel.disabled = false; return; }
        try {
            const res = await adminFetch('/api/admin/plan/asignar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
                fecha: planDatos.fecha, acompanante: acomp, rol, camionClave: r.clave, camion: r.camion, dominio: r.dominio, chofer: r.chofer,
                clientes: r.clientes, kg: r.kg, importe: r.importe, km: r.km, estimado: planDatos.origen === 'estimado' }) });
            const d = await res.json().catch(() => ({}));
            if (!res.ok) { planMsg(d.error || 'No se pudo asignar.', 'error'); sel.disabled = false; return; }
            planMsg('✔ Asignado', 'ok'); cargarPlan();
        } catch (e) { if (e.message !== 'SESION') planMsg('No se pudo conectar con el servidor.', 'error'); sel.disabled = false; }
    }
    async function planQuitar(clave) {
        if (!planDatos) return;
        try {
            await adminFetch('/api/admin/plan/quitar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fecha: planDatos.fecha, acompanante: clave }) });
            planMsg('Asignación quitada', 'ok'); cargarPlan();
        } catch (e) {}
    }
    // Mensaje listo para pegar en el grupo de WhatsApp (hoy el supervisor lo arma a mano)
    async function copiarPlanWhatsApp(boton) {
        if (!planDatos) return;
        const asig = planDatos.acompanantes.filter(a => a.asignacion);
        if (!asig.length) { planMsg('Todavía no asignaste a nadie para ese día.', 'error'); return; }
        const num = n => Number(n).toLocaleString('es-AR', { maximumFractionDigits: 0 });
        const lineas = asig.map(a => {
            const x = a.asignacion;
            const det = [x.clientes ? num(x.clientes) + ' clientes' : '', x.kg ? num(x.kg) + ' kg' : ''].filter(Boolean).join(', ');
            return x.rol === 'chofer'
                ? `• *${a.nombre}* maneja el ${x.camion}${x.dominio ? ' (' + x.dominio + ')' : ''}${x.chofer ? ' en lugar de ' + x.chofer : ''}${det ? ' · ' + det : ''}`
                : `• *${a.nombre}* sale con *${x.chofer || 'el chofer'}* en el ${x.camion}${x.dominio ? ' (' + x.dominio + ')' : ''}${det ? ' · ' + det : ''}`;
        });
        const texto = `*Acompañantes · ${planFechaTxt(planDatos.fecha)}*\n` + lineas.join('\n');
        try { await navigator.clipboard.writeText(texto); planMsg('✔ Copiado: pegalo en WhatsApp', 'ok'); }
        catch (e) { window.prompt('Copiá este mensaje (Ctrl+C):', texto); }
    }
    // Usuarios de acompañantes
    async function cargarAcompanantes() {
        const cuerpo = document.getElementById('tablaAcomp');
        try {
            const res = await adminFetch('/api/admin/acompanantes');
            const lista = await res.json().catch(() => []);
            if (!res.ok) { cuerpo.innerHTML = '<tr><td colspan="4" class="empty-row">No se pudo cargar la lista.</td></tr>'; return; }
            cuerpo.innerHTML = lista.length ? lista.map(u => `<tr><td><b>${escapeHtml(u.nombre)}</b></td>
                <td><span class="badge ${u.activo ? 'badge-ok' : 'badge-falla'}">${u.activo ? 'Activo' : 'Desactivado'}</span></td>
                <td style="color:var(--muted);">${u.ultimo_ingreso ? escapeHtml(formatoFechaHora(u.ultimo_ingreso)) : 'Nunca'}</td>
                <td><div class="acciones"><button type="button" class="btn-suave btn-mini" onclick="pinAcompanante('${escapeHtml(u.clave)}')">Nuevo PIN</button>
                    <button type="button" class="btn-suave btn-mini" onclick="activoAcompanante('${escapeHtml(u.clave)}', ${u.activo ? 'false' : 'true'})">${u.activo ? 'Desactivar' : 'Activar'}</button></div></td></tr>`).join('')
                : '<tr><td colspan="4" class="empty-row">Todavía no hay acompañantes. Creá el primero arriba.</td></tr>';
        } catch (e) { if (e.message !== 'SESION') cuerpo.innerHTML = '<tr><td colspan="4" class="empty-row">No se pudo conectar con el servidor.</td></tr>'; }
    }
    function acMsg(t, clase) { const e = document.getElementById('acEstado'); e.textContent = t || ''; e.className = 'export-estado' + (clase ? ' ' + clase : ''); }
    async function crearAcompanante() {
        const inp = document.getElementById('acNombre'), nombre = inp.value.trim();
        if (nombre.length < 2) { acMsg('Escribí el nombre del acompañante.', 'error'); return; }
        try {
            const res = await adminFetch('/api/admin/acompanantes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nombre }) });
            const d = await res.json().catch(() => ({}));
            if (!res.ok) { acMsg(d.error || 'No se pudo crear.', 'error'); return; }
            inp.value = ''; acMsg('✔ Creado', 'ok'); mostrarPinDeposito(d.nombre, d.pin); cargarAcompanantes(); cargarPlan();
        } catch (e) { if (e.message !== 'SESION') acMsg('No se pudo conectar con el servidor.', 'error'); }
    }
    async function pinAcompanante(clave) {
        if (!confirm('¿Generar un PIN nuevo? El anterior deja de servir y se cierra su sesión.')) return;
        try {
            const res = await adminFetch('/api/admin/acompanantes/pin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clave }) });
            const d = await res.json().catch(() => ({}));
            if (res.ok) mostrarPinDeposito(d.nombre, d.pin); else acMsg(d.error || 'No se pudo cambiar el PIN.', 'error');
        } catch (e) {}
    }
    async function activoAcompanante(clave, activo) {
        try {
            await adminFetch('/api/admin/acompanantes/activo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clave, activo }) });
            cargarAcompanantes(); cargarPlan();
        } catch (e) {}
    }

    // ---------- Venta por camión ----------
    function venParams() {
        const otros = document.getElementById('venOtros').value;
        try { localStorage.setItem('flota_ven_otros', otros); } catch (e) {}
        const p = { desde: document.getElementById('venDesde').value, hasta: document.getElementById('venHasta').value };
        if (otros) p.otros = otros;
        return new URLSearchParams(p).toString();
    }
    function pintarCostoLogistico(d) {
        const T = d.totales || {}, cuerpo = document.querySelector('#tabla-venta-costos tbody');
        const p = v => v === null || v === undefined ? '<span style="color:var(--muted)">—</span>' : formatoPesos(v);
        const pct = v => v === null || v === undefined ? '<span style="color:var(--muted)">—</span>' : formatoNumero(v, 1) + ' %';
        const tile = (l, v, s, cls) => `<div class="imp-stat ${cls || ''}"><span class="l">${l}</span><span class="v">${v}</span><span class="s">${s}</span></div>`;
        const dash = '—';
        document.getElementById('venCostoTiles').innerHTML =
            tile('Costo logístico por cliente', T.costoCliente === null ? dash : formatoPesos(T.costoCliente), `${formatoNumero(T.clientes || 0)} clientes visitados`)
            + tile('Costo por km', T.costoKm === null ? dash : formatoPesos(T.costoKm), `${formatoNumero(T.km || 0, 1)} km recorridos`)
            + tile('% sobre la venta', T.pctVenta === null ? dash : formatoNumero(T.pctVenta, 1) + ' %', `${formatoPesos(T.costoLogistico || 0)} sobre ${formatoPesos(T.importe || 0)}`)
            + tile('Venta por km', T.ventaKm === null ? dash : formatoPesos(T.ventaKm), `${formatoNumero(T.camionesConCosto || 0)} camiones con datos`);
        const notas = [];
        if (T.sinPatente) notas.push(`${T.sinPatente} camión(es) sin patente asignada (usá "Asignar patentes")`);
        if (T.sinDatos) notas.push(`${T.sinDatos} sin combustible ni km en el período`);
        if (d.resumen.some(t => t.combustibleEstimado)) notas.push('* hay cargas sin costo: se estimaron con el precio promedio del período');
        notas.push(T.otrosPorDia ? `Se suman ${formatoPesos(T.otrosPorDia)} por día de camión en ruta` : 'Solo combustible (podés sumar otros costos por día arriba)');
        const n = document.getElementById('venCostoNota'); n.textContent = notas.join(' · '); n.className = 'export-estado';
        cuerpo.innerHTML = d.resumen.length ? d.resumen.map(t =>
            `<tr><td><b>${escapeHtml(t.camion)}</b></td><td>${t.dominio ? escapeHtml(t.dominio) : '<span style="color:var(--muted)">sin asignar</span>'}</td><td class="num">${formatoPesos(t.importe)}</td><td class="num">${t.km ? formatoNumero(t.km, 1) : '<span style="color:var(--muted)">—</span>'}</td><td class="num">${p(t.combustible)}${t.combustibleEstimado ? ' <span title="Incluye cargas sin costo estimadas">*</span>' : ''}</td><td class="num">${p(t.costoCliente)}</td><td class="num">${p(t.costoKm)}</td><td class="num">${pct(t.pctVenta)}</td><td class="num">${p(t.costoKg)}</td></tr>`).join('')
            : '<tr><td colspan="9" class="empty-row">No hay repartos en esas fechas.</td></tr>';
    }
    function venMensaje(t, clase) { const e = document.getElementById('venEstado'); e.textContent = t || ''; e.className = 'export-estado' + (clase ? ' ' + clase : ''); }
    function iniciarVentaCamion() {
        try { const o = localStorage.getItem('flota_ven_otros'); if (o && !document.getElementById('venOtros').value) document.getElementById('venOtros').value = o; } catch (e) {}
        if (!document.getElementById('venDesde').value) {
            const h = hoyArAdm();
            document.getElementById('venHasta').value = h;
            document.getElementById('venDesde').value = h.slice(0, 8) + '01';
        }
        cargarVentaCamion();
    }
    async function cargarVentaCamion() {
        const rc = document.querySelector('#tabla-venta-resumen tbody'), dc = document.querySelector('#tabla-venta-dia tbody');
        rc.innerHTML = dc.innerHTML = '<tr><td colspan="7" class="empty-row">Cargando…</td></tr>';
        document.querySelector('#tabla-venta-costos tbody').innerHTML = '<tr><td colspan="9" class="empty-row">Cargando…</td></tr>';
        let d;
        try {
            const res = await adminFetch('/api/admin/venta-camion?' + venParams());
            d = await res.json().catch(() => ({}));
            if (!res.ok) {
                const fila = `<tr><td colspan="7" class="empty-row">${escapeHtml(d.error || 'No se pudo cargar')}</td></tr>`;
                rc.innerHTML = dc.innerHTML = fila;
                document.querySelector('#tabla-venta-costos tbody').innerHTML = fila.replace('colspan="7"', 'colspan="9"');
                document.getElementById('venCostoTiles').innerHTML = ''; document.getElementById('venCostoNota').textContent = '';
                venMensaje(d.detalle ? 'Detalle del error: ' + d.detalle : '', 'error'); return;
            }
        } catch (e) {
            if (e.message !== 'SESION') {
                const fila = '<tr><td colspan="7" class="empty-row">No se pudo conectar con el servidor.</td></tr>';
                rc.innerHTML = dc.innerHTML = fila;
                document.querySelector('#tabla-venta-costos tbody').innerHTML = fila.replace('colspan="7"', 'colspan="9"');
            }
            return;
        }
        pintarCostoLogistico(d);
        const pat = f => f.dominio ? escapeHtml(f.dominio) : '<span style="color:var(--muted)">sin asignar</span>';
        const totImp = d.resumen.reduce((a, t) => a + t.importe, 0), totKg = d.resumen.reduce((a, t) => a + t.kg, 0), totCli = d.resumen.reduce((a, t) => a + t.clientes, 0);
        venMensaje(`${d.filas.length} reparto${d.filas.length === 1 ? '' : 's'} · ${formatoPesos(totImp)}`);
        rc.innerHTML = d.resumen.length ? d.resumen.map(t =>
            `<tr><td><b>${escapeHtml(t.camion)}</b></td><td>${pat(t)}</td><td class="num">${t.dias}</td><td class="num">${t.clientes}</td><td class="num">${formatoPesos(t.importe)}</td><td class="num">${formatoPesos(t.promedioDia)}</td><td class="num">${formatoNumero(t.kg, 1)}</td></tr>`).join('')
            + `<tr><td><b>TOTAL</b></td><td></td><td></td><td class="num"><b>${totCli}</b></td><td class="num"><b>${formatoPesos(totImp)}</b></td><td></td><td class="num"><b>${formatoNumero(totKg, 1)}</b></td></tr>`
            : '<tr><td colspan="7" class="empty-row">No hay repartos en esas fechas.</td></tr>';
        dc.innerHTML = d.filas.length ? d.filas.map(f =>
            `<tr><td>${escapeHtml(docFecha(f.fecha))}</td><td><b>${escapeHtml(f.camion)}</b></td><td>${pat(f)}</td><td>${escapeHtml(f.chofer || '')}</td><td class="num">${f.clientes}</td><td class="num">${formatoPesos(f.importe)}${f.estimado ? ' <span title="Estimado: todavía sin facturar">*</span>' : ''}</td><td class="num">${formatoNumero(f.kg, 1)}</td></tr>`).join('')
            : '<tr><td colspan="7" class="empty-row">No hay repartos en esas fechas.</td></tr>';
    }
    async function descargarVentaCamion(boton) {
        boton.disabled = true; venMensaje('Generando el Excel…');
        try {
            const res = await adminFetch('/api/admin/venta-camion/exportar?' + venParams());
            if (!res.ok) { const d = await res.json().catch(() => ({})); venMensaje(d.error || 'No se pudo generar el Excel.', 'error'); return; }
            const blob = await res.blob();
            const m = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '');
            const nombre = m ? m[1] : 'venta_por_camion.xlsx';
            const url = URL.createObjectURL(blob), a = document.createElement('a');
            a.href = url; a.download = nombre; document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
            venMensaje('✔ Descargado: ' + nombre, 'ok');
        } catch (e) { if (e.message !== 'SESION') venMensaje('No se pudo conectar con el servidor.', 'error'); }
        finally { boton.disabled = false; }
    }
    async function alternarMapeoCamiones() {
        const caja = document.getElementById('venMapeo');
        if (caja.style.display !== 'none') { caja.style.display = 'none'; return; }
        caja.style.display = '';
        const cuerpo = document.getElementById('venMapeoCuerpo');
        try {
            const res = await adminFetch('/api/admin/venta-camion/mapeo');
            const d = await res.json().catch(() => ({}));
            if (!res.ok) { cuerpo.innerHTML = `<tr><td colspan="3" class="empty-row">${escapeHtml(d.error || 'No se pudo cargar')}</td></tr>`; return; }
            document.getElementById('venDominios').innerHTML = d.dominios.map(x => `<option value="${escapeHtml(x)}">`).join('');
            window._venCamiones = d.camiones;
            cuerpo.innerHTML = d.camiones.length ? d.camiones.map((c, i) =>
                `<tr><td><b>${escapeHtml(c.nombre)}</b></td><td><input class="campo" list="venDominios" style="max-width:160px;text-transform:uppercase;" maxlength="10" value="${escapeHtml(c.dominio)}" id="venDom-${i}" placeholder="Ej: AG412KP"></td>
                 <td><button type="button" class="btn-suave" onclick="guardarPatenteCamion(${i}, this)">Guardar</button></td></tr>`).join('')
                : '<tr><td colspan="3" class="empty-row">No hay camiones en Gescom en los últimos 90 días.</td></tr>';
        } catch (e) { if (e.message !== 'SESION') cuerpo.innerHTML = '<tr><td colspan="3" class="empty-row">No se pudo conectar con el servidor.</td></tr>'; }
    }
    async function guardarPatenteCamion(i, boton) {
        boton.disabled = true;
        try {
            const res = await adminFetch('/api/admin/venta-camion/mapeo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clave: window._venCamiones[i].clave, dominio: document.getElementById('venDom-' + i).value }) });
            const d = await res.json().catch(() => ({}));
            if (!res.ok) { venMensaje(d.error || 'No se pudo guardar.', 'error'); return; }
            venMensaje('✔ Patente guardada', 'ok'); cargarVentaCamion();
        } catch (e) { if (e.message !== 'SESION') venMensaje('No se pudo conectar con el servidor.', 'error'); }
        finally { boton.disabled = false; }
    }

    // ---------- Combustible: resumen mensual ----------
    const nAR = (n, d = 0) => n === null || n === undefined ? '—' : Number(n).toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d });
    function combMesMensaje(t, clase) { const e = document.getElementById('combMesEstado'); e.textContent = t || ''; e.className = 'export-estado' + (clase ? ' ' + clase : ''); }
    function iniciarCombustibleMes() {
        const inp = document.getElementById('combMes');
        if (!inp.value) inp.value = hoyArAdm().slice(0, 7);
        cargarCombustibleMes();
    }
    async function cargarCombustibleMes() {
        const mes = document.getElementById('combMes').value; if (!mes) return;
        const cuerpo = document.querySelector('#tabla-comb-mes tbody'), kpis = document.getElementById('combMesKpis');
        combMesMensaje('Calculando…');
        try {
            const res = await adminFetch('/api/admin/combustible/resumen?mes=' + encodeURIComponent(mes));
            const d = await res.json().catch(() => ({}));
            if (!res.ok) { cuerpo.innerHTML = `<tr><td colspan="7" class="empty-row">${escapeHtml(d.error || 'No se pudo cargar')}</td></tr>`; kpis.innerHTML = ''; combMesMensaje(''); return; }
            const t = d.totales, a = d.anterior;
            const dif = (act, ant) => ant > 0 ? ` <small style="color:var(--muted)">(${act >= ant ? '+' : ''}${Math.round((act - ant) / ant * 100)}% vs mes anterior)</small>` : '';
            const kpi = (titulo, valor, extra) => `<div style="flex:1 1 150px;padding:12px 14px;border-radius:16px;border:1px solid var(--border);background:rgba(255,255,255,.04);"><div style="font-size:.7rem;letter-spacing:1px;text-transform:uppercase;color:var(--muted);">${titulo}</div><div style="font-size:1.25rem;font-weight:800;margin-top:2px;">${valor}</div><div style="font-size:.78rem;">${extra || ''}</div></div>`;
            kpis.innerHTML = kpi('Litros del mes', nAR(t.litros, 1), dif(t.litros, a.litros)) + kpi('Gasto del mes', '$ ' + nAR(t.costo, 2), dif(t.costo, a.costo)) +
                kpi('Cargas', nAR(t.cargas), '') + kpi('Consumo promedio', t.lPor100 === null ? '—' : nAR(t.lPor100, 1) + ' L/100 km', '');
            cuerpo.innerHTML = d.camiones.length ? d.camiones.map(c => `<tr><td><b>${escapeHtml(c.dominio)}</b></td><td class="num">${nAR(c.cargas)}</td><td class="num">${nAR(c.litros, 1)}</td><td class="num">${c.costo === null ? '—' : '$ ' + nAR(c.costo, 2)}</td><td class="num">${c.precioLitro === null ? '—' : '$ ' + nAR(c.precioLitro, 2)}</td><td class="num">${nAR(c.kmGps, 1)}</td><td class="num">${c.lPor100 === null ? '—' : nAR(c.lPor100, 1)}</td></tr>`).join('')
                : '<tr><td colspan="7" class="empty-row">No hay cargas de combustible en ese mes.</td></tr>';
            combMesMensaje('');
        } catch (e) { if (e.message !== 'SESION') combMesMensaje('No se pudo conectar con el servidor.', 'error'); }
    }
    async function descargarCombustibleMes(boton) {
        const mes = document.getElementById('combMes').value; if (!mes) return;
        boton.disabled = true; combMesMensaje('Generando el Excel…');
        try {
            const res = await adminFetch('/api/admin/combustible/resumen/exportar?mes=' + encodeURIComponent(mes));
            if (!res.ok) { const d = await res.json().catch(() => ({})); combMesMensaje(d.error || 'No se pudo generar el Excel.', 'error'); return; }
            const blob = await res.blob(), url = URL.createObjectURL(blob), a = document.createElement('a');
            a.href = url; a.download = `combustible_${mes}.xlsx`; document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
            combMesMensaje('✔ Descargado: combustible_' + mes + '.xlsx', 'ok');
        } catch (e) { if (e.message !== 'SESION') combMesMensaje('No se pudo conectar con el servidor.', 'error'); }
        finally { boton.disabled = false; }
    }

    async function iniciarRetornos() {
        if (!document.getElementById('retDesde').value) {
            document.getElementById('retHasta').value = hoyArAdm();
            document.getElementById('retDesde').value = new Date(Date.parse(hoyArAdm() + 'T00:00:00Z') - 30 * 86400000).toISOString().slice(0, 10);
            try {
                const r = await adminFetch('/api/retorno/choferes');
                if (r.ok) document.getElementById('retChofer').innerHTML = '<option value="">Todos los choferes</option>' + (await r.json()).map(n => `<option>${escapeHtml(n)}</option>`).join('');
            } catch (e) {}
        }
        cargarRetornos(); cargarUsuariosDeposito(); cargarRetornosPendientes();
    }
    let retPendAbierto = false, retPendDatos = null;
    function alternarRetPend() { retPendAbierto = !retPendAbierto; pintarRetPend(); }
    function pintarRetPend() {
        const caja = document.getElementById('retPendientes'); if (!caja || !retPendDatos) return;
        const d = retPendDatos, todos = d.pendientes || [];
        const antes = todos.filter(p => !p.esHoy), hoy = todos.filter(p => p.esHoy);
        if (!d.gescom) { caja.innerHTML = '<div class="pend-barra warn"><span>No se pudo revisar qué retornos faltan (Gescom no respondió).</span></div>'; return; }
        if (!todos.length) { caja.innerHTML = '<div class="pend-barra ok"><span>✔ Retornos al día</span></div>'; return; }
        const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
        const dia = f => `${DIAS[new Date(f + 'T12:00:00Z').getUTCDay()]} ${f.split('-').reverse().slice(0, 2).join('/')}`;
        const txt = antes.length
            ? `⚠️ <b>${antes.length}</b> retorno${antes.length === 1 ? '' : 's'} sin cargar${hoy.length ? ` <span class="pend-hoy">· ${hoy.length} de hoy en ruta</span>` : ''}`
            : `🚚 <b>${hoy.length}</b> camion${hoy.length === 1 ? '' : 'es'} de hoy en ruta, a la espera del retorno`;
        const grupos = new Map();
        todos.forEach(p => { if (!grupos.has(p.fecha)) grupos.set(p.fecha, []); grupos.get(p.fecha).push(p); });
        const lista = [...grupos].map(([f, ps]) => `<div class="pend-dia${ps[0].esHoy ? ' hoy' : ''}">${ps[0].esHoy ? 'Hoy · en ruta' : escapeHtml(dia(f))} <small>${ps.length}</small></div>`
            + ps.map(p => `<div class="pend-fila"><span><b>${escapeHtml(p.chofer)}</b>${p.reparto ? ' · reparto ' + escapeHtml(p.reparto) : ''}</span><small>${p.clientes} cliente${p.clientes === 1 ? '' : 's'}</small></div>`).join('')).join('');
        caja.innerHTML = `<div class="pend-barra ${antes.length ? 'err' : 'warn'}"><span>${txt}</span><button type="button" class="btn-suave" onclick="alternarRetPend()">${retPendAbierto ? 'Ocultar ▴' : 'Ver ▾'}</button></div>`
            + `<div class="pend-panel"${retPendAbierto ? '' : ' style="display:none"'}>${lista}</div>`;
    }
    async function cargarRetornosPendientes() {
        const caja = document.getElementById('retPendientes'); if (!caja) return;
        try {
            const res = await adminFetch('/api/retorno/pendientes?dias=5');
            if (!res.ok) { caja.innerHTML = ''; return; }
            retPendDatos = await res.json(); pintarRetPend();
        } catch (e) { caja.innerHTML = ''; }
    }

    async function cargarRetornos() {
        const cuerpo = document.querySelector('#tabla-retornos tbody');
        try {
            const res = await adminFetch('/api/retorno/historial?' + retParams());
            const d = await res.json().catch(() => ({}));
            if (!res.ok) { cuerpo.innerHTML = `<tr><td colspan="9" class="empty-row">${escapeHtml(d.error || 'No se pudo cargar')}</td></tr>`; return; }
            retornosAdm = d;
        } catch (e) { if (e.message !== 'SESION') cuerpo.innerHTML = '<tr><td colspan="9" class="empty-row">No se pudo conectar con el servidor.</td></tr>'; return; }
        retMensaje(retornosAdm.length >= 500 ? 'Se muestran los primeros 500 resultados: acotá las fechas.' : '');
        cuerpo.innerHTML = retornosAdm.length ? retornosAdm.map((r, k) =>
            `<tr><td>${escapeHtml(docFecha(r.fecha))}</td><td><b>${escapeHtml(r.chofer)}</b></td><td>${escapeHtml(r.reparto || '—')}</td><td>${escapeHtml(r.dominio || '')}</td>
             <td class="num">${r.cajas}</td><td class="num">${escapeHtml(String(r.total_unidades))}</td><td class="num">${r.items.length}</td><td style="color:var(--muted);">${escapeHtml(r.cargado_por)}</td>
             <td><button type="button" class="btn-suave" onclick="verRetorno(${k})">Ver</button></td></tr>`).join('')
            : '<tr><td colspan="9" class="empty-row">No hay retornos cargados con esos filtros.</td></tr>';
    }
    function verRetorno(k) {
        const r = retornosAdm[k]; if (!r) return;
        const q = document.getElementById('retTexto').value.trim().toLowerCase();
        document.getElementById('retTitulo').innerText = docFecha(r.fecha) + ' · ' + r.chofer;
        document.getElementById('retSub').innerText = `Reparto ${r.reparto || '—'}${r.dominio ? ' · ' + r.dominio : ''} · ${r.cajas} caja${r.cajas === 1 ? '' : 's'} en buen estado · cargó ${r.cargado_por}`;
        document.getElementById('retItems').innerHTML = r.items.length ? r.items.map(i =>
            `<tr${q && (i.descripcion.toLowerCase().includes(q) || String(i.codigo).toLowerCase().includes(q)) ? ' style="background:rgba(59,130,246,.14)"' : ''}><td>${escapeHtml(i.descripcion)} <small style="color:var(--muted)">${escapeHtml(i.codigo)}</small></td><td class="num">${i.cargada === null || i.cargada === undefined ? '—' : escapeHtml(String(i.cargada))}</td><td class="num"><b>${escapeHtml(String(i.retorno))}</b></td></tr>`).join('')
            : '<tr><td colspan="3" class="empty-row">No volvieron productos.</td></tr>';
        document.getElementById('retObs').innerText = r.observaciones ? '📝 ' + r.observaciones : '';
        document.getElementById('retAcciones').innerHTML = `<button type="button" class="btn-suave" onclick="borrarRetorno(${r.id})">🗑 Borrar este registro</button>`;
        document.getElementById('modalRetorno').classList.add('on');
    }
    async function borrarRetorno(id) {
        if (!confirm('¿Borrar este registro de retorno? No se puede deshacer.')) return;
        try {
            const res = await adminFetch('/api/retorno/' + id, { method: 'DELETE' });
            if (res.ok) { document.getElementById('modalRetorno').classList.remove('on'); cargarRetornos(); }
        } catch (e) {}
    }
    async function descargarRetornos(boton) {
        boton.disabled = true; retMensaje('Generando el Excel…');
        try {
            const res = await adminFetch('/api/retorno/exportar?' + retParams());
            if (!res.ok) { const d = await res.json().catch(() => ({})); retMensaje(d.error || 'No se pudo generar el Excel.', 'error'); return; }
            const blob = await res.blob();
            const m = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '');
            const nombre = m ? m[1] : 'retornos.xlsx';
            const url = URL.createObjectURL(blob), a = document.createElement('a');
            a.href = url; a.download = nombre; document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
            retMensaje('✔ Descargado: ' + nombre, 'ok');
        } catch (e) { if (e.message !== 'SESION') retMensaje('No se pudo conectar con el servidor.', 'error'); }
        finally { boton.disabled = false; }
    }

    // ---- Usuarios del depósito ----
    function mostrarPinDeposito(nombre, pin) {
        document.getElementById('pinDepTitulo').innerText = 'PIN de ' + nombre;
        document.getElementById('pinDepValor').innerText = pin;
        document.getElementById('modalPinDeposito').classList.add('on');
    }
    async function cargarUsuariosDeposito() {
        const cuerpo = document.getElementById('tablaDeposito');
        try {
            const res = await adminFetch('/api/admin/deposito');
            const lista = await res.json();
            cuerpo.innerHTML = lista.length ? lista.map(u =>
                `<tr><td><b>${escapeHtml(u.nombre)}</b></td><td>${u.activo ? '<span class="badge badge-ok">Activo</span>' : '<span class="badge badge-falla">Desactivado</span>'}</td>
                 <td style="color:var(--muted);">${u.ultimo_ingreso ? escapeHtml(formatoFechaHora(u.ultimo_ingreso)) : 'Nunca'}</td>
                 <td><button type="button" class="btn-suave" onclick="pinUsuarioDeposito('${escapeHtml(u.clave)}','${escapeHtml(u.nombre)}')">Nuevo PIN</button>
                     <button type="button" class="btn-suave" onclick="activoUsuarioDeposito('${escapeHtml(u.clave)}', ${u.activo ? 'false' : 'true'})">${u.activo ? 'Desactivar' : 'Activar'}</button></td></tr>`).join('')
                : '<tr><td colspan="4" class="empty-row">Todavía no creaste ningún usuario de depósito.</td></tr>';
        } catch (e) { if (e.message !== 'SESION') cuerpo.innerHTML = '<tr><td colspan="4" class="empty-row">No se pudo cargar la lista.</td></tr>'; }
    }
    async function crearUsuarioDeposito() {
        const nombre = document.getElementById('depNombre').value.trim();
        if (nombre.length < 2) { retMensaje('Escribí el nombre del encargado.', 'error'); return; }
        try {
            const res = await adminFetch('/api/admin/deposito', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nombre }) });
            const d = await res.json().catch(() => ({}));
            if (!res.ok) { retMensaje(d.error || 'No se pudo crear el usuario.', 'error'); return; }
            document.getElementById('depNombre').value = ''; retMensaje('');
            mostrarPinDeposito(d.nombre, d.pin); cargarUsuariosDeposito();
        } catch (e) { if (e.message !== 'SESION') retMensaje('No se pudo conectar con el servidor.', 'error'); }
    }
    async function pinUsuarioDeposito(clave, nombre) {
        if (!confirm('¿Generar un PIN nuevo para ' + nombre + '? Se cierra su sesión actual.')) return;
        try {
            const res = await adminFetch('/api/admin/deposito/pin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clave }) });
            const d = await res.json().catch(() => ({}));
            if (res.ok) mostrarPinDeposito(d.nombre, d.pin); else retMensaje(d.error || 'No se pudo cambiar el PIN.', 'error');
        } catch (e) {}
    }
    async function activoUsuarioDeposito(clave, activo) {
        try {
            await adminFetch('/api/admin/deposito/activo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clave, activo }) });
            cargarUsuariosDeposito();
        } catch (e) {}
    }

    // Menú lateral: se contrae a solo íconos y recuerda la elección en este navegador
    function alternarMenuLateral() {
        const min = document.body.classList.toggle('menu-min');
        try { localStorage.setItem('beniq_menu_min', min ? '1' : '0'); } catch (e) {}
    }
    (function iniciarMenuLateral() {
        try { if (localStorage.getItem('beniq_menu_min') === '1') document.body.classList.add('menu-min'); } catch (e) {}
        document.querySelectorAll('.nav-btn').forEach(b => b.title = b.textContent.trim());
    })();

    function cambiarVistaAdmin(vista, btn) {
        document.querySelectorAll('.vista-seccion').forEach(s => s.classList.remove('active'));
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

        if (vista === 'gps') {
            document.getElementById('seccion-gps').classList.add('active');
            setTimeout(() => { map.invalidateSize(); }, 200);
        } else if (vista === 'checklists') {
            document.getElementById('seccion-checklists').classList.add('active');
        } else if (vista === 'combustible') {
            document.getElementById('seccion-combustible').classList.add('active');
            iniciarCombustibleMes();
        } else if (vista === 'choferes') {
            document.getElementById('seccion-choferes').classList.add('active');
            cargarChoferes();
        } else if (vista === 'orden') {
            document.getElementById('seccion-orden').classList.add('active');
            cargarOrden();
            ordImpEstado();
        } else if (vista === 'docs') {
            document.getElementById('seccion-docs').classList.add('active');
            document.getElementById('docModalFecha').style.display = '';
            cargarDocs();
        } else if (vista === 'retornos') {
            document.getElementById('seccion-retornos').classList.add('active');
            iniciarRetornos();
        } else if (vista === 'jornadas') {
            document.getElementById('seccion-jornadas').classList.add('active');
            iniciarJornadas();
        } else if (vista === 'venta') {
            document.getElementById('seccion-venta').classList.add('active');
            iniciarVentaCamion();
        } else if (vista === 'plan') {
            document.getElementById('seccion-plan').classList.add('active');
            iniciarPlan();
        }
        btn.classList.add('active');
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    // Mapa de OpenStreetMap (sin clave); el tono oscuro se logra con un filtro CSS sobre las baldosas
    const map = L.map('map').setView([-33.2814, -62.1785], 14);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap'
    }).addTo(map);

    let marcadores = {};
    let lineasRecorrido = {};
    let primerEncuadre = true;
    let vehSel = null; // el trazo celeste solo se muestra para el camión tocado

    function mostrarSoloTrazo(nombre) {
        vehSel = nombre;
        Object.keys(lineasRecorrido).forEach(k => {
            const linea = lineasRecorrido[k];
            if (k === nombre) { if (!map.hasLayer(linea)) linea.addTo(map); }
            else if (map.hasLayer(linea)) map.removeLayer(linea);
        });
    }

    const iconoVehiculo = L.divIcon({
        className: 'custom-pin',
        html: '<div class="veh-pin"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 3h15v13H1z"/><path d="M16 8h4l3 3v5h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg></div>',
        iconSize: [38, 38],
        iconAnchor: [19, 19],
        popupAnchor: [0, -20]
    });

    // Rendimiento Km/L: km recorridos desde la carga anterior del mismo vehículo ÷ litros de la carga actual
    // (supone que cada carga llena el tanque). Si el servidor informa un rendimiento propio, se usa ese.
    function calcularRendimientos(lista) {
        const ultimoOdometro = {};
        const resultado = new Map();
        [...lista].sort((a, b) => new Date(a.fecha) - new Date(b.fecha)).forEach(c => {
            const dominio = String(c.dominio || '').trim().toUpperCase();
            const odo = parseFloat(c.odometroActual);
            const litros = parseFloat(c.litros);
            const previo = ultimoOdometro[dominio];
            if (previo !== undefined && odo > previo && litros > 0) {
                resultado.set(c.id, (odo - previo) / litros);
            }
            if (!isNaN(odo)) ultimoOdometro[dominio] = odo;
        });
        return resultado;
    }

    async function cargarDatos() {
        if (!leerTokenAdmin()) { mostrarLoginAdmin(); return; }
        try {
            // ---------- Ubicaciones / odómetro ----------
            const resUbicaciones = await adminFetch('/api/ubicaciones');
            const ubicaciones = await resUbicaciones.json();

            const tablaKmBody = document.querySelector('#tabla-kilometraje tbody');
            tablaKmBody.innerHTML = '';

            // El trazo se reconstruye completo en cada actualización (antes se duplicaban los puntos en cada ciclo)
            const vehiculosUnicos = {};
            const historicoPuntos = {};
            ubicaciones.forEach(u => {
                vehiculosUnicos[u.vehiculo] = u;
                if (!historicoPuntos[u.vehiculo]) historicoPuntos[u.vehiculo] = [];
                const ult = historicoPuntos[u.vehiculo][historicoPuntos[u.vehiculo].length - 1];
                if (!ult || ult[0] !== u.latitud || ult[1] !== u.longitud) {
                    historicoPuntos[u.vehiculo].push([u.latitud, u.longitud]);
                }
            });

            const listaVehiculos = Object.values(vehiculosUnicos);
            let kmTotales = 0;

            // Quitar del mapa los vehículos que ya no tienen datos (por ejemplo, tras reiniciar el servidor)
            Object.keys(marcadores).forEach(k => {
                if (!vehiculosUnicos[k]) {
                    map.removeLayer(marcadores[k]); delete marcadores[k];
                    if (lineasRecorrido[k]) { map.removeLayer(lineasRecorrido[k]); delete lineasRecorrido[k]; }
                }
            });

            if (listaVehiculos.length === 0) {
                tablaKmBody.innerHTML = '<tr><td colspan="4" class="empty-row">Sin registros de movimiento aún</td></tr>';
            } else {
                listaVehiculos.forEach(v => {
                    kmTotales += Number(v.distanciaTotalKm) || 0;
                    const popup = `<b>${escapeHtml(v.vehiculo)}</b><br>Chofer: ${escapeHtml(v.chofer_id)}<br><b>${escapeHtml(formatoNumero(v.distanciaTotalKm, 2))} km</b><br><span style="color:#94a0c8;">Última señal: ${escapeHtml(formatoHora(v.fecha_hora))}</span>`;

                    if (marcadores[v.vehiculo]) {
                        marcadores[v.vehiculo].setLatLng([v.latitud, v.longitud]).setPopupContent(popup);
                    } else {
                        const nombreVeh = v.vehiculo;
                        marcadores[nombreVeh] = L.marker([v.latitud, v.longitud], { icon: iconoVehiculo }).addTo(map).bindPopup(popup);
                        marcadores[nombreVeh].on('popupopen', () => mostrarSoloTrazo(nombreVeh));
                        marcadores[nombreVeh].on('popupclose', () => { if (vehSel === nombreVeh) mostrarSoloTrazo(null); });
                    }

                    if (lineasRecorrido[v.vehiculo]) {
                        lineasRecorrido[v.vehiculo].setLatLngs(historicoPuntos[v.vehiculo]);
                    } else {
                        lineasRecorrido[v.vehiculo] = L.polyline(historicoPuntos[v.vehiculo], {
                            color: '#38bdf8', weight: 4, opacity: 0.9
                        });
                        if (vehSel === v.vehiculo) lineasRecorrido[v.vehiculo].addTo(map);
                    }

                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td><b>${escapeHtml(v.vehiculo)}</b></td>
                        <td>${escapeHtml(v.chofer_id)}</td>
                        <td class="num"><span class="badge badge-info">${escapeHtml(formatoNumero(v.distanciaTotalKm, 2))} km</span></td>
                        <td style="color: var(--muted);">${escapeHtml(formatoHora(v.fecha_hora))}</td>
                    `;
                    tr.style.cursor = 'pointer';
                    tr.title = 'Tocá para ver el camión y su recorrido en el mapa';
                    tr.onclick = () => { const m = marcadores[v.vehiculo]; if (m) { map.setView(m.getLatLng(), Math.max(map.getZoom(), 15)); m.openPopup(); } };
                    tablaKmBody.appendChild(tr);
                });

                // Primer encuadre: mostrar todos los vehículos en el mapa
                if (primerEncuadre) {
                    primerEncuadre = false;
                    const puntos = listaVehiculos.map(v => [v.latitud, v.longitud]);
                    map.fitBounds(puntos, { padding: [50, 50], maxZoom: 16 });
                }
            }

            // ---------- Combustible ----------
            const resCombustible = await adminFetch('/api/combustible');
            const listaCombustible = await resCombustible.json();
            const tablaCombustibleBody = document.querySelector('#tabla-combustible tbody');
            tablaCombustibleBody.innerHTML = '';

            let litrosTotales = 0;
            listaCombustible.forEach(c => { litrosTotales += parseFloat(c.litros) || 0; });
            const rendimientos = calcularRendimientos(listaCombustible);

            if (listaCombustible.length === 0) {
                tablaCombustibleBody.innerHTML = '<tr><td colspan="8" class="empty-row">No hay registros de combustible aún</td></tr>';
            } else {
                [...listaCombustible].reverse().forEach(c => {
                    const rend = c.rendimientoKmLitros > 0 ? Number(c.rendimientoKmLitros) : rendimientos.get(c.id);
                    const rendimientoTexto = rend > 0
                        ? `<span class="badge badge-ok">${escapeHtml(formatoNumero(rend, 2))} Km/L</span>`
                        : `<span style="color: var(--muted);">Base inicial</span>`;

                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td>${escapeHtml(formatoFechaHora(c.fecha))}</td>
                        <td>${escapeHtml(c.chofer)}</td>
                        <td><b>${escapeHtml(c.dominio)}</b></td>
                        <td class="num">${escapeHtml(formatoNumero(c.litros, 2))} L</td>
                        <td class="num">${escapeHtml(formatoPesos(c.costoTotal))}</td>
                        <td class="num">${escapeHtml(formatoNumero(c.odometroActual))} km</td>
                        <td>${rendimientoTexto}</td>
                        <td><button type="button" class="btn-danger" onclick="eliminarCombustible(${Number(c.id)})">🗑️ Borrar</button></td>
                    `;
                    tablaCombustibleBody.appendChild(tr);
                });
            }

            // ---------- Check-lists ----------
            const resChecklists = await adminFetch('/api/checklists');
            const checklists = await resChecklists.json();
            const tablaChecklistBody = document.querySelector('#tabla-checklists tbody');
            tablaChecklistBody.innerHTML = '';

            let checklistsConFallas = 0;
            if (checklists.length === 0) {
                tablaChecklistBody.innerHTML = '<tr><td colspan="7" class="empty-row">No hay check-lists registrados</td></tr>';
            } else {
                [...checklists].reverse().forEach(c => {
                    const fallas = Object.entries(c.respuestas || {}).filter(([, valor]) => valor === 'Falla').map(([item]) => item);
                    if (fallas.length > 0) checklistsConFallas++;
                    const estado = fallas.length === 0
                        ? '<span class="badge badge-ok">✔ Sin fallas</span>'
                        : `<span class="badge badge-falla">⚠ ${fallas.length} ${fallas.length === 1 ? 'falla' : 'fallas'}</span><div class="fallas-detalle">${fallas.map(escapeHtml).join(' · ')}</div>`;

                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td>${escapeHtml(formatoFechaHora(c.marca_temporal))}</td>
                        <td>${escapeHtml(c.chofer)}</td>
                        <td><b>${escapeHtml(c.dominio)}</b></td>
                        <td>${escapeHtml(c.tipo_vehiculo)}</td>
                        <td>${estado}</td>
                        <td>${escapeHtml(c.observaciones || 'Sin novedades')}</td>
                        <td><button type="button" class="btn-danger" onclick="eliminarChecklist(${Number(c.id)})">🗑️ Borrar</button></td>
                    `;
                    tablaChecklistBody.appendChild(tr);
                });
            }

            // ---------- Indicadores ----------
            document.getElementById('kpiVehiculos').innerText = formatoNumero(listaVehiculos.length);
            document.getElementById('kpiKm').innerText = formatoNumero(kmTotales, 1);
            document.getElementById('kpiLitros').innerText = formatoNumero(litrosTotales, 1);
            document.getElementById('kpiChecklists').innerText = formatoNumero(checklists.length);
            const hayFallas = checklistsConFallas > 0;
            document.getElementById('kpiChecklistsLbl').innerText = hayFallas ? `Check-lists · ${checklistsConFallas} con fallas` : 'Check-lists';
            document.getElementById('kpiFallasBox').classList.toggle('alerta', hayFallas);

            // contexto de cada indicador (solo con datos reales)
            const ctx = (id, txt) => { const e = document.getElementById(id); if (e) e.textContent = txt; };
            const ahoraMs = Date.now();
            const conSenal = listaVehiculos.filter(v => v.fecha_hora && (ahoraMs - new Date(v.fecha_hora).getTime()) < 15 * 60000).length;
            ctx('kpiVehCtx', listaVehiculos.length ? `${conSenal} con señal reciente · ${listaVehiculos.length - conSenal} sin señal` : 'Sin datos todavía');
            const vConKm = listaVehiculos.filter(v => Number(v.distanciaTotalKm) > 0).length;
            ctx('kpiKmCtx', vConKm ? `Promedio ${formatoNumero(kmTotales / vConKm, 1)} km por vehículo` : 'Sin recorridos');
            ctx('kpiChkCtx', checklists.length ? (hayFallas ? `${checklistsConFallas} con fallas · ${checklists.length - checklistsConFallas} sin novedades` : 'Todos sin novedades') : 'Sin check-lists');
            ctx('kpiLitCtx', listaCombustible.length ? `${listaCombustible.length} ${listaCombustible.length === 1 ? 'carga' : 'cargas'} registradas` : 'Sin cargas');
            document.getElementById('kpiVehiculos').closest('.kpi').classList.toggle('sin-senal', listaVehiculos.length > 0 && conSenal === 0);

            document.getElementById('lblActualizado').innerText = 'En vivo · ' + formatoHora(new Date());

        } catch (error) {
            if (error.message === 'SESION') return; // la sesión venció: ya se pidió la clave de nuevo
            console.error("Error al actualizar datos del panel:", error);
            document.getElementById('lblActualizado').innerText = 'Sin conexión con el servidor';
        }
    }

    async function eliminarChecklist(id) {
        if (!confirm("¿Estás seguro de eliminar este check-list?")) return;
        try {
            const res = await adminFetch(`/api/checklist/${id}`, { method: 'DELETE' });
            if (res.ok) cargarDatos();
        } catch (err) {}
    }

    async function eliminarCombustible(id) {
        if (!confirm("¿Estás seguro de eliminar este registro de combustible?")) return;
        try {
            const res = await adminFetch(`/api/combustible/${id}`, { method: 'DELETE' });
            if (res.ok) cargarDatos();
        } catch (err) {}
    }

    // Campanita de notificaciones (solo con sesión iniciada)
    const VISTA_DE_AVISO = { retorno: 'retornos', docs: 'docs', checklist: 'checklists', orden: 'orden' };
    function arrancarCampana() {
        if (!leerTokenAdmin()) return;
        iniciarCampana({
            contenedor: 'campana',
            llamar: (url, o) => adminFetch(url, o),
            alElegir: n => {
                const vista = VISTA_DE_AVISO[n.tipo]; if (!vista) return;
                const btn = document.querySelector(`[onclick*="cambiarVistaAdmin('${vista}'"]`);
                cambiarVistaAdmin(vista, btn);
            }
        });
    }
    arrancarCampana();

    cargarDatos();
    setInterval(cargarDatos, 10000);
    setTimeout(() => { try { cargarDocs(); } catch (e) {} }, 1500);

    // Cabecera: saludo según la hora + fecha de hoy
    (function saludoAdmin() {
        const poner = () => {
            const el = document.getElementById('adminSub'); if (!el) return;
            const hora = Number(new Date().toLocaleString('en-GB', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', hour12: false })) % 24;
            const saludo = hora < 6 ? 'Buenas noches' : hora < 13 ? 'Buen día' : hora < 20 ? 'Buenas tardes' : 'Buenas noches';
            const f = new Date().toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', weekday: 'short', day: 'numeric', month: 'short' }).replace(/\./g, '');
            el.textContent = `${saludo} · ${f}`;
        };
        poner(); setInterval(poner, 5 * 60 * 1000);
    })();
