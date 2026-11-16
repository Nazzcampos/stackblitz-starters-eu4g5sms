    // ---------- Utilidades ----------
    const $ = id => document.getElementById(id);
    const esc = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fmtFecha = f => f ? f.split('-').reverse().join('/') : '';
    const fmtHora = iso => new Date(iso).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const fmtNum = n => Number(n).toLocaleString('es-AR', { maximumFractionDigits: 2 });
    function hoyAR() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }); }
    function haceDias(n) { return new Date(Date.parse(hoyAR() + 'T00:00:00Z') - n * 86400000).toISOString().slice(0, 10); }
    function toast(t, tipo) { const e = document.createElement('div'); e.className = 'toast ' + (tipo || ''); e.textContent = t; document.body.appendChild(e); setTimeout(() => e.remove(), 3600); }
    function guardarLocal(k, v) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} }
    function leerLocal(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

    let token = leerLocal('flota_dep_token'), nombreUsuario = '';
    async function api(url, opciones) {
        const o = opciones || {};
        const r = await fetch(url, { ...o, headers: { ...(o.headers || {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) } });
        if (r.status === 401 && token) { salir(true); throw new Error('SESION'); }
        return r;
    }
    async function json(url, opciones) {
        const r = await api(url, opciones);
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || 'No se pudo completar la acción');
        return d;
    }

    // ---------- Ingreso ----------
    async function cargarUsuarios() {
        try {
            const lista = await (await fetch('/api/deposito/usuarios')).json();
            $('loginUsuario').innerHTML = lista.length ? '<option value="">Seleccioná tu nombre</option>' + lista.map(n => `<option>${esc(n)}</option>`).join('') : '<option value="">Todavía no hay usuarios: pedile al administrador que cree el tuyo</option>';
        } catch (e) { $('loginUsuario').innerHTML = '<option value="">No se pudo cargar la lista</option>'; }
    }
    $('formLogin').addEventListener('submit', async e => {
        e.preventDefault();
        const b = $('btnLogin'); b.disabled = true; $('loginError').classList.add('oculto');
        try {
            const r = await fetch('/api/deposito/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nombre: $('loginUsuario').value, pin: $('loginPin').value }) });
            const d = await r.json().catch(() => ({}));
            $('loginPin').value = '';
            if (!r.ok) { $('loginError').textContent = d.error || 'No se pudo ingresar'; $('loginError').classList.remove('oculto'); return; }
            token = d.token; guardarLocal('flota_dep_token', token); entrar(d.nombre);
        } catch (err) { $('loginError').textContent = 'No se pudo conectar con el servidor.'; $('loginError').classList.remove('oculto'); }
        finally { b.disabled = false; }
    });
    // Cabecera: saludo según la hora y fecha de hoy (Argentina)
    function saludarDeposito(nombre) {
        const sub = document.querySelector('.marca-sub'); if (!sub) return;
        if (!nombre) { sub.textContent = 'Control de retorno del camión'; return; }
        const hora = Number(new Date().toLocaleString('en-GB', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', hour12: false })) % 24;
        const saludo = hora < 6 ? 'Buenas noches' : hora < 13 ? 'Buen día' : hora < 20 ? 'Buenas tardes' : 'Buenas noches';
        const f = new Date().toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', weekday: 'short', day: 'numeric', month: 'short' }).replace(/\./g, '');
        sub.textContent = `${saludo}, ${String(nombre).split(' ')[0]} · ${f}`;
    }
    function entrar(nombre) {
        nombreUsuario = nombre; $('quienNombre').textContent = nombre; saludarDeposito(nombre); $('quien').classList.remove('oculto');
        $('vistaLogin').classList.add('oculto'); $('vistaApp').classList.remove('oculto');
        $('rtFecha').value = hoyAR(); $('rtFecha').max = hoyAR();
        $('hDesde').value = haceDias(30); $('hHasta').value = hoyAR();
        cargarChoferes(); cargarPendientes();
        if (!temporizadorPend) temporizadorPend = setInterval(() => { if (token && !document.hidden) cargarPendientes(); }, 5 * 60 * 1000);
    }
    function salir(porVencida) {
        token = null; guardarLocal('flota_dep_token', null);
        $('vistaApp').classList.add('oculto'); $('vistaLogin').classList.remove('oculto'); $('quien').classList.add('oculto');
        resetRetorno(); cargarUsuarios(); $('rtPendientes').innerHTML = ''; saludarDeposito('');
        if (porVencida === true) toast('Tu sesión se cerró. Ingresá de nuevo.', 'error');
    }
    async function recuperarSesion() {
        if (!token) return;
        try { const d = await json('/api/retorno/me'); entrar(d.nombre); } catch (e) { /* queda el login */ }
    }

    // ---------- Pestañas ----------
    function verTab(t) {
        $('tabCargar').classList.toggle('on', t === 'cargar'); $('tabHistorial').classList.toggle('on', t === 'historial');
        $('panelCargar').classList.toggle('oculto', t !== 'cargar'); $('panelHistorial').classList.toggle('oculto', t !== 'historial');
        if (t === 'historial') cargarHistorial();
    }
    async function cargarChoferes() {
        try {
            const lista = await json('/api/retorno/choferes');
            $('rtChofer').innerHTML = '<option value="">Elegí el chofer</option>' + lista.map(n => `<option>${esc(n)}</option>`).join('');
            $('hChofer').innerHTML = '<option value="">Todos</option>' + lista.map(n => `<option>${esc(n)}</option>`).join('');
        } catch (e) {
            if (e.message !== 'SESION') { $('rtChofer').innerHTML = '<option value="">No se pudo leer Gescom</option>'; $('rtMensaje').innerHTML = '<div class="aviso err">No se pudo leer la lista de choferes de Gescom. Probá de nuevo en un momento.</div>'; }
        }
    }

    // ---------- Cargar retorno ----------
    let rt = null;
    function resetRetorno() { rt = { fecha: '', chofer: '', reparto: '', items: [], repartos: [], existentes: [], borradores: {}, gescom: true }; $('rtFormulario').classList.add('oculto'); $('rtRepartos').classList.add('oculto'); $('rtMensaje').innerHTML = ''; }
    resetRetorno();

    async function buscarCarga(repartoPreferido) {
        const fecha = $('rtFecha').value, chofer = $('rtChofer').value;
        if (!chofer || !fecha) { toast('Elegí el chofer y la fecha.', 'error'); return; }
        const b = $('btnBuscar'); b.disabled = true; $('rtMensaje').innerHTML = '<div class="aviso">Buscando la carga en Gescom…</div>';
        try {
            const d = await json(`/api/retorno/carga?chofer=${encodeURIComponent(chofer)}&fecha=${fecha}`);
            resetRetorno();
            rt.fecha = fecha; rt.chofer = chofer; rt.gescom = d.gescom; rt.existentes = d.existentes;
            const nombres = new Set(d.repartos.map(r => r.reparto));
            rt.repartos = d.repartos.map(r => ({ reparto: r.reparto, items: r.items }));
            d.existentes.forEach(x => { if (!nombres.has(x.reparto)) rt.repartos.push({ reparto: x.reparto, items: [] }); });
            let msg = '';
            if (!d.gescom) msg = '<div class="aviso warn">No se pudo leer la carga en Gescom. Podés anotar igual buscando los artículos a mano.</div>';
            else if (!d.repartos.length) msg = '<div class="aviso warn">Gescom no muestra carga para ese chofer ese día. Verificá la fecha, o anotá igual buscando los artículos a mano.</div>';
            $('rtMensaje').innerHTML = msg;
            if (rt.repartos.length > 1) {
                $('rtRepartos').classList.remove('oculto');
                $('rtRepartos').innerHTML = '<span style="color:var(--muted);font-size:.85rem;align-self:center;">Repartos del día:</span>' + rt.repartos.map(r => `<button type="button" class="chip" data-rep="${esc(r.reparto)}" onclick="elegirReparto(this.dataset.rep)">Reparto ${esc(r.reparto || '—')}</button>`).join('');
            }
            if (typeof repartoPreferido === 'string' && rt.repartos.some(r => r.reparto === repartoPreferido)) elegirReparto(repartoPreferido);
            else if (rt.repartos.length === 1) elegirReparto(rt.repartos[0].reparto);
            else if (!rt.repartos.length) elegirReparto('', true);
        } catch (e) { if (e.message !== 'SESION') $('rtMensaje').innerHTML = `<div class="aviso err">${esc(e.message)}</div>`; }
        finally { b.disabled = false; }
    }

    function guardarBorrador() {
        if (!rt || rt.reparto === null || !$('rtFormulario') || $('rtFormulario').classList.contains('oculto')) return;
        rt.borradores[rt.reparto] = { items: rt.items, cajas: $('rtCajas').value, dominio: $('rtDominio').value, obs: $('rtObs').value };
    }
    function elegirReparto(rep, manual) {
        guardarBorrador();
        rt.reparto = rep;
        document.querySelectorAll('#rtRepartos .chip').forEach(c => c.classList.toggle('on', c.dataset.rep === rep));
        const bor = rt.borradores[rep];
        const base = rt.repartos.find(r => r.reparto === rep);
        const ex = rt.existentes.find(x => x.reparto === rep);
        if (bor) {
            rt.items = bor.items; $('rtCajas').value = bor.cajas; $('rtDominio').value = bor.dominio; $('rtObs').value = bor.obs;
        } else {
            rt.items = (base ? base.items : []).map(i => ({ codigo: i.codigo, descripcion: i.descripcion, cargada: i.cantidad, retorno: '', extra: false }));
            if (ex) ex.items.forEach(x => {
                const f = rt.items.find(i => i.codigo === x.codigo);
                if (f) f.retorno = String(x.retorno);
                else rt.items.push({ codigo: x.codigo, descripcion: x.descripcion, cargada: x.cargada, retorno: String(x.retorno), extra: true });
            });
            $('rtCajas').value = ex ? ex.cajas || '' : ''; $('rtDominio').value = ex ? ex.dominio || '' : ''; $('rtObs').value = ex ? ex.observaciones || '' : '';
        }
        $('rtManual').style.display = manual || (rt.repartos.length === 0) ? 'flex' : 'none';
        $('rtRepartoManual').value = rep;
        $('rtEstado').innerHTML = ex ? `<div class="aviso ok">✔ Este retorno ya fue cargado por <b>${esc(ex.cargado_por)}</b> el ${esc(fmtHora(ex.actualizado))}. Podés corregirlo y volver a guardar.</div>` : '';
        $('rtFiltro').value = ''; $('rtBuscar').value = ''; $('rtResultados').innerHTML = '';
        $('rtFormulario').classList.remove('oculto');
        pintarLista();
        $('rtFormulario').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function pintarLista() {
        const cont = $('rtLista');
        if (!rt.items.length) { cont.innerHTML = '<div class="vacio">No hay productos en la lista. Buscá abajo los que volvieron.</div>'; actualizarResumen(); return; }
        cont.innerHTML = rt.items.map((it, i) => `<div class="it" data-i="${i}" data-txt="${esc((it.descripcion + ' ' + it.codigo).toLowerCase())}">
            <div><b>${esc(it.descripcion)}</b><small>${esc(it.codigo)}${it.cargada !== null && it.cargada !== undefined ? ` · Salió: <span class="sal">${esc(fmtNum(it.cargada))}</span>` : ' · <i>agregado a mano</i>'}<span class="ex"></span>${it.extra && !it.retorno ? `<button type="button" class="suave quitar" onclick="quitarItem(${i})">Quitar</button>` : ''}</small></div>
            <input type="text" inputmode="decimal" placeholder="0" value="${esc(it.retorno)}" data-i="${i}" aria-label="Volvió: ${esc(it.descripcion)}"></div>`).join('');
        cont.querySelectorAll('input').forEach(inp => {
            inp.addEventListener('input', () => { rt.items[+inp.dataset.i].retorno = inp.value.trim(); marcarFila(inp.closest('.it')); actualizarResumen(); });
            inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); const vis = [...cont.querySelectorAll('.it:not(.oculto) input')]; const k = vis.indexOf(inp); (vis[k + 1] || $('rtCajas')).focus(); } });
            inp.addEventListener('focus', () => inp.select());
        });
        cont.querySelectorAll('.it').forEach(marcarFila);
        filtrarLista(); actualizarResumen();
    }
    function marcarFila(fila) {
        const it = rt.items[+fila.dataset.i], n = Number(String(it.retorno).replace(',', '.'));
        const con = it.retorno !== '' && Number.isFinite(n) && n > 0;
        const exceso = con && it.cargada !== null && it.cargada !== undefined && n > it.cargada;
        fila.classList.toggle('con', con && !exceso); fila.classList.toggle('exceso', exceso);
        fila.querySelector('.ex').textContent = exceso ? ' · ⚠ volvió más de lo que salió' : '';
    }
    function filtrarLista() {
        const q = $('rtFiltro').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
        document.querySelectorAll('#rtLista .it').forEach(f => f.classList.toggle('oculto', q.length > 0 && !q.every(p => f.dataset.txt.includes(p))));
    }
    function quitarItem(i) { rt.items.splice(i, 1); pintarLista(); }
    function actualizarResumen() {
        let prods = 0, unid = 0;
        rt.items.forEach(it => { const n = Number(String(it.retorno).replace(',', '.')); if (it.retorno !== '' && Number.isFinite(n) && n > 0) { prods++; unid += n; } });
        $('rtResumen').innerHTML = `${prods} producto${prods === 1 ? '' : 's'} · <span>${fmtNum(unid)}</span> unidades`;
    }

    let temporizadorBusqueda = null;
    function buscarArticulo() {
        clearTimeout(temporizadorBusqueda);
        const q = $('rtBuscar').value.trim();
        if (q.length < 2) { $('rtResultados').innerHTML = ''; return; }
        temporizadorBusqueda = setTimeout(async () => {
            try {
                const lista = await json('/api/retorno/articulos?q=' + encodeURIComponent(q));
                $('rtResultados').innerHTML = lista.length ? lista.map(a => `<button type="button" data-c="${esc(a.codigo)}" data-d="${esc(a.descripcion)}">${esc(a.descripcion)} <small style="color:var(--muted)">· ${esc(a.codigo)}</small></button>`).join('') : '<div class="vacio" style="padding:10px;">No se encontró ningún artículo.</div>';
                $('rtResultados').querySelectorAll('button').forEach(b => b.onclick = () => agregarArticulo(b.dataset.c, b.dataset.d));
            } catch (e) { if (e.message !== 'SESION') $('rtResultados').innerHTML = `<div class="aviso err">${esc(e.message)}</div>`; }
        }, 300);
    }
    function agregarArticulo(codigo, descripcion) {
        let i = rt.items.findIndex(x => x.codigo === codigo);
        if (i < 0) { rt.items.push({ codigo, descripcion, cargada: null, retorno: '', extra: true }); i = rt.items.length - 1; }
        $('rtBuscar').value = ''; $('rtResultados').innerHTML = ''; $('rtFiltro').value = '';
        pintarLista();
        const inp = document.querySelector(`#rtLista input[data-i="${i}"]`);
        if (inp) { inp.scrollIntoView({ block: 'center', behavior: 'smooth' }); inp.focus(); }
    }

    async function guardarRetorno() {
        if (!rt.chofer || !rt.fecha) return;
        const reparto = (rt.reparto || '').trim();
        if (!reparto && rt.repartos.length === 0 && !confirm('No escribiste el número de reparto. ¿Guardar igual sin número?')) return;
        for (const it of rt.items) {
            if (it.retorno === '') continue;
            const n = Number(String(it.retorno).replace(',', '.'));
            if (!Number.isFinite(n) || n < 0) { toast(`La cantidad de "${it.descripcion}" no es válida.`, 'error'); return; }
        }
        const cajas = $('rtCajas').value.trim();
        if (cajas !== '' && !/^\d+$/.test(cajas)) { toast('Las cajas tienen que ser un número entero.', 'error'); return; }
        const b = $('btnGuardar'); b.disabled = true;
        try {
            const d = await json('/api/retorno', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
                fecha: rt.fecha, chofer: rt.chofer, reparto, dominio: $('rtDominio').value, cajas: cajas === '' ? 0 : Number(cajas), observaciones: $('rtObs').value,
                items: rt.items.map(i => ({ codigo: i.codigo, descripcion: i.descripcion, cargada: i.cargada, retorno: i.retorno === '' ? 0 : i.retorno })) }) });
            toast(`✔ Guardado: ${d.articulos} producto${d.articulos === 1 ? '' : 's'}, ${fmtNum(d.unidades)} unidades, ${cajas || 0} cajas.`, 'ok');
            const nuevo = await json(`/api/retorno/carga?chofer=${encodeURIComponent(rt.chofer)}&fecha=${rt.fecha}`);
            rt.existentes = nuevo.existentes; delete rt.borradores[reparto]; cargarPendientes();
            const ex = rt.existentes.find(x => x.reparto === reparto);
            if (ex) $('rtEstado').innerHTML = `<div class="aviso ok">✔ Guardado por <b>${esc(ex.cargado_por)}</b> el ${esc(fmtHora(ex.actualizado))}. Podés corregirlo y volver a guardar.</div>`;
        } catch (e) { if (e.message !== 'SESION') toast(e.message, 'error'); }
        finally { b.disabled = false; }
    }

    // ---------- Aviso: retornos sin cargar ----------
    let pendientes = [], temporizadorPend = null;
    const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
    const diaCorto = f => DIAS[new Date(f + 'T12:00:00Z').getUTCDay()] + ' ' + fmtFecha(f).slice(0, 5);
    async function cargarPendientes() {
        try {
            const d = await json('/api/retorno/pendientes?dias=5');
            pendientes = d.pendientes || [];
            const antes = pendientes.filter(p => !p.esHoy), hoy = pendientes.filter(p => p.esHoy);
            const fila = p => `<button type="button" class="pend" onclick="abrirPendiente(${pendientes.indexOf(p)})"><b>${esc(diaCorto(p.fecha))}</b> · ${esc(p.chofer)}${p.reparto ? ' · reparto ' + esc(p.reparto) : ''} <small>${p.clientes} cliente${p.clientes === 1 ? '' : 's'}</small><span>Cargar ›</span></button>`;
            let h = '';
            if (!d.gescom) h = '<div class="aviso warn">No se pudo revisar qué retornos faltan (Gescom no respondió).</div>';
            else if (!pendientes.length) h = '<div class="aviso ok">✔ Todos los retornos de los últimos días están cargados.</div>';
            else {
                if (antes.length) h += `<div class="aviso err"><b>⚠️ Falta cargar ${antes.length} retorno${antes.length === 1 ? '' : 's'}</b> de días anteriores. Tocá uno para cargarlo.<div class="pend-lista">${antes.map(fila).join('')}</div></div>`;
                if (hoy.length) h += `<div class="aviso warn"><b>Hoy, a la espera de que vuelvan (${hoy.length}):</b><div class="pend-lista">${hoy.map(fila).join('')}</div></div>`;
            }
            $('rtPendientes').innerHTML = h;
        } catch (e) { /* si falla, no se muestra nada */ }
    }
    function abrirPendiente(i) {
        const p = pendientes[i]; if (!p) return;
        verTab('cargar');
        $('rtFecha').value = p.fecha;
        if (![...$('rtChofer').options].some(o => o.value === p.chofer)) $('rtChofer').insertAdjacentHTML('beforeend', `<option>${esc(p.chofer)}</option>`);
        $('rtChofer').value = p.chofer;
        buscarCarga(p.reparto);
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    // ---------- Historial ----------
    function paramsHistorial() {
        const p = new URLSearchParams({ desde: $('hDesde').value, hasta: $('hHasta').value });
        if ($('hChofer').value) p.set('chofer', $('hChofer').value);
        if ($('hTexto').value.trim()) p.set('q', $('hTexto').value.trim());
        return p;
    }
    let historial = [];
    async function cargarHistorial() {
        $('hMensaje').innerHTML = '<div class="aviso">Buscando…</div>';
        try {
            historial = await json('/api/retorno/historial?' + paramsHistorial());
            $('hMensaje').innerHTML = historial.length ? `<div class="aviso ok">${historial.length} retorno${historial.length === 1 ? '' : 's'} encontrado${historial.length === 1 ? '' : 's'}${historial.length >= 500 ? ' (se muestran los primeros 500)' : ''}.</div>` : '';
            const q = $('hTexto').value.trim().toLowerCase();
            $('hLista').innerHTML = historial.length ? historial.map((r, k) => `<div class="reg"><div class="reg-top" onclick="$('det${k}').classList.toggle('oculto')">
                <div><b>${esc(fmtFecha(r.fecha))} · ${esc(r.chofer)}</b><br><small>Reparto ${esc(r.reparto || '—')}${r.dominio ? ' · ' + esc(r.dominio) : ''} · cargó ${esc(r.cargado_por)} el ${esc(fmtHora(r.actualizado))}</small></div>
                <div class="badges"><span class="badge">📦 ${r.cajas} caja${r.cajas === 1 ? '' : 's'}</span><span class="badge">🔁 ${fmtNum(r.total_unidades)} unid.</span><span class="badge">${r.items.length} producto${r.items.length === 1 ? '' : 's'}</span></div></div>
                <div class="detalle oculto" id="det${k}">${r.items.length ? `<table><thead><tr><th>Producto</th><th class="n">Salió</th><th class="n">Volvió</th></tr></thead><tbody>${r.items.map(i => `<tr${q && (i.descripcion.toLowerCase().includes(q) || i.codigo.toLowerCase().includes(q)) ? ' style="background:rgba(59,130,246,.14)"' : ''}><td>${esc(i.descripcion)} <small style="color:var(--muted)">${esc(i.codigo)}</small></td><td class="n">${i.cargada === null || i.cargada === undefined ? '—' : esc(fmtNum(i.cargada))}</td><td class="n"><b>${esc(fmtNum(i.retorno))}</b></td></tr>`).join('')}</tbody></table>` : '<div class="vacio" style="padding:8px;">No volvieron productos.</div>'}
                ${r.observaciones ? `<p class="ayuda" style="margin-top:8px;">📝 ${esc(r.observaciones)}</p>` : ''}
                <button type="button" class="suave chico" onclick="corregir(${k})">✏ Corregir este retorno</button></div></div>`).join('') : '<div class="vacio">No hay retornos cargados con esos filtros.</div>';
        } catch (e) { if (e.message !== 'SESION') $('hMensaje').innerHTML = `<div class="aviso err">${esc(e.message)}</div>`; }
    }
    function corregir(k) {
        const r = historial[k]; if (!r) return;
        verTab('cargar');
        $('rtFecha').value = r.fecha;
        if (![...$('rtChofer').options].some(o => o.value === r.chofer)) $('rtChofer').insertAdjacentHTML('beforeend', `<option>${esc(r.chofer)}</option>`);
        $('rtChofer').value = r.chofer;
        buscarCarga(r.reparto);
    }
    async function descargarExcel(boton) {
        boton.disabled = true;
        try {
            const r = await api('/api/retorno/exportar?' + paramsHistorial());
            if (!r.ok) { const d = await r.json().catch(() => ({})); toast(d.error || 'No se pudo generar el Excel.', 'error'); return; }
            const blob = await r.blob();
            const m = /filename="([^"]+)"/.exec(r.headers.get('Content-Disposition') || '');
            const url = URL.createObjectURL(blob), a = document.createElement('a');
            a.href = url; a.download = m ? m[1] : 'retornos.xlsx'; document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
            toast('✔ Excel descargado.', 'ok');
        } catch (e) { if (e.message !== 'SESION') toast('No se pudo descargar.', 'error'); }
        finally { boton.disabled = false; }
    }

    cargarUsuarios();
    recuperarSesion();
