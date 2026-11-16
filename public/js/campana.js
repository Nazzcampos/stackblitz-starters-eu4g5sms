// Campanita de notificaciones (supervisor y depósito).
// Uso: iniciarCampana({ contenedor: 'idDelContenedor', llamar: (url, opciones) => Promise<Response>, alElegir: (notif) => {} })
(function () {
    const ICONO = { retorno: '📦', docs: '📄', checklist: '🛠️', orden: '🧭' };
    let cfg = null, abierta = false, pestana = 'nuevas', items = [], noLeidas = 0, timer = null, cajaEl = null;

    const esc = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    function hace(iso) {
        const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
        if (m < 1) return 'ahora';
        if (m < 60) return `hace ${m} min`;
        if (m < 60 * 24) return `hace ${Math.round(m / 60)} h`;
        const d = Math.round(m / 1440);
        return d === 1 ? 'ayer' : `hace ${d} días`;
    }
    async function pedir(url, cuerpo) {
        const o = cuerpo ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) } : {};
        const r = await cfg.llamar(url, o);
        if (!r.ok) throw new Error('http');
        return r.json();
    }
    async function cargar() {
        if (!cfg) return;
        try {
            const d = await pedir('/api/notificaciones' + (pestana === 'archivo' ? '?archivadas=1' : ''));
            items = d.items || [];
            if (pestana === 'nuevas') noLeidas = d.noLeidas || 0;
            else { const n = await pedir('/api/notificaciones'); noLeidas = n.noLeidas || 0; }
            pintar();
        } catch (e) { /* sin conexión o sesión vencida: se reintenta */ }
    }
    async function accion(url, cuerpo) { try { await pedir(url, cuerpo); } catch (e) { /* nada */ } await cargar(); }

    function pintar() {
        if (!cajaEl) return;
        const badge = cajaEl.querySelector('.cp-badge');
        badge.textContent = noLeidas > 99 ? '99+' : String(noLeidas);
        badge.classList.toggle('on', noLeidas > 0);
        cajaEl.querySelector('.cp-btn').classList.toggle('hay', noLeidas > 0);
        const panel = cajaEl.querySelector('.cp-panel');
        panel.classList.toggle('on', abierta);
        if (!abierta) return;
        panel.querySelectorAll('.cp-tab').forEach(t => t.classList.toggle('on', t.dataset.tab === pestana));
        const lista = panel.querySelector('.cp-lista');
        lista.innerHTML = items.length ? items.map(n => `
            <div class="cp-item nivel-${esc(n.nivel)}${n.leida ? ' leida' : ''}" data-id="${n.id}">
                <div class="cp-ico">${ICONO[n.tipo] || '🔔'}</div>
                <div class="cp-cuerpo" data-elegir="${n.id}">
                    <div class="cp-titulo">${n.leida ? '' : '<span class="cp-punto"></span>'}${esc(n.titulo)}</div>
                    ${n.mensaje ? `<div class="cp-msg">${esc(n.mensaje)}</div>` : ''}
                    <div class="cp-hora">${hace(n.fecha)}${n.resuelta ? ' · ✔ resuelto' : ''}</div>
                </div>
                <div class="cp-acc">
                    ${n.archivada ? `<button type="button" data-restaurar="${n.id}" title="Sacar del archivo">↩</button>`
                        : `<button type="button" data-leer="${n.id}" data-leida="${n.leida ? 1 : 0}" title="${n.leida ? 'Marcar como no leída' : 'Marcar como leída'}">${n.leida ? '○' : '✓'}</button>
                           <button type="button" data-archivar="${n.id}" title="Archivar">🗄</button>`}
                </div>
            </div>`).join('') : `<div class="cp-vacio">${pestana === 'archivo' ? 'No hay notificaciones archivadas.' : '🎉 No tenés notificaciones nuevas.'}</div>`;
        panel.querySelector('.cp-pie').style.display = pestana === 'nuevas' ? 'flex' : 'none';
    }

    function montar() {
        cajaEl.innerHTML = `
            <button type="button" class="cp-btn" aria-label="Notificaciones" title="Notificaciones">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>
                <span class="cp-badge"></span>
            </button>
            <div class="cp-panel">
                <div class="cp-cab"><b>Notificaciones</b><button type="button" class="cp-cerrar" aria-label="Cerrar">✕</button></div>
                <div class="cp-tabs"><button type="button" class="cp-tab on" data-tab="nuevas">Bandeja</button><button type="button" class="cp-tab" data-tab="archivo">Archivo</button></div>
                <div class="cp-lista"></div>
                <div class="cp-pie"><button type="button" data-todas="1">Marcar todas como leídas</button><button type="button" data-archleidas="1">Archivar leídas</button></div>
            </div>`;
        cajaEl.addEventListener('click', e => {
            const t = e.target;
            if (t.closest('.cp-btn')) { abierta = !abierta; pintar(); if (abierta) cargar(); return; }
            if (t.closest('.cp-cerrar')) { abierta = false; pintar(); return; }
            const tab = t.closest('.cp-tab'); if (tab) { pestana = tab.dataset.tab; cargar(); return; }
            const b = t.closest('button');
            if (b && b.dataset.leer) { accion('/api/notificaciones/leer', { id: Number(b.dataset.leer), leida: b.dataset.leida !== '1' }); return; }
            if (b && b.dataset.archivar) { accion('/api/notificaciones/archivar', { id: Number(b.dataset.archivar) }); return; }
            if (b && b.dataset.restaurar) { accion('/api/notificaciones/archivar', { id: Number(b.dataset.restaurar), archivar: false }); return; }
            if (b && b.dataset.todas) { accion('/api/notificaciones/leer', { todas: true }); return; }
            if (b && b.dataset.archleidas) { accion('/api/notificaciones/archivar', { leidas: true }); return; }
            const cuerpo = t.closest('[data-elegir]');
            if (cuerpo) {
                const n = items.find(x => String(x.id) === cuerpo.dataset.elegir); if (!n) return;
                if (!n.leida && !n.archivada) accion('/api/notificaciones/leer', { id: n.id });
                abierta = false; pintar();
                if (cfg.alElegir) cfg.alElegir(n);
            }
        });
        document.addEventListener('click', e => { if (abierta && cajaEl && !cajaEl.contains(e.target)) { abierta = false; pintar(); } });
    }

    window.iniciarCampana = function (config) {
        cfg = config; cajaEl = document.getElementById(config.contenedor);
        if (!cajaEl) return;
        if (!cajaEl.dataset.listo) { cajaEl.dataset.listo = '1'; cajaEl.classList.add('campana'); montar(); }
        abierta = false; pestana = 'nuevas';
        cargar();
        clearInterval(timer);
        timer = setInterval(() => { if (!document.hidden) cargar(); }, 60 * 1000);
    };
    window.detenerCampana = function () { clearInterval(timer); timer = null; items = []; noLeidas = 0; abierta = false; pintar(); };
    window.refrescarCampana = cargar;
})();
