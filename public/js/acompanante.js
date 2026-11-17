    // Pantalla del acompañante: ve con quién y en qué camión sale hoy y en los próximos días.
    const $ = id => document.getElementById(id);
    const esc = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fmtNum = (n, d) => Number(n).toLocaleString('es-AR', { maximumFractionDigits: d || 0 });
    function guardarLocal(k, v) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} }
    function leerLocal(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function toast(t, tipo) { const e = document.createElement('div'); e.className = 'toast ' + (tipo || ''); e.textContent = t; document.body.appendChild(e); setTimeout(() => e.remove(), 3600); }

    let token = leerLocal('flota_acomp_token'), temporizador = null;
    async function api(url, opciones) {
        const o = opciones || {};
        const r = await fetch(url, { ...o, headers: { ...(o.headers || {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) } });
        if (r.status === 401 && token) { salir(true); throw new Error('SESION'); }
        return r;
    }

    // ---------- Ingreso ----------
    async function cargarUsuarios() {
        try {
            const lista = await (await fetch('/api/acomp/usuarios')).json();
            $('loginUsuario').innerHTML = lista.length ? '<option value="">Seleccioná tu nombre</option>' + lista.map(n => `<option>${esc(n)}</option>`).join('') : '<option value="">Todavía no hay usuarios: pedile al supervisor que cree el tuyo</option>';
        } catch (e) { $('loginUsuario').innerHTML = '<option value="">No se pudo cargar la lista</option>'; }
    }
    $('formLogin').addEventListener('submit', async e => {
        e.preventDefault();
        const b = $('btnLogin'); b.disabled = true; $('loginError').classList.add('oculto');
        try {
            const r = await fetch('/api/acomp/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nombre: $('loginUsuario').value, pin: $('loginPin').value }) });
            const d = await r.json().catch(() => ({}));
            $('loginPin').value = '';
            if (!r.ok) { $('loginError').textContent = d.error || 'No se pudo ingresar'; $('loginError').classList.remove('oculto'); return; }
            token = d.token; guardarLocal('flota_acomp_token', token); guardarLocal('flota_rol', 'acomp'); entrar(d.nombre);
        } catch (err) { $('loginError').textContent = 'No se pudo conectar con el servidor.'; $('loginError').classList.remove('oculto'); }
        finally { b.disabled = false; }
    });
    function saludar(nombre) {
        const sub = document.querySelector('.marca-sub'); if (!sub) return;
        if (!nombre) { sub.textContent = 'Tu salida de reparto'; return; }
        const hora = Number(new Date().toLocaleString('en-GB', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', hour12: false })) % 24;
        const saludo = hora < 6 ? 'Buenas noches' : hora < 13 ? 'Buen día' : hora < 20 ? 'Buenas tardes' : 'Buenas noches';
        sub.textContent = `${saludo}, ${String(nombre).split(' ')[0]}`;
    }
    function entrar(nombre) {
        $('quienNombre').textContent = nombre; saludar(nombre); $('quien').classList.remove('oculto');
        $('vistaLogin').classList.add('oculto'); $('vistaApp').classList.remove('oculto');
        cargarPlan();
        if (!temporizador) temporizador = setInterval(() => { if (token && !document.hidden) cargarPlan(); }, 5 * 60 * 1000);
    }
    function salir(porVencida) {
        token = null; guardarLocal('flota_acomp_token', null);
        $('vistaApp').classList.add('oculto'); $('vistaLogin').classList.remove('oculto'); $('quien').classList.add('oculto');
        $('acHoy').innerHTML = $('acProx').innerHTML = ''; saludar(''); cargarUsuarios();
        if (porVencida === true) toast('Tu sesión se cerró. Ingresá de nuevo.', 'error');
    }

    // ---------- Planificación ----------
    function etiquetaDia(f, hoy) {
        const d = Date.parse(f + 'T12:00:00Z'), h = Date.parse(hoy + 'T12:00:00Z');
        const n = Math.round((d - h) / 86400000);
        const txt = new Date(d).toLocaleDateString('es-AR', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
        return (n === 0 ? 'Hoy' : n === 1 ? 'Mañana' : txt.charAt(0).toUpperCase() + txt.slice(1)) + (n <= 1 ? ' · ' + txt : '');
    }
    function tarjeta(s, hoy, destacada) {
        const esChofer = s.rol === 'chofer';
        const con = esChofer ? '' : (s.chofer ? `<span class="ac-con">con <b>${esc(s.chofer)}</b></span>` : '');
        const tile = (v, l) => `<div class="ac-tile"><b>${v}</b><span>${l}</span></div>`;
        return `<div class="card ac-card${destacada ? ' ac-hoy' : ''}">
            <div class="ac-dia">${esc(etiquetaDia(s.fecha, hoy))}</div>
            <div class="ac-titulo">${esChofer ? 'Salís de <b>chofer</b>' : 'Salís a <b>acompañar</b>'}</div>
            <div class="ac-camion">🚚 ${esc(s.camion)}${s.dominio ? ' · ' + esc(s.dominio) : ''} ${con}</div>
            <div class="ac-tiles">${tile(fmtNum(s.clientes), 'clientes')}${tile(fmtNum(s.kg), 'kg')}${s.km ? tile('~' + fmtNum(s.km), 'km') : ''}</div>
            ${s.estimado ? '<div class="aviso warn" style="margin-top:10px;">Datos estimados: el reparto todavía no está armado en el sistema.</div>' : ''}
            ${s.nota ? `<div class="ac-nota">📝 ${esc(s.nota)}</div>` : ''}
        </div>`;
    }
    async function cargarPlan() {
        try {
            const r = await api('/api/acomp/mi-plan'); const d = await r.json();
            if (!r.ok) throw new Error(d.error || '');
            const hoy = d.hoy, hoyS = d.salidas.filter(s => s.fecha === hoy), prox = d.salidas.filter(s => s.fecha > hoy);
            $('acHoy').innerHTML = hoyS.length ? hoyS.map(s => tarjeta(s, hoy, true)).join('')
                : '<div class="card"><h2>Hoy</h2><p class="ayuda" style="margin:0;">No tenés ninguna salida asignada para hoy.</p></div>';
            $('acProx').innerHTML = prox.length ? '<h3 class="ac-sec">Próximas salidas</h3>' + prox.map(s => tarjeta(s, hoy, false)).join('')
                : '<div class="card"><h2>Próximas salidas</h2><p class="ayuda" style="margin:0;">Todavía no te asignaron salidas para los próximos días. Cuando el supervisor las arme, aparecen acá.</p></div>';
            // Al verlas queda registrado para el supervisor
            [...new Set(d.salidas.filter(s => !s.visto).map(s => s.fecha))].forEach(f =>
                api('/api/acomp/visto', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fecha: f }) }).catch(() => {}));
        } catch (e) { if (e.message !== 'SESION') $('acHoy').innerHTML = '<div class="aviso err">No se pudo cargar tu planificación. Probá de nuevo en un momento.</div>'; }
    }
    async function recuperarSesion() {
        if (!token) return;
        try { const r = await api('/api/acomp/mi-plan'); const d = await r.json(); if (r.ok) entrar(d.nombre); } catch (e) { /* queda el login */ }
    }
    cargarUsuarios(); recuperarSesion();
