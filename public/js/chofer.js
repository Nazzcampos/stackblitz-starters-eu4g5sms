    let choferActual = "";
    let clientesPorId = {};

    // ---------- Sesión: el token se guarda en el dispositivo y viaja en cada pedido ----------
    function leerTokenGuardado() { try { return localStorage.getItem('flota_token'); } catch (e) { return null; } }
    function guardarTokenSesion(t) { try { localStorage.setItem('flota_token', t); } catch (e) {} }
    function borrarTokenGuardado() { try { localStorage.removeItem('flota_token'); } catch (e) {} }

    // Igual que fetch, pero con la sesión del chofer. Si el servidor la rechaza (401), se vuelve al login.
    async function apiFetch(url, opciones) {
        const token = leerTokenGuardado();
        const cfg = Object.assign({}, opciones || {});
        cfg.headers = Object.assign({}, cfg.headers || {});
        if (token) cfg.headers['Authorization'] = 'Bearer ' + token;
        const res = await fetch(url, cfg);
        if (res.status === 401 && token) {
            let mensaje = '';
            try { mensaje = (await res.clone().json()).error || ''; } catch (e) {}
            sesionVencida(mensaje);
        }
        return res;
    }
    function sesionVencida(mensaje) {
        const habiaSesion = !!choferActual;
        cerrarSesion();
        if (habiaSesion) mostrarToast(mensaje || "Tu sesión venció. Volvé a ingresar con tu PIN.", 'error');
    }

    function escapeHtml(t) {
        return String(t == null ? '' : t).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    }
    function formatoPesos(n) {
        return (n < 0 ? '-$' : '$') + Math.abs(Number(n)).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    // Las fechas llegan como AAAA-MM-DD; se formatean a mano para evitar corrimientos por zona horaria
    function formatoFecha(f) {
        if (!f) return 'S/F';
        const [y, m, d] = String(f).slice(0, 10).split('-');
        return `${d}/${m}/${y}`;
    }
    function fechaLocalHoy() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    function iniciales(nombre) {
        const partes = String(nombre).trim().split(/\s+/).filter(Boolean);
        return ((partes[0] || '?')[0] + (partes[1] ? partes[1][0] : '')).toUpperCase();
    }

    // Avisos breves (reemplazan a los alert)
    function mostrarToast(mensaje, tipo) {
        const wrap = document.getElementById('toastWrap');
        const t = document.createElement('div');
        t.className = 'toast ' + (tipo || '');
        t.textContent = mensaje;
        wrap.appendChild(t);
        setTimeout(() => { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; }, 3200);
        setTimeout(() => t.remove(), 3600);
    }

    // Cargar la lista de choferes en el select al abrir la app
    async function cargarChoferesParaLogin() {
        try {
            const res = await fetch('/api/choferes');
            const choferes = await res.json();
            const select = document.getElementById('selectChoferLogin');
            select.innerHTML = '<option value="">Seleccioná tu nombre</option>';

            choferes.forEach(c => {
                const opt = document.createElement('option');
                opt.value = c.nombre;
                opt.textContent = c.nombre;
                select.appendChild(opt);
            });
        } catch (err) {
            console.error("Error al obtener choferes:", err);
            document.getElementById('selectChoferLogin').innerHTML = '<option value="">Error al cargar choferes</option>';
        }
    }

    // Ejecutar al iniciar: lista de choferes, fecha de hoy y, si hay una sesión guardada, entrar directo
    window.onload = async () => {
        cargarChoferesParaLogin();
        const inputFecha = document.getElementById('inputFechaRuta');
        if (inputFecha) inputFecha.value = fechaLocalHoy();

        if (leerTokenGuardado()) {
            try {
                const res = await apiFetch('/api/me');
                if (res.ok) {
                    const datos = await res.json();
                    entrarComoChofer(datos.nombre);
                } else {
                    borrarTokenGuardado();
                }
            } catch (err) { /* sin conexión: queda el login */ }
        }
    };

    // Atajos Hoy / Mañana y resumen del reparto (clientes, importe, kilos y deuda a cobrar)
    function fechaRutaRapida(dias) {
        const d = new Date(); d.setDate(d.getDate() + dias);
        document.getElementById('inputFechaRuta').value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        cambiarFechaRuta();
    }
    async function pintarResumenReparto(clientes) {
        const caja = document.getElementById('resumenReparto');
        const fecha = document.getElementById('inputFechaRuta').value || fechaLocalHoy();
        try {
            const r = await apiFetch('/api/resumen-reparto?fecha=' + encodeURIComponent(fecha));
            if (!r.ok) throw new Error('error');
            const d = await r.json();
            if (!d.comprobantes) {
                caja.innerHTML = '<div class="rep-vacio">Todavía no hay reparto asignado para esta fecha. Cuando se carguen los pedidos en el sistema, vas a ver acá el resumen.</div>';
            } else {
                const cobrar = (clientes || []).reduce((a, c) => a + (deudaDe(c).cobrar || 0), 0);
                const kg = Number(d.kg).toLocaleString('es-AR', { maximumFractionDigits: 1 });
                clientesRutaActual = Array.isArray(clientes) ? clientes : [];
                caja.innerHTML =
                    '<div class="rp-panel">' +
                      '<div class="rp-fila">' +
                        '<div><div class="rp-n" id="rpTotal">' + d.clientes + '</div><div class="rp-l">Clientes</div></div>' +
                        '<div><div class="rp-n rp-ok" id="rpVis">0</div><div class="rp-l">Visitados</div></div>' +
                        '<div><div class="rp-n rp-warn" id="rpPend">' + d.clientes + '</div><div class="rp-l">Pendientes</div></div>' +
                      '</div>' +
                      '<div class="rp-prog"><div class="rp-meta"><span>Progreso de reparto</span><b id="rpPct">0%</b></div><div class="rp-barra"><i id="rpBarra"></i></div></div>' +
                      '<div class="rp-grid">' +
                        '<div><div class="rp-l">En reparto' + (d.estimado ? ' (estimado)' : '') + '</div><div class="rp-v">' + (d.importe > 0 ? formatoPesos(d.importe) : 'Sin facturar') + '</div></div>' +
                        '<div><div class="rp-l">A cobrar (deuda)</div><div class="rp-v rp-warn">' + formatoPesos(cobrar) + '</div></div>' +
                        '<div><div class="rp-l">Contado (al entregar)</div><div class="rp-v rp-ok">' + formatoPesos(d.contado || 0) + '</div></div>' +
                        '<div><div class="rp-l">Peso aproximado</div><div class="rp-v">≈ ' + kg + ' kg</div></div>' +
                      '</div>' +
                    '</div>';
                actualizarProgresoReparto();
            }
            pintarFechaLarga();
            caja.style.display = 'block';
        } catch (e) { caja.style.display = 'none'; }
    }

    function cambiarFechaRuta() {
        pintarFechaLarga();
        if (choferActual) {
            cargarRutaChoferReal(choferActual);
        }
    }

    // Cabecera: saludo según la hora, primer nombre del chofer, fecha y camión de la jornada en curso
    function pintarSaludo() {
        const hola = document.getElementById('saludoHola'), sub = document.getElementById('saludoSub');
        if (!hola || !sub) return;
        const hora = Number(new Date().toLocaleString('en-GB', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', hour12: false })) % 24;
        const saludo = hora < 6 ? 'Buenas noches' : hora < 13 ? 'Buen día' : hora < 20 ? 'Buenas tardes' : 'Buenas noches';
        const partes = String(choferActual || '').trim().split(/\s+/).filter(Boolean);
        const nombre = (partes[1] || partes[0] || '').toLowerCase().replace(/^./, c => c.toUpperCase());
        hola.textContent = nombre ? `${saludo}, ${nombre}` : saludo;
        const fecha = new Date().toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', weekday: 'short', day: 'numeric', month: 'short' }).replace(/\./g, '');
        const camion = (typeof jornada !== 'undefined' && jornada && jornada.vehiculo) ? jornada.vehiculo : '';
        sub.textContent = fecha.charAt(0).toUpperCase() + fecha.slice(1) + ' · ' + (camion ? '🚚 ' + camion : 'Sin jornada');
        sub.classList.toggle('on', !!camion);
    }

    // Pasa de la pantalla de login a la app, ya con el chofer autenticado
    function entrarComoChofer(nombre) {
        choferActual = nombre;
        document.getElementById('lblChofer').innerText = choferActual;
        document.getElementById('avatarChofer').innerText = iniciales(choferActual);
        document.getElementById('userChip').classList.add('on');
        pintarSaludo();

        document.getElementById('vista-login').classList.remove('active');
        document.querySelectorAll('.vista-seccion').forEach(sec => { if (sec.id !== 'vista-login') sec.classList.remove('active'); });
        document.querySelectorAll('.nav-btn').forEach((b, i) => b.classList.toggle('active', i === 0));
        document.getElementById('seccion-checklist').classList.add('active');
        document.getElementById('navIsland').style.display = 'flex';
        window.scrollTo({ top: 0 });

        // Para que los avisos de llegada funcionen sin pasos extra (también al reabrir la app): se carga la ruta y se enciende el GPS
        cargarAvisados();
        cargarRutaChoferReal(nombre);
        if (!MODO_PRUEBA) iniciarSeguimientoGPS();
        actualizarEstadoAlertas();
        if (NATIVO) setTimeout(() => abrirBienvenidaNativa(false), 600);
        docsRevisarAvisos();
        jornadaTraer();
    }

    // ---------- Login único: Chofer / Supervisor / Depósito ----------
    (function () {
        const SUBS = {
            chofer: 'Elegí tu nombre e ingresá tu PIN para ver tu reparto.',
            sup: 'Ingresá la clave para ver la flota, los check-lists y los retornos.',
            dep: 'Elegí tu nombre e ingresá tu PIN para cargar los retornos del camión.'
        };
        let depCargado = false;
        async function cargarUsuariosDep() {
            const sel = document.getElementById('selectDep');
            try {
                const lista = await (await fetch('/api/deposito/usuarios')).json();
                depCargado = lista.length > 0;
                sel.innerHTML = lista.length
                    ? '<option value="">Seleccioná tu nombre</option>' + lista.map(n => `<option>${escapeHtml(n)}</option>`).join('')
                    : '<option value="">Todavía no hay usuarios: pedile al administrador que cree el tuyo</option>';
            } catch (e) { sel.innerHTML = '<option value="">No se pudo cargar la lista</option>'; }
        }
        function elegirRol(r) {
            if (!SUBS[r]) r = 'chofer';
            document.querySelectorAll('#roles button').forEach(b => { const on = b.dataset.rol === r; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
            document.getElementById('loginForm').style.display = r === 'chofer' ? '' : 'none';
            document.getElementById('formSup').style.display = r === 'sup' ? '' : 'none';
            document.getElementById('formDep').style.display = r === 'dep' ? '' : 'none';
            document.getElementById('loginSubRol').textContent = SUBS[r];
            try { localStorage.setItem('flota_rol', r); } catch (e) {}
            if (r === 'dep' && !depCargado) cargarUsuariosDep();
        }
        document.querySelectorAll('#roles button').forEach(b => b.addEventListener('click', () => elegirRol(b.dataset.rol)));
        let rolInicial = 'chofer';
        try { rolInicial = localStorage.getItem('flota_rol') || 'chofer'; } catch (e) {}
        elegirRol(rolInicial);

        function guardar(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
        async function pedir(url, cuerpo, boton) {
            boton.disabled = true; boton.classList.add('cargando');
            try {
                const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });
                const datos = await res.json().catch(() => ({}));
                if (!res.ok) { mostrarToast(datos.error || 'No se pudo iniciar sesión.', 'error'); return null; }
                return datos;
            } catch (e) { mostrarToast('No se pudo conectar con el servidor.', 'error'); return null; }
            finally { boton.disabled = false; boton.classList.remove('cargando'); }
        }
        document.getElementById('formSup').addEventListener('submit', async (e) => {
            e.preventDefault();
            const campo = document.getElementById('claveSup');
            const d = await pedir('/api/admin/login', { password: campo.value }, document.getElementById('btnSup'));
            campo.value = '';
            if (d && d.token) { guardar('flota_admin_token', d.token); location.replace('/admin.html'); }
        });
        document.getElementById('formDep').addEventListener('submit', async (e) => {
            e.preventDefault();
            const nombre = document.getElementById('selectDep').value;
            const campo = document.getElementById('pinDep');
            if (!nombre) { mostrarToast('Seleccioná tu nombre.', 'error'); return; }
            const d = await pedir('/api/deposito/login', { nombre, pin: campo.value.trim() }, document.getElementById('btnDep'));
            campo.value = '';
            if (d && d.token) { guardar('flota_dep_token', d.token); location.replace('/deposito.html'); }
        });
    })();

    // Login: nombre + PIN. El servidor devuelve una sesión que solo da acceso al reparto de ese chofer
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const nombre = document.getElementById('selectChoferLogin').value;
        const campoPin = document.getElementById('pinLogin');
        const pin = campoPin.value.trim();
        if (!nombre) {
            mostrarToast("Por favor seleccioná un chofer.", 'error');
            return;
        }
        if (!/^\d{4,8}$/.test(pin)) {
            mostrarToast("Ingresá tu PIN (entre 4 y 8 números).", 'error');
            return;
        }

        const boton = document.getElementById('btnLogin');
        boton.disabled = true; boton.classList.add('cargando');
        try {
            const res = await fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nombre, pin })
            });
            const datos = await res.json().catch(() => ({}));
            campoPin.value = '';
            if (!res.ok) {
                mostrarToast(datos.error || "No se pudo iniciar sesión.", 'error');
                return;
            }
            guardarTokenSesion(datos.token);
            entrarComoChofer(datos.nombre);
        } catch (err) {
            mostrarToast("No se pudo conectar con el servidor.", 'error');
        } finally {
            boton.disabled = false; boton.classList.remove('cargando');
        }
    });

    // ---------- Cambiar mi PIN ----------
    function abrirCambioPin() {
        if (!choferActual || document.getElementById('modalCambioPin')) return;
        const cont = document.createElement('div');
        cont.id = 'modalCambioPin';
        cont.className = 'modal-overlay';
        cont.innerHTML = `
            <form class="modal-card" autocomplete="off" style="text-align:center;">
                <h3 class="modal-title">🔑 Cambiar mi PIN</h3>
                <p class="modal-sub">${escapeHtml(choferActual)}</p>
                <label for="pinActual">PIN actual</label>
                <input type="password" id="pinActual" inputmode="numeric" pattern="[0-9]*" maxlength="8" required
                       style="text-align:center; letter-spacing:6px; font-size:1.2rem;">
                <label for="pinNuevo" style="margin-top:10px; display:block;">PIN nuevo (4 a 8 números)</label>
                <input type="password" id="pinNuevo" inputmode="numeric" pattern="[0-9]*" maxlength="8" required
                       style="text-align:center; letter-spacing:6px; font-size:1.2rem;">
                <label for="pinNuevo2" style="margin-top:10px; display:block;">Repetí el PIN nuevo</label>
                <input type="password" id="pinNuevo2" inputmode="numeric" pattern="[0-9]*" maxlength="8" required
                       style="text-align:center; letter-spacing:6px; font-size:1.2rem;">
                <p class="login-sub" style="margin-top:12px; font-size:.76rem;">Evitá números fáciles como 1234 o 0000. Al cambiarlo, tu sesión en otros dispositivos se cierra.</p>
                <div style="display:grid; gap:8px; margin-top:12px;">
                    <button type="submit" id="btnGuardarPinNuevo">Guardar PIN</button>
                    <button type="button" class="btn-ghost" id="btnCancelarPin">Cancelar</button>
                </div>
            </form>`;
        document.body.appendChild(cont);
        const cerrar = () => cont.remove();
        cont.addEventListener('click', (ev) => { if (ev.target === cont) cerrar(); });
        cont.querySelector('#btnCancelarPin').onclick = cerrar;
        cont.querySelectorAll('input').forEach(i => i.addEventListener('input', () => { i.value = i.value.replace(/\D/g, ''); }));
        cont.querySelector('form').addEventListener('submit', async (ev) => {
            ev.preventDefault();
            const pinActual = cont.querySelector('#pinActual').value.trim();
            const pinNuevo = cont.querySelector('#pinNuevo').value.trim();
            const pinNuevo2 = cont.querySelector('#pinNuevo2').value.trim();
            if (!/^\d{4,8}$/.test(pinNuevo)) { mostrarToast("El PIN nuevo debe tener entre 4 y 8 números.", 'error'); return; }
            if (pinNuevo !== pinNuevo2) { mostrarToast("Los dos PIN nuevos no coinciden.", 'error'); return; }
            const boton = cont.querySelector('#btnGuardarPinNuevo');
            boton.disabled = true;
            try {
                const res = await apiFetch('/api/cambiar-pin', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pinActual, pinNuevo })
                });
                const datos = await res.json().catch(() => ({}));
                if (!res.ok) { mostrarToast(datos.error || "No se pudo cambiar el PIN.", 'error'); return; }
                guardarTokenSesion(datos.token);
                mostrarToast("✅ PIN cambiado. Usalo la próxima vez que ingreses.", 'ok');
                cerrar();
            } catch (err) {
                mostrarToast("No se pudo conectar con el servidor.", 'error');
            } finally {
                boton.disabled = false;
            }
        });
        setTimeout(() => { const c = cont.querySelector('#pinActual'); if (c) c.focus(); }, 50);
    }

    function cerrarSesion() {
        // Al salir se corta el turno y el GPS, y se borra la sesión del dispositivo
        enviarAlServidor = false;
        detenerSeguimientoGPS();
        if (wakeLock !== null) { wakeLock.release().catch(() => {}); wakeLock = null; }
        borrarTokenGuardado();
        document.getElementById('gps-status').style.display = 'none';
        document.getElementById('avisoWrap').innerHTML = '';
        clientesPorId = {};
        clientesAvisados.clear();
        rutaReset();
        jornadaReset();
        ordenReset();
        docsReset();
        choferActual = "";
        actualizarEstadoAlertas();
        document.querySelectorAll('.vista-seccion').forEach(sec => sec.classList.remove('active'));
        document.getElementById('vista-login').classList.add('active');
        document.getElementById('navIsland').style.display = 'none';
        document.getElementById('userChip').classList.remove('on');
        document.getElementById('selectChoferLogin').value = '';
        document.getElementById('pinLogin').value = '';
    }

    function cambiarVista(vista, btn) {
        document.querySelectorAll('.vista-seccion').forEach(s => {
            if (s.id !== 'vista-login') s.classList.remove('active');
        });
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

        if (vista === 'checklist') {
            document.getElementById('seccion-checklist').classList.add('active');
        } else if (vista === 'combustible') {
            document.getElementById('seccion-combustible').classList.add('active');
        } else if (vista === 'ruta') {
            document.getElementById('seccion-ruta').classList.add('active');
            setTimeout(() => { mapChofer.invalidateSize(); }, 200);
            cargarRutaChoferReal(choferActual);
        } else if (vista === 'orden') {
            document.getElementById('seccion-orden').classList.add('active');
            ordenAbrir();
        } else if (vista === 'docs') {
            document.getElementById('seccion-docs').classList.add('active');
            docsAbrir();
        }
        if (vista !== 'orden') ordenGuardarYa();
        btn.classList.add('active');
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    const itemsChecklist = [
        "Documentación Completa (Licencia, Cédula, Seguro, ITV, etc.)",
        "Cinturón de seguridad",
        "Parabrisas y espejos retrovisores",
        "Botiquín de emergencias",
        "Neumáticos",
        "Luces",
        "Fluidos (aceite y agua)",
        "Bocina",
        "Limpieza"
    ];

    // Cada ítem se responde con un selector táctil OK / Falla / N/A
    const container = document.getElementById('checklist-container');
    itemsChecklist.forEach((item, index) => {
        const div = document.createElement('div');
        div.className = 'checklist-item';
        div.innerHTML = `
            <span>${escapeHtml(item)}</span>
            <div class="seg" role="radiogroup" aria-label="${escapeHtml(item)}">
                <input type="radio" name="item_${index}" id="item_${index}_ok" value="OK" checked>
                <label for="item_${index}_ok" class="l-ok">OK</label>
                <input type="radio" name="item_${index}" id="item_${index}_falla" value="Falla">
                <label for="item_${index}_falla" class="l-falla">Falla</label>
                <input type="radio" name="item_${index}" id="item_${index}_na" value="N/A">
                <label for="item_${index}_na" class="l-na">N/A</label>
            </div>
        `;
        div.addEventListener('change', () => {
            const valor = div.querySelector('input:checked').value;
            div.classList.toggle('falla', valor === 'Falla');
        });
        container.appendChild(div);
    });

    // Inicializar mapa del chofer (mapa oscuro a tono con la app)
    const mapChofer = L.map('map-chofer').setView([-33.2814, -62.1785], 14);
    // Mapa de OpenStreetMap (sin clave). El tono oscuro se logra con un filtro CSS sobre las baldosas.
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap'
    }).addTo(mapChofer);

    let marcadoresClientes = [];
    let marcadorChoferVivo = null;

    // =====================================================================
    //  RUTA SUGERIDA: recorrido por calles pasando por las paradas en el orden del reparto,
    //  con mapa en pantalla completa e indicaciones paso a paso (la ruta la calcula el servidor)
    // =====================================================================
    const RADIO_VISITA_M = 45;       // a esta distancia de un cliente se da la parada por visitada
    const FUERA_DE_RUTA_M = 80;      // si el GPS se aleja tanto del recorrido, se recalcula
    let paradasRuta = [];            // clientes con ubicación, en orden de reparto
    let pinInfo = {};                // id -> { orden, deuda }
    let marcadoresPorId = {};
    let visitadosRuta = new Set();
    let ruta = null;                 // { geom, cum, pasos, tramos, fin, pend, conGPS, distancia, duracion }
    let lineasRuta = [];
    let rutaCalculando = false, rutaUltimoCalculo = 0, rutaTimer = null, rutaFuera = 0, rutaPi = 0;
    let rutaVigente = false;
    let mapaPlaceholder = null;

    function claveVisitados() { return choferActual + ':' + document.getElementById('inputFechaRuta').value; }
    function cargarVisitados() {
        visitadosRuta = new Set();
        try {
            const o = JSON.parse(localStorage.getItem('flota_visitados') || '{}');
            if (o.k === claveVisitados() && Array.isArray(o.ids)) o.ids.forEach(i => visitadosRuta.add(String(i)));
        } catch (e) {}
    }
    function guardarVisitados() { try { localStorage.setItem('flota_visitados', JSON.stringify({ k: claveVisitados(), ids: [...visitadosRuta] })); } catch (e) {} }

    function pendientes() { return paradasRuta.filter(c => !visitadosRuta.has(String(c.id).replace(/\D/g, ''))); }
    function idSeguroDe(c) { return String(c.id).replace(/\D/g, ''); }

    function iconoPin(id) {
        const i = pinInfo[id] || { orden: '', deuda: false };
        const pend = pendientes();
        const esSiguiente = pend.length && idSeguroDe(pend[0]) === id;
        const clase = (i.deuda ? 'pin-debt' : 'pin-ok') + (visitadosRuta.has(id) ? ' pin-visto' : '') + (esSiguiente ? ' pin-next' : '');
        return L.divIcon({ className: 'custom-pin', html: `<div class="pin ${clase}">${escapeHtml(i.orden)}</div>`, iconSize: [28, 28], iconAnchor: [14, 14] });
    }
    function pintarPines() { Object.keys(marcadoresPorId).forEach(id => marcadoresPorId[id].setIcon(iconoPin(id))); actualizarProgresoReparto(); }

    // ---------- Progreso del reparto y filtros de la lista de clientes ----------
    let clientesRutaActual = [];
    let filtroClientes = 'todos';
    function normalizarBusqueda(t) { return String(t == null ? '' : t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
    function pintarFechaLarga() {
        const el = document.getElementById('rutaFechaLarga'), f = (document.getElementById('inputFechaRuta') || {}).value;
        if (!el || !/^\d{4}-\d{2}-\d{2}$/.test(f || '')) return;
        const t = new Date(f + 'T12:00:00').toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
        el.textContent = t.charAt(0).toUpperCase() + t.slice(1);
    }
    function actualizarProgresoReparto() {
        const tot = document.getElementById('rpTotal'); if (!tot) return;
        const ids = clientesRutaActual.map(c => String(c.id).replace(/\D/g, ''));
        const total = Math.max(ids.length, Number(tot.textContent) || 0);
        const vis = ids.filter(id => visitadosRuta.has(id)).length;
        document.getElementById('rpVis').textContent = vis;
        document.getElementById('rpPend').textContent = Math.max(0, total - vis);
        const pct = total ? Math.round(vis * 100 / total) : 0;
        document.getElementById('rpPct').textContent = pct + '%';
        document.getElementById('rpBarra').style.width = pct + '%';
        aplicarFiltroClientes();
    }
    function fijarFiltroClientes(f) { filtroClientes = f; aplicarFiltroClientes(); }
    function aplicarFiltroClientes() {
        const barra = document.getElementById('clToolbar'); if (!barra) return;
        const cards = [...document.querySelectorAll('#contenedor-clientes .cliente-card')];
        barra.style.display = cards.length ? '' : 'none';
        const q = normalizarBusqueda((document.getElementById('clBuscar') || {}).value).trim();
        let nVis = 0;
        cards.forEach(card => {
            const visto = visitadosRuta.has(card.dataset.id);
            card.classList.toggle('visitado', visto);
            if (visto) nVis++;
            const okF = filtroClientes === 'todos' || (filtroClientes === 'pend' && !visto) || (filtroClientes === 'vis' && visto);
            card.style.display = okF && (!q || (card.dataset.texto || '').includes(q)) ? '' : 'none';
        });
        document.getElementById('clNTodos').textContent = cards.length;
        document.getElementById('clNVis').textContent = nVis;
        document.getElementById('clNPend').textContent = cards.length - nVis;
        document.querySelectorAll('.cl-f').forEach(b => b.classList.toggle('on', b.dataset.f === filtroClientes));
        const rep = cards.length ? (cards[0].querySelector('.cc-estados .chip:nth-child(2)') || {}).textContent : '';
        document.getElementById('clSub').textContent = cards.length + ' paradas' + (rep ? ' · ' + rep.replace('Reparto ', 'Ruta ') : '');
    }

    function decodificarPolyline(str) {
        const out = []; let i = 0, lat = 0, lon = 0;
        while (i < str.length) {
            for (const eje of [0, 1]) {
                let b, r = 0, sh = 0;
                do { b = str.charCodeAt(i++) - 63; r |= (b & 31) << sh; sh += 5; } while (b >= 32);
                const d = (r & 1) ? ~(r >> 1) : (r >> 1);
                if (eje === 0) lat += d; else lon += d;
            }
            out.push([lat / 1e6, lon / 1e6]);
        }
        return out;
    }

    function fmtDist(m) {
        if (m < 1000) return (m < 200 ? Math.max(10, Math.round(m / 10) * 10) : Math.round(m / 50) * 50) + ' m';
        return (m / 1000).toFixed(m < 10000 ? 1 : 0).replace('.', ',') + ' km';
    }
    function fmtTiempo(seg) {
        const min = Math.max(1, Math.round(seg / 60));
        if (min < 60) return min + ' min';
        return Math.floor(min / 60) + ' h ' + String(min % 60).padStart(2, '0') + ' min';
    }

    function textoPaso(p) {
        const n = p.n ? p.n : '';
        const en = n ? ' en ' + n : '';
        const por = n ? ' por ' + n : '';
        const dir = { 'left': 'a la izquierda', 'right': 'a la derecha', 'slight left': 'levemente a la izquierda', 'slight right': 'levemente a la derecha', 'sharp left': 'cerrado a la izquierda', 'sharp right': 'cerrado a la derecha' };
        if (p.t === 'arrive') return 'Llegaste a tu parada';
        if (p.t === 'roundabout' || p.t === 'rotary' || p.t === 'roundabout turn') return 'En la rotonda, tomá la ' + (p.ex || 1) + 'ª salida' + (n ? ' hacia ' + n : '');
        if (p.m === 'uturn') return 'Hacé un cambio de sentido';
        if (p.t === 'fork') return 'En la bifurcación, mantenete ' + (dir[p.m] || 'derecho') + por;
        if (p.t === 'merge') return 'Incorporate' + por;
        if (p.t === 'on ramp' || p.t === 'off ramp') return 'Tomá la salida ' + (dir[p.m] || '') + por;
        if (dir[p.m]) return 'Girá ' + dir[p.m] + en;
        return 'Seguí derecho' + por;
    }
    const ANGULO_PASO = { 'straight': 0, 'slight right': 45, 'right': 90, 'sharp right': 135, 'uturn': 180, 'sharp left': -135, 'left': -90, 'slight left': -45 };
    function flechaSvg(grados, llegada) {
        if (llegada) return '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>';
        return `<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" style="transform:rotate(${grados}deg)"><path d="M12 20V5"/><path d="M6 11l6-6 6 6"/></svg>`;
    }

    function rutaDibujar() {
        lineasRuta.forEach(l => mapChofer.removeLayer(l));
        lineasRuta = [];
        if (!ruta) return;
        lineasRuta.push(L.polyline(ruta.geom, { color: '#0b1030', weight: 10, opacity: .7, interactive: false, lineJoin: 'round' }).addTo(mapChofer));
        lineasRuta.push(L.polyline(ruta.geom, { color: '#38bdf8', weight: 5, opacity: .95, interactive: false, lineJoin: 'round' }).addTo(mapChofer));
    }

    function rutaPrepararDatos(r, pend, conGPS) {
        const geom = decodificarPolyline(r.geometria);
        const cum = [0];
        for (let i = 1; i < geom.length; i++) cum.push(cum[i - 1] + distanciaMetros(geom[i - 1][0], geom[i - 1][1], geom[i][0], geom[i][1]));
        // cada paso se ubica en un punto del trazado, para saber cuál es el próximo aunque el GPS se saltee un punto
        const pasos = []; const fin = [];
        let desde = 0;
        r.tramos.forEach((t, ti) => {
            t.pasos.forEach(p => {
                if (p.t === 'depart') return;
                let mejor = desde, md = Infinity;
                const tope = Math.min(geom.length, desde + 4000);
                for (let k = desde; k < tope; k++) {
                    const d = (geom[k][0] - p.ll[0]) ** 2 + (geom[k][1] - p.ll[1]) ** 2;
                    if (d < md) { md = d; mejor = k; }
                }
                desde = mejor;
                pasos.push(Object.assign({ gi: mejor, ti }, p));
                if (p.t === 'arrive') fin[ti] = mejor;
            });
            if (fin[ti] === undefined) fin[ti] = geom.length - 1;
        });
        return { geom, cum, pasos, tramos: r.tramos, fin, pend: pend.map(idSeguroDe), conGPS, distancia: r.distancia, duracion: r.duracion };
    }

    function rutaProgramar(ms) {
        clearTimeout(rutaTimer);
        rutaTimer = setTimeout(() => rutaCalcular(true), ms);
    }

    async function rutaCalcular(forzar) {
        if (!rutaVigente) return;
        const pend = pendientes();
        if (!pend.length) { ruta = null; rutaDibujar(); rutaPintarResumen(); navActualizar(); pintarPines(); return; }
        const puntos = [];
        const conGPS = !!ultimaPosicion;
        if (conGPS) puntos.push([ultimaPosicion.lat, ultimaPosicion.lon]);
        const lote = pend.slice(0, 1);   // solo se traza hasta la próxima parada, así el mapa no se llena de líneas
        lote.forEach(c => puntos.push([Number(c.lat), Number(c.lon)]));
        if (puntos.length < 2) { ruta = null; rutaDibujar(); rutaPintarResumen(); navActualizar(); pintarPines(); return; }
        const espera = rutaUltimoCalculo + 3000 - Date.now();
        if (!forzar || rutaCalculando || espera > 0) { rutaProgramar(Math.max(1500, espera)); return; }
        rutaCalculando = true; rutaUltimoCalculo = Date.now();
        try {
            const res = await apiFetch('/api/ruta-sugerida', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ puntos }) });
            const datos = await res.json().catch(() => ({}));
            if (!rutaVigente) return;
            if (!res.ok) throw new Error(datos.error || 'HTTP ' + res.status);
            ruta = rutaPrepararDatos(datos, lote, conGPS);
            rutaPi = 0; rutaFuera = 0;
            rutaDibujar();
        } catch (e) {
            console.warn('Ruta sugerida:', e.message);
            document.getElementById('rutaResumen').innerHTML = '🧭 No se pudo calcular la ruta ahora. Se reintenta sola.';
            rutaProgramar(20000);
        } finally { rutaCalculando = false; }
        rutaPintarResumen(); navActualizar(); pintarPines();
    }

    function rutaPintarResumen() {
        const el = document.getElementById('rutaResumen');
        const pend = pendientes();
        if (!rutaVigente) { el.innerHTML = '🧭 La ruta sugerida está disponible para el reparto de hoy.'; return; }
        if (!paradasRuta.length) { el.innerHTML = '🧭 Ruta sugerida: no hay clientes con ubicación.'; return; }
        if (!pend.length) { el.innerHTML = '🏁 <b>Recorrido completo.</b> Visitaste todas las paradas.'; return; }
        const resto = `${pend.length} ${pend.length === 1 ? 'parada pendiente' : 'paradas pendientes'}`;
        if (!ruta) { el.innerHTML = ultimaPosicion ? `🧭 Calculando la ruta a la próxima parada… · ${resto}` : `🧭 Tocá ◎ para activar el GPS y ver la ruta a tu próxima parada · ${resto}`; return; }
        el.innerHTML = `🧭 Hasta <b>${escapeHtml(pend[0].nombre)}</b>: <b>${fmtDist(ruta.distancia)}</b> · <b>${fmtTiempo(ruta.duracion)}</b> · ${resto}`;
    }

    // Posición del GPS sobre el trazado (busca cerca de la anterior para no confundirse si el recorrido pasa dos veces por el mismo lugar)
    function rutaUbicarEnTrazado(lat, lon) {
        const g = ruta.geom;
        let mejor = -1, md = Infinity;
        const ini = Math.max(0, rutaPi - 5), fin = Math.min(g.length, rutaPi + 400);
        for (let k = ini; k < fin; k++) {
            const d = (g[k][0] - lat) ** 2 + ((g[k][1] - lon) * Math.cos(lat * Math.PI / 180)) ** 2;
            if (d < md) { md = d; mejor = k; }
        }
        let dm = distanciaMetros(lat, lon, g[mejor][0], g[mejor][1]);
        if (dm > FUERA_DE_RUTA_M) {          // por si se adelantó mucho: se busca en todo el trazado
            for (let k = 0; k < g.length; k++) {
                const d = (g[k][0] - lat) ** 2 + ((g[k][1] - lon) * Math.cos(lat * Math.PI / 180)) ** 2;
                if (d < md) { md = d; mejor = k; }
            }
            dm = distanciaMetros(lat, lon, g[mejor][0], g[mejor][1]);
        }
        return { pi: mejor, dist: dm };
    }

    function navActualizar() {
        const pend = pendientes();
        const sig = pend[0];
        const arriba = document.getElementById('navInstr'), distEl = document.getElementById('navDist'), flecha = document.getElementById('navFlecha');
        // Panel inferior: próxima parada
        document.getElementById('navOrden').innerText = sig ? (sig.orden || '-') : '🏁';
        document.getElementById('navNombre').innerText = sig ? sig.nombre : (paradasRuta.length ? 'Recorrido completo' : 'Sin paradas con ubicación');
        document.getElementById('navDir').innerText = sig ? [sig.direccion, sig.localidad].filter(Boolean).join(' · ') : '';
        let met = '';
        if (ruta && ultimaPosicion) {
            const pi = rutaPi;
            let k = ruta.fin.findIndex(f => f > pi); if (k < 0) k = ruta.fin.length - 1;
            const resta = Math.max(0, ruta.cum[ruta.fin[k]] - ruta.cum[pi]);
            const tr = ruta.tramos[k];
            const tiempo = tr && tr.distancia > 0 ? tr.duracion * Math.min(1, resta / tr.distancia) : 0;
            met = `Faltan <b>${fmtDist(resta)}</b> · ${fmtTiempo(tiempo)} · ${pend.length} ${pend.length === 1 ? 'parada pendiente' : 'paradas pendientes'}`;
        } else if (ruta) {
            met = `${fmtDist(ruta.distancia)} · ${fmtTiempo(ruta.duracion)}`;
        }
        document.getElementById('navMetricas').innerHTML = met;
        // Indicación de giro
        if (!ruta || !ruta.pasos.length) {
            distEl.innerText = '—'; arriba.innerText = pend.length ? 'Calculando la ruta…' : 'Sin paradas pendientes'; flecha.innerHTML = flechaSvg(0, !pend.length); return;
        }
        let idx = ruta.pasos.findIndex(p => p.gi > rutaPi);
        if (idx < 0) idx = ruta.pasos.length - 1;
        const p = ruta.pasos[idx];
        const hasta = ultimaPosicion ? Math.max(0, ruta.cum[p.gi] - ruta.cum[rutaPi]) : p.d;
        distEl.innerText = p.t === 'arrive' && hasta < 25 ? 'Llegaste' : fmtDist(hasta);
        arriba.innerText = textoPaso(p) + (p.t === 'arrive' && sig ? ' · #' + sig.orden : '');
        flecha.innerHTML = flechaSvg(ANGULO_PASO[p.m] !== undefined ? ANGULO_PASO[p.m] : 0, p.t === 'arrive');
    }

    function marcarVisitada(id) {
        visitadosRuta.add(String(id)); guardarVisitados();
        rutaPintarResumen(); pintarPines(); navActualizar();
        rutaProgramar(300);
    }

    function rutaOnPosicion(lat, lon, precision) {
        if (!rutaVigente || !paradasRuta.length) return;
        // Parada visitada: el camión estuvo a pocos metros del cliente
        if (precision <= 60) {
            const hecho = pendientes().filter(c => distanciaMetros(lat, lon, Number(c.lat), Number(c.lon)) <= RADIO_VISITA_M);
            if (hecho.length) { hecho.forEach(c => visitadosRuta.add(idSeguroDe(c))); guardarVisitados(); ruta = null; rutaDibujar(); rutaPintarResumen(); pintarPines(); rutaProgramar(300); return; }
        }
        if (!ruta) { if (!rutaCalculando) rutaProgramar(500); return; }
        if (!ruta.conGPS) { ruta = null; rutaProgramar(300); return; }   // la ruta se había calculado sin ubicación: ahora sale desde donde está el camión
        const u = rutaUbicarEnTrazado(lat, lon);
        rutaPi = u.pi;
        if (u.dist > FUERA_DE_RUTA_M) { rutaFuera++; if (rutaFuera >= 2) { rutaFuera = 0; rutaProgramar(Math.max(300, rutaUltimoCalculo + 10000 - Date.now())); } }
        else rutaFuera = 0;
        navActualizar();
    }

    function rutaIniciar(clientes) {
        const hoy = document.getElementById('inputFechaRuta').value === fechaLocalHoy();
        rutaVigente = hoy;
        paradasRuta = clientes.filter(c => c.lat && c.lon);
        cargarVisitados();
        ruta = null; rutaDibujar(); rutaPintarResumen(); pintarPines();
        if (rutaVigente && paradasRuta.length) rutaProgramar(200);
    }
    function rutaReset() {
        cerrarMapaGrande(true);
        paradasRuta = []; pinInfo = {}; marcadoresPorId = {}; visitadosRuta = new Set(); ruta = null; rutaVigente = false;
        clearTimeout(rutaTimer); rutaDibujar();
        document.getElementById('rutaResumen').innerHTML = '🧭 Ruta sugerida: esperando tu reparto…';
    }

    function rutaSaltear() {
        const sig = pendientes()[0];
        if (!sig) return;
        marcarVisitada(idSeguroDe(sig));
        mostrarToast('Parada salteada: ' + sig.nombre, 'ok');
    }
    function rutaAbrirGoogle() {
        const sig = pendientes()[0];
        if (!sig) return;
        window.open(`https://www.google.com/maps/dir/?api=1&destination=${sig.lat},${sig.lon}&travelmode=driving`, '_blank');
    }

    function actualizarBotonSeguir() { const b = document.getElementById('btnSeguir'); if (b) b.classList.toggle('on', seguirMiUbicacion); }
    function alternarSeguir() {
        seguirMiUbicacion = !seguirMiUbicacion;
        actualizarBotonSeguir();
        if (seguirMiUbicacion && ultimaPosicion) mapChofer.setView([ultimaPosicion.lat, ultimaPosicion.lon], Math.max(mapChofer.getZoom(), 17), { animate: true });
    }
    mapChofer.on('dragstart', () => { if (document.querySelector('.map-wrap.full')) { seguirMiUbicacion = false; actualizarBotonSeguir(); } });

    function abrirMapaGrande() {
        const w = document.querySelector('.map-wrap');
        if (!w || w.classList.contains('full')) return;
        mapaPlaceholder = document.createElement('div');
        mapaPlaceholder.style.height = w.offsetHeight + 'px';
        w.parentNode.insertBefore(mapaPlaceholder, w);
        document.body.appendChild(w);
        w.classList.add('full');
        document.body.style.overflow = 'hidden';
        document.getElementById('icoExpandir').innerHTML = '<path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="M14 10l7-7"/><path d="M3 21l7-7"/>';
        try { history.pushState({ mapa: 1 }, ''); } catch (e) {}
        seguirMiUbicacion = true; actualizarBotonSeguir();
        setTimeout(() => {
            mapChofer.invalidateSize();
            centrarEnMiUbicacion();
            if (!ruta && rutaVigente) rutaProgramar(100);
            navActualizar();
            if (!ultimaPosicion && paradasRuta.length) mapChofer.fitBounds(paradasRuta.map(c => [Number(c.lat), Number(c.lon)]), { padding: [60, 60] });
        }, 60);
    }
    function restaurarMapaChico() {
        const w = document.querySelector('.map-wrap.full');
        if (!w) return;
        w.classList.remove('full');
        if (mapaPlaceholder && mapaPlaceholder.parentNode) { mapaPlaceholder.replaceWith(w); mapaPlaceholder = null; }
        document.body.style.overflow = '';
        document.getElementById('icoExpandir').innerHTML = '<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/>';
        setTimeout(() => mapChofer.invalidateSize(), 60);
    }
    function cerrarMapaGrande(sinHistorial) {
        if (!document.querySelector('.map-wrap.full')) return;
        if (!sinHistorial && history.state && history.state.mapa) { history.back(); return; }   // popstate hace el resto
        restaurarMapaChico();
    }
    function alternarMapaGrande() { document.querySelector('.map-wrap.full') ? cerrarMapaGrande() : abrirMapaGrande(); }
    window.addEventListener('popstate', () => restaurarMapaChico());

    // Deuda del cliente: total de la cuenta, lo que ya corresponde cobrar y el pedido reciente (todavía no se cobra)
    function deudaDe(c) {
        const total = parseFloat(c.saldo_deuda) || 0;
        const cobrar = c.deuda_cobrar !== undefined ? (parseFloat(c.deuda_cobrar) || 0) : Math.max(total, 0);
        const reciente = parseFloat(c.deuda_reciente) || 0;
        return { total, cobrar, reciente, dias: c.dias_reciente || 7 };
    }

    // Ícono de exhibidor (estante de hierro/alambre) en lugar de heladera
    const ICONO_EXH = '<svg class="ico-exh" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 3v17M19 3v17"/><path d="M5 8h14M5 13h14M5 18h14"/><path d="M3 21h4M17 21h4"/><path d="M9 3v5M14 3v5M9 8v5M14 8v5M9 13v5M14 13v5" stroke-width="1" opacity=".6"/></svg>';

    // Exhibidores que el cliente tiene hoy en comodato (REME entregados menos REMI devueltos). null = dato no disponible
    function resumenExhibidores(c) {
        if (!Array.isArray(c.exhibidores)) return null;
        if (c.exhibidores.length === 0) return 'Sin exhibidores en comodato';
        const cant = n => Number.isInteger(Number(n)) ? String(Number(n)) : Number(n).toFixed(2);
        return c.exhibidores.map(e => `${cant(e.cantidad)} × ${e.descripcion}`).join(' · ');
    }

    // Cargar la hoja de ruta real del chofer considerando la fecha elegida
    async function cargarRutaChoferReal(nombreChofer) {
        const fechaInput = document.getElementById('inputFechaRuta').value;
        let url = `/api/ventas-chofer/${encodeURIComponent(nombreChofer)}`;
        if (fechaInput) {
            url += `?fecha=${fechaInput}`;
        }

        try {
            const res = await apiFetch(url);
            const clientes = await res.json();
            pintarResumenReparto(Array.isArray(clientes) ? clientes : []);

            marcadoresClientes.forEach(m => mapChofer.removeLayer(m));
            marcadoresClientes = [];
            marcadoresPorId = {}; pinInfo = {};

            const listaContainer = document.getElementById('contenedor-clientes');
            listaContainer.innerHTML = '';

            if (!Array.isArray(clientes) || clientes.length === 0) {
                listaContainer.innerHTML = `<p class="empty-state">⚠️ No hay repartos ni ventas cargadas para la fecha ${escapeHtml(formatoFecha(fechaInput) === 'S/F' ? 'de hoy' : formatoFecha(fechaInput))}.</p>`;
                rutaIniciar([]);
                return;
            }

            clientesPorId = {};
            clientes.forEach(c => {
                const idSeguro = String(c.id).replace(/\D/g, '');
                clientesPorId[idSeguro] = c;
                const d = deudaDe(c);
                const saldo = d.total;
                const tieneDeuda = d.cobrar > 0;
                const nombreSeguro = escapeHtml(c.nombre);
                const codigoHtml = c.cliente_codigo ? `<span style="color: var(--cyan);">Cód. ${escapeHtml(c.cliente_codigo)}</span> · ` : '';
                const textoBoton = tieneDeuda ? `Ver Cta. Cte 💰 ${formatoPesos(d.cobrar)} a cobrar` : 'Ver Cta. Cte';

                if (c.lat && c.lon) {
                    let popupHtml = `<b>#${escapeHtml(c.orden || '-')} · ${codigoHtml}${nombreSeguro}</b><br>${escapeHtml(c.direccion) || 'Sin dirección'}`;
                    if (d.total > 0) {
                        popupHtml += `<br><button class="btn-deuda" onclick="verCuentaCorriente('${idSeguro}')">${textoBoton}</button>`;
                    }
                    if (Number(c.contado) > 0) popupHtml += `<br>💵 Contado: cobrar ${formatoPesos(c.contado)}`;
                    else if (d.reciente > 0) popupHtml += `<br>🕓 Pedido reciente: ${formatoPesos(d.reciente)}`;
                    if (resumenExhibidores(c)) popupHtml += `<br>${ICONO_EXH} ${escapeHtml(resumenExhibidores(c))}`;

                    pinInfo[idSeguro] = { orden: c.orden || '', deuda: tieneDeuda };
                    const marker = L.marker([c.lat, c.lon], { icon: iconoPin(idSeguro) }).addTo(mapChofer).bindPopup(popupHtml);
                    marcadoresPorId[idSeguro] = marker;
                    marcadoresClientes.push(marker);
                }

                const contado = Number(c.contado) || 0;
                const chipCond = (!contado && c.condicion_pago) ? `<span class="chip chip-neutro">Pago: ${escapeHtml(c.condicion_pago)}</span>` : '';
                let chipCuenta;
                if (tieneDeuda) chipCuenta = `<span class="chip chip-danger">Con deuda</span>`;
                else if (saldo < 0) chipCuenta = `<span class="chip chip-ok">✔ Saldo a favor ${formatoPesos(Math.abs(saldo))}</span>`;
                else if (d.reciente > 0 || contado > 0) chipCuenta = `<span class="chip chip-ok">✔ Sin deuda a cobrar</span>`;
                else chipCuenta = `<span class="chip chip-ok">✔ Al día</span>`;
                let eco = '';
                if (tieneDeuda) eco += `<div class="cc-eco cc-eco-deuda"><span>💰 Deuda a cobrar</span><b>${formatoPesos(d.cobrar)}</b></div>`;
                if (contado > 0) eco += `<div class="cc-eco cc-eco-contado"><span>💵 Contado al entregar</span><b>${formatoPesos(contado)}</b></div>`;
                else if (d.reciente > 0) eco += `<div class="cc-eco cc-eco-reciente"><span>🕓 Pedido reciente</span><b>${formatoPesos(d.reciente)}</b></div>`;

                const card = document.createElement('div');
                card.className = 'cliente-card';
                card.dataset.id = idSeguro;
                card.dataset.texto = normalizarBusqueda([c.nombre, c.direccion, c.localidad, c.cliente_codigo].join(' '));
                card.innerHTML = `
                    <div class="cc-cab">
                        <div class="orden-badge">${escapeHtml(c.orden || 'S/N')}</div>
                        <div class="cliente-body">
                            ${c.cliente_codigo ? `<div class="cc-cod">Cód. ${escapeHtml(c.cliente_codigo)}</div>` : ''}
                            <div class="cliente-nombre">${nombreSeguro}</div>
                            <div class="cliente-dir">${escapeHtml(c.direccion)} · ${escapeHtml(c.localidad)}</div>
                        </div>
                    </div>
                    <div class="cc-estados">
                        ${chipCuenta}
                        <span class="chip">Reparto ${escapeHtml(c.reparto_codigo || 'General')}</span>
                        ${chipCond}
                        <span class="chip chip-visit">✔ Visitado</span>
                    </div>
                    ${eco}
                    ${resumenExhibidores(c) ? `<div class="cliente-exh">${ICONO_EXH} ${escapeHtml(resumenExhibidores(c))}</div>` : ''}
                    <div class="cc-acciones">
                        <button type="button" class="btn-ghost cc-btn" onclick="verCuentaCorriente('${idSeguro}')">Cuenta corriente</button>
                        <button type="button" class="btn-ghost cc-btn" onclick="verComprobantes('${idSeguro}')">🧾 Comprobante</button>
                    </div>
                `;
                listaContainer.appendChild(card);
            });

            rutaIniciar(clientes);
            actualizarProgresoReparto();
            if (!ultimaPosicion && clientes.length > 0 && clientes[0].lat && clientes[0].lon) {
                mapChofer.setView([clientes[0].lat, clientes[0].lon], 13);
            }
            // La ruta puede llegar después de que el GPS ya tenga posición: se revisa de inmediato
            if (ultimaPosicion) revisarCercaniaClientes(ultimaPosicion.lat, ultimaPosicion.lon);
            actualizarEstadoAlertas();
        } catch (err) {
            console.error("Error al cargar la ruta real del chofer:", err);
            document.getElementById('contenedor-clientes').innerHTML = '<p class="empty-state" style="color: var(--danger);">Error al conectar con Gescom.</p>';
        }
    }


    // =====================================================================
    // --- COMPROBANTES DEL DÍA: ver, descargar PDF y compartir por WhatsApp ---
    // Es una copia informativa armada con los datos de Gescom (no el comprobante fiscal)
    let comprobantesAbiertos = [];
    function fechaDeReparto() {
        return (document.getElementById('inputFechaRuta') || {}).value || docsHoy();
    }
    function nombreComprobante(c) {
        return (c.tipo || 'Comprobante') + ' ' + String(c.pv || '').padStart(4, '0') + '-' + String(c.numero || '').padStart(8, '0');
    }
    function textoComprobante(c) {
        const l = [nombreComprobante(c) + ' · ' + (c.cliente || ''), 'Fecha: ' + (c.fecha || '')];
        (c.items || []).forEach(i => l.push('• ' + Number(i.cantidad) + ' × ' + (i.descripcion || i.codigo) + '  ' + formatoPesos(i.importe)));
        l.push('TOTAL: ' + formatoPesos(c.total), '(Copia informativa, no es el comprobante fiscal)');
        return l.join('\n');
    }
    async function verComprobantes(clienteId) {
        const cliente = clientesPorId[clienteId];
        let lista;
        try {
            const r = await apiFetch('/api/comprobantes?cliente_id=' + encodeURIComponent(clienteId) + '&fecha=' + encodeURIComponent(fechaDeReparto()));
            if (!r.ok) throw new Error('error');
            lista = await r.json();
        } catch (e) { mostrarToast('No se pudieron cargar los comprobantes.', 'error'); return; }
        comprobantesAbiertos = lista;
        let cuerpo;
        if (!lista.length) cuerpo = '<p class="empty-state">No hay comprobantes de este cliente para el día elegido.</p>';
        else cuerpo = lista.map((c, n) =>
            '<div class="doc-item"><div class="doc-nom">🧾 ' + escapeHtml(nombreComprobante(c)) + '</div>' +
            '<div class="doc-estado">' + escapeHtml(c.fecha || '') + (c.condicion ? ' · ' + escapeHtml(c.condicion) : '') + '</div>' +
            '<table class="tabla-cc"><tbody>' + (c.items || []).map(i =>
                '<tr><td>' + escapeHtml(Number(i.cantidad) + ' × ' + (i.descripcion || i.codigo)) + '</td><td class="num">' + formatoPesos(i.importe) + '</td></tr>').join('') + '</tbody></table>' +
            '<div class="cc-total"><span>Total</span><span class="monto">' + formatoPesos(c.total) + '</span></div>' +
            '<div class="doc-opc"><button type="button" onclick="comprobanteAccion(' + n + ',\'ver\')">📄 Ver PDF</button>' +
            '<button type="button" onclick="comprobanteAccion(' + n + ',\'bajar\')">⬇ Descargar</button>' +
            '<button type="button" onclick="comprobanteAccion(' + n + ',\'compartir\')">📲 WhatsApp</button></div></div>').join('') +
            '<p class="doc-nota">Copia informativa con los datos del sistema. No es el comprobante fiscal.</p>';
        const m = ordenModal('<h3 class="modal-title">🧾 ' + escapeHtml(cliente ? cliente.nombre : 'Cliente') + '</h3><p class="modal-sub">Comprobantes del ' + escapeHtml(formatoFecha(fechaDeReparto())) + '</p>' + cuerpo +
            '<button type="button" class="btn-ghost" onclick="this.closest(\'.modal-overlay\').remove()">Cerrar</button>');
        m.style.zIndex = 2000;
    }
    async function comprobanteAccion(n, accion) {
        const c = comprobantesAbiertos[n];
        if (!c) return;
        try {
            const r = await apiFetch('/api/comprobantes/' + encodeURIComponent(c.id) + '/pdf?fecha=' + encodeURIComponent(fechaDeReparto()));
            if (!r.ok) throw new Error('error');
            const blob = await r.blob();
            const archivo = nombreComprobante(c).replace(/[^A-Za-z0-9_-]+/g, '_') + '.pdf';
            const file = new File([blob], archivo, { type: 'application/pdf' });
            if (accion === 'compartir') {
                if (navigator.canShare && navigator.canShare({ files: [file] })) {
                    try { await navigator.share({ files: [file], title: nombreComprobante(c), text: nombreComprobante(c) + ' · ' + (c.cliente || '') }); return; }
                    catch (e) { if (e && e.name === 'AbortError') return; }
                }
                // Sin compartir archivos en este equipo: se manda el detalle como texto por WhatsApp
                window.open('https://wa.me/?text=' + encodeURIComponent(textoComprobante(c)), '_blank');
                return;
            }
            const url = URL.createObjectURL(blob);
            if (accion === 'ver') { window.open(url, '_blank'); }
            else { const a = document.createElement('a'); a.href = url; a.download = archivo; document.body.appendChild(a); a.click(); a.remove(); }
            setTimeout(() => URL.revokeObjectURL(url), 60000);
        } catch (e) { mostrarToast('No se pudo generar el comprobante.', 'error'); }
    }

    // --- FUNCIÓN: CONSULTAR Y MOSTRAR LA CUENTA CORRIENTE DEL CLIENTE ---
    // Muestra comprobantes a cobrar y créditos (notas de crédito, recibos a cuenta) y el total neto
    async function verCuentaCorriente(clienteId) {
        const cliente = clientesPorId[clienteId];
        const nombreCliente = cliente ? cliente.nombre : 'Cliente';
        try {
            const response = await apiFetch(`/api/cta-cte/${clienteId}`);
            if (response.status === 403) {
                mostrarToast("Ese cliente no figura en tu reparto actual. Actualizá la hoja de ruta.", 'error');
                return;
            }
            if (!response.ok) throw new Error('HTTP ' + response.status);
            const movimientos = await response.json();

            const debitos = movimientos.filter(m => !m.es_credito);
            const creditos = movimientos.filter(m => m.es_credito);
            const totalDebitos = debitos.reduce((a, m) => a + parseFloat(m.saldo_pendiente), 0);
            const totalCreditos = creditos.reduce((a, m) => a + parseFloat(m.saldo_pendiente), 0); // ya viene negativo
            const total = totalDebitos + totalCreditos;
            const hoy = fechaLocalHoy();

            const fila = m => {
                const importe = parseFloat(m.saldo_pendiente);
                const vencido = !m.es_credito && m.fecha_vencimiento && String(m.fecha_vencimiento).slice(0, 10) < hoy;
                const cuota = m.numero_cuota > 1 ? ` (cuota ${escapeHtml(m.numero_cuota)})` : '';
                const etiquetaReciente = m.reciente ? ' <span class="chip chip-warn" style="padding:1px 7px; font-size:.62rem;">Reciente</span>' : '';
                return `
                    <tr>
                        <td>${escapeHtml(m.tipo_comprobante_codigo)} ${escapeHtml(m.punto_venta_codigo)}-${escapeHtml(m.numero_comprobante)}${cuota}${etiquetaReciente}</td>
                        <td style="color:${vencido ? 'var(--danger)' : 'var(--muted)'};">${m.es_credito ? '-' : formatoFecha(m.fecha_vencimiento)}</td>
                        <td class="num" style="color:${m.es_credito ? 'var(--ok)' : 'var(--danger)'};">${formatoPesos(importe)}</td>
                    </tr>`;
            };

            let html = `
                <div class="modal-overlay" onclick="if (event.target === this) this.remove()">
                    <div class="modal-card">
                        <h3 class="modal-title">💳 ${escapeHtml(nombreCliente)}</h3>
                        <p class="modal-sub">Cuenta corriente</p>`;

            if (movimientos.length === 0) {
                html += `<p class="empty-state" style="color: var(--ok);">El cliente no registra movimientos pendientes.</p>`;
            } else {
                html += `<table class="tabla-cc">
                    <thead>
                        <tr>
                            <th>Comprobante</th>
                            <th>Vence</th>
                            <th style="text-align: right;">Saldo</th>
                        </tr>
                    </thead>
                    <tbody>${debitos.map(fila).join('')}${creditos.map(fila).join('')}</tbody>
                </table>`;

                if (creditos.length > 0) {
                    html += `
                    <div class="cc-line"><span>Subtotal comprobantes</span><span>${formatoPesos(totalDebitos)}</span></div>
                    <div class="cc-line" style="color: var(--ok);"><span>Créditos a favor</span><span>${formatoPesos(totalCreditos)}</span></div>`;
                }

                const recientes = debitos.filter(m => m.reciente).reduce((a, m) => a + parseFloat(m.saldo_pendiente), 0);
                const recienteEf = total > 0 ? Math.min(recientes, total) : 0;
                if (recienteEf > 0) {
                    const aCobrar = Math.max(0, total - recientes);
                    html += `
                    <div class="cc-line" style="color: var(--warn);"><span>🕓 Pedido reciente (todavía no se cobra)</span><span>${formatoPesos(recienteEf)}</span></div>
                    <div class="cc-total">
                        <span>A cobrar ahora</span>
                        <span class="monto" style="color:${aCobrar > 0 ? 'var(--danger)' : 'var(--ok)'};">${formatoPesos(aCobrar)}</span>
                    </div>
                    <div class="cc-line"><span>Total de la cuenta corriente</span><span>${formatoPesos(total)}</span></div>`;
                } else {
                    const etiqueta = total > 0 ? 'Total a cobrar' : (total < 0 ? 'Saldo a favor' : 'Saldo');
                    const colorTotal = total > 0 ? 'var(--danger)' : 'var(--ok)';
                    html += `
                    <div class="cc-total">
                        <span>${etiqueta}</span>
                        <span class="monto" style="color:${colorTotal};">${formatoPesos(total)}</span>
                    </div>`;
                }
            }

            html += `
                        <button type="button" class="btn-ghost" onclick="this.closest('.modal-overlay').remove()">Cerrar</button>
                    </div>
                </div>`;

            document.body.insertAdjacentHTML('beforeend', html);

        } catch (error) {
            console.error("Error al obtener la cuenta corriente:", error);
            mostrarToast("No se pudo cargar la cuenta corriente en este momento.", 'error');
        }
    }

    // =====================================================================
    //  GPS EN VIVO + AVISO DE LLEGADA A CLIENTES
    // =====================================================================
    const RADIO_AVISO_METROS = 250;      // a esta distancia de un cliente se muestra el aviso
    const INTERVALO_ENVIO_MS = 30000;    // cada cuánto se informa la posición al servidor
    const PRECISION_MAX_ENVIO_M = 150;   // no se envían posiciones con más de este error
    const MODO_PRUEBA = new URLSearchParams(location.search).has('sim'); // ?sim=1 → tocar el mapa simula la ubicación

    let watchId = null;
    let enviarAlServidor = false;        // true mientras hay un turno activo (check-list enviado)
    let vehiculoActual = "";
    let ultimoEnvio = 0;
    let ultimaPosicion = null;
    let circuloPrecision = null;
    let seguirMiUbicacion = true;
    let wakeLock = null;

    // =====================================================================
    //  APP ANDROID (APK): GPS en segundo plano, avisos del sistema y envío nativo
    //  Dentro del APK, Capacitor deja disponibles los plugins; en el navegador común nada de esto se activa.
    // =====================================================================
    const CAP = window.Capacitor || null;
    const NATIVO = !!(CAP && typeof CAP.isNativePlatform === 'function' && CAP.isNativePlatform());
    let watcherNativo = null;
    let gpsNativoIniciando = false;
    const pluginsNativos = {};
    function pluginNativo(nombre) {
        if (!NATIVO) return null;
        if (!pluginsNativos[nombre]) {
            try { pluginsNativos[nombre] = (CAP.Plugins && CAP.Plugins[nombre]) || CAP.registerPlugin(nombre); } catch (e) { return null; }
        }
        return pluginsNativos[nombre];
    }

    async function prepararNotificacionesNativas() {
        const LN = pluginNativo('LocalNotifications');
        if (!LN) return;
        try {
            await LN.createChannel({ id: 'avisos', name: 'Avisos de llegada a clientes', description: 'Te avisa cuando te acercás a un cliente de tu ruta',
                importance: 5, visibility: 1, vibration: true, lights: true });
        } catch (e) {}
        try {
            const p = await LN.checkPermissions();
            if (p && p.display !== 'granted') await LN.requestPermissions();
        } catch (e) {}
    }

    // GPS que sigue funcionando con la pantalla apagada (servicio con notificación fija "ruta en curso")
    async function iniciarGpsNativo() {
        if (watcherNativo !== null || gpsNativoIniciando) return true;
        const BG = pluginNativo('BackgroundGeolocation');
        if (!BG) { mostrarToast("No se pudo iniciar el GPS de la app.", 'error'); return false; }
        gpsNativoIniciando = true;
        try {
            prepararNotificacionesNativas();
            watcherNativo = await BG.addWatcher({
                backgroundTitle: 'Flota · ruta en curso',
                backgroundMessage: 'Compartiendo tu ubicación y avisando cuando llegues a un cliente',
                requestPermissions: true,
                stale: false,
                distanceFilter: 10
            }, (loc, err) => {
                if (err) {
                    if (err.code === 'NOT_AUTHORIZED') {
                        mostrarToast("Falta el permiso de ubicación. Tocá «Permisos y batería».", 'error');
                        abrirBienvenidaNativa(true);
                    }
                    return;
                }
                if (!loc) return;
                onPosicion({ coords: { latitude: loc.latitude, longitude: loc.longitude, accuracy: loc.accuracy } });
            });
            document.getElementById('gps-pill').classList.add('on');
            actualizarEstadoMapa("Buscando señal GPS...");
            return true;
        } catch (e) {
            mostrarToast("No se pudo iniciar el GPS. Revisá los permisos del celular.", 'error');
            return false;
        } finally {
            gpsNativoIniciando = false;
        }
    }
    function detenerGpsNativo() {
        if (watcherNativo === null) return;
        const BG = pluginNativo('BackgroundGeolocation');
        try { if (BG) BG.removeWatcher({ id: watcherNativo }); } catch (e) {}
        watcherNativo = null;
    }

    // Aviso del sistema (suena y vibra aunque la pantalla esté apagada)
    async function notificarNativo(titulo, cuerpo) {
        const LN = pluginNativo('LocalNotifications');
        if (!LN) return;
        try {
            await LN.schedule({ notifications: [{ id: Date.now() % 2000000000, title: titulo, body: cuerpo, largeBody: cuerpo, channelId: 'avisos' }] });
        } catch (e) {}
    }

    // Muestra en pantalla si el último envío llegó al servidor (sirve para diagnosticar problemas de GPS)
    function marcarEnvio(ok, detalle) {
        const el = document.getElementById('envioEstado');
        if (!el) return;
        const hora = new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        el.style.color = ok ? 'var(--ok)' : '#fb7185';
        el.textContent = ok ? ('Envío al servidor: ✔ ' + hora) : ('Envío al servidor: ✖ ' + hora + (detalle ? ' · ' + detalle : ''));
    }

    // Al estar en segundo plano, Android frena los pedidos de la página; el envío nativo no se frena
    function enviarUbicacionServidor(lat, lon) {
        const cuerpo = { chofer_id: choferActual, vehiculo: vehiculoActual, latitud: lat, longitud: lon };
        const viaWeb = () => apiFetch('/api/ubicacion', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo)
        }).then(r => marcarEnvio(r.ok, r.ok ? '' : 'error ' + r.status)).catch(() => marcarEnvio(false, 'sin conexión'));
        const http = pluginNativo('CapacitorHttp');
        if (http && typeof http.request === 'function') {
            http.request({
                url: location.origin + '/api/ubicacion', method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (leerTokenGuardado() || '') },
                data: cuerpo
            }).then(r => {
                if (r && r.status === 401) { sesionVencida(); return; }
                if (r && r.status >= 200 && r.status < 300) marcarEnvio(true);
                else viaWeb();
            }).catch(viaWeb);
        } else {
            viaWeb();
        }
    }

    // Si el vehículo está quieto el GPS no informa posiciones nuevas: se reenvía la última cada 30 s
    // para que el panel de administración lo vea igual (y se envía al instante al enviar el check-list).
    function reenviarUltimaPosicion(forzar) {
        if (!enviarAlServidor || MODO_PRUEBA || !ultimaPosicion) return;
        if (ultimaPosicion.precision > PRECISION_MAX_ENVIO_M) return;
        if (!forzar && Date.now() - ultimoEnvio < INTERVALO_ENVIO_MS) return;
        ultimoEnvio = Date.now();
        enviarUbicacionServidor(ultimaPosicion.lat, ultimaPosicion.lon);
    }
    setInterval(() => reenviarUltimaPosicion(false), 15000);

    // Pantalla de bienvenida: permisos y batería (en Motorola/Samsung/Xiaomi sin esto el sistema puede apagar la app)
    function abrirBienvenidaNativa(forzar) {
        if (!NATIVO || document.getElementById('modalBienvenidaNativa')) return;
        let hecho = false;
        try { hecho = localStorage.getItem('flota_bienvenida_ok') === '1'; } catch (e) {}
        if (hecho && !forzar) return;
        const cont = document.createElement('div');
        cont.id = 'modalBienvenidaNativa';
        cont.className = 'modal-overlay';
        cont.innerHTML = `
            <div class="modal-card">
                <h3 class="modal-title">📱 Dejá el celular listo</h3>
                <p class="modal-sub">Hacelo una sola vez</p>
                <div class="paso-nat"><div class="num-nat">1</div><div>
                    <h4>📍 Ubicación todo el tiempo</h4>
                    <p>Entrá a Permisos → Ubicación y elegí «Permitir todo el tiempo». Activá también «Usar ubicación precisa».</p>
                    <button type="button" class="btn-ghost" data-acc="ajustes">Abrir ajustes de la app</button>
                </div></div>
                <div class="paso-nat"><div class="num-nat">2</div><div>
                    <h4>🔔 Notificaciones</h4>
                    <p>Para que suene el aviso cuando llegás a un cliente, aunque la pantalla esté apagada.</p>
                    <button type="button" class="btn-ghost" data-acc="notif">Permitir notificaciones</button>
                </div></div>
                <div class="paso-nat"><div class="num-nat">3</div><div>
                    <h4>🔋 Batería sin restricciones</h4>
                    <p>En los ajustes de la app entrá a Batería (o «Uso de batería de la app») y elegí «Sin restricciones».</p>
                    <button type="button" class="btn-ghost" data-acc="ajustes">Abrir ajustes de la app</button>
                </div></div>
                <div style="display:grid; gap:8px; margin-top:14px;">
                    <button type="button" data-acc="listo">Ya lo configuré</button>
                    <button type="button" class="btn-ghost" data-acc="luego">Más tarde</button>
                </div>
            </div>`;
        document.body.appendChild(cont);
        cont.querySelectorAll('[data-acc="ajustes"]').forEach(b => b.onclick = () => {
            const BG = pluginNativo('BackgroundGeolocation');
            try { if (BG) BG.openSettings(); } catch (e) {}
        });
        cont.querySelector('[data-acc="notif"]').onclick = () => prepararNotificacionesNativas();
        cont.querySelector('[data-acc="listo"]').onclick = () => {
            try { localStorage.setItem('flota_bienvenida_ok', '1'); } catch (e) {}
            cont.remove();
        };
        cont.querySelector('[data-acc="luego"]').onclick = () => cont.remove();
    }
    if (NATIVO) document.getElementById('btnPermisosNativos').style.display = 'block';
    const clientesAvisados = new Set();  // "fecha:idCliente" para avisar una sola vez por cliente y día

    function distanciaMetros(lat1, lon1, lat2, lon2) {
        const R = 6371000, rad = Math.PI / 180;
        const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    async function solicitarWakeLock() {
        if (NATIVO) return; // en la app el servicio de GPS ya mantiene el seguimiento con la pantalla apagada
        if ('wakeLock' in navigator) {
            try { wakeLock = await navigator.wakeLock.request('screen'); } catch (err) {}
        }
    }
    // Android/iOS liberan el bloqueo de pantalla al minimizar; se vuelve a pedir al regresar
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && enviarAlServidor) solicitarWakeLock();
    });

    function actualizarEstadoMapa(texto) {
        document.getElementById('mapStatus').innerText = texto;
        document.getElementById('btnMiUbicacion').classList.toggle('on', watchId !== null || watcherNativo !== null || MODO_PRUEBA);
    }

    // Si el usuario arrastra el mapa, deja de seguirlo hasta que toque ◎
    mapChofer.on('dragstart', () => { seguirMiUbicacion = false; });
    if (MODO_PRUEBA) {
        mapChofer.on('click', (e) => {
            onPosicion({ coords: { latitude: e.latlng.lat, longitude: e.latlng.lng, accuracy: 10 } });
        });
        setTimeout(() => mostrarToast("Modo prueba: tocá el mapa para simular tu ubicación.", 'ok'), 600);
        actualizarEstadoMapa("Modo prueba · tocá el mapa para simular tu ubicación");
    }

    function iniciarSeguimientoGPS() {
        if (MODO_PRUEBA) return true;
        if (NATIVO) { iniciarGpsNativo(); return true; }
        if (!navigator.geolocation) {
            mostrarToast("Este dispositivo no permite usar el GPS.", 'error');
            return false;
        }
        if (watchId !== null) return true;
        watchId = navigator.geolocation.watchPosition(onPosicion, onErrorGPS, {
            enableHighAccuracy: true, maximumAge: 2000, timeout: 20000
        });
        document.getElementById('gps-pill').classList.add('on');
        actualizarEstadoMapa("Buscando señal GPS...");
        return true;
    }

    function detenerSeguimientoGPS() {
        detenerGpsNativo();
        if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
        document.getElementById('gps-pill').classList.remove('on');
        if (marcadorChoferVivo) { mapChofer.removeLayer(marcadorChoferVivo); marcadorChoferVivo = null; }
        if (circuloPrecision) { mapChofer.removeLayer(circuloPrecision); circuloPrecision = null; }
        ultimaPosicion = null;
        actualizarEstadoMapa("Ubicación apagada · tocá ◎ para verla en vivo");
    }

    // Tocar la pastilla "EN VIVO" apaga la ubicación, salvo que haya un turno activo
    function alternarSeguimiento() {
        if (enviarAlServidor) {
            mostrarToast("Hay una jornada en curso. Para detener el GPS, finalizá la jornada en Check-list.", 'error');
            return;
        }
        detenerSeguimientoGPS();
    }

    function centrarEnMiUbicacion() {
        seguirMiUbicacion = true;
        if (!iniciarSeguimientoGPS()) return;
        if (ultimaPosicion) {
            mapChofer.setView([ultimaPosicion.lat, ultimaPosicion.lon], Math.max(mapChofer.getZoom(), 16), { animate: true });
        }
        actualizarEstadoMapa(ultimaPosicion ? "Siguiendo tu ubicación en vivo" : "Buscando señal GPS...");
    }

    function onErrorGPS(err) {
        if (err.code === 1) {
            mostrarToast("Permití el acceso a la ubicación en el navegador para usar el GPS.", 'error');
            detenerSeguimientoGPS();
        } else if (err.code === 2) {
            actualizarEstadoMapa("Sin señal GPS. Buscando...");
        }
        // code 3 (timeout): el seguimiento continúa y se reintenta solo
    }

    // Se ejecuta cada vez que el dispositivo informa una nueva posición (movimiento real, sin esperar)
    function onPosicion(pos) {
        const lat = pos.coords.latitude, lon = pos.coords.longitude;
        const precision = Math.round(pos.coords.accuracy || 0);
        const primera = !ultimaPosicion;
        ultimaPosicion = { lat, lon, precision };

        // Punto celeste pulsante + círculo con la precisión del GPS
        if (marcadorChoferVivo) {
            marcadorChoferVivo.setLatLng([lat, lon]);
        } else {
            marcadorChoferVivo = L.marker([lat, lon], {
                zIndexOffset: 1000,
                icon: L.divIcon({ className: 'custom-pin', html: '<div class="pin-live"></div>', iconSize: [20, 20], iconAnchor: [10, 10] })
            }).addTo(mapChofer).bindPopup("<b>¡Estás acá!</b><br>Ubicación en vivo");
        }
        if (circuloPrecision) {
            circuloPrecision.setLatLng([lat, lon]).setRadius(precision || 1);
        } else {
            circuloPrecision = L.circle([lat, lon], {
                radius: precision || 1, color: '#22d3ee', weight: 1, fillColor: '#22d3ee', fillOpacity: 0.12, interactive: false
            }).addTo(mapChofer);
        }

        if (primera) {
            mapChofer.setView([lat, lon], Math.max(mapChofer.getZoom(), 16), { animate: true });
        } else if (seguirMiUbicacion) {
            mapChofer.panTo([lat, lon], { animate: true, duration: 0.5 });
        }

        const texto = `Lat ${lat.toFixed(5)}, Lon ${lon.toFixed(5)} · precisión ±${precision} m`;
        document.getElementById('coords').innerText = texto;
        actualizarEstadoMapa(MODO_PRUEBA ? "Modo prueba · ubicación simulada" : (seguirMiUbicacion ? "Siguiendo tu ubicación en vivo · ±" + precision + " m" : "Ubicación en vivo · ±" + precision + " m"));

        // Informar al servidor (máx. una vez cada 30 s y solo con buena precisión)
        if (enviarAlServidor && !MODO_PRUEBA && precision <= PRECISION_MAX_ENVIO_M && Date.now() - ultimoEnvio >= INTERVALO_ENVIO_MS) {
            ultimoEnvio = Date.now();
            enviarUbicacionServidor(lat, lon);
        }

        revisarCercaniaClientes(lat, lon);
        rutaOnPosicion(lat, lon, precision);
    }

    // Recuerda qué clientes ya se avisaron hoy (sobrevive a recargar la página)
    function cargarAvisados() {
        try {
            const o = JSON.parse(localStorage.getItem('flota_avisados') || '{}');
            if (o.fecha === fechaLocalHoy() && Array.isArray(o.claves)) o.claves.forEach(k => clientesAvisados.add(k));
        } catch (e) {}
    }
    function guardarAvisados() {
        if (MODO_PRUEBA) return;
        try { localStorage.setItem('flota_avisados', JSON.stringify({ fecha: fechaLocalHoy(), claves: [...clientesAvisados] })); } catch (e) {}
    }
    function formatoDistancia(m) {
        return m >= 1000 ? (m / 1000).toFixed(1).replace('.', ',') + ' km' : Math.round(m / 10) * 10 + ' m';
    }

    // Línea bajo el mapa que muestra si los avisos de llegada están funcionando y por qué no
    function actualizarEstadoAlertas() {
        const el = document.getElementById('alertasStatus');
        if (!el) return;
        const fecha = document.getElementById('inputFechaRuta').value;
        const clientes = Object.values(clientesPorId).filter(c => c.lat && c.lon);
        if (!choferActual) { el.innerText = ''; return; }
        if (fecha !== fechaLocalHoy()) { el.innerText = '🔕 Avisos de llegada apagados: la fecha elegida no es la de hoy'; return; }
        if (clientes.length === 0) { el.innerText = '🔕 Avisos de llegada: todavía no hay clientes de hoy cargados'; return; }
        if (!ultimaPosicion) { el.innerText = `🔕 Avisos de llegada: esperando tu ubicación (${clientes.length} clientes cargados). Tocá ◎ y permití el GPS.`; return; }
        let mejor = null;
        clientes.forEach(c => {
            const d = distanciaMetros(ultimaPosicion.lat, ultimaPosicion.lon, Number(c.lat), Number(c.lon));
            if (!mejor || d < mejor.d) mejor = { c, d };
        });
        el.innerText = `🔔 Avisos activos · ${clientes.length} clientes · más cercano: ${mejor.c.nombre} a ${formatoDistancia(mejor.d)}`;
    }

    // Avisa cuando el chofer se acerca a un cliente (una vez; se vuelve a habilitar si se aleja más del doble del radio)
    function revisarCercaniaClientes(lat, lon) {
        actualizarEstadoAlertas();
        const fecha = document.getElementById('inputFechaRuta').value;
        if (fecha !== fechaLocalHoy()) return; // solo se avisa en la ruta de hoy

        const cercanos = [];
        Object.keys(clientesPorId).forEach(idSeguro => {
            const c = clientesPorId[idSeguro];
            if (!c.lat || !c.lon) return;
            const clave = `${choferActual}:${fecha}:${idSeguro}`;
            const d = distanciaMetros(lat, lon, Number(c.lat), Number(c.lon));
            if (clientesAvisados.has(clave)) {
                if (d > RADIO_AVISO_METROS * 2) { clientesAvisados.delete(clave); guardarAvisados(); }
                return;
            }
            if (d <= RADIO_AVISO_METROS) cercanos.push({ c, idSeguro, clave, d });
        });
        cercanos.sort((a, b) => a.d - b.d).forEach(x => {
            clientesAvisados.add(x.clave);
            guardarAvisados();
            mostrarAvisoCliente(x.c, x.idSeguro, x.d);
        });
    }

    function textoDeudaCliente(d) {
        if (d.cobrar > 0) {
            let texto = `Este cliente debe ${formatoPesos(d.cobrar)} a cobrar.`;
            if (d.reciente > 0) texto += ` Además tiene ${formatoPesos(d.reciente)} de pedido reciente (todavía no se cobra).`;
            return { clase: 'debe', texto };
        }
        if (d.reciente > 0) {
            return { clase: 'reciente', texto: `No tiene deuda a cobrar. Figuran ${formatoPesos(d.reciente)} de pedido reciente (menos de ${d.dias} días): todavía no corresponde cobrarlo.` };
        }
        if (d.total < 0) return { clase: 'ok', texto: `Este cliente no debe (tiene ${formatoPesos(Math.abs(d.total))} a favor).` };
        return { clase: 'ok', texto: 'Este cliente no debe.' };
    }

    function mostrarAvisoCliente(c, idSeguro, distancia) {
        const d = deudaDe(c);
        const { clase, texto } = textoDeudaCliente(d);
        const exhibidoresTxt = resumenExhibidores(c);
        const codigo = c.cliente_codigo ? `${c.cliente_codigo}, ` : '';
        const titulo = `Estás llegando al cliente ${codigo}${c.nombre}`;
        const metros = Math.max(10, Math.round(distancia / 10) * 10);

        const aviso = document.createElement('div');
        aviso.className = 'aviso ' + clase;
        aviso.innerHTML = `
            <div class="aviso-head">
                <div class="aviso-icon">📍</div>
                <div>
                    <div class="aviso-title">Estás llegando al cliente ${escapeHtml(codigo)}${escapeHtml(c.nombre)}</div>
                    <div class="aviso-meta">A unos ${metros} m · ${escapeHtml(c.direccion || 'Sin dirección')}${c.localidad ? ' (' + escapeHtml(c.localidad) + ')' : ''}</div>
                </div>
            </div>
            <div class="aviso-msg">${escapeHtml(texto)}</div>
            ${exhibidoresTxt ? `<div class="aviso-exh">${ICONO_EXH} Exhibidores: ${escapeHtml(exhibidoresTxt)}</div>` : ''}
            <div class="aviso-actions">
                ${d.total > 0 ? `<button type="button" class="btn-deuda" data-accion="cc" style="flex:1;">Ver Cta. Cte</button>` : ''}
                <button type="button" class="btn-ghost" data-accion="cerrar" style="flex:1;">Entendido</button>
            </div>`;
        aviso.querySelector('[data-accion="cerrar"]').onclick = () => aviso.remove();
        const btnCc = aviso.querySelector('[data-accion="cc"]');
        if (btnCc) btnCc.onclick = () => { aviso.remove(); verCuentaCorriente(idSeguro); };
        document.getElementById('avisoWrap').appendChild(aviso);
        setTimeout(() => aviso.remove(), 90000);

        // Llamar la atención aunque el chofer esté mirando el camino: vibración, sonido y, si se permitió, notificación del sistema
        try { if (navigator.vibrate) navigator.vibrate([250, 120, 250]); } catch (e) {}
        sonarAviso();
        notificarSistema(titulo, exhibidoresTxt ? `${texto} Exhibidores: ${exhibidoresTxt}.` : texto, idSeguro);
    }

    function sonarAviso() {
        try {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return;
            const ctx = new Ctx(), osc = ctx.createOscillator(), gain = ctx.createGain();
            osc.type = 'sine'; osc.frequency.value = 880;
            gain.gain.setValueAtTime(0.0001, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.45);
            osc.connect(gain); gain.connect(ctx.destination);
            osc.start(); osc.stop(ctx.currentTime + 0.5);
            osc.onended = () => ctx.close();
        } catch (e) {}
    }

    function pedirPermisoNotificaciones() {
        if (NATIVO) { prepararNotificacionesNativas(); return; }
        try {
            if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
        } catch (e) {}
    }
    function notificarSistema(titulo, cuerpo, tag) {
        if (NATIVO) { notificarNativo(titulo, cuerpo); return; }
        try {
            if ('Notification' in window && Notification.permission === 'granted') {
                new Notification(titulo, { body: cuerpo, tag: 'cliente-' + tag });
            }
        } catch (e) { /* algunos celulares no permiten el constructor sin service worker: queda el aviso en pantalla */ }
    }

    document.getElementById('checklistForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const dominio = document.getElementById('dominio').value;
        const tipo_vehiculo = document.getElementById('tipo_vehiculo').value;
        const observaciones = document.getElementById('observaciones').value;

        const respuestas = {};
        itemsChecklist.forEach((item, index) => {
            respuestas[item] = document.querySelector(`input[name="item_${index}"]:checked`).value;
        });

        try {
            const respuesta = await apiFetch('/api/checklist', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chofer: choferActual, dominio, tipo_vehiculo, respuestas, observaciones })
            });
            if (respuesta.ok) {
                if (jornada) {
                    mostrarToast("¡Check-list enviado!", 'ok');
                } else {
                    // Si todavía no había iniciado la jornada, el check-list la inicia (como antes iniciaba el turno)
                    mostrarToast("¡Check-list enviado! Jornada iniciada: GPS y avisos de llegada activados.", 'ok');
                    await jornadaIniciar(dominio, true);
                }
            } else {
                mostrarToast("El servidor no aceptó el check-list. Revisá los datos.", 'error');
            }
        } catch (error) {
            mostrarToast("No se pudo conectar con el servidor.", 'error');
        }
    });

    document.getElementById('combustibleForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const datosCarga = {
            chofer: choferActual,
            dominio: document.getElementById('dominio_combustible').value,
            litros: document.getElementById('litros').value,
            costoTotal: document.getElementById('costoTotal').value,
            odometroActual: document.getElementById('odometroActual').value
        };

        try {
            const respuesta = await apiFetch('/api/combustible', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(datosCarga)
            });
            if (respuesta.ok) {
                mostrarToast("⛽ ¡Carga registrada con éxito!", 'ok');
                document.getElementById('combustibleForm').reset();
            } else {
                mostrarToast("No se pudo registrar la carga.", 'error');
            }
        } catch (error) {
            mostrarToast("Error de conexión.", 'error');
        }
    });


    // =====================================================================
    //  ORDEN DE REPARTO: el chofer ordena su recorrido y lo envía al administrador (que lo baja a Excel para Gescom)
    // =====================================================================
    const ORD_DIAS = { lunes: 'Lunes', martes: 'Martes', miercoles: 'Miércoles', jueves: 'Jueves', viernes: 'Viernes', sabado: 'Sábado', domingo: 'Domingo' };
    const ORD_DIAS_CORTO = { lunes: 'Lun', martes: 'Mar', miercoles: 'Mié', jueves: 'Jue', viernes: 'Vie', sabado: 'Sáb', domingo: 'Dom' };
    let ord = { modo: 'dia', rutas: [], propuestas: [], actual: null, lista: [], editable: false, propuesta: null, guardando: null, cambiosServidor: 0, cargado: false };

    function ordenReset() {
        clearTimeout(ord.guardando);
        ord = { modo: ord.modo, rutas: [], propuestas: [], actual: null, lista: [], editable: false, propuesta: null, guardando: null, cambiosServidor: 0, cargado: false };
        const l = document.getElementById('ordLista');
        if (l) l.innerHTML = '<p class="empty-state">Elegí un recorrido para empezar.</p>';
        ['ordBanner', 'ordAyuda', 'ordBarra'].forEach(id => { const e = document.getElementById(id); if (e) e.style.display = 'none'; });
    }

    async function ordenAbrir() {
        const sel = document.getElementById('ordSelector');
        try {
            const r = await apiFetch('/api/orden/rutas');
            if (!r.ok) throw new Error();
            const d = await r.json();
            ord.rutas = d.rutas || [];
            ord.propuestas = d.propuestas || [];
        } catch (e) {
            sel.innerHTML = '<option value="">No se pudieron cargar tus zonas</option>';
            mostrarToast("No se pudieron cargar tus zonas. Probá de nuevo en un momento.", 'error');
            return;
        }
        if (!ord.cargado) {
            let guardado = null;
            try { guardado = localStorage.getItem('flota_orden_modo'); } catch (e) {}
            // Si cada zona tiene un solo día, es más natural mostrarlo por día; si no, por zona
            const unDiaCadaUna = ord.rutas.length > 0 && ord.rutas.every(z => Object.keys(z.dias).length === 1);
            ord.modo = guardado === 'dia' || guardado === 'zona' ? guardado : (unDiaCadaUna ? 'dia' : 'zona');
            ord.cargado = true;
        }
        ordenPintarSelector();
    }

    function ordenMarca(ruta, dia) {
        const p = ord.propuestas.find(x => x.ruta === ruta && (x.dia || '') === dia);
        if (!p) return '';
        return { borrador: ' ✎', enviada: ' 📤', aprobada: ' ✅', rechazada: ' ❌' }[p.estado] || '';
    }

    function ordenPintarSelector(mantener) {
        const sel = document.getElementById('ordSelector');
        document.querySelectorAll('#ordModo button').forEach(b => b.classList.toggle('on', b.dataset.modo === ord.modo));
        const opciones = [];
        if (ord.modo === 'zona') {
            ord.rutas.forEach(z => {
                const dias = Object.keys(z.dias).map(d => ORD_DIAS_CORTO[d] + ' ' + z.dias[d]).join(', ');
                opciones.push({ v: z.ruta + '|', t: 'Zona ' + z.ruta + ' · ' + z.clientes + ' clientes' + (dias ? ' (' + dias + ')' : '') + ordenMarca(z.ruta, '') });
            });
        } else {
            Object.keys(ORD_DIAS).forEach(d => {
                ord.rutas.forEach(z => {
                    if (z.dias[d]) opciones.push({ v: z.ruta + '|' + d, t: ORD_DIAS[d] + ' · Zona ' + z.ruta + ' · ' + z.dias[d] + ' clientes' + ordenMarca(z.ruta, d) });
                });
            });
        }
        const previo = mantener ? sel.value : '';
        if (!opciones.length) {
            sel.innerHTML = '<option value="">No encontramos zonas para tu reparto</option>';
            document.getElementById('ordLista').innerHTML = '<p class="empty-state">Todavía no tenés zonas asignadas según tus entregas de las últimas semanas. Si creés que es un error, avisale al administrador.</p>';
            return;
        }
        sel.innerHTML = '<option value="">Elegí un recorrido…</option>' + opciones.map(o => '<option value="' + escapeHtml(o.v) + '">' + escapeHtml(o.t) + '</option>').join('');
        if (previo && opciones.some(o => o.v === previo)) sel.value = previo;
        else if (opciones.length === 1) { sel.value = opciones[0].v; ordenElegir(); }
    }

    function ordenCambiarModo(modo) {
        if (ord.modo === modo) return;
        ordenGuardarYa();
        ord.modo = modo;
        try { localStorage.setItem('flota_orden_modo', modo); } catch (e) {}
        ord.actual = null;
        ordenPintarSelector();
        document.getElementById('ordLista').innerHTML = '<p class="empty-state">Elegí un recorrido para empezar.</p>';
        ['ordBanner', 'ordAyuda', 'ordBarra'].forEach(id => document.getElementById(id).style.display = 'none');
    }

    async function ordenElegir() {
        await ordenGuardarYa();
        const val = document.getElementById('ordSelector').value;
        if (!val) return;
        const [ruta, dia] = val.split('|');
        ord.actual = { ruta, dia: dia || '' };
        document.getElementById('ordLista').innerHTML = '<p class="empty-state">Cargando clientes…</p>';
        try {
            const r = await apiFetch('/api/orden/ruta/' + encodeURIComponent(ruta) + (dia ? '?dia=' + encodeURIComponent(dia) : ''));
            if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'error');
            const d = await r.json();
            if (!ord.actual || ord.actual.ruta !== ruta) return;
            ord.lista = d.clientes.map(c => ({ ...c, baja: !!c.baja }));
            ord.editable = !!d.editable;
            ord.propuesta = d.propuesta;
            ord.cambiosServidor = d.propuesta && d.propuesta.estado === 'borrador' ? d.propuesta.cambios : 0;
            // Posición original según Gescom (para mostrar "antes estaba en…")
            const base = ord.lista.slice().sort((a, b) => ((a.orden == null ? -1 : a.orden) - (b.orden == null ? -1 : b.orden)) || a.nombre.localeCompare(b.nombre));
            const pos = new Map(base.map((c, i) => [c.id, i + 1]));
            ord.lista.forEach(c => { c.posOrig = pos.get(c.id); });
            ordenPintar();
        } catch (e) {
            document.getElementById('ordLista').innerHTML = '<p class="empty-state">No se pudo cargar este recorrido: ' + escapeHtml(e.message || '') + '</p>';
        }
    }

    // Posición visible de cada cliente (las bajas no ocupan lugar)
    function ordenPosiciones() {
        let n = 0;
        return ord.lista.map(c => c.baja ? null : ++n);
    }

    function ordenPintar() {
        const cont = document.getElementById('ordLista');
        const pos = ordenPosiciones();
        const hayCambios = ordenHayCambios();
        cont.innerHTML = '';
        ord.lista.forEach((c, i) => {
            const cambio = c.baja || (pos[i] !== null && pos[i] !== c.posOrig);
            const el = document.createElement('div');
            el.className = 'ord-item' + (cambio && ord.editable ? ' cambio' : '') + (c.sin_ubicar && !c.baja && !cambio ? ' nuevo' : '') + (c.baja ? ' baja' : '');
            el.dataset.id = c.id;
            const tags = [];
            if (c.sin_ubicar && !c.baja) tags.push(cambio ? '<span class="chip chip-ok">✔ Orden asignado</span>' : '<span class="chip chip-warn">Sin orden de reparto</span>');
            if (c.aparecio) tags.push('<span class="chip chip-warn">🆕 Apareció después</span>');
            if (c.baja) tags.push('<span class="chip" style="color:var(--danger);border-color:rgba(251,113,133,.4);background:rgba(251,113,133,.1);">🚫 Baja propuesta</span>');
            else if (cambio && !c.sin_ubicar) tags.push('<span class="chip">Antes: N° ' + c.posOrig + '</span>');
            if (c.codigo) tags.push('<span class="chip" style="color:var(--muted);border-color:var(--border);background:transparent;">Cód. ' + escapeHtml(c.codigo) + '</span>');
            const dir = [c.direccion, c.localidad].filter(Boolean).join(' · ');
            el.innerHTML =
                (ord.editable ? '<button type="button" class="ord-pos" onclick="ordenPedirPosicion(\'' + c.id + '\')" aria-label="Elegir posición">' + (pos[i] === null ? '—' : pos[i]) + '</button>'
                              : '<div class="ord-pos" style="cursor:default;">' + (pos[i] === null ? '—' : pos[i]) + '</div>') +
                '<div class="ord-main"><div class="ord-nom">' + escapeHtml(c.nombre) + '</div>' +
                (dir ? '<div class="ord-dir">' + escapeHtml(dir) + '</div>' : '') +
                (tags.length ? '<div class="ord-tags">' + tags.join('') + '</div>' : '') + '</div>' +
                (ord.editable ? '<button type="button" class="ord-baja' + (c.baja ? ' on' : '') + '" onclick="ordenAlternarBaja(\'' + c.id + '\')" aria-label="Marcar baja" title="Marcar como baja">🚫</button>' +
                                '<div class="ord-handle" data-arrastrar="1" aria-label="Arrastrar">⠿</div>' : '');
            cont.appendChild(el);
        });
        if (ord.editable) cont.querySelectorAll('.ord-handle').forEach(h => h.addEventListener('pointerdown', ordenIniciarArrastre));
        ordenPintarEstado(hayCambios);
    }

    function ordenHayCambios() {
        const pos = ordenPosiciones();
        return ord.lista.some((c, i) => c.baja || (pos[i] !== null && pos[i] !== c.posOrig));
    }

    function ordenPintarEstado(hayCambios) {
        const banner = document.getElementById('ordBanner');
        const barra = document.getElementById('ordBarra');
        const ayuda = document.getElementById('ordAyuda');
        const p = ord.propuesta;
        let txt = '', cls = '';
        if (p && p.estado === 'enviada') { txt = '📤 Ya enviaste esta propuesta (' + p.cambios + ' cambios). Esperando que el administrador la revise. Si te olvidaste de algo, tocá «Seguir editando».'; cls = 'warn'; }
        else if (p && p.estado === 'aprobada') { txt = '✅ El administrador aprobó tu propuesta. Falta que la cargue en Gescom; cuando esté cargada vas a ver el orden nuevo. Si querés cambiar algo más, tocá «Seguir editando».'; cls = 'ok'; }
        else if (p && p.estado === 'rechazada') { txt = '❌ El administrador no aprobó la última propuesta' + (p.nota ? ': «' + p.nota + '»' : '.') + ' Podés armar una nueva.'; cls = 'err'; }
        else if (ord.lista.some(c => c.sin_ubicar && !c.baja)) { txt = 'Hay clientes sin orden de reparto cargado (marcados en amarillo). Pueden ser clientes nuevos o viejos que nunca tuvieron orden. Ubicalos donde corresponda.'; cls = 'warn'; }
        banner.style.display = txt ? 'block' : 'none';
        banner.className = 'ord-banner ' + cls;
        banner.textContent = txt;
        ayuda.style.display = ord.editable && ord.lista.length ? 'flex' : 'none';
        document.getElementById('ordContador').textContent = ord.lista.length + ' clientes' + (hayCambios ? ' · con cambios' : '');
        // Barra de acciones
        let html = '';
        if (ord.editable && hayCambios) {
            html = '<button type="button" class="btn-ghost" onclick="ordenDescartar()">↺ Descartar</button><button type="button" onclick="ordenEnviar()">📤 Enviar al administrador</button>';
        } else if (p && p.estado === 'enviada') {
            html = '<button type="button" class="btn-ghost" onclick="ordenRetirar()">Descartar todo</button><button type="button" onclick="ordenReabrir()">✏ Seguir editando</button>';
        } else if (p && p.estado === 'aprobada') {
            html = '<button type="button" onclick="ordenReabrir()">✏ Seguir editando</button>';
        }
        barra.style.display = html ? 'flex' : 'none';
        barra.innerHTML = html;
    }

    // ---- Guardado automático del borrador ----
    function ordenProgramarGuardado() {
        clearTimeout(ord.guardando);
        document.getElementById('ordGuardado').textContent = 'Guardando…';
        ord.guardando = setTimeout(() => ordenGuardarYa(), 900);
    }
    async function ordenGuardarYa() {
        if (!ord.guardando || !ord.actual) { ord.guardando = null; return true; }
        clearTimeout(ord.guardando);
        ord.guardando = null;
        const est = document.getElementById('ordGuardado');
        try {
            const r = await apiFetch('/api/orden/borrador', {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ruta: ord.actual.ruta, dia: ord.actual.dia, ids: ord.lista.map(c => c.id), bajas: ord.lista.filter(c => c.baja).map(c => c.id) })
            });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(d.error || 'error');
            ord.cambiosServidor = d.cambios;
            const p = ord.propuestas.find(x => x.ruta === ord.actual.ruta && (x.dia || '') === ord.actual.dia);
            if (p) { p.estado = 'borrador'; p.cambios = d.cambios; } else ord.propuestas.push({ ruta: ord.actual.ruta, dia: ord.actual.dia, estado: 'borrador', cambios: d.cambios });
            ord.propuesta = { estado: 'borrador', cambios: d.cambios, nota: '' };
            est.textContent = '✔ Borrador guardado ' + new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
            return true;
        } catch (e) {
            est.textContent = '✖ No se pudo guardar: ' + (e.message || 'sin conexión') + ' · se reintenta al mover algo';
            return false;
        }
    }

    function ordenCambio() { ordenPintar(); ordenProgramarGuardado(); }

    function ordenAlternarBaja(id) {
        const c = ord.lista.find(x => x.id === id);
        if (!c) return;
        c.baja = !c.baja;
        ordenCambio();
    }

    // ---- Mover a una posición escribiendo el número ----
    function ordenModal(html) {
        const cont = document.createElement('div');
        cont.className = 'modal-overlay';
        cont.innerHTML = '<div class="modal-card">' + html + '</div>';
        cont.addEventListener('click', e => { if (e.target === cont) cont.remove(); });
        document.body.appendChild(cont);
        return cont;
    }
    function ordenPedirPosicion(id) {
        const idx = ord.lista.findIndex(x => x.id === id);
        if (idx < 0) return;
        const c = ord.lista[idx];
        const total = ord.lista.filter(x => !x.baja).length;
        const actual = ordenPosiciones()[idx];
        const m = ordenModal(
            '<h3 class="modal-title">Mover cliente</h3><p class="modal-sub">' + escapeHtml(c.nombre) + '</p>' +
            '<label for="ordNumPos" style="margin-top:4px;">Nueva posición (1 a ' + total + ')</label>' +
            '<input type="number" inputmode="numeric" min="1" max="' + total + '" id="ordNumPos" class="ord-num" value="' + (actual || '') + '">' +
            '<div class="ord-fila"><button type="button" class="btn-ghost" data-r="ini">⬆ Al inicio</button><button type="button" class="btn-ghost" data-r="fin">⬇ Al final</button></div>' +
            '<div class="ord-fila"><button type="button" class="btn-ghost" data-r="no">Cancelar</button><button type="button" data-r="ok">Mover</button></div>');
        const input = m.querySelector('#ordNumPos');
        const hacer = destino => { m.remove(); ordenMoverA(id, destino); };
        m.querySelector('[data-r="ini"]').onclick = () => hacer(1);
        m.querySelector('[data-r="fin"]').onclick = () => hacer(total);
        m.querySelector('[data-r="no"]').onclick = () => m.remove();
        m.querySelector('[data-r="ok"]').onclick = () => {
            const n = parseInt(input.value, 10);
            if (!Number.isFinite(n) || n < 1 || n > total) { mostrarToast('Poné un número entre 1 y ' + total + '.', 'error'); return; }
            hacer(n);
        };
        input.addEventListener('keydown', e => { if (e.key === 'Enter') m.querySelector('[data-r="ok"]').click(); });
        setTimeout(() => { input.focus(); input.select(); }, 60);
    }
    function ordenMoverA(id, destino) {
        const desde = ord.lista.findIndex(x => x.id === id);
        if (desde < 0) return;
        const [c] = ord.lista.splice(desde, 1);
        c.baja = false;
        // la posición N es la N-ésima entre los que no son baja
        let visibles = 0, indice = ord.lista.length;
        for (let i = 0; i < ord.lista.length; i++) {
            if (ord.lista[i].baja) continue;
            visibles++;
            if (visibles === destino) { indice = i; break; }
        }
        ord.lista.splice(indice, 0, c);
        ordenCambio();
        const el = document.querySelector('#ordLista .ord-item[data-id="' + id + '"]');
        if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.classList.add('destello'); }
    }

    // ---- Arrastrar con el dedo (o el mouse) desde la manija ☰ ----
    function ordenIniciarArrastre(ev) {
        const manija = ev.currentTarget;
        const el = manija.closest('.ord-item');
        const lista = el.parentNode;
        ev.preventDefault();
        el.classList.add('arrastrando');
        let y = ev.clientY;
        const reubicar = () => {
            const hermanos = [...lista.children].filter(h => h !== el);
            let destino = null;
            for (const h of hermanos) { const r = h.getBoundingClientRect(); if (r.top + r.height / 2 > y) { destino = h; break; } }
            if (destino !== el.nextSibling) lista.insertBefore(el, destino);
        };
        const autoscroll = setInterval(() => {
            if (y < 110) window.scrollBy(0, -14);
            else if (y > window.innerHeight - 150) window.scrollBy(0, 14);
            else return;
            reubicar();
        }, 30);
        // Se escucha en la ventana (no en la manija): al reubicar el elemento en la lista el navegador suelta la captura del puntero
        const mover = e => { if (e.pointerId !== ev.pointerId) return; y = e.clientY; reubicar(); };
        const bloquearScroll = e => e.preventDefault();
        const soltar = e => {
            if (e && e.pointerId !== undefined && e.pointerId !== ev.pointerId) return;
            clearInterval(autoscroll);
            window.removeEventListener('pointermove', mover);
            window.removeEventListener('pointerup', soltar);
            window.removeEventListener('pointercancel', soltar);
            window.removeEventListener('touchmove', bloquearScroll);
            el.classList.remove('arrastrando');
            const ids = [...lista.children].map(h => h.dataset.id);
            const antes = ord.lista.map(c => c.id).join();
            if (ids.join() !== antes) {
                const porId = new Map(ord.lista.map(c => [c.id, c]));
                ord.lista = ids.map(i => porId.get(i));
                ordenCambio();
            } else ordenPintar();
        };
        window.addEventListener('pointermove', mover);
        window.addEventListener('pointerup', soltar);
        window.addEventListener('pointercancel', soltar);
        window.addEventListener('touchmove', bloquearScroll, { passive: false });
    }

    // ---- Enviar / descartar / retirar ----
    function ordenEnviar() {
        const m = ordenModal(
            '<h3 class="modal-title">Enviar al administrador</h3><p class="modal-sub">' + (ord.actual.dia ? ORD_DIAS[ord.actual.dia] + ' · ' : '') + 'Zona ' + escapeHtml(ord.actual.ruta) + '</p>' +
            '<p style="margin:0;font-size:.9rem;line-height:1.5;">Vas a mandar tu nuevo orden de reparto para que lo revise y lo cargue en Gescom. Mientras esté en revisión no vas a poder cambiarlo.</p>' +
            '<div class="ord-fila"><button type="button" class="btn-ghost" data-r="no">Volver</button><button type="button" data-r="ok">Enviar</button></div>');
        m.querySelector('[data-r="no"]').onclick = () => m.remove();
        m.querySelector('[data-r="ok"]').onclick = async () => {
            m.remove();
            if (!(await ordenGuardarYa())) { mostrarToast('No se pudo guardar el borrador. Revisá tu conexión.', 'error'); return; }
            try {
                const r = await apiFetch('/api/orden/enviar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ord.actual) });
                const d = await r.json().catch(() => ({}));
                if (!r.ok) throw new Error(d.error || 'error');
                mostrarToast('📤 Propuesta enviada al administrador.', 'ok');
                const p = ord.propuestas.find(x => x.ruta === ord.actual.ruta && (x.dia || '') === ord.actual.dia);
                if (p) p.estado = 'enviada';
                ordenPintarSelector(true);
                ordenElegir();
            } catch (e) {
                mostrarToast(e.message || 'No se pudo enviar.', 'error');
            }
        };
    }
    async function ordenBorrarPropuesta(mensaje) {
        try {
            const r = await apiFetch('/api/orden/propuesta?ruta=' + encodeURIComponent(ord.actual.ruta) + '&dia=' + encodeURIComponent(ord.actual.dia), { method: 'DELETE' });
            if (!r.ok) throw new Error();
            ord.propuestas = ord.propuestas.filter(x => !(x.ruta === ord.actual.ruta && (x.dia || '') === ord.actual.dia && ['borrador', 'enviada'].includes(x.estado)));
            mostrarToast(mensaje, 'ok');
            ordenPintarSelector(true);
            ordenElegir();
        } catch (e) { mostrarToast('No se pudo completar la acción.', 'error'); }
    }
    function ordenDescartar() {
        clearTimeout(ord.guardando); ord.guardando = null;
        ordenBorrarPropuesta('Cambios descartados. Volvió el orden de Gescom.');
    }
    function ordenRetirar() { ordenBorrarPropuesta('Propuesta descartada. Volvió el orden de Gescom.'); }

    // Volver a editar una propuesta ya enviada o aprobada: se conservan todos los cambios y hay que reenviarla
    function ordenReabrir() {
        const aprobada = ord.propuesta && ord.propuesta.estado === 'aprobada';
        const m = ordenModal(
            '<h3 class="modal-title">Seguir editando</h3><p class="modal-sub">' + (ord.actual.dia ? ORD_DIAS[ord.actual.dia] + ' · ' : '') + 'Zona ' + escapeHtml(ord.actual.ruta) + '</p>' +
            '<p style="margin:0;font-size:.9rem;line-height:1.5;">Se conservan todos tus cambios. El administrador va a dejar de ver esta propuesta hasta que la vuelvas a enviar.' +
            (aprobada ? '<br><br><b>Ojo:</b> ya estaba aprobada. Si el administrador ya la cargó en Gescom, avisale que vas a mandar otra.' : '') + '</p>' +
            '<div class="ord-fila"><button type="button" class="btn-ghost" data-r="no">Volver</button><button type="button" data-r="ok">Seguir editando</button></div>');
        m.querySelector('[data-r="no"]').onclick = () => m.remove();
        m.querySelector('[data-r="ok"]').onclick = async () => {
            m.remove();
            try {
                const r = await apiFetch('/api/orden/reabrir', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ord.actual) });
                const d = await r.json().catch(() => ({}));
                if (!r.ok) throw new Error(d.error || 'error');
                const p = ord.propuestas.find(x => x.ruta === ord.actual.ruta && (x.dia || '') === ord.actual.dia);
                if (p) p.estado = 'borrador';
                mostrarToast('✏ Podés seguir editando. Acordate de volver a enviarla.', 'ok');
                ordenPintarSelector(true);
                ordenElegir();
            } catch (e) { mostrarToast(e.message || 'No se pudo reabrir.', 'error'); }
        };
    }

    // =====================================================================
    //  DOCUMENTACIÓN CON VENCIMIENTO: check-list mensual y avisos (29 y 15 días antes)
    // =====================================================================
    let docs = { dato: null, sel: {}, fechas: {}, abierto: false };

    function docsReset() {
        docs = { dato: null, sel: {}, fechas: {}, abierto: false };
        const b = document.getElementById('docsBanner'); if (b) b.style.display = 'none';
        const nb = document.querySelectorAll('#navIsland .nav-btn')[4]; if (nb) nb.classList.remove('con-aviso');
    }
    function docsHoy() { return fechaLocalHoy(); }
    function docsPlural(n, uno, varios) { return n + ' ' + (n === 1 ? uno : varios); }

    // Frase del aviso según el estado del documento
    function docsFrase(a) {
        const de = a.de === 'camion' ? 'del camión ' + a.sujeto : 'tuyo';
        const cuando = formatoFecha(a.fecha);
        if (a.estado === 'vencido') return '⛔ ' + a.nombre + ' (' + de + ') está VENCIDO desde el ' + cuando + '. Renovalo y cargá la fecha nueva.';
        if (a.estado === 'ultimo') return '🚨 ÚLTIMO AVISO: ' + a.nombre + ' (' + de + ') vence el ' + cuando + ' (' + (a.dias === 0 ? 'vence hoy' : 'faltan ' + docsPlural(a.dias, 'día', 'días')) + '). Renovalo ya.';
        return '⚠ Cuidado con el vencimiento de ' + a.nombre + ' (' + de + '): vence el ' + cuando + ' (faltan ' + docsPlural(a.dias, 'día', 'días') + ').';
    }

    async function docsTraer(dominio) {
        const r = await apiFetch('/api/docs/mi-estado' + (dominio ? '?dominio=' + encodeURIComponent(dominio) : ''));
        if (!r.ok) throw new Error('error');
        return r.json();
    }

    // Se llama al entrar: actualiza el cartel del check-list, el punto rojo del menú y, una vez por día, muestra el aviso
    async function docsRevisarAvisos() {
        let d;
        try { d = await docsTraer(''); } catch (e) { return; }
        if (!choferActual) return;
        docs.dato = d;
        docsPintarBanner();
        const nb = document.querySelectorAll('#navIsland .nav-btn')[4];
        const urgente = d.avisos.some(a => a.estado === 'vencido' || a.estado === 'ultimo') || !d.mensual.hecho;
        if (nb) nb.classList.toggle('con-aviso', urgente);
        let visto = null;
        try { visto = localStorage.getItem('flota_docs_aviso'); } catch (e) {}
        if ((d.avisos.length || !d.mensual.hecho) && visto !== docsHoy()) {
            const mostrar = () => {
                if (!choferActual) return;
                if (document.getElementById('modalBienvenidaNativa')) { setTimeout(mostrar, 5000); return; }
                try { localStorage.setItem('flota_docs_aviso', docsHoy()); } catch (e) {}
                docsMostrarAviso(d);
            };
            setTimeout(mostrar, 2200);
        }
    }

    function docsPintarBanner() {
        const b = document.getElementById('docsBanner');
        const d = docs.dato;
        if (!b || !d) return;
        const venc = d.avisos.filter(a => a.estado === 'vencido').length;
        const ult = d.avisos.filter(a => a.estado === 'ultimo').length;
        const av = d.avisos.filter(a => a.estado === 'aviso').length;
        const partes = [];
        if (!d.mensual.hecho) partes.push('📋 Te falta la documentación de este mes');
        if (venc) partes.push('⛔ ' + docsPlural(venc, 'vencido', 'vencidos'));
        if (ult) partes.push('🚨 ' + docsPlural(ult, 'último aviso', 'últimos avisos'));
        if (av) partes.push('⚠ ' + docsPlural(av, 'por vencer', 'por vencer'));
        if (!partes.length) { b.style.display = 'none'; return; }
        b.style.display = 'block';
        b.className = 'ord-banner ' + (venc || ult ? 'err' : 'warn');
        b.style.cursor = 'pointer';
        b.innerHTML = '<b>Documentación:</b> ' + escapeHtml(partes.join(' · ')) + ' <span style="text-decoration:underline;">Tocá para verlo</span>';
        b.onclick = irADocs;
    }
    function irADocs() {
        const btn = document.querySelectorAll('#navIsland .nav-btn')[4];
        const m = document.getElementById('modalAvisoDocs'); if (m) m.remove();
        if (btn) cambiarVista('docs', btn);
    }

    function docsMostrarAviso(d) {
        const lineas = d.avisos.map(a => '<p class="doc-linea" style="color:' + (a.estado === 'aviso' ? 'var(--warn)' : 'var(--danger)') + ';font-weight:700;">' + escapeHtml(docsFrase(a)) + '</p>');
        if (!d.mensual.hecho) lineas.push('<p class="doc-linea" style="font-weight:700;">📋 Todavía no hiciste la documentación de este mes. Es obligatoria: tardás un minuto.</p>');
        const m = ordenModal(
            '<h3 class="modal-title">📄 Documentación</h3><p class="modal-sub">Revisá tus vencimientos</p>' + lineas.join('') +
            '<div class="ord-fila"><button type="button" class="btn-ghost" data-r="no">Más tarde</button><button type="button" data-r="ok">Ver y actualizar</button></div>');
        m.id = 'modalAvisoDocs';
        m.querySelector('[data-r="no"]').onclick = () => m.remove();
        m.querySelector('[data-r="ok"]').onclick = irADocs;
        const resumen = d.avisos.slice(0, 3).map(a => docsFrase(a)).join(' ') || 'Te falta la documentación de este mes.';
        notificarSistema('Documentación: revisá tus vencimientos', resumen, 'docs');
    }

    // ---- Pantalla Documentación ----
    async function docsAbrir() {
        const estado = document.getElementById('docsEstadoMes');
        try {
            const d = await docsTraer('');
            docs.dato = d;
        } catch (e) { estado.className = 'ord-banner err'; estado.textContent = 'No se pudo cargar tu documentación. Probá de nuevo.'; return; }
        docs.abierto = true;
        docsPintarBanner();
        docsPintar();
    }
    function docsClave(aplica, tipo) { return aplica + '|' + tipo; }
    function docsCompleto(aplica, d) {
        const k = docsClave(aplica, d.tipo), s = docs.sel[k];
        if (s === 'fecha') return /^\d{4}-\d{2}-\d{2}$/.test(docs.fechas[k] || '');
        return !!s;
    }
    function docsPuedeConfirmar(d) {
        return d.estado !== 'vencido' && d.estado !== 'falta' && (d.fecha || d.sin_fecha);
    }
    function docsEstadoTexto(d) {
        if (d.estado === 'falta') return 'Sin cargar todavía';
        if (d.estado === 'na') return 'No aplica';
        if (d.sin_fecha === 'no_vence') return 'No vence';
        if (d.estado === 'vencido') return 'VENCIDO el ' + formatoFecha(d.fecha) + ' (hace ' + docsPlural(-d.dias, 'día', 'días') + ')';
        if (d.estado === 'ultimo') return 'Vence el ' + formatoFecha(d.fecha) + ' · ÚLTIMO AVISO (' + (d.dias === 0 ? 'hoy' : docsPlural(d.dias, 'día', 'días')) + ')';
        if (d.estado === 'aviso') return 'Vence el ' + formatoFecha(d.fecha) + ' · faltan ' + docsPlural(d.dias, 'día', 'días');
        return 'Vence el ' + formatoFecha(d.fecha) + ' · faltan ' + d.dias + ' días';
    }

    function docsFila(aplica, d) {
        const k = docsClave(aplica, d.tipo), s = docs.sel[k];
        const completo = docsCompleto(aplica, d);
        const op = (val, txt) => '<button type="button" class="' + (s === val ? 'on' : '') + '" onclick="docsElegir(\'' + aplica + '\',\'' + d.tipo + '\',\'' + val + '\')">' + txt + '</button>';
        let botones = '';
        if (docsPuedeConfirmar(d)) botones += op('confirmar', '✔ Sigue igual');
        botones += op('fecha', d.estado === 'vencido' || d.estado === 'falta' ? '📅 Cargar fecha nueva' : '📅 Cambió la fecha');
        if (d.permite_sin_fecha) botones += op('no_vence', 'No vence') + op('no_aplica', 'No aplica');
        let fecha = '';
        if (s === 'fecha') {
            const v = docs.fechas[k] || '';
            const pasada = v && v < docsHoy();
            fecha = '<div class="doc-fecha"><label>Nueva fecha de vencimiento</label><input type="date" value="' + escapeHtml(v) + '" onchange="docsFecha(\'' + aplica + '\',\'' + d.tipo + '\', this.value)">' +
                    (pasada ? '<div class="doc-nota">⚠ Esa fecha ya pasó: el administrador va a recibir un aviso.</div>' : '') + '</div>';
        }
        return '<div class="doc-item ' + (completo ? 'listo' : d.estado) + '"><div class="doc-nom">' + escapeHtml(d.nombre) + '</div>' +
               '<div class="doc-estado">' + escapeHtml(docsEstadoTexto(d)) + '</div><div class="doc-opc">' + botones + '</div>' + fecha + '</div>';
    }

    function docsPintar() {
        const d = docs.dato;
        const estado = document.getElementById('docsEstadoMes');
        if (d.mensual.hecho) { estado.className = 'ord-banner ok'; estado.textContent = '✅ Ya hiciste la documentación de ' + d.periodo + ' (el ' + d.mensual.cuando + '). Si renovaste algo, actualizalo acá.'; }
        else { estado.className = 'ord-banner warn'; estado.textContent = '📋 Falta la documentación de ' + d.periodo + '. Es obligatoria: confirmá o actualizá cada vencimiento.'; }
        let html = '<div class="doc-titulo">🪪 Tus documentos</div>' + d.chofer.map(x => docsFila('chofer', x)).join('');
        if (d.dominio) {
            const alertas = d.camion.filter(x => ['vencido', 'ultimo', 'aviso'].includes(x.estado));
            html += '<div class="doc-titulo">🚚 Tu camión ' + escapeHtml(d.dominio) + '</div>' +
                (alertas.length
                    ? alertas.map(x => '<div class="doc-item ' + x.estado + '"><div class="doc-nom">' + escapeHtml(x.nombre) + '</div><div class="doc-estado">' + escapeHtml(docsEstadoTexto(x)) + '</div></div>').join('') +
                      '<p class="doc-nota">Los documentos del camión los actualiza el administrador. Si renovaste alguno, avisale.</p>'
                    : '<p class="doc-nota">✅ Documentación del camión al día. La controla el administrador.</p>');
        }
        document.getElementById('docsFormulario').innerHTML = html;
        const todos = d.chofer.map(x => ['chofer', x]);
        const hechos = todos.filter(([a, x]) => docsCompleto(a, x)).length;
        const falta = todos.length - hechos;
        const prog = document.getElementById('docsProgreso');
        prog.style.display = todos.length ? 'flex' : 'none';
        prog.innerHTML = '<span>Completaste ' + hechos + ' de ' + todos.length + '</span><button type="button" class="btn-ghost" onclick="docsTodoIgual()">✔ Todo lo vigente sigue igual</button>';
        const bt = document.getElementById('docsEnviar');
        bt.style.display = todos.length ? 'block' : 'none';
        bt.disabled = falta > 0;
        bt.style.opacity = falta > 0 ? '.5' : '1';
        bt.textContent = falta > 0 ? 'Te faltan ' + falta + ' por completar' : '📤 Enviar documentación del mes';
    }
    function docsElegir(aplica, tipo, valor) {
        const k = docsClave(aplica, tipo);
        docs.sel[k] = valor;
        if (valor === 'fecha' && !docs.fechas[k]) docs.fechas[k] = '';
        docsPintar();
    }
    function docsFecha(aplica, tipo, valor) {
        docs.fechas[docsClave(aplica, tipo)] = valor;
        docsPintar();
    }
    function docsTodoIgual() {
        const d = docs.dato;
        d.chofer.forEach(x => { if (docsPuedeConfirmar(x) && !docs.sel[docsClave('chofer', x.tipo)]) docs.sel[docsClave('chofer', x.tipo)] = 'confirmar'; });
        docsPintar();
    }

    async function docsEnviarMensual() {
        const d = docs.dato;
        const items = [];
        d.chofer.forEach(x => items.push({ aplica: 'chofer', tipo: x.tipo }));
        items.forEach(i => { const k = docsClave(i.aplica, i.tipo); i.accion = docs.sel[k]; i.fecha = docs.fechas[k] || undefined; });
        const bt = document.getElementById('docsEnviar');
        bt.disabled = true;
        try {
            const r = await apiFetch('/api/docs/mensual', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dominio: d.dominio, items }) });
            const res = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(res.error || 'No se pudo enviar');
            const venc = (res.alertas || []).length;
            mostrarToast(venc ? '📄 Enviada. Ojo: cargaste documentación vencida o con fecha menor; se avisó al administrador.' : '📄 ¡Documentación del mes enviada!', venc ? 'error' : 'ok');
            docs.sel = {}; docs.fechas = {};
            await docsAbrir();
            docsRevisarAvisosSilencioso();
        } catch (e) {
            mostrarToast(e.message || 'No se pudo enviar.', 'error');
            docsPintar();
        }
    }
    async function docsRevisarAvisosSilencioso() {
        try { docs.dato = await docsTraer(''); } catch (e) { return; }
        docsPintarBanner();
        const nb = document.querySelectorAll('#navIsland .nav-btn')[4];
        if (nb) nb.classList.toggle('con-aviso', docs.dato.avisos.some(a => a.estado === 'vencido' || a.estado === 'ultimo') || !docs.dato.mensual.hecho);
    }

    // Corta el GPS del dispositivo (la jornada se cierra en el servidor con jornadaFinalizar)
    function finalizarTurno() {
        enviarAlServidor = false;
        detenerSeguimientoGPS();
        if (wakeLock !== null) { wakeLock.release().catch(() => {}); wakeLock = null; }
        document.getElementById('gps-status').style.display = 'none';
    }

    // =====================================================================
    //  JORNADA: el chofer inicia al salir y finaliza al volver (si se olvida, el sistema la cierra solo)
    // =====================================================================
    let jornada = null;              // { id, inicio, vehiculo } mientras hay una jornada en curso
    let jornadaReloj = null;
    function fmtHoraLocal(f) { return new Date(f).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false }); }
    function fmtDuracionMin(min) { min = Math.max(0, Math.round(min)); return min < 60 ? min + ' min' : Math.floor(min / 60) + ' h ' + String(min % 60).padStart(2, '0') + ' min'; }

    function jornadaPintar() {
        pintarSaludo();
        const caja = document.getElementById('jornadaCaja');
        caja.classList.toggle('on', !!jornada);
        document.getElementById('jornadaInicio').style.display = jornada ? 'none' : 'flex';
        document.getElementById('btnJornadaFin').style.display = jornada ? 'block' : 'none';
        clearInterval(jornadaReloj);
        if (jornada) {
            const actualizar = () => {
                document.getElementById('jornadaTitulo').innerText = 'Jornada en curso';
                document.getElementById('jornadaDetalle').innerText = `Desde las ${fmtHoraLocal(jornada.inicio)} · ${jornada.vehiculo} · ${fmtDuracionMin((Date.now() - new Date(jornada.inicio).getTime()) / 60000)}`;
            };
            actualizar();
            jornadaReloj = setInterval(actualizar, 30000);
        } else {
            document.getElementById('jornadaTitulo').innerText = 'Jornada sin iniciar';
            document.getElementById('jornadaDetalle').innerText = 'Tocá "Iniciar jornada" cuando salgas con el camión. Se activa el GPS y los avisos de llegada.';
        }
    }

    // Enciende el GPS y los avisos con la patente de la jornada
    function activarGpsJornada(dominio) {
        document.getElementById('gps-status').style.display = 'block';
        vehiculoActual = dominio;
        enviarAlServidor = true;
        ultimoEnvio = 0;
        seguirMiUbicacion = true;
        solicitarWakeLock();
        pedirPermisoNotificaciones();
        iniciarSeguimientoGPS();
        reenviarUltimaPosicion(true);
        // Se carga la ruta ahora para poder avisar al acercarse, aunque el chofer no abra la pestaña de ruta
        cargarRutaChoferReal(choferActual);
    }

    async function jornadaIniciar(dominioDado, silencioso) {
        const dominio = String(dominioDado || document.getElementById('jornadaDominio').value || '').trim().toUpperCase();
        if (dominio.replace(/[^A-Z0-9]/g, '').length < 5) { mostrarToast('Ingresá la patente del camión para iniciar la jornada.', 'error'); document.getElementById('jornadaDominio').focus(); return; }
        const boton = document.getElementById('btnJornadaIniciar');
        boton.disabled = true;
        try {
            const res = await apiFetch('/api/jornada/iniciar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dominio }) });
            const d = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(d.error || 'No se pudo iniciar la jornada.');
            jornada = d.jornada;
            try { localStorage.setItem('flota_ultima_patente', dominio); } catch (e) {}
            const campo = document.getElementById('dominio');
            if (campo && !campo.value) campo.value = dominio;
            jornadaPintar();
            activarGpsJornada(jornada.vehiculo);
            if (!silencioso) mostrarToast('▶ Jornada iniciada. GPS y avisos de llegada activados.', 'ok');
        } catch (e) {
            mostrarToast(e.message || 'No se pudo conectar con el servidor.', 'error');
        } finally { boton.disabled = false; }
    }

    async function jornadaFinalizar() {
        if (!confirm('¿Finalizar la jornada? Se detiene el GPS y los avisos de llegada.')) return;
        const boton = document.getElementById('btnJornadaFin');
        boton.disabled = true;
        try {
            const res = await apiFetch('/api/jornada/finalizar', { method: 'POST' });
            const d = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(d.error || 'No se pudo finalizar la jornada.');
            finalizarTurno();
            jornada = null; jornadaPintar();
            const j = d.jornada;
            mostrarToast(j ? `🛑 Jornada finalizada: ${fmtDuracionMin(j.minutos)} · ${String(j.km).replace('.', ',')} km` : '🛑 Jornada finalizada.', 'ok');
        } catch (e) {
            mostrarToast(e.message || 'No se pudo conectar con el servidor.', 'error');
        } finally { boton.disabled = false; }
    }

    // Al ingresar (o recargar) se recupera la jornada abierta y se retoma el GPS
    async function jornadaTraer() {
        try {
            const campo = document.getElementById('jornadaDominio');
            if (campo && !campo.value) { try { campo.value = localStorage.getItem('flota_ultima_patente') || ''; } catch (e) {} }
            const res = await apiFetch('/api/jornada/actual');
            if (!res.ok) return;
            const d = await res.json();
            jornada = d.jornada || null;
            jornadaPintar();
            if (jornada && !enviarAlServidor) activarGpsJornada(jornada.vehiculo);
        } catch (e) { /* sin conexión: queda "sin iniciar" y se puede reintentar */ }
    }
    function jornadaReset() { jornada = null; clearInterval(jornadaReloj); jornadaPintar(); }
