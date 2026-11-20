'use strict';
/* UTeM Smart Sports front end. Plain JavaScript. Every value from the server is written with textContent
   (through el()), never innerHTML, so stored text cannot inject scripts. */
const state = { user: null, cfg: { rules: {}, leadMin: 5 }, timers: [], charts: [] };
const $ = (s, r = document) => r.querySelector(s);

function el(tag, props, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else n.setAttribute(k, v);
  }
  for (const c of kids.flat(Infinity)) if (c !== null && c !== undefined && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
}
async function api(path, { method = 'GET', body, form } = {}) {
  const opt = { method, headers: { 'X-Requested-With': 'SmartSports' }, credentials: 'same-origin' };
  if (body) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  if (form) opt.body = form;
  const r = await fetch(`/api${path}`, opt);
  const data = (r.headers.get('content-type') || '').includes('json') ? await r.json() : await r.text();
  if (!r.ok) {
    if (r.status === 401 && state.user) { state.user = null; renderChrome(); }
    throw new Error((data && data.error) || 'Request failed');
  }
  return data;
}
function toast(msg, kind = '') {
  const t = el('div', { class: `toast ${kind}`, role: 'status' }, msg);
  $('#toasts').append(t); setTimeout(() => t.remove(), 4500);
}
const fail = (e) => toast(e.message, 'bad');
const isAdmin = () => state.user && state.user.role === 'Admin';
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };
const fmtDate = (s) => new Date(`${s}T00:00:00`).toLocaleDateString('en-MY', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const debounce = (fn, ms = 300) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
function clearTimers() { state.timers.forEach((t) => (t && t.stop ? t.stop() : clearInterval(t))); state.timers = []; state.charts.forEach((c) => c.destroy()); state.charts = []; }

/* ---------- dialog helper ---------- */
const dlg = $('#dlg');
function openDialog(title, body, foot) {
  dlg.replaceChildren(...[
    el('div', { class: 'dlg-head' }, el('h2', {}, title), el('button', { type: 'button', 'aria-label': 'Close', onclick: () => dlg.close() }, '×')),
    el('div', { class: 'dlg-body' }, body), foot ? el('div', { class: 'dlg-foot' }, foot) : null].filter(Boolean));
  if (!dlg.open) dlg.showModal();
}
dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });

/* ---------- small helpers: avatar and password field with Show/Hide ---------- */
function avatar(u, size = 32) {
  const initials = (u.full_name || '?').split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  return el('span', { class: 'avatar', style: `width:${size}px;height:${size}px;font-size:${Math.round(size / 2.6)}px` },
    u.photoSrc ? el('img', { src: u.photoSrc, alt: '' }) : initials);
}
function pw(label, name, o = {}) {
  const input = el('input', { name, type: 'password', required: o.required !== false, autocomplete: o.autocomplete || 'off', minlength: o.minlength, maxlength: 72, placeholder: o.placeholder });
  const btn = el('button', { type: 'button', class: 'ghost sm pw-toggle', 'aria-pressed': 'false', onclick: () => {
    const show = input.type === 'password'; input.type = show ? 'text' : 'password';
    btn.textContent = show ? 'Hide' : 'Show'; btn.setAttribute('aria-pressed', String(show)); } }, 'Show');
  return el('label', {}, label, el('span', { class: 'pw-wrap' }, input, btn), o.note ? el('span', { class: 'field-note' }, o.note) : null);
}

/* ---------- chrome: nav + user box ---------- */
function renderChrome() {
  const links = [['#/', 'Book facilities']];
  if (state.user) links.push(['#/bookings', 'My bookings']);
  if (isAdmin()) links.push(['#/admin/facilities', 'Facilities'], ['#/admin/bookings', 'All bookings'], ['#/admin/reports', 'Reports'], ['#/admin/devices', 'Lighting devices'],
    ['#/admin/monitor', 'Monitoring'], ['#/admin/users', 'Users'], ['#/admin/audit', 'Audit log']);
  const cur = location.hash || '#/';
  $('#nav').replaceChildren(...links.map(([h, t]) => el('a', { href: h, 'aria-current': cur === h ? 'page' : false }, t)));
  const box = $('#userbox');
  if (state.user) {
    box.replaceChildren(
      el('a', { class: 'chip-user', href: '#/profile', title: 'Open your profile', 'aria-current': cur === '#/profile' ? 'page' : false }, avatar(state.user, 30),
        el('span', {}, state.user.full_name, el('small', {}, `${state.user.student_id} · ${state.user.role}`))),
      el('button', { class: 'ghost sm logout', type: 'button', onclick: logout }, 'Log out'));
  } else {
    box.replaceChildren(
      el('button', { class: 'ghost sm logout', type: 'button', onclick: () => authDialog('login', null, 'student') }, 'Student log in'),
      el('button', { class: 'primary sm', type: 'button', onclick: () => authDialog('login', null, 'admin') }, 'Admin log in'));
  }
}
async function logout() {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  state.user = null; sessionStorage.removeItem('tgPrompt'); dlg.open && dlg.close();
  location.hash = '#/'; route(); toast('You are logged out');
}

/* ---------- login / register (two portals: Student and Admin) ---------- */
function authDialog(mode = 'login', after, portal = 'student') {
  if (portal === 'admin') mode = 'login';
  const err = el('div', { class: 'err', hidden: true, role: 'alert' });
  const sec = `section-${portal}`; // keeps the browser from mixing up saved student and admin passwords
  const switcher = el('div', { class: 'portal', role: 'tablist', 'aria-label': 'Log in as' },
    ...[['student', 'Student'], ['admin', 'Admin']].map(([p, t]) => el('button', { type: 'button', role: 'tab', class: p === portal ? 'on' : '', 'aria-selected': String(p === portal), onclick: () => authDialog('login', after, p) }, t)));
  const tabs = portal === 'student' ? el('div', { class: 'tabs', role: 'tablist' },
    ...[['login', 'Log in'], ['register', 'Create account']].map(([m, t]) => el('button', { type: 'button', role: 'tab', 'aria-selected': String(mode === m), onclick: () => authDialog(m, after, 'student') }, t))) : null;
  const form = el('form', { style: 'display:grid;gap:14px', autocomplete: 'on' });
  const field = (label, name, type = 'text', extra = {}) => el('label', {}, label, el('input', { name, type, required: true, ...extra }));
  if (mode === 'login') {
    form.append(field(portal === 'admin' ? 'Admin email or ID' : 'Student ID or email', 'identifier', 'text', { autocomplete: `${sec} username`, placeholder: portal === 'admin' ? 'admin@utem.edu.my' : 'B032510025' }),
      pw('Password', 'password', { autocomplete: `${sec} current-password` }), err, el('button', { class: 'primary', type: 'submit' }, portal === 'admin' ? 'Log in as admin' : 'Log in'),
      portal === 'student' ? el('p', { class: 'small muted' }, 'Forgot your password? Ask an administrator to reset it for you.') : null);
  } else {
    form.append(field('Student ID', 'student_id', 'text', { placeholder: 'B032510025', maxlength: 10, autocomplete: 'off' }), field('Full name', 'full_name', 'text', { maxlength: 100, autocomplete: 'name' }),
      field('Student email', 'email', 'email', { placeholder: 'name@student.utem.edu.my', autocomplete: 'email' }),
      pw('Password', 'password', { minlength: 8, autocomplete: 'new-password', note: 'At least 8 characters with letters and numbers. Press Show to check what you typed.' }),
      el('div', { class: 'notice' }, 'Next step: you will link Telegram, so create a free Telegram account first if you do not have one.'), err, el('button', { class: 'primary', type: 'submit' }, 'Create account'));
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.hidden = true;
    const body = Object.fromEntries(new FormData(form));
    try {
      if (mode === 'login') await doLogin({ identifier: body.identifier, password: body.password, portal }, false, after);
      else { await api('/auth/register', { method: 'POST', body }); await doLogin({ identifier: body.student_id, password: body.password, portal: 'student' }, true, after); }
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  });
  openDialog(portal === 'admin' ? 'Admin log in' : 'UTeM Student Portal', [switcher, tabs, form]);
}
async function doLogin(body, justRegistered, after) {
  state.user = (await api('/auth/login', { method: 'POST', body })).user;
  dlg.close(); renderChrome(); toast(`Welcome, ${state.user.full_name}`, 'good');
  const needTelegram = state.user.role === 'Student' && !state.user.telegram_linked;
  if (after) { route(); after(); }
  else if (needTelegram && (justRegistered || !sessionStorage.getItem('tgPrompt'))) telegramOnboarding();
  else route();
}

