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
        $('acHoy').innerHTML = $('acProx').innerHTML = ''; plan = null; hoyAbierto = false; verTodas = false; saludar(''); cargarUsuarios();
        if (porVencida === true) toast('Tu sesión se cerró. Ingresá de nuevo.', 'error');
    }

    // ---------- Planificación ----------
    // Foco en la próxima salida (casi siempre mañana). Hoy queda en una barra chica y el resto, en tarjetas compactas.
    let plan = null, hoyAbierto = false, verTodas = false;
    const POR_DEFECTO = 4;
    function etiquetaDia(f, hoy) {
        const d = Date.parse(f + 'T12:00:00Z'), h = Date.parse(hoy + 'T12:00:00Z');
        const n = Math.round((d - h) / 86400000);
        const txt = new Date(d).toLocaleDateString('es-AR', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
        return (n === 0 ? 'Hoy' : n === 1 ? 'Mañana' : txt.charAt(0).toUpperCase() + txt.slice(1)) + (n <= 1 ? ' · ' + txt : '');
    }
    function diaCorto(f) {
        const t = new Date(Date.parse(f + 'T12:00:00Z')).toLocaleDateString('es-AR', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'numeric' }).replace('.', '');
        return t.charAt(0).toUpperCase() + t.slice(1);
    }
    const datos = s => [s.clientes ? fmtNum(s.clientes) + ' clientes' : '', s.kg ? fmtNum(s.kg) + ' kg' : '', s.km ? '~' + fmtNum(s.km) + ' km' : ''].filter(Boolean).join(' · ');
    function tarjeta(s, hoy, clase) {
        const esChofer = s.rol === 'chofer';
        const con = esChofer ? '' : (s.chofer ? `<span class="ac-con">con <b>${esc(s.chofer)}</b></span>` : '');
        const tile = (v, l) => `<div class="ac-tile"><b>${v}</b><span>${l}</span></div>`;
        return `<div class="card ac-card ${clase || ''}">
            <div class="ac-dia">${esc(etiquetaDia(s.fecha, hoy))}</div>
            <div class="ac-titulo">${esChofer ? 'Salís de <b>chofer</b>' : 'Salís a <b>acompañar</b>'}</div>
            <div class="ac-camion">🚚 ${esc(s.camion)}${s.dominio ? ' · ' + esc(s.dominio) : ''} ${con}</div>
            <div class="ac-tiles">${tile(fmtNum(s.clientes), 'clientes')}${tile(fmtNum(s.kg), 'kg')}${s.km ? tile('~' + fmtNum(s.km), 'km') : ''}</div>
            ${s.estimado ? '<div class="aviso warn" style="margin-top:10px;">Datos estimados: el reparto todavía no está armado en el sistema.</div>' : ''}
            ${s.nota ? `<div class="ac-nota">📝 ${esc(s.nota)}</div>` : ''}
        </div>`;
    }
    function tarjetaMini(s) {
        const esChofer = s.rol === 'chofer';
        return `<div class="ac-mini">
            <div class="ac-mini-dia">${esc(diaCorto(s.fecha))}</div>
            <div class="ac-mini-t">${esChofer ? '<b>De chofer</b>' : '<b>Acompañás</b>'} · ${esc(s.camion)}</div>
            ${!esChofer && s.chofer ? `<div class="ac-mini-s">con ${esc(s.chofer)}</div>` : ''}
            <div class="ac-mini-n">${esc(datos(s))}${s.estimado ? ' <span class="ac-est" title="Datos estimados">· est.</span>' : ''}</div>
            ${s.nota ? `<div class="ac-mini-nota">📝 ${esc(s.nota)}</div>` : ''}
        </div>`;
    }
    function alternarHoy() { hoyAbierto = !hoyAbierto; pintarPlan(); }
    function alternarTodas() { verTodas = !verTodas; pintarPlan(); }
    function pintarPlan() {
        if (!plan) return;
        const hoy = plan.hoy, hoyS = plan.salidas.filter(s => s.fecha === hoy), fut = plan.salidas.filter(s => s.fecha > hoy);
        // Hoy: una barra chica (se abre al tocarla). Si no hay nada más para mostrar, va abierta.
        const hoyAbiertoAhora = hoyAbierto || (!fut.length && hoyS.length > 0);
        $('acHoy').innerHTML = hoyS.map(s => `<button type="button" class="ac-hoybar${hoyAbiertoAhora ? ' abierta' : ''}" onclick="alternarHoy()" aria-expanded="${hoyAbiertoAhora}">
                <span class="ac-hoy-tag">Hoy</span>
                <span class="ac-hoy-txt"><b>${esc(s.camion)}</b>${s.rol === 'chofer' ? ' · de chofer' : (s.chofer ? ' · con ' + esc(s.chofer) : '')}</span>
                <span class="ac-hoy-n">${esc(datos(s))}</span><span class="ac-chev" aria-hidden="true">▾</span></button>`
            + (hoyAbiertoAhora ? tarjeta(s, hoy, 'ac-hoy') : '')).join('');
        // Próxima salida (la primera que sigue): tarjeta grande. El resto, compactas y de a pocas.
        let html = '';
        if (fut.length) {
            html += tarjeta(fut[0], hoy, 'ac-hero');
            const resto = fut.slice(1);
            if (resto.length) {
                const ver = verTodas ? resto : resto.slice(0, POR_DEFECTO);
                html += `<h3 class="ac-sec">Después · ${resto.length} salida${resto.length === 1 ? '' : 's'}</h3><div class="ac-grid">${ver.map(tarjetaMini).join('')}</div>`;
                if (resto.length > POR_DEFECTO) html += `<button type="button" class="suave ac-mas" onclick="alternarTodas()">${verTodas ? 'Ver menos' : (resto.length - POR_DEFECTO === 1 ? 'Ver 1 más' : 'Ver ' + (resto.length - POR_DEFECTO) + ' más')}</button>`;
            }
        } else if (!hoyS.length) {
            html = '<div class="card"><h2>Sin salidas asignadas</h2><p class="ayuda" style="margin:0;">Todavía no te asignaron salidas. Cuando el supervisor las arme, aparecen acá.</p></div>';
        }
        $('acProx').innerHTML = html;
    }
    async function cargarPlan() {
        try {
            const r = await api('/api/acomp/mi-plan'); const d = await r.json();
            if (!r.ok) throw new Error(d.error || '');
            plan = d; pintarPlan();
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
