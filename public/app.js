'use strict';
const $app = document.getElementById('app');
const state = { user: null, csrf: null, timer: null, term: null };

// ---------- helpers ----------
function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(c));
  return n;
}
async function api(method, url, body) {
  const res = await fetch('/api' + url, {
    method, credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': state.csrf || '' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {}; try { data = await res.json(); } catch { /* empty */ }
  if (res.status === 401 && state.user) { state.user = null; render(); }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}
const fmtB = (b) => (b == null ? '–' : b >= 2 ** 30 ? (b / 2 ** 30).toFixed(1) + ' GB' : (b / 2 ** 20).toFixed(0) + ' MB');
const pct = (a, b) => (b ? Math.min(100, (a / b) * 100) : 0);
const when = (d) => new Date(d).toLocaleString();
const bar = (label, p, text) => el('div', { class: 'meter' }, el('div', { class: 'row', style: 'justify-content:space-between' }, el('span', {}, label), el('span', {}, text)), el('div', { class: 'bar' }, el('i', { style: `width:${p.toFixed(0)}%` })));
const status = (s) => el('span', {}, el('span', { class: 'dot ' + s }), s);
function copyBtn(text) { const b = el('button', { class: 'btn sm', onclick: async () => { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy'), 1200); } }, 'Copy'); return b; }
function toast(parent, msg, kind = 'err') { const m = el('div', { class: 'msg ' + kind, role: 'alert' }, msg); parent.prepend(m); setTimeout(() => m.remove(), 8000); }
async function guard(parent, fn) { try { return await fn(); } catch (e) { toast(parent, e.message); } }
function modal(content) { const m = el('div', { class: 'modal', onclick: (e) => e.target === m && m.remove() }, el('div', { class: 'card', role: 'dialog' }, content)); document.body.append(m); return m; }

// ---------- auth ----------
function authView(mode = 'login') {
  const err = el('div');
  const f = el('form', { onsubmit: async (e) => {
    e.preventDefault(); err.replaceChildren();
    const d = Object.fromEntries(new FormData(f));
    try {
      const r = await api('POST', '/auth/' + mode, d);
      state.csrf = r.csrf; state.user = r.user; location.hash = '#/'; render();
    } catch (x) { err.append(el('div', { class: 'msg err' }, x.message)); }
  } },
    el('label', { for: 'email' }, 'Email'), el('input', { id: 'email', name: 'email', type: 'email', required: true, autocomplete: 'email' }),
    mode === 'register' && [el('label', { for: 'username' }, 'Username (also your SSH username)'), el('input', { id: 'username', name: 'username', required: true, pattern: '[a-z][a-z0-9_]{2,15}', autocomplete: 'username' })],
    el('label', { for: 'password' }, 'Password'), el('input', { id: 'password', name: 'password', type: 'password', required: true, minlength: mode === 'register' ? 10 : 1, autocomplete: mode === 'register' ? 'new-password' : 'current-password' }),
    err, el('button', { class: 'btn pri', style: 'width:100%;margin-top:16px' }, mode === 'login' ? 'Sign in' : 'Create account'));
  $app.replaceChildren(el('div', { class: 'auth' }, el('div', { class: 'card' },
    el('div', { class: 'brand', style: 'padding-left:0' }, 'SOURAJITVFX CLOUD'),
    el('h1', {}, mode === 'login' ? 'Sign in' : 'Create your account'), f,
    el('p', { class: 'mute' }, mode === 'login' ? 'New here? ' : 'Have an account? ', el('a', { href: '#', onclick: (e) => { e.preventDefault(); authView(mode === 'login' ? 'register' : 'login'); } }, mode === 'login' ? 'Create an account' : 'Sign in')))));
}

// ---------- shell ----------
function shell(content, active) {
  const link = (h, t) => el('a', { href: h, class: active === h ? 'on' : '' }, t);
  const nav = el('nav', { class: 'nav' }, link('#/', 'My servers'),
    state.user.role === 'admin' && [el('div', { class: 'sep' }, 'Administration'), link('#/admin/users', 'Users'), link('#/admin/servers', 'All servers'), link('#/admin/audit', 'Audit log'), link('#/admin/infra', 'Infrastructure')],
    el('div', { class: 'grow' }),
    el('button', { onclick: async () => { await api('POST', '/auth/logout'); state.user = null; const c = await api('GET', '/csrf'); state.csrf = c.csrf; render(); } }, 'Sign out (' + state.user.username + ')'));
  $app.replaceChildren(el('div', { class: 'layout' }, el('aside', { class: 'side' }, el('div', { class: 'brand' }, 'SOURAJITVFX CLOUD'), nav), el('main', {}, content)));
}
function poll(fn, ms) { clearInterval(state.timer); state.timer = setInterval(fn, ms); }

// ---------- dashboard ----------
async function dashboard() {
  const box = el('div'); shell(box, '#/');
  const draw = async () => {
    const [{ servers }, infra] = await Promise.all([api('GET', '/servers'), api('GET', '/servers/infra')]);
    const run = servers.filter((s) => s.status === 'running'), stop = servers.filter((s) => s.status === 'stopped');
    const sum = (k) => run.reduce((a, s) => a + (+s[k] || 0), 0);
    const cpuAvg = run.length ? sum('cpu') / run.length : 0;
    const list = servers.length ? servers.map(serverCard) : [el('div', { class: 'card mute' }, 'No servers yet. Create your first VPS to receive SSH details.')];
    box.replaceChildren(
      el('div', { class: 'head' }, el('h1', {}, 'My servers'), el('button', { class: 'btn pri', onclick: () => createModal(infra) }, 'Create VPS')),
      !infra.configured && el('div', { class: 'msg warn' }, infra.message),
      el('div', { class: 'grid stats' },
        ...[['Total VPS', servers.length], ['Running', run.length], ['Stopped', stop.length]].map(([t, v]) => el('div', { class: 'card stat' }, el('h3', {}, t), el('b', {}, v))),
        el('div', { class: 'card' }, bar('CPU (avg)', cpuAvg, cpuAvg.toFixed(0) + '%'), el('br'), bar('RAM', pct(sum('mem_used'), sum('mem_total')), fmtB(sum('mem_used')) + ' / ' + fmtB(sum('mem_total'))), el('br'), bar('Storage', pct(sum('disk_used'), sum('disk_total')), fmtB(sum('disk_used')) + ' / ' + fmtB(sum('disk_total'))))),
      el('div', { class: 'grid' }, list));
    if (!servers.some((s) => s.status === 'creating')) poll(() => draw().catch(() => {}), 15000); else poll(() => draw().catch(() => {}), 4000);
  };
  await guard(box, draw);
}
function serverCard(s) {
  return el('div', { class: 'card srv', tabindex: 0, onclick: () => (location.hash = '#/server/' + s.id), onkeydown: (e) => e.key === 'Enter' && (location.hash = '#/server/' + s.id) },
    el('div', { class: 'row', style: 'justify-content:space-between' }, el('h2', {}, s.name), status(s.status)),
    el('div', { class: 'mute mono' }, `${s.os} · ${s.cpu_cores} vCPU · ${s.ram_mb} MB · ${s.disk_gb} GB`),
    s.status === 'error' && el('div', { class: 'msg err' }, s.error || 'Provisioning failed'),
    s.status === 'running' && s.mem_total != null && el('div', { class: 'three' }, bar('CPU', s.cpu || 0, (s.cpu || 0).toFixed(0) + '%'), bar('RAM', pct(s.mem_used, s.mem_total), fmtB(s.mem_used)), bar('Disk', pct(s.disk_used, s.disk_total), fmtB(s.disk_used))));
}

function createModal(infra, forUser) {
  if (!infra.configured) return modal([el('h2', {}, 'Create VPS'), el('div', { class: 'msg warn' }, infra.message), el('button', { class: 'btn', onclick: (e) => e.target.closest('.modal').remove() }, 'Close')]);
  const err = el('div');
  const f = el('form', { onsubmit: async (e) => {
    e.preventDefault(); err.replaceChildren();
    const d = Object.fromEntries(new FormData(f)); if (!d.public_key) delete d.public_key;
    try {
      const r = await api('POST', '/servers', d);
      m.remove();
      if (r.temp_password) showOnce(r);
      location.hash = '#/server/' + r.server.id;
    } catch (x) { err.replaceChildren(el('div', { class: 'msg err' }, x.message)); }
  } },
    el('label', {}, 'Name'), el('input', { name: 'name', required: true, minlength: 2, maxlength: 40, placeholder: 'my-first-vps' }),
    el('label', {}, 'Operating system'), el('select', { name: 'os' }, infra.os.map((o) => el('option', { value: o }, o === 'ubuntu-24.04' ? 'Ubuntu 24.04 LTS' : 'Debian 12'))),
    el('div', { class: 'three' },
      el('div', {}, el('label', {}, `vCPU (max ${infra.limits.max_cpu})`), el('input', { name: 'cpu_cores', type: 'number', min: 1, max: infra.limits.max_cpu, value: 1, required: true })),
      el('div', {}, el('label', {}, `RAM MB (max ${infra.limits.max_ram_mb})`), el('input', { name: 'ram_mb', type: 'number', min: 256, max: infra.limits.max_ram_mb, value: 1024, required: true })),
      el('div', {}, el('label', {}, `Disk GB (max ${infra.limits.max_disk_gb})`), el('input', { name: 'disk_gb', type: 'number', min: 4, max: infra.limits.max_disk_gb, value: 10, required: true }))),
    el('label', {}, infra.allow_password_auth ? 'SSH public key (optional)' : 'SSH public key (required)'),
    el('textarea', { name: 'public_key', placeholder: 'ssh-ed25519 AAAA… you@laptop', required: !infra.allow_password_auth }),
    err, el('div', { class: 'row', style: 'margin-top:16px' }, el('button', { class: 'btn pri' }, 'Create VPS'), el('button', { type: 'button', class: 'btn', onclick: () => m.remove() }, 'Cancel')));
  const m = modal([el('h2', {}, 'Create VPS'), f]);
}
function showOnce(r) {
  const m = modal([el('h2', {}, 'Save your temporary password'), el('p', { class: 'mute' }, 'Your server is provisioning. This password is shown once here; you can reveal it later by re-entering your account password.'),
    el('pre', { class: 'code' }, `Username: ${r.server.ssh_username}\nPassword: ${r.temp_password}`), el('div', { class: 'row' }, copyBtn(r.temp_password), el('button', { class: 'btn', onclick: () => m.remove() }, 'I saved it'))]);
}

// ---------- server detail ----------
async function serverView(id) {
  const box = el('div'); shell(box, '#/');
  let first = true;
  const draw = async () => {
    const { server: s, history, has_password } = await api('GET', '/servers/' + id);
    if (state.term) return; // don't redraw while a terminal is open
    const act = (a) => guard(box, async () => { await api('POST', `/servers/${id}/action`, { action: a }); await draw(); });
    const ready = s.status === 'running', creating = s.status === 'creating';
    box.replaceChildren(
      el('div', { class: 'head' }, el('div', {}, el('a', { href: '#/' }, '← All servers'), el('h1', {}, s.name)), status(s.status)),
      creating && el('div', { class: 'msg warn' }, 'Provisioning in progress. SSH details appear here when the server is ready (usually 1–2 minutes).'),
      s.status === 'error' && el('div', { class: 'msg err' }, s.error || 'Provisioning failed. Delete this server and try again.'),
      !creating && s.status !== 'error' && el('div', { class: 'card' }, el('h2', { style: 'margin-bottom:12px' }, 'SSH connection'),
        el('div', { class: 'kv' },
          ...[['IP address', s.ip], ['Port', String(s.ssh_port)], ['Username', s.ssh_username], ['OS', s.os], ['Status', s.status]].flatMap(([k, v]) => [el('span', {}, k), el('span', {}, v), k === 'OS' || k === 'Status' ? el('span') : copyBtn(v)]),
          has_password ? [el('span', {}, 'Password'), el('span', { id: 'pw' }, '••••••••••••'), el('button', { class: 'btn sm', onclick: () => revealModal(id) }, 'Reveal')] : [el('span', {}, 'Auth'), el('span', {}, 'SSH key only'), el('span')]),
        el('pre', { class: 'code' }, `ssh -p ${s.ssh_port} ${s.ssh_username}@${s.ip}`)),
      el('div', { class: 'card', style: 'margin-top:14px' }, el('div', { class: 'row' },
        el('button', { class: 'btn', disabled: ready || creating || s.status === 'error', onclick: () => act('start') }, 'Start'),
        el('button', { class: 'btn', disabled: !ready, onclick: () => act('stop') }, 'Stop'),
        el('button', { class: 'btn', disabled: !ready, onclick: () => act('restart') }, 'Restart'),
        el('button', { class: 'btn', disabled: !ready, onclick: () => openTerminal(box, id, draw) }, 'Open terminal'),
        has_password && el('button', { class: 'btn', disabled: !ready, onclick: () => passwordModal(id, draw) }, 'Change SSH password'),
        el('div', { class: 'grow' }),
        el('button', { class: 'btn bad', onclick: async () => { if (confirm(`Delete "${s.name}" and all its data? This cannot be undone.`)) { await guard(box, async () => { await api('DELETE', '/servers/' + id); location.hash = '#/'; }); } } }, 'Delete')),
        el('div', { id: 'termhost' })),
      ready && el('div', { class: 'card', style: 'margin-top:14px' }, el('h2', { style: 'margin-bottom:12px' }, 'Resources'), el('div', { class: 'grid' },
        bar('CPU', s.cpu || 0, `${(s.cpu || 0).toFixed(0)}% of ${s.cpu_cores} vCPU`), bar('RAM', pct(s.mem_used, s.mem_total), `${fmtB(s.mem_used)} / ${fmtB(s.mem_total)}`), bar('Storage', pct(s.disk_used, s.disk_total), `${fmtB(s.disk_used)} / ${fmtB(s.disk_total)}`),
        history.length > 1 && spark(history))),
      !creating && s.status !== 'error' && termiusGuide(s));
    if (first) { first = false; poll(() => draw().catch(() => {}), creating ? 4000 : 10000); }
  };
  await guard(box, draw);
}
function spark(h) {
  const w = 600, ht = 60, pts = h.map((p, i) => `${(i / (h.length - 1)) * w},${ht - Math.min(100, p.cpu || 0) / 100 * ht}`).join(' ');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${ht}`); svg.setAttribute('style', 'width:100%;height:60px'); svg.setAttribute('preserveAspectRatio', 'none');
  const pl = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  pl.setAttribute('points', pts); pl.setAttribute('fill', 'none'); pl.setAttribute('stroke', '#3b9eff'); pl.setAttribute('stroke-width', '2'); svg.append(pl);
  return el('div', {}, el('div', { class: 'mute', style: 'font-size:12px' }, 'CPU, last hour'), svg);
}
function termiusGuide(s) {
  return el('div', { class: 'card', style: 'margin-top:14px' }, el('h2', {}, 'Connect with Termius'),
    el('ol', { class: 'steps' }, el('li', {}, 'Open Termius → Hosts → New Host.'), el('li', {}, `Address: ${s.ip}`), el('li', {}, `Port: ${s.ssh_port}`), el('li', {}, `Username: ${s.ssh_username}`),
      el('li', {}, 'Password: reveal it above, or choose the key you gave at creation.'), el('li', {}, 'Save, then tap the host to connect.')));
}
function revealModal(id) {
  const out = el('div');
  const m = modal([el('h2', {}, 'Reveal SSH password'), el('p', { class: 'mute' }, 'Confirm your account password to continue.'),
    el('form', { onsubmit: async (e) => { e.preventDefault(); out.replaceChildren(); try { const r = await api('POST', `/servers/${id}/reveal-password`, { account_password: e.target.p.value }); out.append(el('pre', { class: 'code' }, r.password), copyBtn(r.password)); e.target.remove(); } catch (x) { out.append(el('div', { class: 'msg err' }, x.message)); } } },
      el('input', { name: 'p', type: 'password', required: true, autocomplete: 'current-password' }), el('div', { class: 'row', style: 'margin-top:12px' }, el('button', { class: 'btn pri' }, 'Reveal'), el('button', { type: 'button', class: 'btn', onclick: () => m.remove() }, 'Close'))), out]);
}
function passwordModal(id, after) {
  const out = el('div');
  const m = modal([el('h2', {}, 'Change SSH password'), el('p', { class: 'mute' }, 'Leave blank to generate a strong password.'),
    el('form', { onsubmit: async (e) => { e.preventDefault(); out.replaceChildren(); const v = e.target.p.value; try { const r = await api('POST', `/servers/${id}/ssh-password`, v ? { new_password: v } : {}); out.append(el('div', { class: 'msg ok' }, 'Password updated.'), r.password && el('pre', { class: 'code' }, r.password), r.password && copyBtn(r.password)); e.target.remove(); } catch (x) { out.append(el('div', { class: 'msg err' }, x.message)); } } },
      el('input', { name: 'p', type: 'password', minlength: 12, maxlength: 64, autocomplete: 'new-password', placeholder: 'New password (12+ characters)' }), el('div', { class: 'row', style: 'margin-top:12px' }, el('button', { class: 'btn pri' }, 'Update'), el('button', { type: 'button', class: 'btn', onclick: () => { m.remove(); after(); } }, 'Close'))), out]);
}
function openTerminal(box, id, after) {
  const host = box.querySelector('#termhost'); host.replaceChildren();
  const div = el('div', { class: 'term' }); host.append(div);
  const term = new Terminal({ fontFamily: 'JetBrains Mono, monospace', fontSize: 14, cursorBlink: true, theme: { background: '#000000', foreground: '#e8ecff', cursor: '#3b9eff' } });
  const fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open(div); fit.fit();
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/terminal?server=' + id);
  const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
  ws.onopen = () => send({ t: 'r', c: term.cols, r: term.rows });
  ws.onmessage = (e) => term.write(e.data);
  term.onData((d) => send({ t: 'd', d }));
  const onResize = () => { fit.fit(); send({ t: 'r', c: term.cols, r: term.rows }); };
  window.addEventListener('resize', onResize);
  const close = el('button', { class: 'btn sm', style: 'margin-top:8px', onclick: () => end() }, 'Close terminal');
  host.append(close);
  state.term = { ws };
  function end() { window.removeEventListener('resize', onResize); try { ws.close(); } catch { /* */ } term.dispose(); state.term = null; host.replaceChildren(); after(); }
  ws.onclose = () => { term.write('\r\n\x1b[90m[connection closed]\x1b[0m\r\n'); };
  term.focus();
}

// ---------- admin ----------
async function adminUsers() {
  const box = el('div'); shell(box, '#/admin/users');
  await guard(box, async () => {
    const { users } = await api('GET', '/admin/users');
    const reload = () => adminUsers();
    box.replaceChildren(el('div', { class: 'head' }, el('h1', {}, 'Users')), el('div', { class: 'card scroll' }, el('table', {},
      el('thead', {}, el('tr', {}, ['User', 'Email', 'Role', 'Status', 'Servers', 'Quota', ''].map((h) => el('th', {}, h)))),
      el('tbody', {}, users.map((u) => el('tr', {}, el('td', {}, u.username), el('td', {}, u.email), el('td', {}, u.role), el('td', {}, u.status), el('td', {}, u.servers), el('td', {}, u.max_servers ?? 'default'),
        el('td', {}, el('div', { class: 'row' },
          el('button', { class: 'btn sm', onclick: async () => { const v = prompt('Max servers for ' + u.username + ' (blank = default)', u.max_servers ?? ''); if (v === null) return; await guard(box, async () => { await api('PATCH', '/admin/users/' + u.id, { max_servers: v === '' ? null : +v }); reload(); }); } }, 'Quota'),
          u.id !== state.user.id && el('button', { class: 'btn sm' + (u.status === 'active' ? ' bad' : ''), onclick: () => guard(box, async () => { await api('POST', `/admin/users/${u.id}/${u.status === 'active' ? 'suspend' : 'restore'}`); reload(); }) }, u.status === 'active' ? 'Suspend' : 'Restore')))))))));
  });
}
async function adminServers() {
  const box = el('div'); shell(box, '#/admin/servers');
  await guard(box, async () => {
    const [{ servers }, { users }, infra] = await Promise.all([api('GET', '/admin/servers'), api('GET', '/admin/users'), api('GET', '/servers/infra')]);
    box.replaceChildren(el('div', { class: 'head' }, el('h1', {}, 'All servers'), el('button', { class: 'btn pri', onclick: () => adminCreate(users, infra) }, 'Create for user')),
      el('div', { class: 'card scroll' }, el('table', {}, el('thead', {}, el('tr', {}, ['Name', 'Owner', 'OS', 'Status', 'Address', 'Resources', 'CPU', ''].map((h) => el('th', {}, h)))),
        el('tbody', {}, servers.map((s) => el('tr', {}, el('td', {}, s.name), el('td', {}, s.owner), el('td', {}, s.os), el('td', {}, status(s.status)), el('td', { class: 'mono' }, `${s.ip}:${s.ssh_port}`),
          el('td', {}, `${s.cpu_cores}c/${s.ram_mb}M/${s.disk_gb}G`), el('td', {}, s.cpu != null ? s.cpu.toFixed(0) + '%' : '–'),
          el('td', {}, el('div', { class: 'row' },
            s.status === 'running' && el('button', { class: 'btn sm', onclick: () => guard(box, async () => { await api('POST', `/admin/servers/${s.id}/action`, { action: 'stop' }); adminServers(); }) }, 'Stop'),
            s.status === 'stopped' && el('button', { class: 'btn sm', onclick: () => guard(box, async () => { await api('POST', `/admin/servers/${s.id}/action`, { action: 'start' }); adminServers(); }) }, 'Start'),
            el('button', { class: 'btn sm bad', onclick: () => confirm('Delete ' + s.name + '?') && guard(box, async () => { await api('DELETE', '/admin/servers/' + s.id); adminServers(); }) }, 'Delete')))))))));
  });
}
function adminCreate(users, infra) {
  if (!infra.configured) return createModal(infra);
  const err = el('div');
  const f = el('form', { onsubmit: async (e) => { e.preventDefault(); const d = Object.fromEntries(new FormData(f)); if (!d.public_key) delete d.public_key; try { await api('POST', '/admin/servers', d); m.remove(); adminServers(); } catch (x) { err.replaceChildren(el('div', { class: 'msg err' }, x.message)); } } },
    el('label', {}, 'Owner'), el('select', { name: 'user_id' }, users.filter((u) => u.status === 'active').map((u) => el('option', { value: u.id }, u.username))),
    el('label', {}, 'Name'), el('input', { name: 'name', required: true }), el('label', {}, 'OS'), el('select', { name: 'os' }, infra.os.map((o) => el('option', { value: o }, o))),
    el('div', { class: 'three' }, el('div', {}, el('label', {}, 'vCPU'), el('input', { name: 'cpu_cores', type: 'number', value: 1, min: 1 })), el('div', {}, el('label', {}, 'RAM MB'), el('input', { name: 'ram_mb', type: 'number', value: 1024, min: 256 })), el('div', {}, el('label', {}, 'Disk GB'), el('input', { name: 'disk_gb', type: 'number', value: 10, min: 4 }))),
    el('label', {}, 'SSH public key (optional)'), el('textarea', { name: 'public_key' }), err, el('div', { class: 'row', style: 'margin-top:14px' }, el('button', { class: 'btn pri' }, 'Create'), el('button', { type: 'button', class: 'btn', onclick: () => m.remove() }, 'Cancel')));
  const m = modal([el('h2', {}, 'Create server for user'), f]);
}
async function adminAudit() {
  const box = el('div'); shell(box, '#/admin/audit');
  await guard(box, async () => {
    const { logs } = await api('GET', '/admin/audit?limit=200');
    box.replaceChildren(el('div', { class: 'head' }, el('h1', {}, 'Audit log')), el('div', { class: 'card scroll' }, el('table', {}, el('thead', {}, el('tr', {}, ['Time', 'User', 'Action', 'Target', 'IP'].map((h) => el('th', {}, h)))),
      el('tbody', {}, logs.map((l) => el('tr', {}, el('td', {}, when(l.created_at)), el('td', {}, l.username || '–'), el('td', { class: 'mono' }, l.action), el('td', { class: 'mono' }, (l.target || '').slice(0, 36)), el('td', {}, l.ip || '–')))))));
  });
}
async function adminInfra() {
  const box = el('div'); shell(box, '#/admin/infra');
  await guard(box, async () => {
    const [info, { settings: S }] = await Promise.all([api('GET', '/admin/infra'), api('GET', '/admin/settings')]);
    const P = S.provider, n = info.node;
    const msg = el('div');
    const f = el('form', { onsubmit: async (e) => {
      e.preventDefault(); const d = Object.fromEntries(new FormData(f)); msg.replaceChildren();
      const body = { registration_open: !!d.registration_open, allow_password_auth: !!d.allow_password_auth, max_servers_default: +d.max_servers_default,
        limits: { max_cpu: +d.max_cpu, max_ram_mb: +d.max_ram_mb, max_disk_gb: +d.max_disk_gb },
        provider: { node: d.node, storage: d.storage, bridge: d.bridge, gateway: d.gateway, cidr: +d.cidr, ip_pool: d.ip_pool.split('\n').map((x) => x.trim()).filter(Boolean), public_host: d.public_host, ssh_port_base: +d.ssh_port_base || 0, templates: { 'ubuntu-24.04': d.tpl_ubuntu, 'debian-12': d.tpl_debian } } };
      try { await api('PUT', '/admin/settings', body); toast(msg, 'Saved', 'ok'); setTimeout(adminInfra, 600); } catch (x) { toast(msg, x.message); }
    } },
      el('div', { class: 'two' }, el('div', {}, el('label', {}, 'Proxmox node name'), el('input', { name: 'node', value: P.node })), el('div', {}, el('label', {}, 'Storage'), el('input', { name: 'storage', value: P.storage }))),
      el('div', { class: 'three' }, el('div', {}, el('label', {}, 'Bridge'), el('input', { name: 'bridge', value: P.bridge })), el('div', {}, el('label', {}, 'Gateway'), el('input', { name: 'gateway', value: P.gateway })), el('div', {}, el('label', {}, 'CIDR prefix'), el('input', { name: 'cidr', type: 'number', value: P.cidr }))),
      el('label', {}, 'IP pool (one per line, or 10.0.0.10-50)'), el('textarea', { name: 'ip_pool' }, P.ip_pool.join('\n')),
      el('div', { class: 'two' }, el('div', {}, el('label', {}, 'Public host (shared-IP mode, optional)'), el('input', { name: 'public_host', value: P.public_host })), el('div', {}, el('label', {}, 'SSH port base (0 = each VPS has its own IP on port 22)'), el('input', { name: 'ssh_port_base', type: 'number', value: P.ssh_port_base }))),
      el('label', {}, 'Ubuntu 24.04 template'), el('input', { name: 'tpl_ubuntu', value: P.templates['ubuntu-24.04'] }), el('label', {}, 'Debian 12 template'), el('input', { name: 'tpl_debian', value: P.templates['debian-12'] }),
      el('h3', { style: 'margin-top:20px' }, 'Limits and policy'),
      el('div', { class: 'three' }, el('div', {}, el('label', {}, 'Max vCPU'), el('input', { name: 'max_cpu', type: 'number', value: S.limits.max_cpu })), el('div', {}, el('label', {}, 'Max RAM MB'), el('input', { name: 'max_ram_mb', type: 'number', value: S.limits.max_ram_mb })), el('div', {}, el('label', {}, 'Max disk GB'), el('input', { name: 'max_disk_gb', type: 'number', value: S.limits.max_disk_gb }))),
      el('label', {}, 'Default servers per user'), el('input', { name: 'max_servers_default', type: 'number', value: S.max_servers_default }),
      el('label', { class: 'row' }, el('input', { type: 'checkbox', name: 'registration_open', checked: S.registration_open, style: 'width:auto' }), 'Allow new registrations'),
      el('label', { class: 'row' }, el('input', { type: 'checkbox', name: 'allow_password_auth', checked: S.allow_password_auth, style: 'width:auto' }), 'Allow SSH password login (otherwise keys only)'),
      msg, el('button', { class: 'btn pri', style: 'margin-top:14px' }, 'Save settings'));
    box.replaceChildren(el('div', { class: 'head' }, el('h1', {}, 'Infrastructure')),
      !info.configured && el('div', { class: 'msg warn' }, info.message, el('br'), 'Missing: ' + info.missing.join(', ')),
      info.error && el('div', { class: 'msg err' }, 'Provider error: ' + info.error),
      n && el('div', { class: 'card', style: 'margin-bottom:14px' }, el('h2', { style: 'margin-bottom:12px' }, 'Proxmox node · v' + n.version), el('div', { class: 'three' }, bar('Host CPU', n.cpu, n.cpu.toFixed(0) + '%'), bar('Host RAM', pct(n.mem_used, n.mem_total), `${fmtB(n.mem_used)} / ${fmtB(n.mem_total)}`), bar('Host disk', pct(n.disk_used, n.disk_total), `${fmtB(n.disk_used)} / ${fmtB(n.disk_total)}`))),
      el('div', { class: 'card' }, el('h2', {}, 'Provider settings'), f));
  });
}

// ---------- router ----------
async function render() {
  clearInterval(state.timer); state.term = null;
  if (!state.user) return authView('login');
  const h = location.hash || '#/';
  const m = h.match(/^#\/server\/([0-9a-f-]{36})$/);
  if (m) return serverView(m[1]);
  if (h.startsWith('#/admin/') && state.user.role === 'admin') return ({ '#/admin/users': adminUsers, '#/admin/servers': adminServers, '#/admin/audit': adminAudit, '#/admin/infra': adminInfra }[h] || dashboard)();
  return dashboard();
}
window.addEventListener('hashchange', render);
(async () => { try { const c = await api('GET', '/csrf'); state.csrf = c.csrf; state.user = c.user; } catch { /* show login */ } render(); })();