/* ---------- Telegram linking (no chat ID needed: press Start in the bot) ---------- */
function telegramLinker(onDone) {
  const box = el('div', { class: 'tg' }); let timer = null;
  const stop = () => { if (timer) clearInterval(timer); timer = null; };
  const manual = () => {
    const input = el('input', { inputmode: 'numeric', placeholder: 'Chat ID, for example 123456789', 'aria-label': 'Telegram chat ID' });
    const msg = el('div', { class: 'err', hidden: true });
    return el('div', { style: 'display:grid;gap:8px;margin-top:8px' },
      el('p', { class: 'small' }, 'To find your chat ID: in Telegram search for ', el('b', {}, '@userinfobot'), ' and press Start. It replies with "Id: 123456789". Our bot also tells you if you send it /start. Type the number here:'),
      el('div', { class: 'row' }, input, el('button', { type: 'button', class: 'sm', onclick: async () => {
        msg.hidden = true;
        try {
          const r = await api('/auth/profile', { method: 'PATCH', body: { telegram_chat_id: input.value.trim() } });
          state.user = r.user; renderChrome();
          if (r.telegram_test === 'Sent') { stop(); toast('Telegram linked', 'good'); onDone(); }
          else { msg.textContent = 'Saved, but Telegram could not send you a message. Open our bot in Telegram and press Start first, then try again.'; msg.hidden = false; }
        } catch (ex) { msg.textContent = ex.message; msg.hidden = false; }
      } }, 'Save chat ID')), msg);
  };
  async function check() {
    try { const s = await api('/auth/telegram/status'); if (s.linked) { stop(); state.user = (await api('/auth/me')).user; renderChrome(); onDone(); } } catch (_) { /* keep waiting */ }
  }
  async function start() {
    stop();
    box.replaceChildren(el('p', { class: 'muted small' }, 'Preparing your link...'));
    try {
      const r = await api('/auth/telegram/link-code', { method: 'POST' });
      box.replaceChildren(
        el('ol', { class: 'steps' }, el('li', {}, 'Install ', el('b', {}, 'Telegram'), ' on your phone or computer and sign in (it is free).'),
          el('li', {}, 'Press the green button. Telegram opens our bot ', el('b', {}, `@${r.username}`), '.'),
          el('li', {}, 'Press ', el('b', {}, 'Start'), ' in Telegram. This page links your account by itself within a few seconds.')),
        el('a', { class: 'btn primary', href: r.url, target: '_blank', rel: 'noopener' }, `Open @${r.username} in Telegram`),
        el('p', { class: 'small muted' }, `Waiting for you to press Start... The link works for ${r.expires_minutes} minutes.`),
        el('details', {}, el('summary', {}, 'The button does not work? Use your chat ID instead'), manual()));
      timer = setInterval(check, 3000);
    } catch (e) { box.replaceChildren(el('div', { class: 'err' }, e.message), el('button', { class: 'ghost sm', type: 'button', style: 'margin-top:8px', onclick: start }, 'Try again')); }
  }
  return { node: box, start, stop };
}
function telegramOnboarding() {
  sessionStorage.setItem('tgPrompt', '1');
  const linker = telegramLinker(() => { dlg.close(); toast('Telegram linked. Your alerts will arrive there.', 'good'); });
  dlg.addEventListener('close', () => { linker.stop(); route(); }, { once: true });
  openDialog('Set up Telegram before you book',
    [el('p', {}, 'We send your booking confirmation and the "your court is ready, lights are on" alert through Telegram. Please link it now. It takes about one minute.'), linker.node],
    [el('button', { class: 'ghost', type: 'button', onclick: () => dlg.close() }, 'Do it later')]);
  linker.start();
}

/* ---------- profile page ---------- */
async function profileView(main) {
  if (!state.user) return needLogin(main);
  const me = (await api('/auth/profile')).user; state.user = me; renderChrome();
  const msg = (cls) => el('div', { class: cls, hidden: true, role: 'alert' });

  const photoErr = msg('err');
  const photoCard = el('div', { class: 'card' }, el('h3', {}, 'Profile photo'),
    el('div', { class: 'row', style: 'margin-top:12px' }, avatar(me, 84), el('div', { class: 'grow', style: 'display:grid;gap:6px' },
      el('p', { class: 'small muted' }, 'JPEG, PNG or WebP, up to 2 MB.'),
      el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', 'aria-label': 'Choose a profile photo', onchange: async (e) => {
        const f = e.target.files[0]; if (!f) return; photoErr.hidden = true;
        const fd = new FormData(); fd.append('photo', f);
        try { const r = await api('/auth/photo', { method: 'POST', form: fd }); state.user.photoSrc = r.photoSrc; toast('Photo updated', 'good'); route(); } catch (ex) { photoErr.textContent = ex.message; photoErr.hidden = false; }
      } }))), photoErr);

  const infoErr = msg('err');
  const info = el('form', { style: 'display:grid;gap:12px' },
    el('label', {}, 'Full name', el('input', { name: 'full_name', value: me.full_name, required: true, maxlength: 100, autocomplete: 'name' })),
    el('div', { class: 'row' }, el('label', { class: 'grow' }, 'Student ID', el('input', { value: me.student_id, readonly: true, class: 'ro' })), el('label', { class: 'grow' }, 'Role', el('input', { value: me.role, readonly: true, class: 'ro' }))),
    el('label', {}, 'Email', el('input', { value: me.email, readonly: true, class: 'ro' })),
    el('label', {}, 'Phone number', el('input', { name: 'phone', value: me.phone, placeholder: '012-3456789', autocomplete: 'tel', maxlength: 20 })),
    el('label', {}, 'Faculty or programme', el('input', { name: 'faculty', value: me.faculty, placeholder: 'FTMK, BITA', list: 'faculties', maxlength: 100 }),
      el('datalist', { id: 'faculties' }, ...['FTMK', 'FKE', 'FKEKK', 'FKM', 'FKP', 'FPTT'].map((x) => el('option', { value: x })))),
    infoErr, el('button', { class: 'primary', type: 'submit' }, 'Save my information'));
  info.addEventListener('submit', async (e) => {
    e.preventDefault(); infoErr.hidden = true;
    try { const r = await api('/auth/profile', { method: 'PATCH', body: Object.fromEntries(new FormData(info)) }); state.user = r.user; renderChrome(); toast('Information saved', 'good'); }
    catch (ex) { infoErr.textContent = ex.message; infoErr.hidden = false; }
  });

  const tgBody = el('div', { style: 'display:grid;gap:12px;margin-top:10px' });
  const drawTg = () => {
    if (state.user.telegram_linked) {
      tgBody.replaceChildren(el('div', { class: 'row' }, el('span', { class: 'badge' }, 'Linked'), el('span', { class: 'small muted' }, 'Booking alerts arrive in Telegram.')),
        el('div', { class: 'row' }, el('button', { class: 'ghost sm', type: 'button', onclick: async () => { try { toast(`Test message: ${(await api('/auth/telegram/test', { method: 'POST' })).status}`, 'good'); } catch (ex) { fail(ex); } } }, 'Send a test message'),
          el('button', { class: 'ghost sm', type: 'button', onclick: async () => { if (!confirm('Unlink Telegram?')) return; await api('/auth/telegram', { method: 'DELETE' }); state.user.telegram_linked = false; renderChrome(); drawTg(); } }, 'Unlink')));
    } else {
      const linker = telegramLinker(() => { state.user.telegram_linked = true; toast('Telegram linked', 'good'); drawTg(); });
      state.timers.push({ stop: linker.stop }); // cleared with the page
      tgBody.replaceChildren(el('div', { class: 'notice warn' }, 'Telegram is not linked. Create a Telegram account first, then link it here to get your confirmations, receipts and court-ready alerts.'), linker.node);
      linker.start();
    }
  };
  drawTg();

  const pwErr = msg('err');
  const pwForm = el('form', { style: 'display:grid;gap:12px', autocomplete: 'off' },
    pw('Current password', 'current_password', { autocomplete: 'off' }), pw('New password', 'new_password', { minlength: 8, autocomplete: 'new-password' }),
    pw('Repeat new password', 'confirm_password', { minlength: 8, autocomplete: 'new-password' }),
    el('p', { class: 'small muted' }, 'Your password never changes unless you press the button below. We cannot show your saved password because it is stored scrambled (hashed). Use Show to check what you type.'),
    pwErr, el('button', { class: 'primary', type: 'submit' }, 'Change password'));
  pwForm.addEventListener('submit', async (e) => {
    e.preventDefault(); pwErr.hidden = true;
    try { await api('/auth/profile', { method: 'PATCH', body: Object.fromEntries(new FormData(pwForm)) }); pwForm.reset(); toast('Password changed', 'good'); }
    catch (ex) { pwErr.textContent = ex.message; pwErr.hidden = false; }
  });

  main.replaceChildren(el('div', { class: 'head' }, el('div', {}, el('h1', {}, 'My profile'), el('p', {}, 'Keep your details up to date and link Telegram to get your alerts.')),
    el('button', { class: 'ghost', type: 'button', onclick: logout }, 'Log out')),
    el('div', { class: 'profile-grid' }, el('div', { style: 'display:grid;gap:16px;align-content:start' }, photoCard, el('div', { class: 'card' }, el('h3', {}, 'Personal information'), el('div', { style: 'margin-top:12px' }, info))),
      el('div', { style: 'display:grid;gap:16px;align-content:start' }, el('div', { class: 'card' }, el('h3', {}, 'Telegram alerts'), tgBody), el('div', { class: 'card' }, el('h3', {}, 'Change password'), el('div', { style: 'margin-top:12px' }, pwForm)))));
}

/* ---------- facilities (student view) ---------- */
async function facilitiesView(main) {
  const q = { text: '', type: '', venue: '' };
  const [types, all] = await Promise.all([api('/facilities/types'), api('/facilities')]);
  const venues = [...new Set(all.map((f) => f.location))].sort();
  const shown = types.filter((t) => all.some((f) => f.type_id === t.type_id));
  const box = el('div'); const chips = el('div', { class: 'row' });
  const draw = () => {
    const t = q.text.toLowerCase();
    const list = all.filter((f) => (!q.type || String(f.type_id) === q.type) && (!q.venue || f.location === q.venue)
      && (!t || f.facility_name.toLowerCase().includes(t) || f.location.toLowerCase().includes(t) || f.type_name.toLowerCase().includes(t)));
    if (!list.length) { box.replaceChildren(el('div', { class: 'empty' }, 'No facilities match your search. Clear the filters to see them all.')); return; }
    const byVenue = list.reduce((m, f) => ((m[f.location] = m[f.location] || []).push(f), m), {});
    box.replaceChildren(...Object.keys(byVenue).sort().flatMap((v) => [el('h2', { class: 'venue' }, v, el('span', { class: 'muted small' }, ` ${byVenue[v].length} ${byVenue[v].length === 1 ? 'court' : 'courts'}`)), el('div', { class: 'grid' }, ...byVenue[v].map(courtCard))]));
  };
  const drawChips = () => chips.replaceChildren(...[{ type_id: '', type_name: 'All sports' }, ...shown].map((t) =>
    el('button', { class: 'pill', type: 'button', 'aria-pressed': String(q.type === String(t.type_id)), onclick: () => { q.type = String(t.type_id); drawChips(); draw(); } }, t.type_name)));
  drawChips();
  const banner = !state.user
    ? el('div', { class: 'notice', style: 'margin-bottom:16px' }, el('b', {}, 'Before you book: '), 'create a free Telegram account. We send your confirmation and the "court is ready, lights are on" alert there. You link it after you log in.')
    : state.user.role === 'Student' && !state.user.telegram_linked
      ? el('div', { class: 'notice warn', style: 'margin-bottom:16px' }, el('b', {}, 'Link Telegram first. '), 'Your booking confirmation and court-ready alert are sent there. ', el('a', { href: '#/profile' }, 'Link Telegram now'))
      : null;
  main.replaceChildren(...[
    el('div', { class: 'head' }, el('div', {}, el('h1', {}, 'Book a sports facility'), el('p', {}, `Pick a court and a slot up to ${state.cfg.rules.maxAdvanceDays || 7} days ahead. The lights switch on for you ${state.cfg.leadMin} minutes before your slot.`))),
    banner,
    el('div', { class: 'filters' }, el('input', { type: 'search', placeholder: 'Search sport, court or venue', 'aria-label': 'Search facilities', oninput: debounce((e) => { q.text = e.target.value.trim(); draw(); }, 150) }),
      el('select', { 'aria-label': 'Venue', onchange: (e) => { q.venue = e.target.value; draw(); } }, el('option', { value: '' }, 'All venues'), ...venues.map((v) => el('option', { value: v }, v)))),
    el('div', { class: 'filters' }, chips), box].filter(Boolean));
  draw();
}
function courtCard(f) {
  const img = el('div', { class: 'court-img' }, f.photoSrc ? el('img', { src: f.photoSrc, alt: '', loading: 'lazy' }) : null, f.photoSrc ? null : f.type_name);
  return el('article', { class: 'card court' }, img, el('div', { class: 'court-body' },
    el('div', { class: 'row' }, el('h3', {}, f.facility_name), el('span', { class: 'badge blue' }, f.type_name)),
    el('p', { class: 'muted small' }, f.location, f.capacity ? ` · up to ${f.capacity} players` : ''),
    el('div', { class: 'row small muted' }, el('span', { class: `lamp ${f.light_state === 'ON' ? 'on' : ''}`, 'aria-hidden': 'true' }), f.thing_name ? `Smart lighting ${f.light_state === 'ON' ? 'on now' : 'ready'}` : 'Lights not automated'),
    el('button', { type: 'button', class: 'primary', onclick: () => slotDialog(f) }, 'View slots')));
}

/* ---------- slot picker: create + reschedule ---------- */
async function slotDialog(f, existing) {
  const picker = { date: existing ? existing.booking_date : addDays(0), slot: null };
  const slotsBox = el('div', { class: 'slots' });
  const summary = el('span', {}, 'No slot selected');
  const confirm = el('button', { class: 'primary', type: 'button', disabled: true }, existing ? 'Move my booking' : 'Confirm booking');
  const msg = el('div', { class: 'err', hidden: true, role: 'alert' });
  const draw = async () => {
    picker.slot = null; confirm.disabled = true; summary.textContent = 'No slot selected';
    const rows = await api(`/facilities/${f.facility_id}/availability?date=${picker.date}`);
    slotsBox.replaceChildren(...rows.map((s) => {
      const free = s.state === 'available';
      const label = { available: 'Available', booked: 'Booked', past: 'Passed', mine: 'Your booking' }[s.state];
      return el('button', { type: 'button', class: `slot ${free ? '' : s.state}`, disabled: !free, 'aria-label': `${s.start} to ${s.end}, ${label}`,
        onclick: (e) => { picker.slot = s; slotsBox.querySelectorAll('.picked').forEach((n) => n.classList.remove('picked')); e.currentTarget.classList.add('picked'); summary.textContent = `${fmtDate(picker.date)}, ${s.start} to ${s.end}`; confirm.disabled = false; } },
      `${s.start} - ${s.end}`, el('small', {}, label));
    }));
  };
  const dateIn = el('input', { type: 'date', value: picker.date, min: addDays(0), max: addDays(state.cfg.rules.maxAdvanceDays || 7), 'aria-label': 'Booking date',
    onchange: (e) => { picker.date = e.target.value; draw().catch(fail); } });
  confirm.addEventListener('click', async () => {
    if (!state.user) { return authDialog('login', () => slotDialog(f, existing)); }
    msg.hidden = true; confirm.disabled = true;
    try {
      const body = { slot_id: picker.slot.slot_id, booking_date: picker.date };
      if (existing) await api(`/bookings/${existing.booking_id}`, { method: 'PUT', body });
      else await api('/bookings', { method: 'POST', body: { ...body, facility_id: f.facility_id } });
      dlg.close(); toast(existing ? 'Booking moved' : 'Booking confirmed. Check Telegram for your receipt.', 'good'); route();
    } catch (ex) { msg.textContent = ex.message; msg.hidden = false; draw().catch(() => {}); }
  });
  openDialog(f.facility_name, [
    f.photoSrc ? el('img', { class: 'dlg-photo', src: f.photoSrc, alt: '' }) : null,
    el('div', { class: 'row' }, el('label', {}, 'Date', dateIn), el('p', { class: 'small muted grow' }, `${f.location}. One-hour slots, up to ${state.cfg.rules.maxPerDay} bookings per day.`)),
    el('div', { class: 'legend' }, ...[['#9bdcc3', 'Available'], ['#e2e8ea', 'Booked or passed'], ['#9cc3ea', 'Your booking'], ['#0e9f6e', 'Your choice']].map(([c, t]) => el('span', {}, el('i', { style: `border-color:${c};background:${c}` }), t))),
    slotsBox,
    el('div', { class: 'notice' }, `Lights switch on automatically ${state.cfg.leadMin} minutes before your slot and a Telegram message tells you the court is ready.`), msg],
  [el('span', { class: 'grow small' }, summary), el('button', { class: 'ghost', type: 'button', onclick: () => dlg.close() }, 'Cancel'), confirm]);
  await draw().catch(fail);
}

/* ---------- my bookings ---------- */
const STATUS_CLASS = { Confirmed: '', Completed: 'blue', Cancelled: 'off' };
async function bookingsView(main) {
  if (!state.user) return needLogin(main);
  const q = { status: '', text: '' };
  const list = el('div', { class: 'list' }); const notes = el('div', { class: 'list' });
  const load = async () => {
    const qs = new URLSearchParams(); if (q.status) qs.set('status', q.status); if (q.text) qs.set('q', q.text);
    const rows = await api(`/bookings?${qs}`);
    list.replaceChildren(...(rows.length ? rows.map(bookingRow) : [el('div', { class: 'empty' }, 'No bookings yet. Pick a court on the Book facilities page.')]));
  };
  const bookingRow = (b) => el('div', { class: 'card item' },
    el('div', {}, el('h3', {}, b.facility_name), el('p', {}, `${fmtDate(b.booking_date)} · ${b.start_time} - ${b.end_time} · #${b.booking_id}`)),
    el('div', { class: 'row' }, el('span', { class: `badge ${STATUS_CLASS[b.status]}` }, b.status),
      el('button', { class: 'ghost sm', type: 'button', onclick: async () => { try { window.open((await api(`/bookings/${b.booking_id}/receipt`)).url, '_blank', 'noopener'); } catch (e) { fail(e); } } }, 'Receipt'),
      b.can_change ? el('button', { class: 'ghost sm', type: 'button', onclick: () => slotDialog({ facility_id: b.facility_id, facility_name: b.facility_name, location: b.location }, b) }, 'Change slot') : null,
      b.can_change ? el('button', { class: 'danger sm', type: 'button', onclick: async () => { if (!confirm('Cancel this booking?')) return; try { toast((await api(`/bookings/${b.booking_id}/cancel`, { method: 'PATCH' })).message, 'good'); load(); loadNotes(); } catch (e) { fail(e); } } }, 'Cancel') : null));
  const loadNotes = async () => {
    const n = await api('/notifications');
    notes.replaceChildren(...(n.length ? n.slice(0, 8).map((x) => el('div', { class: 'card small' }, el('b', {}, x.type), ` · ${x.status}`, el('p', { class: 'muted' }, x.message))) : [el('p', { class: 'muted small' }, 'No messages yet.')]));
  };
  main.replaceChildren(
    el('div', { class: 'head' }, el('div', {}, el('h1', {}, 'My bookings'), el('p', {}, `You can change or cancel a booking until ${state.cfg.rules.cancelCutoffHours} hours before it starts.`))),
    el('div', { class: 'filters' }, el('select', { 'aria-label': 'Status', onchange: (e) => { q.status = e.target.value; load().catch(fail); } },
      el('option', { value: '' }, 'All statuses'), ...['Confirmed', 'Completed', 'Cancelled'].map((s) => el('option', { value: s }, s))),
    el('input', { type: 'search', placeholder: 'Search by court', oninput: debounce((e) => { q.text = e.target.value.trim(); load().catch(fail); }) })),
    el('div', { style: 'display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:18px;align-items:start' },
      list, el('div', { class: 'card' }, el('h3', {}, 'Telegram messages'), el('p', { class: 'muted small', style: 'margin:4px 0 12px' }, state.user.telegram_linked ? 'Telegram is linked.' : 'Link Telegram in your profile to get court-ready alerts.'), notes)));
  await Promise.all([load(), loadNotes()]);
}
function needLogin(main) {
  main.replaceChildren(el('div', { class: 'empty' }, el('h2', {}, 'Log in to continue'), el('p', { style: 'margin:6px 0 14px' }, 'You need a UTeM student account to see your bookings.'), el('button', { class: 'primary', type: 'button', onclick: () => authDialog() }, 'Log in')));
}

/* ---------- admin: facilities CRUDS ---------- */
async function adminFacilities(main) {
  const q = { text: '', status: '' }; const tbody = el('tbody');
  const types = await api('/facilities/types');
  const load = async () => {
    const qs = new URLSearchParams(); if (q.text) qs.set('q', q.text); if (q.status) qs.set('status', q.status);
    const rows = await api(`/facilities?${qs}`);
    tbody.replaceChildren(...(rows.length ? rows.map((f) => el('tr', {},
      el('td', {}, el('b', {}, f.facility_name), el('div', { class: 'muted small' }, f.location)), el('td', {}, f.type_name), el('td', {}, f.capacity || '-'),
      el('td', {}, el('span', { class: `badge ${f.status === 'Active' ? '' : 'off'}` }, f.status)), el('td', { class: 'mono' }, f.thing_name || '-'),
      el('td', {}, el('div', { class: 'row' }, el('button', { class: 'ghost sm', type: 'button', onclick: () => facilityForm(f) }, 'Edit'),
        el('button', { class: 'danger sm', type: 'button', onclick: async () => { if (!confirm(`Delete ${f.facility_name}?`)) return; try { toast((await api(`/facilities/${f.facility_id}`, { method: 'DELETE' })).message, 'good'); load(); } catch (e) { fail(e); } } }, 'Delete'))))) : [el('tr', {}, el('td', { colspan: 6, class: 'muted' }, 'No facilities found.'))]));
  };
  function facilityForm(f) {
    const err = el('div', { class: 'err', hidden: true });
    const form = el('form', { style: 'display:grid;gap:14px' },
      el('label', {}, 'Facility name', el('input', { name: 'facility_name', required: true, minlength: 3, maxlength: 100, value: f ? f.facility_name : '' })),
      el('label', {}, 'Type', el('select', { name: 'type_id' }, ...types.map((t) => el('option', { value: t.type_id, selected: f && f.type_id === t.type_id }, t.type_name)))),
      el('label', {}, 'Location', el('input', { name: 'location', required: true, maxlength: 150, value: f ? f.location : '' })),
      el('div', { class: 'row' }, el('label', { class: 'grow' }, 'Capacity', el('input', { name: 'capacity', type: 'number', min: 1, max: 200, value: f && f.capacity ? f.capacity : '' })),
        el('label', { class: 'grow' }, 'Status', el('select', { name: 'status' }, ...['Active', 'Inactive'].map((s) => el('option', { selected: f && f.status === s }, s))))),
      el('label', {}, 'Photo', el('input', { name: 'photo', type: 'file', accept: 'image/jpeg,image/png,image/webp' }), el('span', { class: 'field-note' }, 'JPEG, PNG or WebP, up to 2 MB. Stored privately in Amazon S3.')),
      err, el('button', { class: 'primary', type: 'submit' }, f ? 'Save changes' : 'Add facility'));
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); err.hidden = true;
      const fd = new FormData(form); const body = Object.fromEntries(fd); const photo = fd.get('photo'); delete body.photo;
      try {
        const id = f ? f.facility_id : (await api('/facilities', { method: 'POST', body })).facility_id;
        if (f) await api(`/facilities/${id}`, { method: 'PUT', body });
        if (photo && photo.size) { const pf = new FormData(); pf.append('photo', photo); await api(`/facilities/${id}/photo`, { method: 'POST', form: pf }); }
        dlg.close(); toast('Facility saved', 'good'); load();
      } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    });
    openDialog(f ? 'Edit facility' : 'Add facility', form);
  }
  main.replaceChildren(
    el('div', { class: 'head' }, el('div', {}, el('h1', {}, 'Facilities'), el('p', {}, 'Add, edit, search and remove courts. A court with booking history is set to Inactive instead of deleted.')), el('button', { class: 'primary', type: 'button', onclick: () => facilityForm(null) }, 'Add facility')),
    el('div', { class: 'filters' }, el('input', { type: 'search', placeholder: 'Search name or location', oninput: debounce((e) => { q.text = e.target.value.trim(); load().catch(fail); }) }),
      el('select', { 'aria-label': 'Status', onchange: (e) => { q.status = e.target.value; load().catch(fail); } }, el('option', { value: '' }, 'All statuses'), el('option', {}, 'Active'), el('option', {}, 'Inactive'))),
    el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, ...['Facility', 'Type', 'Capacity', 'Status', 'Device', ''].map((h) => el('th', {}, h)))), tbody)));
  await load();
}

/* ---------- admin: reports ---------- */
async function adminReports(main) {
  const r = { from: addDays(-29), to: addDays(0) }; const out = el('div');
  const draw = async () => {
    const qs = new URLSearchParams(r); const d = await api(`/reports/overview?${qs}`); const s = d.summary;
    state.charts.forEach((c) => c.destroy()); state.charts = [];
    const kpi = (v, t) => el('div', { class: 'card kpi' }, el('b', {}, v), el('span', {}, t));
    const chart = (title, id) => el('div', { class: 'card' }, el('h3', {}, title), el('div', { class: 'chart-box' }, el('canvas', { id, role: 'img', 'aria-label': title })));
    const e = s.energy;
    out.replaceChildren(
      el('div', { class: 'kpis' }, kpi(s.bookings.total, 'Bookings made'), kpi(`${s.utilization_pct}%`, 'Slots in use'), kpi(`${s.cancellation_rate_pct}%`, 'Cancellation rate'), kpi(s.active_users, 'Active students'), kpi(s.avg_bookings_per_day, 'Bookings per day')),
      el('section', { class: 'card sdg' }, el('h2', {}, 'Energy and climate: SDG 7 and SDG 13'),
        el('p', {}, 'Lights only run for booked slots, so courts are not left lit all evening. This estimate compares automated hours with lights that stay on for the whole opening time.'),
        el('div', { class: 'sdg-nums' }, ...[[`${e.hours_saved} h`, 'Lighting hours saved'], [`${e.kwh_saved} kWh`, 'Electricity saved'], [`${e.co2_kg_avoided} kg`, 'CO2 avoided'], [`RM ${e.rm_saved.toFixed(2)}`, 'Cost saved']].map(([v, t]) => el('div', {}, el('b', {}, v), el('span', {}, t)))),
        el('p', { class: 'small' }, `Assumptions: ${e.assumptions.lightKw} kW per court, ${e.assumptions.gridEf_kg_per_kwh} kg CO2 per kWh, RM ${e.assumptions.tariff_rm_per_kwh} per kWh, open ${e.assumptions.open} to ${e.assumptions.close}. Edit them in the server settings.`)),
      el('div', { class: 'charts' }, chart('Bookings per day', 'c-day'), chart('Usage by facility', 'c-fac'), chart('Busiest hours', 'c-hour'), chart('Busiest weekdays', 'c-dow'), chart('Booking status', 'c-status')),
      el('div', { class: 'charts' },
        el('div', { class: 'card' }, el('h3', {}, 'Top students'), table(['Student', 'Bookings', 'Cancelled'], d.top_users.map((u) => [`${u.full_name} (${u.student_id})`, u.bookings, `${u.cancelled} (${u.cancel_pct}%)`]))),
        el('div', { class: 'card' }, el('h3', {}, 'Facility ranking and busiest slot'), table(['Rank', 'Facility', 'Used', 'Use %', 'Peak'],
          d.by_facility.map((f) => { const p = d.peak_slots.find((x) => x.facility_name === f.facility_name); return [f.usage_rank, f.facility_name, f.used_slots, `${f.utilization_pct}%`, p ? `${p.start_time} (${p.bookings})` : '-']; })),
        d.unused_facilities.length ? el('p', { class: 'small muted', style: 'margin-top:10px' }, `No bookings in this period: ${d.unused_facilities.join(', ')}`) : null)));
    const mk = (id, type, labels, data, label, colors) => state.charts.push(new Chart($(`#${id}`), { type, data: { labels, datasets: [{ label, data, backgroundColor: colors || '#0e9f6e', borderColor: '#0e9f6e', tension: 0.3 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: type === 'doughnut' } }, scales: type === 'doughnut' ? {} : { y: { beginAtZero: true, ticks: { precision: 0 } } } } }));
    mk('c-day', 'line', d.by_day.map((x) => x.day.slice(5)), d.by_day.map((x) => x.bookings), 'Bookings');
    mk('c-fac', 'bar', d.by_facility.map((x) => x.facility_name), d.by_facility.map((x) => x.used_slots), 'Slots used');
    mk('c-hour', 'bar', d.by_hour.map((x) => `${String(x.hour).padStart(2, '0')}:00`), d.by_hour.map((x) => x.bookings), 'Bookings', '#12293f');
    mk('c-dow', 'bar', d.by_weekday.map((x) => x.day_name), d.by_weekday.map((x) => x.bookings), 'Bookings', '#f5a524');
    mk('c-status', 'doughnut', ['Confirmed', 'Completed', 'Cancelled'], [s.bookings.confirmed, s.bookings.completed, s.bookings.cancelled], 'Bookings', ['#0e9f6e', '#3b82c4', '#c4cdd2']);
  };
  const table = (heads, rows) => el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, ...heads.map((h) => el('th', {}, h)))),
    el('tbody', {}, ...(rows.length ? rows.map((r2) => el('tr', {}, ...r2.map((c) => el('td', {}, c)))) : [el('tr', {}, el('td', { colspan: heads.length, class: 'muted' }, 'No data in this period.'))]))));
  const from = el('input', { type: 'date', value: r.from, 'aria-label': 'From' }); const to = el('input', { type: 'date', value: r.to, 'aria-label': 'To' });
  const apply = () => { r.from = from.value; r.to = to.value; draw().catch(fail); };
  main.replaceChildren(
    el('div', { class: 'head' }, el('div', {}, el('h1', {}, 'Reports'), el('p', {}, 'Booking frequency, usage statistics and energy saved by the lighting automation.'))),
    el('div', { class: 'filters' }, el('label', { class: 'row' }, 'From', from), el('label', { class: 'row' }, 'To', to), el('button', { class: 'primary', type: 'button', onclick: apply }, 'Update report'),
      el('a', { class: 'btn ghost', style: 'color:var(--ink);border:1px solid var(--line);background:transparent', href: '#', onclick: (e) => { e.preventDefault(); window.location = `/api/reports/export.csv?from=${from.value}&to=${to.value}`; } }, 'Download CSV')), out);
  await draw();
}

/* ---------- admin: devices ---------- */
async function adminDevices(main) {
  const grid = el('div', { class: 'grid' }); const feed = el('div', { class: 'feed' }); const mode = el('span', { class: 'badge blue' });
  const load = async () => {
    const [d, f] = await Promise.all([api('/devices'), api('/devices/feed')]);
    mode.textContent = d.mode === 'aws' ? 'Connected to AWS IoT Core' : 'Simulation mode';
    grid.replaceChildren(...d.devices.map((x) => el('div', { class: 'card', style: 'display:grid;gap:10px' },
      el('div', { class: 'row' }, el('span', { class: `lamp big ${x.light_state === 'ON' ? 'on' : ''}`, role: 'img', 'aria-label': `Lights ${x.light_state}` }),
        el('div', { class: 'grow' }, el('h3', {}, x.facility_name), el('span', { class: 'mono muted' }, x.thing_name))),
      el('div', { class: 'row' }, el('span', { class: `badge ${x.status === 'Online' ? '' : 'red'}` }, x.status), el('span', { class: 'badge off' }, `Lights ${x.light_state}`), el('span', { class: 'small muted' }, x.last_seen ? `seen ${x.seconds_since_seen}s ago` : 'never seen')),
      el('div', { class: 'row' }, el('button', { class: 'warn sm', type: 'button', onclick: () => send(x, 'ON') }, 'Override ON'), el('button', { class: 'ghost sm', type: 'button', onclick: () => send(x, 'OFF') }, 'Override OFF'),
        el('button', { class: 'ghost sm', type: 'button', onclick: async () => { if (confirm(`Remove ${x.thing_name}?`)) { try { await api(`/devices/${x.device_id}`, { method: 'DELETE' }); load(); } catch (e) { fail(e); } } } }, 'Remove')))));
    feed.replaceChildren(...(f.length ? f.map((x) => el('div', {}, el('span', { class: 't' }, x.at.slice(11, 19)), ' ', el('span', { class: x.kind === 'command' ? 'cmd' : '' }, x.thing_name), ' ', el('span', { class: /Failed|Offline/.test(x.detail) ? 'bad' : '' }, x.detail))) : [el('div', { class: 't' }, 'Waiting for the first command or heartbeat...')]));
  };
  const send = async (x, command) => { try { toast((await api(`/devices/${x.device_id}/command`, { method: 'POST', body: { command } })).message, 'good'); setTimeout(() => load().catch(() => {}), 900); } catch (e) { fail(e); } };
  async function addDevice() {
    const fac = await api('/facilities'); const err = el('div', { class: 'err', hidden: true });
    const form = el('form', { style: 'display:grid;gap:14px' }, el('label', {}, 'Facility', el('select', { name: 'facility_id' }, ...fac.filter((x) => !x.thing_name).map((x) => el('option', { value: x.facility_id }, x.facility_name)))),
      el('label', {}, 'AWS IoT Thing name', el('input', { name: 'thing_name', required: true, minlength: 3, placeholder: 'RELAY_05', class: 'mono' })), err, el('button', { class: 'primary', type: 'submit' }, 'Register device'));
    form.addEventListener('submit', async (e) => { e.preventDefault(); try { await api('/devices', { method: 'POST', body: Object.fromEntries(new FormData(form)) }); dlg.close(); load(); } catch (ex) { err.textContent = ex.message; err.hidden = false; } });
    openDialog('Register a lighting device', form);
  }
  main.replaceChildren(el('div', { class: 'head' }, el('div', {}, el('h1', {}, 'Lighting devices'), el('p', {}, 'ESP32 controllers switch the court lights through a relay. Status refreshes every 5 seconds.')), el('div', { class: 'row' }, mode, el('button', { class: 'primary', type: 'button', onclick: addDevice }, 'Add device'))),
    grid, el('h2', { style: 'margin:22px 0 10px' }, 'Message feed'), feed);
  await load(); state.timers.push(setInterval(() => load().catch(() => {}), 5000));
}

/* ---------- admin: users + audit ---------- */
async function adminUsers(main) {
  const tbody = el('tbody'); let text = '';
  const resetPw = async (u) => {
    if (!confirm(`Create a temporary password for ${u.full_name}? Their old password stops working.`)) return;
    try {
      const r = await api(`/admin/users/${u.user_id}/reset-password`, { method: 'POST' });
      const copy = el('button', { class: 'ghost sm', type: 'button', onclick: () => { navigator.clipboard && navigator.clipboard.writeText(r.temporary_password); toast('Copied'); } }, 'Copy');
      openDialog('Temporary password', [el('p', {}, `Give this to ${u.full_name}. It is shown only once. They should change it in their profile after logging in.`), el('div', { class: 'row' }, el('code', { class: 'mono big-code' }, r.temporary_password), copy)],
        [el('button', { class: 'primary', type: 'button', onclick: () => dlg.close() }, 'Done')]);
    } catch (e) { fail(e); }
  };
  const load = async () => {
    const rows = await api(`/admin/users?q=${encodeURIComponent(text)}`);
    tbody.replaceChildren(...rows.map((u) => el('tr', {}, el('td', {}, el('b', {}, u.full_name), el('div', { class: 'muted small' }, u.email)), el('td', { class: 'mono' }, u.student_id), el('td', {}, u.role_name),
      el('td', {}, el('span', { class: `badge ${u.status === 'Active' ? '' : 'off'}` }, u.status)), el('td', {}, u.telegram_linked ? 'Linked' : '-'),
      el('td', {}, u.user_id === state.user.user_id ? '' : el('div', { class: 'row' },
        el('button', { class: 'ghost sm', type: 'button', onclick: async () => { try { await api(`/admin/users/${u.user_id}`, { method: 'PATCH', body: { status: u.status === 'Active' ? 'Inactive' : 'Active' } }); load(); } catch (e) { fail(e); } } }, u.status === 'Active' ? 'Deactivate' : 'Activate'),
        el('button', { class: 'ghost sm', type: 'button', onclick: () => resetPw(u) }, 'Reset password'))))));
  };
  main.replaceChildren(el('div', { class: 'head' }, el('div', {}, el('h1', {}, 'Users'), el('p', {}, 'Deactivated accounts lose access immediately. Reset a password for a student who forgot it.'))),
    el('div', { class: 'filters' }, el('input', { type: 'search', placeholder: 'Search name, ID or email', oninput: debounce((e) => { text = e.target.value.trim(); load().catch(fail); }) })),
    el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, ...['Student', 'ID', 'Role', 'Status', 'Telegram', ''].map((h) => el('th', {}, h)))), tbody)));
  await load();
}
async function adminAudit(main) {
  const tbody = el('tbody'); let text = '';
  const load = async () => {
    const rows = await api(`/admin/audit?limit=150&q=${encodeURIComponent(text)}`);
    tbody.replaceChildren(...rows.map((a) => el('tr', {}, el('td', { class: 'mono' }, a.created_at), el('td', {}, a.full_name || 'System'), el('td', {}, el('span', { class: `badge ${/FAIL/.test(a.action) ? 'red' : 'blue'}` }, a.action)), el('td', {}, a.entity ? `${a.entity} #${a.entity_id ?? ''}` : '-'), el('td', { class: 'mono' }, a.ip_address || '-'))));
  };
  main.replaceChildren(el('div', { class: 'head' }, el('div', {}, el('h1', {}, 'Audit log'), el('p', {}, 'Logins, bookings, facility changes and light commands are recorded here.'))),
    el('div', { class: 'filters' }, el('input', { type: 'search', placeholder: 'Search action, name or IP', oninput: debounce((e) => { text = e.target.value.trim(); load().catch(fail); }) })),
    el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, ...['Time', 'Who', 'Action', 'Record', 'IP address'].map((h) => el('th', {}, h)))), tbody)));
  await load();
}

/* ---------- admin: all bookings (search, cancel, delete) ---------- */
async function adminBookings(main) {
  const q = { text: '', status: '', from: '', to: '' }; const tbody = el('tbody');
  const load = async () => {
    const qs = new URLSearchParams({ all: '1' }); for (const k of ['status', 'from', 'to']) if (q[k]) qs.set(k, q[k]); if (q.text) qs.set('q', q.text);
    const rows = await api(`/bookings?${qs}`);
    tbody.replaceChildren(...(rows.length ? rows.map((b) => el('tr', {}, el('td', { class: 'mono' }, `#${b.booking_id}`), el('td', {}, el('b', {}, b.full_name), el('div', { class: 'muted small' }, b.student_id)), el('td', {}, b.facility_name),
      el('td', {}, `${b.booking_date} ${b.start_time}-${b.end_time}`), el('td', {}, el('span', { class: `badge ${STATUS_CLASS[b.status]}` }, b.status)),
      el('td', {}, el('div', { class: 'row' },
        b.status === 'Confirmed' ? el('button', { class: 'ghost sm', type: 'button', onclick: async () => { if (!confirm('Cancel this booking?')) return; try { await api(`/bookings/${b.booking_id}/cancel`, { method: 'PATCH' }); load(); } catch (e) { fail(e); } } }, 'Cancel') : null,
        b.status !== 'Confirmed' ? el('button', { class: 'danger sm', type: 'button', onclick: async () => { if (!confirm('Delete this record?')) return; try { await api(`/bookings/${b.booking_id}`, { method: 'DELETE' }); load(); } catch (e) { fail(e); } } }, 'Delete') : null)))) : [el('tr', {}, el('td', { colspan: 6, class: 'muted' }, 'No bookings match.'))]));
  };
  const date = (k, label) => el('label', { class: 'row' }, label, el('input', { type: 'date', onchange: (e) => { q[k] = e.target.value; load().catch(fail); } }));
  main.replaceChildren(el('div', { class: 'head' }, el('div', {}, el('h1', {}, 'All bookings'), el('p', {}, 'Search every booking by student, court, status or date.'))),
    el('div', { class: 'filters' }, el('input', { type: 'search', placeholder: 'Search student or court', oninput: debounce((e) => { q.text = e.target.value.trim(); load().catch(fail); }) }),
      el('select', { 'aria-label': 'Status', onchange: (e) => { q.status = e.target.value; load().catch(fail); } }, el('option', { value: '' }, 'All statuses'), ...['Confirmed', 'Completed', 'Cancelled'].map((s) => el('option', {}, s))), date('from', 'From'), date('to', 'To')),
    el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, ...['Ref', 'Student', 'Court', 'Slot', 'Status', ''].map((h) => el('th', {}, h)))), tbody)));
  await load();
}

/* ---------- admin: monitoring ---------- */
async function adminMonitor(main) {
  const cards = el('div', { class: 'kpis' }); const signals = el('div', { class: 'kpis' }); const tbody = el('tbody');
  const canvas = el('canvas', { role: 'img', 'aria-label': 'Requests and errors per minute' }); let chart = null;
  const card = (v, t, bad) => el('div', { class: `card kpi ${bad ? 'bad' : ''}` }, el('b', {}, v), el('span', {}, t));
  const load = async () => {
    const d = await api('/admin/monitor'); const s = d.server; const t = d.traffic; const c = d.counts || {};
    cards.replaceChildren(
      card(s.instanceId || s.hostname, `Server that answered${s.az ? ` (${s.az})` : ' (refresh to see another one)'}`),
      card(d.database.ok ? `OK, ${d.database.latency_ms} ms` : 'DOWN', 'Database', !d.database.ok),
      card(`${d.iot.online ?? '-'} / ${d.iot.total ?? '-'}`, `Lighting devices online (${d.iot.mode})`),
      card(d.telegram.ok ? `@${d.telegram.username}` : d.telegram.configured ? 'Problem' : 'Not set up', d.telegram.ok ? 'Telegram bot' : `Telegram bot${d.telegram.error ? `: ${d.telegram.error}` : ''}`, !d.telegram.ok),
      card(d.storage.ok ? `OK (${d.storage.mode})` : `Problem (${d.storage.mode})`, 'File storage', !d.storage.ok),
      card(`${s.memory_mb} MB`, `Memory, CPU load ${s.load_1m}`),
      card(d.scheduler.lastTick ? `${d.scheduler.lastMs} ms` : 'waiting', d.scheduler.lastError ? `Light scheduler: ${d.scheduler.lastError}` : 'Light scheduler last run', !!d.scheduler.lastError),
      card(`${Math.floor(t.uptime_sec / 60)} min`, 'This server has been running'));
    const last = t.series.reduce((a, x) => ({ r: a.r + x.requests, e: a.e + x.errors, c: a.c + x.client_errors }), { r: 0, e: 0, c: 0 });
    signals.replaceChildren(card(last.r, 'Requests, last 30 minutes'), card(last.e, 'Server errors (5xx)', last.e > 0), card(`${t.avg_ms_window} ms`, 'Average response time'),
      card(c.failed_logins_1h ?? '-', 'Failed logins, last hour', (c.failed_logins_1h || 0) >= 5), card(c.failed_commands_24h ?? '-', 'Failed light commands, 24 h', (c.failed_commands_24h || 0) > 0),
      card(c.bookings_today ?? '-', 'Bookings today'), card(c.users ?? '-', 'Registered users'));
    if (!chart) chart = (state.charts[state.charts.push(new Chart(canvas, { data: { labels: [], datasets: [
      { type: 'line', label: 'Requests per minute', data: [], borderColor: '#0e9f6e', backgroundColor: '#0e9f6e22', fill: true, tension: 0.3 },
      { type: 'bar', label: 'Server errors', data: [], backgroundColor: '#cf3b3b' }] },
      options: { responsive: true, maintainAspectRatio: false, animation: false, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } } })) - 1]);
    chart.data.labels = t.series.map((x) => x.minute); chart.data.datasets[0].data = t.series.map((x) => x.requests); chart.data.datasets[1].data = t.series.map((x) => x.errors); chart.update();
    tbody.replaceChildren(...(t.recent_errors.length ? t.recent_errors.map((e) => el('tr', {}, el('td', { class: 'mono' }, e.at.slice(11, 19)), el('td', { class: 'mono' }, e.path), el('td', {}, e.msg))) : [el('tr', {}, el('td', { colspan: 3, class: 'muted' }, 'No server errors since this server started.'))]));
  };
  main.replaceChildren(el('div', { class: 'head' }, el('div', {}, el('h1', {}, 'Monitoring'), el('p', {}, 'Live health of this web server, the database, storage, Telegram and the lighting devices. Refreshes every 5 seconds. CloudWatch keeps the long-term history on AWS.'))),
    cards, el('h2', { style: 'margin:6px 0 12px' }, 'Traffic and security signals'), signals, el('div', { class: 'card', style: 'margin-bottom:18px' }, el('h3', {}, 'Requests per minute (last 30 minutes)'), el('div', { class: 'chart-box' }, canvas)),
    el('h2', { style: 'margin:6px 0 12px' }, 'Recent server errors'), el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, ...['Time', 'Path', 'Message'].map((h) => el('th', {}, h)))), tbody)));
  await load(); state.timers.push(setInterval(() => load().catch(() => {}), 5000));
}

/* ---------- router ---------- */
const ROUTES = { '#/': facilitiesView, '#/profile': profileView, '#/admin/monitor': adminMonitor, '#/bookings': bookingsView, '#/admin/facilities': adminFacilities, '#/admin/bookings': adminBookings, '#/admin/reports': adminReports,
  '#/admin/devices': adminDevices, '#/admin/users': adminUsers, '#/admin/audit': adminAudit };
async function route() {
  clearTimers(); renderChrome();
  const main = $('#main'); const h = location.hash || '#/'; const view = ROUTES[h] || facilitiesView;
  if (h.startsWith('#/admin') && !isAdmin()) { main.replaceChildren(el('div', { class: 'empty' }, el('h2', {}, 'Admin area'), el('p', { style: 'margin:6px 0 14px' }, 'Log in with an administrator account to open this page.'), el('button', { class: 'primary', type: 'button', onclick: () => authDialog() }, 'Log in'))); return; }
  try { await view(main); } catch (e) { main.replaceChildren(el('div', { class: 'err' }, e.message)); }
}
window.addEventListener('hashchange', route);
(async function init() {
  try { state.cfg = await api('/config'); } catch (_) { /* defaults */ }
  try { state.user = (await api('/auth/me')).user; } catch (_) { state.user = null; }
  route();
})();
