/* หน้า LIFF ของ Asthma Smart Kid (ระบบเตือนทานยาผ่าน LINE) — single page app, ไม่มี build step
 * หน้า: ?page=today | meds | appt | history | invite | join&code=XXXX | videos | qa
 * ทุกคำขอไป Apps Script แนบ LINE ID token (Api.gs ตรวจกับ LINE)
 */
(function () {
  'use strict';
  var CFG = window.APP_CONFIG || {};
  var $view = document.getElementById('view');
  var $tabs = document.getElementById('tabs');
  var $select = document.getElementById('patientSelect');
  var $toast = document.getElementById('toast');
  var $dialog = document.getElementById('dialog');

  var state = { me: null, patientId: null, page: 'today', params: {} };

  var OPEN = ['PENDING', 'SENT', 'RESENT', 'ESCALATED'];
  var STATUS = {
    PENDING: ['รอเวลา', ''], SENT: ['ถึงเวลาแล้ว', 'warn'], RESENT: ['ถึงเวลาแล้ว', 'warn'],
    ESCALATED: ['แจ้งผู้ดูแลแล้ว', 'bad'], TAKEN: ['ทานแล้ว', 'ok'], TAKEN_LATE: ['ทานแล้ว (ช้า)', 'ok'],
    SKIPPED: ['ข้าม', ''], MISSED: ['ไม่มีการยืนยัน', 'bad']
  };
  var CONFIRM_MSG = {
    taken: 'บันทึกแล้ว', taken_late: 'บันทึกแล้ว (ยืนยันช้า)', skipped: 'บันทึกการข้ามแล้ว',
    already_taken: 'บันทึกว่าทานแล้วก่อนหน้านี้', already_skipped: 'บันทึกว่าข้ามไว้ก่อนหน้านี้',
    expired: 'หมดเวลายืนยันแล้ว', too_early: 'ยังไม่ถึงเวลาทานยามื้อนี้ (กดได้ก่อนเวลา 1 ชั่วโมง)',
    undone: 'ยกเลิกการบันทึกแล้ว', not_undoable: 'รายการนี้ยังไม่ได้บันทึก',
    closed: 'มื้อนี้ปิดแล้ว (ยาถูกลบจากตาราง หรือพักการแจ้งเตือน)',
    forbidden: 'ไม่มีสิทธิ์ยืนยันยานี้', not_found: 'ไม่พบรายการยานี้'
  };
  var SKIP_REASONS = ['หมอสั่งงด', 'คลื่นไส้/ผลข้างเคียง', 'ยาหมด', 'อื่น ๆ'];
  var MEALS = [['breakfast', 'อาหารเช้า'], ['lunch', 'อาหารกลางวัน'], ['dinner', 'อาหารเย็น']];
  var DOW = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];
  var TYPES = [['FIXED', 'ตั้งเวลาเอง'], ['MEAL', 'ตามมื้ออาหาร'], ['INTERVAL', 'ทุกกี่ชั่วโมง'], ['PRN', 'เมื่อมีอาการ']];
  // ปุ่มลัดตามคำบนฉลากยาที่พบบ่อย — กดปุ่มเดียวแทนการตั้งค่าเอง (ผู้สูงอายุไม่ต้องเข้าใจ "รูปแบบเวลา")
  var PRESETS = [
    ['หลังอาหาร เช้า', 'breakfast:after'],
    ['หลังอาหาร เช้า-เย็น', 'breakfast:after,dinner:after'],
    ['หลังอาหาร เช้า-กลางวัน-เย็น', 'breakfast:after,lunch:after,dinner:after'],
    ['ก่อนอาหาร เช้า', 'breakfast:before'],
    ['ก่อนอาหาร เช้า-เย็น', 'breakfast:before,dinner:before'],
    ['ก่อนนอน', 'bedtime']
  ];
  // ยาสูดพ่น: เวลาตามมื้ออาหารที่ตั้งไว้ (เช้า = เวลาอาหารเช้า, เย็น = เวลาอาหารเย็น) ไม่เลื่อนก่อน/หลังอาหาร
  var INHALER_PRESETS = [['เช้า', 'breakfast'], ['เช้า-เย็น', 'breakfast,dinner'], ['ก่อนนอน', 'bedtime']];
  function isInh(m) { return String(m && m.kind || '').toUpperCase() === 'INHALER'; }
  function verbOf(m) { return isInh(m) ? 'พ่น' : 'ทาน'; }

  /* ───────────── utils ───────────── */

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function html(strings) { // template helper: html`...${x}...` — ค่าที่แทรกถูก escape ยกเว้นห่อด้วย raw()
    var out = strings[0];
    for (var i = 1; i < arguments.length; i++) {
      var v = arguments[i];
      out += (v && v.__raw !== undefined ? v.__raw : Array.isArray(v) ? v.map(function (x) { return x && x.__raw !== undefined ? x.__raw : esc(x); }).join('') : esc(v)) + strings[i];
    }
    return raw(out);
  }
  function raw(s) { return { __raw: s, toString: function () { return s; } }; }
  function render(h) { $view.innerHTML = String(h); }

  var toastTimer;
  /** แจ้งเตือนสั้น ๆ ด้านล่าง; action = { label, run } แสดงปุ่ม เช่น "ยกเลิก" (ค้างไว้นานขึ้นให้กดทัน) */
  function toast(msg, action) {
    $toast.innerHTML = '';
    var span = document.createElement('span'); span.textContent = msg; $toast.appendChild(span);
    if (action) {
      var b = document.createElement('button');
      b.className = 'toast-btn'; b.type = 'button'; b.textContent = action.label;
      b.onclick = function () { $toast.hidden = true; action.run(); };
      $toast.appendChild(b);
    }
    $toast.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { $toast.hidden = true; }, action ? 8000 : 5000);
  }

  function store(k, v) {
    try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; }
  }

  function thaiDate(d) {
    return d.toLocaleDateString('th-TH', { weekday: 'long', day: 'numeric', month: 'long' });
  }
  function hm(d) { return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
  /** "วันนี้ 20:00 น." / "พรุ่งนี้ 08:00 น." / "ศ. 7 พ.ย. 08:00 น." */
  function whenText(iso) {
    var d = new Date(iso), n = new Date();
    var days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(n.getFullYear(), n.getMonth(), n.getDate())) / 86400000);
    var day = days === 0 ? 'วันนี้' : days === 1 ? 'พรุ่งนี้' : d.toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric', month: 'short' });
    return day + ' ' + hm(d) + ' น.';
  }
  /** บอกผู้ใช้ว่าระบบจะเตือนยานี้ครั้งถัดไปเมื่อไร (ให้มั่นใจว่าตั้งถูก) */
  function nextLine(m) {
    if (String(m.schedule_type).toUpperCase() === 'PRN') return 'ยานี้ไม่มีการเตือน กด “บันทึกว่า' + verbOf(m) + '” ในหน้ายาวันนี้เมื่อ' + verbOf(m);
    return m.next_at ? 'เตือนครั้งถัดไป ' + whenText(m.next_at) : 'ยานี้จะไม่มีการเตือนอีก (ตรวจวันที่สิ้นสุด)';
  }
  function ymdLocal(d) { return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function badge(status) { var s = STATUS[status] || [status, '']; return html`<span class="badge ${s[1]}">${s[0]}</span>`; }

  /* ───────────── API ───────────── */

  function api(action, body) {
    var payload = Object.assign({}, body || {}, { action: action, idToken: liff.getIDToken() });
    // ไม่ตั้ง Content-Type → เป็น text/plain → ไม่มี CORS preflight (Apps Script ไม่รองรับ OPTIONS)
    return fetch(CFG.API_URL, { method: 'POST', body: JSON.stringify(payload) })
      .catch(function () { throw new Error('เชื่อมต่อไม่ได้ ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่'); })
      .then(function (r) {
        return r.json().catch(function () { throw new Error('ระบบตอบกลับผิดปกติ (ตรวจ API_URL ใน config.js หรือการ Deploy)'); });
      })
      .then(function (j) {
        if (j.ok) return j.data;
        if (/เซสชันหมดอายุ|เข้าสู่ระบบ/.test(j.error)) refreshSession();
        throw new Error(j.error);
      });
  }

  /** token หมดอายุ (เปิดหน้าทิ้งไว้นาน): โหลดหน้าใหม่ 1 ครั้งเพื่อขอ token ใหม่ ไม่ให้ผู้ใช้ต้องทำเอง */
  function refreshSession() {
    var last = +(sessionStorage.getItem('reloadedAt') || 0);
    if (Date.now() - last < 60000) return;            // กันวนโหลดซ้ำ
    try { sessionStorage.setItem('reloadedAt', String(Date.now())); } catch (e) { return; }
    if (liff.isInClient()) location.reload();
    else { liff.logout(); liff.login({ redirectUri: location.href }); }
  }

  function fail(err) {
    render(html`<div class="card"><h2>เกิดข้อผิดพลาด</h2><p class="err">${err.message || err}</p>
      <button class="btn secondary" data-act="reload">ลองใหม่</button></div>`);
  }

  /* ───────────── routing ───────────── */

  var PAGES = {
    today: pageToday, meds: pageMeds, history: pageHistory, invite: pageInvite,
    join: pageJoin, videos: pageVideos, qa: pageQa, register: pageRegister, appt: pageAppt
  };
  var NEED_PATIENT = ['today', 'meds', 'history', 'invite', 'appt'];

  function go(page, params) {
    state.page = PAGES[page] ? page : 'today';
    state.params = params || {};
    var url = new URL(location.href);
    url.searchParams.set('page', state.page);
    if (state.page !== 'join') url.searchParams.delete('code');
    history.replaceState(null, '', url);
    Array.prototype.forEach.call($tabs.querySelectorAll('a'), function (a) {
      a.classList.toggle('active', a.dataset.page === state.page);
      if (a.dataset.page === state.page) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    window.scrollTo(0, 0);
    if (NEED_PATIENT.indexOf(state.page) >= 0 && !state.patientId) return pageRegister({});
    render('<div class="loading">กำลังโหลด…</div>');
    Promise.resolve().then(function () { return PAGES[state.page](state.params); }).catch(fail);
  }

  function currentPatient() {
    return (state.me.patients || []).filter(function (p) { return p.patient_id === state.patientId; })[0] || null;
  }

  function loadMe() {
    return api('me').then(function (me) {
      state.me = me;
      var ids = me.patients.map(function (p) { return p.patient_id; });
      var saved = store('patientId');
      if (ids.indexOf(state.patientId) < 0) state.patientId = ids.indexOf(saved) >= 0 ? saved : (me.patient ? me.patient.patient_id : ids[0] || null);
      $select.hidden = me.patients.length < 2;
      $select.innerHTML = me.patients.map(function (p) {
        return '<option value="' + esc(p.patient_id) + '"' + (p.patient_id === state.patientId ? ' selected' : '') + '>' +
          esc(p.name) + ({ self: ' (ตัวเอง)', proxy: ' (ดูแลแทน)' }[p.relation] || '') + '</option>';
      }).join('');
      return me;
    });
  }

  /* ───────────── หน้า: ลงทะเบียน ───────────── */

  function mealInputs(p) {
    p = p || {};
    var def = { breakfast: '07:00', lunch: '12:00', dinner: '18:00', bedtime: '21:00' };
    return html`<div class="grid2">
      ${[['breakfast', 'อาหารเช้า'], ['lunch', 'อาหารกลางวัน'], ['dinner', 'อาหารเย็น'], ['bedtime', 'เข้านอน']].map(function (m) {
        return html`<label class="field">${m[1]}<input type="time" name="${m[0]}" value="${p[m[0]] || def[m[0]]}" required></label>`;
      })}
    </div>`;
  }

  /**
   * ลงทะเบียน 2 แบบ
   *   self  = ฉันเป็นผู้ป่วย รับข้อความเตือนใน LINE ของตัวเอง
   *   proxy = ลงทะเบียนแทนผู้ป่วยที่ใช้ LINE ไม่ได้ ข้อความเตือนทุกมื้อส่งมาที่ LINE ของผู้ลงทะเบียน
   */
  function pageRegister(params) {
    params = params || {};
    var hasSelf = !!(state.me && state.me.patient);
    var mode = hasSelf ? 'proxy' : (params.mode === 'proxy' ? 'proxy' : 'self');
    var myName = (state.profile && state.profile.displayName) || '';
    render(html`
      <div class="card">
        <h1>${hasSelf ? 'ลงทะเบียนแทนผู้ป่วย' : 'เริ่มใช้งาน'}</h1>
        <p class="sub">ถ้าคุณเป็นผู้ดูแลของผู้ป่วยที่ใช้ LINE เองอยู่แล้ว ไม่ต้องลงทะเบียน ให้เปิดลิงก์เชิญที่ผู้ป่วยส่งมา</p>
      </div>
      <form class="card" id="regForm" novalidate>
        ${hasSelf ? '' : html`<fieldset class="who"><legend>ใครจะเป็นคนรับข้อความเตือน</legend>
          <label class="who-opt"><input type="radio" name="mode" value="self" ${raw(mode === 'self' ? 'checked' : '')}>
            <span><b>ฉันเป็นผู้ป่วย</b><span class="note">รับข้อความเตือนใน LINE ของฉันเอง</span></span></label>
          <label class="who-opt"><input type="radio" name="mode" value="proxy" ${raw(mode === 'proxy' ? 'checked' : '')}>
            <span><b>ลงทะเบียนแทนผู้ป่วย</b><span class="note">ผู้ป่วยใช้ LINE ไม่ได้ ข้อความเตือนทุกมื้อจะส่งมาที่ LINE ของฉัน</span></span></label>
        </fieldset>`}
        <p class="preview" id="proxyInfo">คุณจะเป็น <b>ผู้ดูแลแทนผู้ป่วย</b>: ได้รับข้อความเตือนทุกมื้อแทนผู้ป่วย กด “ทานแล้ว” เมื่อผู้ป่วยทานยา และเชิญผู้ดูแลคนอื่นมาช่วยได้</p>
        <label class="field"><span id="nameLabel">ชื่อที่ใช้แสดง</span><input type="text" name="name" maxlength="60" required></label>
        <div><h3 id="mealHead">เวลามื้ออาหารปกติ</h3><p class="note">ใช้คำนวณเวลายาก่อน/หลังอาหาร</p></div>
        ${mealInputs()}
        <p class="err" id="regErr" hidden></p>
        <button class="btn" type="submit">ลงทะเบียน</button>
      </form>`);
    var form = $view.querySelector('#regForm'), nameEl = form.elements.name;
    var sync = function () {
      var m = hasSelf ? 'proxy' : form.querySelector('input[name=mode]:checked').value;
      form.querySelector('#proxyInfo').hidden = m !== 'proxy';
      form.querySelector('#nameLabel').textContent = m === 'proxy' ? 'ชื่อผู้ป่วย' : 'ชื่อที่ใช้แสดง';
      form.querySelector('#mealHead').textContent = m === 'proxy' ? 'เวลามื้ออาหารปกติของผู้ป่วย' : 'เวลามื้ออาหารปกติ';
      nameEl.placeholder = m === 'proxy' ? 'เช่น คุณยายบุญมา' : '';
      // ชื่อ LINE ของเราเองใช้เป็นชื่อผู้ป่วยไม่ได้ → ล้างให้ ป้องกันลงทะเบียนผู้ป่วยด้วยชื่อตัวเองโดยไม่ตั้งใจ
      if (m === 'proxy' && nameEl.value === myName) nameEl.value = '';
      if (m === 'self' && !nameEl.value) nameEl.value = myName;
      return m;
    };
    if (mode === 'self') nameEl.value = myName;
    sync();
    form.addEventListener('change', function (e) { if (e.target.name === 'mode') sync(); });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var m = sync(), f = formData(form), btn = form.querySelector('button[type=submit]'), $err = form.querySelector('#regErr');
      delete f.mode;
      if (!f.name) { $err.textContent = m === 'proxy' ? 'กรุณาใส่ชื่อผู้ป่วย' : 'กรุณาใส่ชื่อ'; $err.hidden = false; return; }
      $err.hidden = true; btn.disabled = true;
      var friend = liff.getFriendship ? liff.getFriendship().catch(function () { return { friendFlag: true }; }) : Promise.resolve({ friendFlag: true });
      friend.then(function (fr) {
        return api('registerPatient', Object.assign(f, { forOther: m === 'proxy', displayName: myName, isFriend: !!fr.friendFlag }))
          .then(function (p) {
            state.patientId = p.patient_id; store('patientId', p.patient_id);
            return loadMe().then(function () {
              if (!fr.friendFlag) return askAddFriend(m === 'proxy' ? p.name : '');
              toast(m === 'proxy' ? 'ลงทะเบียนแทน ' + p.name + ' แล้ว เพิ่มยาตัวแรกได้เลย' : 'ลงทะเบียนเรียบร้อย เพิ่มยาตัวแรกได้เลย');
              go('meds');
            });
          });
      }).catch(function (err) { btn.disabled = false; $err.textContent = err.message; $err.hidden = false; });
    });
  }

  /** ยังไม่ได้เพิ่มเพื่อน OA = จะไม่ได้รับข้อความเตือน → บอกให้เพิ่มก่อน (ผิดพลาดที่พบบ่อยที่สุดของผู้ใช้ใหม่) */
  function askAddFriend(patientName) {
    var oa = (state.me && state.me.oaBasicId) || CFG.OA_BASIC_ID;
    render(html`<div class="card">
      <h1>ลงทะเบียนแล้ว</h1>
      <div class="card soft"><p><b>สำคัญ:</b> เพิ่มเพื่อนบัญชี LINE นี้ก่อน ไม่อย่างนั้นจะไม่ได้รับข้อความเตือน${patientName ? 'ยาของ ' + patientName : ''}</p>
        <a class="btn" href="https://line.me/R/ti/p/${encodeURIComponent(oa)}">เพิ่มเพื่อน</a></div>
      <button class="btn secondary" data-go="meds">ไปเพิ่มยา</button>
    </div>`);
  }

  function formData(form) {
    var o = {};
    new FormData(form).forEach(function (v, k) { o[k] = typeof v === 'string' ? v.trim() : v; });
    return o;
  }

  /* ───────────── หน้า: ยาวันนี้ ───────────── */

  function pageToday() {
    var p = currentPatient();
    return api('today', { patientId: state.patientId }).then(function (d) {
      // มื้อของเมื่อวานที่ยังกดได้ (เช่น ยาก่อนนอนหลังเที่ยงคืน) แยกกลุ่ม "เมื่อวาน" ไม่ปนกับเวลาเดียวกันของวันนี้
      var groups = {}, order = [];
      d.doses.forEach(function (x) {
        var k = (x.yesterday ? 'เมื่อวาน ' : '') + x.time;
        if (!groups[k]) { groups[k] = []; order.push(k); }
        groups[k].push(x);
      });
      var scheduled = d.doses.filter(function (x) { return !x.is_prn && !x.yesterday; });
      var done = scheduled.filter(function (x) { return OPEN.indexOf(x.status) < 0; }).length;
      var rel = p ? p.relation : 'self';

      render(html`
        <div class="page-head"><div><h1>ยาวันนี้</h1><p class="sub">${p ? p.name + ' · ' : ''}${thaiDate(new Date())}</p></div>
          ${scheduled.length ? html`<span class="badge ok">เสร็จแล้ว ${done}/${scheduled.length}</span>` : ''}</div>
        ${rel === 'proxy' && p.proxyMode ? html`<p class="note">คุณรับข้อความเตือนแทน ${p.name} · กด “ทานแล้ว” เมื่อผู้ป่วยทานยาแล้ว</p>`
          : rel !== 'self' ? html`<p class="note">คุณกำลังดูแทน ${p.name} · การกดจะบันทึกว่าผู้ดูแลยืนยันแทน</p>` : ''}
        ${d.appt ? apptBanner(d.appt) : ''}
        ${d.doses.length ? '' : html`<div class="card soft"><p>วันนี้ไม่มียาที่ต้องทานตามเวลา</p><button class="btn ghost" data-go="meds">ไปที่ตารางยา</button></div>`}
        ${order.map(function (t) {
          return html`<section class="slot"><div class="slot-time">${t} น.</div>
            ${groups[t].map(function (x) {
              var open = OPEN.indexOf(x.status) >= 0;
              return html`<div class="dose">
                <div class="dose-top"><div><div class="dose-name">${x.name}</div><div class="dose-meta">${x.is_prn ? verbOf(x) + 'เมื่อมีอาการ' : x.dose_text || ''}${x.skip_reason ? ' · ข้าม: ' + x.skip_reason : ''}</div></div>${x.is_prn ? html`<span class="badge ok">บันทึกแล้ว</span>` : badge(x.status)}</div>
                ${open && x.can_confirm ? html`<div class="row"><button class="btn" data-take="${x.dose_id}">${verbOf(x)}แล้ว</button><button class="btn secondary" data-skip="${x.dose_id}">ข้าม</button></div>` : ''}
                ${open && !x.can_confirm && x.status === 'PENDING' ? html`<p class="note">กดยืนยันได้ตั้งแต่ ${x.confirm_from} น.</p>` : ''}
                ${x.can_undo ? html`<button class="btn ghost small undo" data-undo="${x.dose_id}">↩ ยกเลิก (กดผิด)</button>` : ''}
              </div>`;
            })}
          </section>`;
        })}
        ${d.prn.length ? html`<section class="card"><h2>ยาใช้เมื่อมีอาการ</h2>
          ${d.prn.map(function (m) {
            return html`<div class="dose-top"><div><div class="dose-name">${m.name}</div><div class="dose-meta">${m.dose_text || ''}${m.prn_max_per_day ? ' · ไม่เกิน ' + m.prn_max_per_day + ' ครั้ง/วัน' : ''}</div></div>
              <button class="btn small" data-prn="${m.med_id}">บันทึกว่า${verbOf(m)}</button></div>`;
          })}</section>` : ''}
        <p class="note" style="text-align:center">${state.me.patient ? '' : html`ต้องการรับการเตือนยาของตัวเองด้วย? <a href="#" data-go="register" data-mode="self">ลงทะเบียนเป็นผู้ป่วย</a><br>`}
          ดูแลผู้ป่วยที่ใช้ LINE ไม่ได้? <a href="#" data-go="register" data-mode="proxy">ลงทะเบียนแทนผู้ป่วย</a></p>`);
    });
  }

  function confirmDose(doseId, kind, reason) {
    return api('confirm', { doseId: doseId, kind: kind, reason: reason }).then(function (res) {
      var r = res[0] || {};
      toast(CONFIRM_MSG[r.code] || 'บันทึกแล้ว', r.ok ? { label: 'ยกเลิก', run: function () { undoDose(doseId); } } : null);
      return pageToday();
    }).catch(function (e) { toast(e.message); return pageToday(); });
  }

  function undoDose(doseId) {
    return api('undo', { doseId: doseId }).then(function (res) {
      var r = res[0] || {};
      toast(r.ok ? 'ยกเลิกการบันทึกแล้ว' : (CONFIRM_MSG[r.code] || 'ยกเลิกไม่ได้'));
      return state.page === 'today' ? pageToday() : null;
    }).catch(function (e) { toast(e.message); });
  }

  function askSkip(doseId) {
    $dialog.innerHTML = String(html`<h2>เหตุผลที่ข้ามยามื้อนี้</h2>
      <div class="dialog-actions">${SKIP_REASONS.map(function (r, i) { return html`<button class="btn secondary" data-reason="${i}">${r}</button>`; })}
      <button class="btn ghost" data-reason="cancel">ยกเลิก</button></div>`);
    $dialog.onclick = function (e) {
      var b = e.target.closest('[data-reason]'); if (!b) return;
      $dialog.close();
      if (b.dataset.reason !== 'cancel') confirmDose(doseId, 'skip', +b.dataset.reason);
    };
    $dialog.showModal();
  }

  /* ───────────── หน้า: ตารางยา ───────────── */

  function describe(m) {
    var t = String(m.schedule_type).toUpperCase(), s, inh = isInh(m);
    if (t === 'FIXED') s = 'เวลา ' + String(m.times).split(',').map(function (x) { return x.trim(); }).join(', ') + ' น.';
    else if (t === 'MEAL' && inh) s = 'พ่น ' + String(m.meals).split(',').filter(Boolean).map(function (tok) {
      return { breakfast: 'เช้า', lunch: 'กลางวัน', dinner: 'เย็น', bedtime: 'ก่อนนอน' }[tok.trim().split(':')[0]] || tok;
    }).join('-');
    else if (t === 'MEAL') s = String(m.meals).split(',').filter(Boolean).map(function (tok) {
      var p = tok.trim().split(':'), name = { breakfast: 'อาหารเช้า', lunch: 'อาหารกลางวัน', dinner: 'อาหารเย็น' }[p[0]];
      if (p[0] === 'bedtime') return 'ก่อนนอน';
      return ({ before: 'ก่อน', after: 'หลัง' }[p[1]] || 'พร้อม') + name;
    }).join(', ');
    else if (t === 'INTERVAL') s = 'ทุก ' + m.interval_hours + ' ชั่วโมง เริ่ม ' + (m.interval_start || '00:00') + ' น.';
    else s = (inh ? 'พ่น' : 'กิน') + 'เมื่อมีอาการ' + (m.prn_max_per_day ? ' (ไม่เกิน ' + m.prn_max_per_day + ' ครั้ง/วัน)' : '');
    if (inh) s = 'ยาสูดพ่น · ' + s;
    var dow = String(m.days_of_week || '').trim();
    if (dow) s += ' · เฉพาะวัน ' + dow.split(',').map(function (d) { return DOW[+d]; }).join(' ');
    if (m.end_date) s += ' · ถึง ' + m.end_date;
    return s;
  }

  function pageMeds() {
    var p = currentPatient();
    return api('listMeds', { patientId: state.patientId }).then(function (meds) {
      state.meds = meds;
      render(html`
        <div class="page-head"><div><h1>ตารางยา</h1><p class="sub">${p ? p.name : ''} · ${meds.length} รายการ</p></div>
          <button class="btn" data-act="addMed">+ เพิ่มยา</button></div>
        ${meds.length ? '' : html`<div class="card soft"><p>ยังไม่มียา กด “เพิ่มยา” เพื่อเริ่ม</p></div>`}
        ${meds.map(function (m) {
          var stock = m.stock_qty !== '' && m.stock_qty !== null && m.stock_qty !== undefined;
          return html`<div class="card">
            <div class="dose-top"><div><div class="dose-name">${m.name}</div><div class="dose-meta">${m.dose_text || ''}</div></div>
              ${stock ? html`<span class="badge ${+m.stock_qty <= 5 ? 'warn' : ''}">เหลือ ${m.stock_qty}</span>` : ''}</div>
            <p>${describe(m)}</p>
            <p class="next ${m.next_at || String(m.schedule_type).toUpperCase() === 'PRN' ? '' : 'err'}">⏰ ${nextLine(m)}</p>
            ${m.note ? html`<p class="note">${m.note}</p>` : ''}
            <div class="row"><button class="btn secondary small" data-edit="${m.med_id}">แก้ไข</button><button class="btn danger small" data-del="${m.med_id}">ลบ</button></div>
          </div>`;
        })}
        <section class="card soft appt-entry">
          <div class="dose-top"><div><h2>🏥 นัดพบแพทย์</h2><p class="note">ใส่วันนัดจากใบนัด ระบบเตือนเย็นวันก่อนนัดและเช้าวันนัด</p></div>
            <button class="btn small" data-go="appt">จัดการนัด</button></div>
        </section>
        <form class="card soft" id="mealForm">
          <h2>เวลามื้ออาหาร</h2>
          <p class="note">ยาที่ตั้งเป็นก่อนอาหารจะเตือนก่อน 30 นาที หลังอาหารเตือนหลัง 15 นาที</p>
          ${mealInputs(p)}
          <button class="btn ghost" type="submit">บันทึกเวลามื้ออาหาร</button>
        </form>`);
      $view.querySelector('#mealForm').addEventListener('submit', function (e) {
        e.preventDefault();
        api('updatePatient', Object.assign({ patientId: state.patientId }, formData(e.target)))
          .then(loadMe).then(function () { toast('บันทึกเวลามื้ออาหารแล้ว'); })
          .catch(function (err) { toast(err.message); });
      });
    });
  }

  function medForm(m) {
    m = m || { schedule_type: 'FIXED', times: '08:00', units_per_dose: 1 };
    var type = String(m.schedule_type || 'FIXED').toUpperCase();
    var times = String(m.times || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (!times.length) times = ['08:00'];
    var meals = {};
    String(m.meals || '').split(',').filter(Boolean).forEach(function (tok) { var p = tok.trim().split(':'); meals[p[0]] = p[1] || 'with'; });
    var dows = String(m.days_of_week || '').split(',').filter(function (s) { return s.trim() !== ''; }).map(Number);

    var hasExtra = !!(m.note || dows.length || m.start_date || m.end_date || (m.stock_qty !== '' && m.stock_qty !== undefined && m.stock_qty !== null));

    render(html`
      <div class="page-head"><h1>${m.med_id ? 'แก้ไขยา' : 'เพิ่มยา'}</h1><button class="btn ghost small" data-go="meds">ยกเลิก</button></div>
      <form class="card" id="medForm" novalidate>
        <label class="field"><span><b>1.</b> ชื่อยา</span><input type="text" name="name" maxlength="80" required value="${m.name || ''}" placeholder="ดูจากซองยา เช่น Amlodipine 5mg"></label>
        <label class="field" id="doseTextField">ครั้งละ<span class="hint">ไม่บังคับ</span><input type="text" name="dose_text" maxlength="40" value="${isInh(m) ? '' : m.dose_text || ''}" placeholder="เช่น 1 เม็ด"></label>

        <fieldset class="who"><legend><b>2.</b> เวลารับประทานยา <span class="note">(กดตามที่เขียนบนซองยา)</span></legend>
          <div class="presets">${PRESETS.map(function (x) { return html`<button type="button" class="preset" data-preset="${x[1]}">${x[0]}</button>`; })}</div>
          <span class="note">ไม่ตรงกับปุ่มด้านบน? เลือกแบบอื่น:</span>
          <div class="seg">${TYPES.map(function (t) { return html`<label><input type="radio" name="schedule_type" value="${t[0]}" ${raw(t[0] === type ? 'checked' : '')}>${t[1]}</label>`; })}</div>
        </fieldset>

        <fieldset class="who" id="inhalerBox"><legend><b>3.</b> ยาสูดพ่น <span class="note">(ถ้าเป็นยาพ่น กรอกข้อนี้แทนข้อ 2)</span></legend>
          <label class="field">ครั้งละ<span class="puff"><input type="number" name="puffs" min="1" max="20" step="1" inputmode="numeric" value="${isInh(m) ? m.units_per_dose || '' : ''}" placeholder="เช่น 2" aria-label="จำนวน puff ต่อครั้ง"><span>puff</span></span></label>
          <span style="font-weight:600">เวลาพ่นยา</span>
          <div class="presets">${INHALER_PRESETS.map(function (x) { return html`<button type="button" class="preset" data-ipreset="${x[1]}">${x[0]}</button>`; })}</div>
          <span class="note">เช้า เย็น และก่อนนอน ใช้เวลามื้ออาหารที่ตั้งไว้ในหน้าตารางยา · ยาพ่นเมื่อมีอาการ: กรอกจำนวน puff แล้วเลือก “เมื่อมีอาการ” ในข้อ 2</span>
        </fieldset>

        <div data-type="FIXED" class="times" id="timeList">
          ${times.map(timeRow)}
          <button type="button" class="btn ghost small" data-act="addTime">+ เพิ่มเวลา</button>
        </div>

        <div data-type="MEAL" id="mealBox" style="display:flex;flex-direction:column;gap:10px">
          ${MEALS.map(function (x) {
            var on = meals[x[0]];
            return html`<div class="meal-row"><label class="chip"><input type="checkbox" name="meal_${x[0]}" ${raw(on ? 'checked' : '')}>${x[1]}</label>
              <select class="input" name="when_${x[0]}" aria-label="ช่วงเวลา${x[1]}">
                ${[['before', 'ก่อนอาหาร 30 นาที'], ['after', 'หลังอาหาร'], ['with', 'พร้อมอาหาร']].map(function (w) {
                  return html`<option value="${w[0]}" ${raw((on || 'after') === w[0] ? 'selected' : '')}>${w[1]}</option>`;
                })}
              </select></div>`;
          })}
          <label class="chip"><input type="checkbox" name="meal_bedtime" ${raw(meals.bedtime ? 'checked' : '')}>ก่อนนอน</label>
        </div>

        <div data-type="INTERVAL" class="grid2">
          <label class="field">ทุกกี่ชั่วโมง<input type="number" name="interval_hours" min="1" max="24" inputmode="numeric" value="${m.interval_hours || 6}"></label>
          <label class="field">เริ่มเวลา<input type="time" name="interval_start" value="${m.interval_start || '06:00'}"></label>
        </div>

        <div data-type="PRN">
          <label class="field">ไม่เกินกี่ครั้งต่อวัน<span class="hint">เว้นว่าง = ไม่จำกัด</span><input type="number" name="prn_max_per_day" min="1" max="24" inputmode="numeric" value="${m.prn_max_per_day || ''}"></label>
        </div>

        <details class="more" ${raw(hasExtra ? 'open' : '')}>
          <summary><span>ตัวเลือกเพิ่มเติม (ไม่บังคับ)<small>หมายเหตุ · เฉพาะบางวัน · นับยาคงเหลือ</small></span></summary>
          <div style="display:flex;flex-direction:column;gap:14px;margin-top:10px">
            <label class="field">หมายเหตุ<input type="text" name="note" maxlength="80" value="${m.note || ''}" placeholder="เช่น ห้ามเคี้ยว"></label>
            <div data-notprn style="display:flex;flex-direction:column;gap:8px">
              <span style="font-weight:600">วันที่ต้องทาน</span><span class="note">ไม่เลือกเลย = ทุกวัน</span>
              <div class="chips">${DOW.map(function (d, i) { return html`<label class="chip"><input type="checkbox" name="dow" value="${i}" ${raw(dows.indexOf(i) >= 0 ? 'checked' : '')}>${d}</label>`; })}</div>
              <div class="grid2">
                <label class="field">เริ่มวันที่<input type="date" name="start_date" value="${m.start_date || ''}"></label>
                <label class="field">ถึงวันที่<input type="date" name="end_date" value="${m.end_date || ''}"></label>
              </div>
            </div>
            <div style="display:flex;flex-direction:column;gap:8px">
              <span style="font-weight:600">นับยาคงเหลือ</span><span class="note">กรอกจำนวนยาที่มี ระบบจะเตือนก่อนยาหมด</span>
              <div class="grid2">
                <label class="field">ยาคงเหลือ<input type="number" name="stock_qty" min="0" inputmode="numeric" value="${m.stock_qty === undefined ? '' : m.stock_qty}"></label>
                <label class="field" id="unitsField">ใช้ต่อครั้ง<input type="number" name="units_per_dose" min="0.5" step="0.5" inputmode="decimal" value="${m.units_per_dose || 1}"></label>
                <label class="field">เตือนเมื่อเหลือ (วัน)<input type="number" name="low_stock_days" min="0" inputmode="numeric" value="${m.low_stock_days || ''}" placeholder="3"></label>
              </div>
            </div>
          </div>
        </details>

        <div class="preview" id="preview" aria-live="polite"></div>
        <p class="err" id="formErr" hidden></p>
        <button class="btn" type="submit">บันทึก</button>
      </form>`);

    var form = $view.querySelector('#medForm');
    form.dataset.kind = isInh(m) ? 'INHALER' : '';
    var sync = function () {
      var t = form.querySelector('input[name=schedule_type]:checked').value, inh = form.dataset.kind === 'INHALER';
      form.querySelectorAll('[data-type]').forEach(function (el) { el.hidden = el.dataset.type !== t; });
      form.querySelector('[data-notprn]').hidden = t === 'PRN';
      // ยาสูดพ่น: จำนวนต่อครั้งอยู่ในข้อ 3 และเวลาเช้า/เย็นไม่มีก่อน/หลังอาหาร จึงซ่อนช่องที่ซ้ำกัน
      form.querySelector('#doseTextField').hidden = inh;
      form.querySelector('#unitsField').hidden = inh;
      if (inh) form.querySelector('#mealBox').hidden = true;
      form.querySelector('#inhalerBox').classList.toggle('on', inh);
      // ไฮไลต์ปุ่มลัดที่ตรงกับค่าปัจจุบัน (ข้อ 2 = ยากิน, ข้อ 3 = ยาพ่น)
      var cur = t === 'MEAL' ? collectMed(form, m.med_id).meals : '';
      form.querySelectorAll('[data-preset]').forEach(function (b) { var on = !inh && b.dataset.preset === cur; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
      form.querySelectorAll('[data-ipreset]').forEach(function (b) { var on = inh && b.dataset.ipreset === cur; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
    };
    var setKind = function (k) {
      form.dataset.kind = k;
      if (!k) form.elements.puffs.value = '';
    };
    var applyPreset = function (meals) {
      form.querySelector('input[name=schedule_type][value=MEAL]').checked = true;
      var want = {};
      meals.split(',').forEach(function (tok) { var q = tok.split(':'); want[q[0]] = q[1] || 'with'; });
      MEALS.forEach(function (x) {
        form.elements['meal_' + x[0]].checked = !!want[x[0]];
        if (want[x[0]]) form.elements['when_' + x[0]].value = want[x[0]];
      });
      form.elements.meal_bedtime.checked = !!want.bedtime;
      form.querySelector('#formErr').hidden = true;
      sync(); showPreview();
    };
    var showPreview = function () {
      var med = collectMed(form, m.med_id), times = previewTimes(med, currentPatient() || {});
      var dows = med.days_of_week ? 'เฉพาะวัน ' + med.days_of_week.split(',').map(function (d) { return DOW[+d]; }).join(' ') : 'ทุกวัน';
      var range = (med.start_date ? ' ตั้งแต่ ' + med.start_date : '') + (med.end_date ? ' ถึง ' + med.end_date : '');
      var today = ymdLocal(new Date());
      var close = closeTimes(times);
      var warn = med.end_date && med.end_date < today ? 'วันสิ้นสุดผ่านไปแล้ว ยานี้จะไม่มีการเตือนอีก'
        : med.start_date && med.end_date && med.end_date < med.start_date ? 'วันสิ้นสุดอยู่ก่อนวันเริ่ม'
        : med.start_date > today ? 'เริ่มเตือนวันที่ ' + med.start_date + ' (วันนี้ยังไม่เตือน)'
        : close ? 'เวลา ' + close + ' ห่างกันไม่ถึง 1 ชั่วโมง ตรวจว่าตรงกับซองยา'
        : times.length > 6 ? 'เตือนบ่อยมาก (วันละ ' + times.length + ' ครั้ง) ข้อความฟรีของ LINE (300 ข้อความ/เดือน) อาจหมดเร็ว' : '';
      form.querySelector('#preview').innerHTML = String(med.schedule_type === 'PRN'
        ? html`<b>ไม่มีการเตือน</b> · กด “บันทึกว่า${verbOf(med)}” ในหน้ายาวันนี้ทุกครั้งที่${verbOf(med)}`
        : times.length ? html`<b>ระบบจะเตือนเวลา</b> ${times.join(', ')} น. · ${dows}${range}<br><span class="note">วันละ ${times.length} ครั้ง</span>${warn ? html`<br><b class="err">⚠ ${warn}</b>` : ''}`
        : html`<b>ยังไม่มีเวลาเตือน</b> · กรอกข้อมูลด้านบนให้ครบ`);
    };
    form.addEventListener('change', function (e) {
      form.querySelector('#formErr').hidden = true;
      sync(); showPreview();
    });
    form.addEventListener('input', function (e) {
      form.querySelector('#formErr').hidden = true;
      if (e.target.name === 'puffs' && e.target.value !== '' && form.dataset.kind !== 'INHALER') { setKind('INHALER'); sync(); }
      showPreview();
    });
    form.addEventListener('click', function (e) {
      var pr = e.target.closest('[data-preset]');
      if (pr) { setKind(''); return applyPreset(pr.dataset.preset); }
      var ip = e.target.closest('[data-ipreset]');
      if (ip) {
        setKind('INHALER'); applyPreset(ip.dataset.ipreset);
        if (!form.elements.puffs.value) form.elements.puffs.focus();
        return;
      }
      if (e.target.closest('[data-act=addTime],[data-act=rmTime]')) setTimeout(showPreview, 0);
    });
    sync(); showPreview();
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var med = collectMed(form, m.med_id), $err = form.querySelector('#formErr');
      var msg = validateMed(med);
      if (msg) { $err.textContent = msg; $err.hidden = false; return; }
      $err.hidden = true;
      var btn = form.querySelector('button[type=submit]'); btn.disabled = true;
      api('saveMed', { patientId: state.patientId, med: med }).then(function (saved) { toast('บันทึกยาแล้ว · ' + nextLine(saved)); go('meds'); })
        .catch(function (err) { btn.disabled = false; $err.textContent = err.message; $err.hidden = false; });
    });
  }

  /** เวลาที่เสนอเมื่อกด "+ เพิ่มเวลา": มีเวลาเดียว → อีก 12 ชม. (เช้า-เย็น), มีหลายเวลา → ช่องที่ห่างที่สุด */
  function suggestTime() {
    var toMin = function (s) { var x = String(s).match(/^(\d{2}):(\d{2})$/); return x ? +x[1] * 60 + +x[2] : null; };
    var mins = Array.prototype.map.call($view.querySelectorAll('input[name=time]'), function (i) { return toMin(i.value); })
      .filter(function (v) { return v !== null; }).sort(function (a, b) { return a - b; });
    var pick;
    if (!mins.length) pick = 8 * 60;
    else if (mins.length === 1) pick = (mins[0] + 720) % 1440;
    else {
      var best = -1;
      mins.forEach(function (v, i) {
        var next = i + 1 < mins.length ? mins[i + 1] : mins[0] + 1440, gap = next - v;
        if (gap > best) { best = gap; pick = (v + Math.floor(gap / 2 / 30) * 30) % 1440; }
      });
    }
    return ('0' + Math.floor(pick / 60)).slice(-2) + ':' + ('0' + pick % 60).slice(-2);
  }

  function timeRow(t) {
    return html`<div class="time-row"><input type="time" name="time" value="${t}" aria-label="เวลา"><button type="button" class="btn secondary small" data-act="rmTime" aria-label="ลบเวลา">ลบ</button></div>`;
  }

  function collectMed(form, medId) {
    var t = form.querySelector('input[name=schedule_type]:checked').value;
    var val = function (n) { var el = form.elements[n]; return el ? String(el.value).trim() : ''; };
    var num = function (n) { var v = val(n); return v === '' ? '' : Number(v); };
    var med = {
      name: val('name'), dose_text: val('dose_text'), note: val('note'), schedule_type: t,
      times: '', meals: '', interval_hours: '', interval_start: '', prn_max_per_day: '',
      days_of_week: '', start_date: '', end_date: '',
      stock_qty: num('stock_qty'), units_per_dose: num('units_per_dose') || 1, low_stock_days: num('low_stock_days'),
      kind: form.dataset.kind === 'INHALER' ? 'INHALER' : ''
    };
    if (med.kind) {   // ยาสูดพ่น: "ครั้งละ N puff" นับยาคงเหลือเป็น puff และเวลาเช้า/เย็นไม่มีก่อน/หลังอาหาร
      med.puffs = num('puffs');
      med.dose_text = med.puffs ? med.puffs + ' puff' : '';
      med.units_per_dose = med.puffs || 1;
    }
    if (medId) med.med_id = medId;
    if (t === 'FIXED') {
      var ts = Array.prototype.map.call(form.querySelectorAll('input[name=time]'), function (i) { return i.value; }).filter(Boolean);
      med.times = ts.filter(function (x, i) { return ts.indexOf(x) === i; }).sort().join(',');
    }
    if (t === 'MEAL') {
      var parts = MEALS.filter(function (x) { return form.elements['meal_' + x[0]].checked; })
        .map(function (x) { return x[0] + ':' + form.elements['when_' + x[0]].value; });
      if (form.elements.meal_bedtime.checked) parts.push('bedtime');
      med.meals = parts.join(',');
      if (med.kind) med.meals = med.meals.replace(/:with/g, '');   // ยาพ่น: ตรงเวลามื้อ ไม่มีก่อน/หลังอาหาร
    }
    if (t === 'INTERVAL') { med.interval_hours = num('interval_hours'); med.interval_start = val('interval_start'); }
    if (t === 'PRN') med.prn_max_per_day = num('prn_max_per_day');
    if (t !== 'PRN') {
      med.days_of_week = Array.prototype.filter.call(form.querySelectorAll('input[name=dow]'), function (i) { return i.checked; })
        .map(function (i) { return i.value; }).join(',');
      if (med.days_of_week.split(',').length === 7) med.days_of_week = '';
      med.start_date = val('start_date'); med.end_date = val('end_date');
    }
    return med;
  }

  /** คำนวณเวลาเตือนแบบเดียวกับ Schedule.gs เพื่อแสดงตัวอย่างก่อนบันทึก */
  function previewTimes(m, p) {
    var toMin = function (s) { var x = String(s || '').match(/^(\d{1,2}):(\d{2})$/); return x ? +x[1] * 60 + +x[2] : null; };
    var mins = [], def = { breakfast: '07:00', lunch: '12:00', dinner: '18:00', bedtime: '21:00' };
    if (m.schedule_type === 'FIXED') String(m.times).split(',').forEach(function (t) { var v = toMin(t); if (v !== null) mins.push(v); });
    if (m.schedule_type === 'MEAL') String(m.meals).split(',').filter(Boolean).forEach(function (tok) {
      var q = tok.split(':'), base = toMin(p[q[0]] || def[q[0]]);
      if (base === null) return;
      mins.push((base + (q[1] === 'before' ? -30 : q[1] === 'after' ? 15 : 0) + 1440) % 1440);
    });
    if (m.schedule_type === 'INTERVAL') {
      var a = toMin(m.interval_start || '00:00'), n = +m.interval_hours;
      if (a !== null && n >= 1 && n <= 24) for (var k = 0; k * n < 24; k++) mins.push((a + k * n * 60) % 1440);
    }
    mins.sort(function (x, y) { return x - y; });
    return mins.filter(function (v, i) { return i === 0 || v !== mins[i - 1]; })
      .map(function (v) { return ('0' + Math.floor(v / 60)).slice(-2) + ':' + ('0' + v % 60).slice(-2); });
  }

  /** เวลาเตือน 2 เวลาที่ห่างกันไม่ถึง 1 ชั่วโมง (มักเกิดจากตั้งผิด เช่น หลังอาหารเย็น 20:45 กับก่อนนอน 21:00) */
  function closeTimes(times) {
    var toMin = function (s) { return +s.slice(0, 2) * 60 + +s.slice(3, 5); };
    for (var i = 1; i < times.length; i++) {
      if (toMin(times[i]) - toMin(times[i - 1]) < 60) return times[i - 1] + ' กับ ' + times[i];
    }
    return '';
  }

  function validateMed(m) {
    if (!m.name) return 'กรุณาระบุชื่อยา';
    if (m.kind === 'INHALER' && !(m.puffs >= 1 && m.puffs <= 20 && m.puffs === Math.floor(m.puffs))) return 'ยาสูดพ่น: กรอกจำนวน puff ต่อครั้ง (1–20)';
    if (m.schedule_type === 'FIXED' && !m.times) return 'กรุณาระบุเวลาอย่างน้อย 1 เวลา';
    if (m.schedule_type === 'MEAL' && !m.meals) return 'กรุณาเลือกมื้ออาหารอย่างน้อย 1 มื้อ';
    if (m.schedule_type === 'INTERVAL' && !(m.interval_hours >= 1 && m.interval_hours <= 24)) return 'ช่วงเวลาต้องอยู่ระหว่าง 1–24 ชั่วโมง';
    if (m.start_date && m.end_date && m.end_date < m.start_date) return 'วันสิ้นสุดต้องไม่ก่อนวันเริ่ม';
    return '';
  }

  function askDelete(medId) {
    var m = (state.meds || []).filter(function (x) { return x.med_id === medId; })[0] || {};
    $dialog.innerHTML = String(html`<h2>ลบ ${m.name}?</h2><p class="note">ระบบจะหยุดเตือนยานี้ทันที รวมถึงมื้อที่กำลังเตือนอยู่ ประวัติเดิมยังอยู่ครบ</p>
      <div class="dialog-actions"><button class="btn danger" data-yes>ลบยา</button><button class="btn secondary" data-no>ยกเลิก</button></div>`);
    $dialog.onclick = function (e) {
      if (e.target.closest('[data-no]')) return $dialog.close();
      if (!e.target.closest('[data-yes]')) return;
      $dialog.close();
      api('deleteMed', { medId: medId }).then(function () { toast('ลบแล้ว'); go('meds'); }).catch(function (err) { toast(err.message); });
    };
    $dialog.showModal();
  }

  /* ───────────── หน้า: นัดพบแพทย์ ───────────── */

  function apptWhen(a) {
    return a.days_left === 0 ? 'วันนี้' : a.days_left === 1 ? 'พรุ่งนี้' : a.days_left > 1 ? 'อีก ' + a.days_left + ' วัน' : '';
  }

  /** การ์ดนัดครั้งถัดไปบนหน้า "วันนี้" */
  function apptBanner(a) {
    return html`<div class="card appt-banner">
      <div class="dose-top"><div><div class="dose-name">🏥 นัดพบแพทย์${a.days_left <= 1 ? ' ' + apptWhen(a) : ''}</div>
        <div class="dose-meta">${a.date_text}${a.time ? ' · ' + a.time + ' น.' : ''}${a.place ? ' · ' + a.place : ''}</div></div>
        ${a.days_left > 1 ? html`<span class="badge">${apptWhen(a)}</span>` : html`<span class="badge warn">${apptWhen(a)}</span>`}</div>
      <button class="btn ghost small" data-go="appt">ดูนัดทั้งหมด</button>
    </div>`;
  }

  function apptCard(a, past) {
    var when = apptWhen(a);
    return html`<div class="card appt">
      <div class="dose-top"><div><div class="dose-name">${a.date_text}</div>
        <div class="dose-meta">${a.time ? 'เวลา ' + a.time + ' น.' : 'ไม่ระบุเวลา'}${a.place ? ' · ' + a.place : ''}</div></div>
        ${!past && when ? html`<span class="badge ${a.days_left <= 1 ? 'warn' : ''}">${when}</span>` : ''}</div>
      ${a.note ? html`<p class="note">${a.note}</p>` : ''}
      ${past ? '' : html`<div class="row"><button class="btn secondary small" data-aedit="${a.appt_id}">แก้ไข</button><button class="btn danger small" data-adel="${a.appt_id}">ลบ</button></div>`}
    </div>`;
  }

  function pageAppt(params) {
    var p = currentPatient();
    return api('listAppts', { patientId: state.patientId }).then(function (r) {
      var edit = params && params.edit ? r.upcoming.filter(function (a) { return a.appt_id === params.edit; })[0] : null;
      var today = ymdLocal(new Date());
      render(html`
        <div class="page-head"><div><h1>นัดพบแพทย์</h1><p class="sub">${p ? p.name + ' · ' : ''}${r.upcoming.length ? r.upcoming.length + ' นัดที่จะถึง' : 'ยังไม่มีนัด'}</p></div>
          <button class="btn ghost small" data-go="meds">กลับ</button></div>
        <p class="note">ระบบส่ง LINE เตือนเย็นวันก่อนนัด (${r.remind.eve} น.) และเช้าวันนัด (${r.remind.morning} น.) ถึงคนที่รับข้อความเตือนยา</p>
        <div id="apptList">${r.upcoming.length ? r.upcoming.map(function (a) { return apptCard(a, false); })
          : html`<div class="card soft"><p>ยังไม่มีนัด เพิ่มวันนัดจากใบนัดของโรงพยาบาลได้ด้านล่าง</p></div>`}</div>
        <form class="card" id="apptForm" novalidate>
          <h2>${edit ? 'แก้ไขนัด' : 'เพิ่มนัด'}</h2>
          <div class="grid2">
            <label class="field">วันนัด<input type="date" name="date" required min="${today}" value="${edit ? edit.date : ''}"></label>
            <label class="field">เวลา<span class="hint">ไม่บังคับ</span><input type="time" name="time" value="${edit ? edit.time : ''}"></label>
          </div>
          <label class="field">สถานที่<span class="hint">ไม่บังคับ</span><input type="text" name="place" maxlength="80" value="${edit ? edit.place : ''}" placeholder="เช่น คลินิกโรคหืด โรงพยาบาล…"></label>
          <label class="field">หมายเหตุ<span class="hint">ไม่บังคับ</span><input type="text" name="note" maxlength="120" value="${edit ? edit.note : ''}" placeholder="เช่น นำยาพ่นและสมุดนัดไปด้วย"></label>
          <p class="err" hidden></p>
          <div class="row"><button class="btn" type="submit">${edit ? 'บันทึกการแก้ไข' : 'บันทึกนัด'}</button>
            ${edit ? html`<button class="btn secondary" type="button" data-go="appt">ยกเลิกการแก้ไข</button>` : ''}</div>
        </form>
        ${r.past.length ? html`<details class="more"><summary>นัดที่ผ่านมา (${r.past.length})</summary>
          ${r.past.map(function (a) { return apptCard(a, true); })}</details>` : ''}`);

      var form = $view.querySelector('#apptForm');
      if (edit) form.scrollIntoView();
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var v = formData(form), $err = form.querySelector('.err'), btn = form.querySelector('button[type=submit]');
        var msg = !v.date ? 'กรุณาเลือกวันนัด' : v.date < today ? 'วันนัดผ่านไปแล้ว ตรวจวันที่อีกครั้ง' : '';
        if (msg) { $err.textContent = msg; $err.hidden = false; return; }
        $err.hidden = true; btn.disabled = true;
        if (edit) v.appt_id = edit.appt_id;
        api('saveAppt', { patientId: state.patientId, appt: v }).then(function (a) {
          toast('บันทึกนัดแล้ว · ' + a.date_text + (a.time ? ' ' + a.time + ' น.' : ''));
          go('appt');
        }).catch(function (err) { btn.disabled = false; $err.textContent = err.message; $err.hidden = false; });
      });
      $view.querySelector('#apptList').onclick = function (e) {
        var ed = e.target.closest('[data-aedit]'), del = e.target.closest('[data-adel]');
        if (ed) return go('appt', { edit: ed.dataset.aedit });
        if (!del) return;
        var a = r.upcoming.filter(function (x) { return x.appt_id === del.dataset.adel; })[0] || {};
        $dialog.innerHTML = String(html`<h2>ลบนัด ${a.date_text || ''}?</h2><p class="note">ระบบจะไม่เตือนนัดนี้อีก</p>
          <div class="dialog-actions"><button class="btn danger" data-yes>ลบนัด</button><button class="btn secondary" data-no>ยกเลิก</button></div>`);
        $dialog.onclick = function (ev) {
          if (ev.target.closest('[data-no]')) return $dialog.close();
          if (!ev.target.closest('[data-yes]')) return;
          $dialog.close();
          api('deleteAppt', { apptId: a.appt_id }).then(function () { toast('ลบนัดแล้ว'); go('appt'); }).catch(function (err) { toast(err.message); });
        };
        $dialog.showModal();
      };
    });
  }

  /* ───────────── หน้า: ประวัติ ───────────── */

  function pageHistory(params) {
    var days = params.days || 7;
    return api('history', { patientId: state.patientId, days: days }).then(function (h) {
      var s = h.summary, byDay = {}, order = [];
      h.doses.forEach(function (d) {
        var t = new Date(d.scheduled_at), key = t.toDateString();
        if (!byDay[key]) { byDay[key] = { date: t, items: [] }; order.push(key); }
        byDay[key].items.push(Object.assign({ t: t }, d));
      });
      render(html`
        <div class="page-head"><div><h1>ประวัติการทานยา</h1><p class="sub">${currentPatient() ? currentPatient().name : ''}</p></div>
          <div class="seg" style="grid-template-columns:1fr 1fr;min-width:180px">
            <label><input type="radio" name="days" value="7" ${raw(days === 7 ? 'checked' : '')}>7 วัน</label>
            <label><input type="radio" name="days" value="30" ${raw(days === 30 ? 'checked' : '')}>30 วัน</label></div></div>
        <div class="card">
          <div class="dose-top"><h2>ทานยาแล้ว</h2><b style="font-family:Anuphan,sans-serif;font-size:30px;color:var(--brand)">${s.adherencePct === null ? '–' : s.adherencePct + '%'}</b></div>
          <div class="bar" role="img" aria-label="ทานยาแล้ว ${s.adherencePct || 0}%"><i style="width:${s.adherencePct || 0}%"></i></div>
          <p class="note">ไม่นับมื้อที่ข้าม · ตรงเวลา ${s.onTimePct === null ? '–' : s.onTimePct + '%'}</p>
          <div class="stats">
            <div class="stat"><b>${s.taken}</b><span>ตรงเวลา</span></div>
            <div class="stat"><b>${s.late}</b><span>ยืนยันช้า</span></div>
            <div class="stat"><b>${s.skipped}</b><span>ข้าม</span></div>
            <div class="stat"><b style="color:var(--danger)">${s.missed}</b><span>ไม่มีการยืนยัน</span></div>
          </div>
        </div>
        ${order.length ? '' : html`<div class="empty">ยังไม่มีประวัติ</div>`}
        ${order.map(function (k) {
          var g = byDay[k];
          return html`<section class="card"><div class="day-head">${thaiDate(g.date)}</div>
            ${g.items.map(function (d) {
              return html`<div class="hist"><div><div><b>${hm(d.t)}</b> ${d.name || d.med_id}</div>
                <div class="note">${d.by_caregiver ? 'ผู้ดูแลยืนยันแทน' : ''}${d.skip_reason ? 'ข้าม: ' + d.skip_reason : ''}</div></div>${badge(d.status)}</div>`;
            })}</section>`;
        })}`);
      $view.querySelectorAll('input[name=days]').forEach(function (r) {
        r.addEventListener('change', function () { go('history', { days: +r.value }); });
      });
    });
  }

  /* ───────────── หน้า: ผู้ดูแล ───────────── */

  function pageInvite() {
    var p = currentPatient();
    return api('listCaregivers', { patientId: state.patientId }).then(function (cgs) {
      var canManage = !p || p.canManage;
      // ผู้ดูแลทั่วไปเชิญเองไม่ได้ → บอกว่าให้ใครเป็นคนส่งลิงก์ (ผู้ดูแลแทนผู้ป่วย ถ้ามี ไม่อย่างนั้นคือผู้ป่วย)
      var proxy = cgs.filter(function (c) { return c.role === 'proxy'; })[0];
      var asker = proxy ? proxy.name + ' (ผู้ดูแลแทนผู้ป่วย)' : (p ? p.name : 'ผู้ป่วย');
      render(html`
        <div class="page-head"><div><h1>ผู้ดูแล</h1><p class="sub">${p ? p.name : ''}</p></div></div>
        <div class="card">
          <h2>เชิญผู้ดูแล</h2>
          <p class="sub">ผู้ดูแลจะได้รับแจ้งเมื่อไม่มีการยืนยันการทานยาใน 30 นาที ยืนยันแทน ดูประวัติ และแก้ตารางยาได้</p>
          ${canManage ? html`<div id="inviteBox"><button class="btn" data-act="createInvite">สร้างลิงก์เชิญ</button></div>`
            : html`<p class="preview" id="inviteAsk">อยากให้คนอื่นมาช่วยดูแล? บอก <b>${asker}</b> เป็นคนส่งลิงก์เชิญ</p>`}
        </div>
        <div class="card">
          <h2>ผู้ดูแลตอนนี้ (${cgs.length})</h2>
          ${cgs.length ? '' : html`<p class="note">ยังไม่มีผู้ดูแล</p>`}
          ${cgs.map(function (c) {
            var role = c.role !== 'proxy' ? 'ผู้ดูแล'
              : p && p.proxyMode === false ? 'ผู้ดูแลแทนผู้ป่วย · ตอนนี้ผู้ป่วยรับข้อความเตือนเองแล้ว' : 'ผู้ดูแลแทนผู้ป่วย · รับข้อความเตือนแทน';
            return html`<div class="dose-top"><div><div class="dose-name">${c.name}${c.isSelf ? ' (คุณ)' : ''}</div>
              <div class="note">${role}</div>
              ${c.followed ? '' : html`<div class="note err">ยังไม่ได้เพิ่มเพื่อน OA จึงไม่ได้รับการแจ้งเตือน</div>`}</div>
              ${c.canRemove ? html`<button class="btn danger small" data-rmcg="${c.linkId}" data-name="${c.name}" data-self="${c.isSelf ? '1' : ''}">${c.isSelf ? 'ออกจากการดูแล' : 'นำออก'}</button>` : ''}</div>`;
          })}
          ${canManage ? '' : html`<p class="note">เชิญหรือนำผู้ดูแลคนอื่นออกได้เฉพาะผู้ป่วย ผู้ดูแลแทนผู้ป่วย หรือผู้ดูแลระบบ</p>`}
        </div>`);
    });
  }

  function askRemoveCaregiver(linkId, name, self) {
    var p = currentPatient() || {};
    $dialog.innerHTML = String(self
      ? html`<h2>ออกจากการเป็นผู้ดูแลของ ${p.name}?</h2>
        <p class="note">คุณจะไม่ได้รับแจ้งเตือนและดูข้อมูลยาของ ${p.name} ไม่ได้อีก ถ้าต้องการกลับมา ต้องขอลิงก์เชิญใหม่</p>
        <div class="dialog-actions"><button class="btn danger" data-yes>ออกจากการดูแล</button><button class="btn secondary" data-no>ยกเลิก</button></div>`
      : html`<h2>นำ ${name} ออกจากผู้ดูแล?</h2>
        <p class="note">${name} จะไม่ได้รับแจ้งเตือนและดูข้อมูลยาไม่ได้อีก ถ้าต้องการกลับมา ต้องส่งลิงก์เชิญใหม่</p>
        <div class="dialog-actions"><button class="btn danger" data-yes>นำออก</button><button class="btn secondary" data-no>ยกเลิก</button></div>`);
    $dialog.onclick = function (e) {
      if (e.target.closest('[data-no]')) return $dialog.close();
      if (!e.target.closest('[data-yes]')) return;
      $dialog.close();
      api('removeCaregiver', { linkId: linkId }).then(function (r) {
        if (!r || !r.left) { toast('นำผู้ดูแลออกแล้ว'); return go('invite'); }
        // ออกเองแล้ว → ดูผู้ป่วยคนนี้ไม่ได้อีก โหลดรายชื่อใหม่
        state.patientId = null;
        return loadMe().then(function () { toast('ออกจากการเป็นผู้ดูแลของ ' + p.name + ' แล้ว'); go('today'); });
      }).catch(function (err) { toast(err.message); });
    };
    $dialog.showModal();
  }

  function createInvite() {
    var box = $view.querySelector('#inviteBox');
    box.innerHTML = '<p class="note">กำลังสร้าง…</p>';
    api('createInvite', { patientId: state.patientId }).then(function (inv) {
      state.invite = inv;
      var canShare = liff.isApiAvailable && liff.isApiAvailable('shareTargetPicker');
      box.innerHTML = String(html`
        <p class="note">รหัสเชิญ (ใช้ได้ครั้งเดียว ภายใน ${inv.expiresHours} ชั่วโมง)</p>
        <div class="code">${inv.code}</div>
        <div class="linkbox">${inv.url}</div>
        <div class="row">
          ${canShare ? html`<button class="btn" data-act="shareInvite">ส่งผ่าน LINE</button>` : ''}
          <button class="btn ${canShare ? 'secondary' : ''}" data-act="copyInvite">คัดลอกลิงก์</button>
        </div>`);
    }).catch(function (e) { box.innerHTML = String(html`<p class="err">${e.message}</p>`); });
  }

  function shareInvite() {
    var inv = state.invite;
    liff.shareTargetPicker([{
      type: 'text',
      text: 'ช่วยเป็นผู้ดูแลการทานยาของ ' + inv.patientName + ' หน่อยนะ\nกดลิงก์นี้เพื่อตอบรับ (ใช้ได้ ' + inv.expiresHours + ' ชั่วโมง)\n' + inv.url
    }]).then(function (r) { if (r) toast('ส่งคำเชิญแล้ว'); }).catch(function (e) { toast('ส่งไม่สำเร็จ: ' + e.message); });
  }

  function copyInvite() {
    var url = state.invite.url;
    (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject())
      .then(function () { toast('คัดลอกลิงก์แล้ว'); })
      .catch(function () { toast('คัดลอกไม่ได้ กดค้างที่ลิงก์เพื่อคัดลอก'); });
  }

  function pageJoin(params) {
    var code = params.code || new URL(location.href).searchParams.get('code');
    if (!code) { render(html`<div class="card"><h1>ไม่พบรหัสเชิญ</h1><p class="sub">ขอลิงก์ใหม่จากคนที่ส่งลิงก์ให้</p></div>`); return; }
    var friendship = liff.getFriendship ? liff.getFriendship().catch(function () { return { friendFlag: true }; }) : Promise.resolve({ friendFlag: true });
    return friendship.then(function (f) {
      return api('acceptInvite', { code: code, displayName: state.profile && state.profile.displayName, isFriend: !!f.friendFlag });
    }).then(function (r) {
      state.patientId = r.patientId; store('patientId', r.patientId);
      return Promise.all([loadMe(), liff.getFriendship ? liff.getFriendship().catch(function () { return { friendFlag: true }; }) : { friendFlag: true }])
        .then(function (res) {
          var oa = r.oaBasicId || CFG.OA_BASIC_ID;
          render(html`<div class="card">
            <h1>เป็นผู้ดูแลแล้ว</h1>
            <p>คุณเป็นผู้ดูแลการทานยาของ <b>${r.patientName}</b></p>
            ${res[1].friendFlag ? '' : html`<div class="card soft"><p><b>สำคัญ:</b> เพิ่มเพื่อนบัญชี LINE นี้ก่อน ไม่อย่างนั้นจะไม่ได้รับการแจ้งเตือน</p>
              <a class="btn" href="https://line.me/R/ti/p/${encodeURIComponent(oa)}">เพิ่มเพื่อน</a></div>`}
            <button class="btn ${res[1].friendFlag ? '' : 'secondary'}" data-go="today">ดูยาวันนี้ของ ${r.patientName}</button>
          </div>`);
        });
    }).catch(function (e) {
      render(html`<div class="card"><h1>ตอบรับคำเชิญไม่สำเร็จ</h1><p class="err">${e.message}</p>
        ${state.patientId ? html`<button class="btn secondary" data-go="today">กลับหน้าแรก</button>` : ''}</div>`);
    });
  }

  /* ───────────── หน้า: วิดีโอความรู้ + แบบทดสอบ ───────────── */

  /* ───────────── ถาม-ตอบ ───────────── */

  // ทาน = กิน, ตัดช่องว่าง/เครื่องหมาย — ให้ค้น "ลืมกิน" เจอคำถาม "ลืมทานยา"
  function qaNorm(s) {
    return String(s || '').toLowerCase().replace(/รับประทาน|ทาน/g, 'กิน').replace(/[\s?？!.,，、:;'"“”()\-–—…]/g, '');
  }
  var QA_URGENT = 'ถ้าเด็กมีอาการหายใจเหนื่อย ปีกจมูกบาน อกบุ๋ม ริมฝีปากเขียว ปลายมือปลายเท้าม่วง เรียก 1669 ทันที หรือรีบนำส่งโรงพยาบาล';
  var Q_STATUS = { OPEN: ['รอคำตอบ', 'warn'], ANSWERED: ['ตอบแล้ว', 'ok'] };

  function shortTime(iso) { return iso ? whenText(iso).replace('พรุ่งนี้', '').trim() : ''; }

  function faqItem(f) {
    return html`<details class="faq" data-faq="${f.faq_id}"><summary>${f.question}</summary><p class="faq-a">${f.answer}</p></details>`;
  }

  function myQuestionItem(q) {
    var st = Q_STATUS[q.status] || [q.status, ''];
    return html`<div class="qa-item">
      <div class="dose-top"><div class="qa-q">${q.text}</div><span class="badge ${st[1]}">${st[0]}</span></div>
      <div class="note">ถามเมื่อ ${shortTime(q.asked_at)}</div>
      ${q.answer ? html`<div class="qa-a"><b>${state.me.qaTeam || 'พยาบาล'}ตอบ:</b> ${q.answer}</div>` : ''}
    </div>`;
  }

  function staffItem(q) {
    return html`<form class="qa-item staff" data-qid="${q.question_id}">
      <div class="note">จาก <b>${q.asker}</b>${q.patient ? html` · ${q.patient.relation} · ผู้ป่วย <b>${q.patient.name}</b>` : ''} · ${shortTime(q.asked_at)}</div>
      <div class="qa-q">${q.text}</div>
      ${q.patient ? html`<div class="note">ยาที่ใช้: ${q.patient.meds.length ? q.patient.meds.join(' · ') : 'ยังไม่มียาในตาราง'}</div>` : ''}
      ${q.faq_question ? html`<div class="note">ระบบตอบอัตโนมัติไปแล้ว: “${q.faq_question}” (ผู้ถามยังต้องการคำตอบเพิ่ม)</div>` : ''}
      <label class="field"><span>คำตอบ</span><textarea name="answer" rows="4" maxlength="2000" required></textarea></label>
      <label class="check"><input type="checkbox" name="addFaq"> เพิ่มเป็นคำถามที่พบบ่อยด้วย (ครั้งหน้าระบบตอบเองได้)</label>
      <div class="faq-extra" hidden>
        <label class="field"><span>คำถาม (แก้ให้กว้างขึ้นได้ ไม่ต้องมีชื่อคน)</span><input type="text" name="faqQuestion" maxlength="200" value="${q.text.slice(0, 200)}"></label>
        <label class="field"><span>คำค้น (keywords)</span><span class="hint">คำที่ถ้าอยู่ในคำถาม ให้ตอบข้อนี้ คั่นด้วยจุลภาค เช่น ลืมทาน,ลืมกิน</span><input type="text" name="keywords" maxlength="300"></label>
      </div>
      <p class="err" hidden></p>
      <button class="btn" type="submit">ส่งคำตอบ</button>
    </form>`;
  }

  function pageQa() {
    var me = state.me, team = me.qaTeam || 'พยาบาล';
    var friendship = liff.getFriendship ? liff.getFriendship().catch(function () { return { friendFlag: true }; }) : Promise.resolve({ friendFlag: true });
    return Promise.all([api('faq'), api('myQuestions'), me.isQaStaff ? api('staffQuestions') : null, friendship]).then(function (r) {
      var faqs = r[0], mine = r[1], staff = r[2], isFriend = !!r[3].friendFlag;
      var oa = me.oaBasicId || CFG.OA_BASIC_ID;
      render(html`<div class="page-head"><div><h1>ถาม-ตอบ</h1>
          <p class="sub">${me.hasQaStaff ? 'ค้นหาคำถามที่พบบ่อย หรือส่งคำถามถึง' + team : 'ค้นหาคำถามที่พบบ่อย'}</p></div></div>
        ${staff ? html`<section class="card" id="staffBox">
          <h2>คำถามรอตอบ (${staff.open.length})</h2>
          ${staff.open.length ? staff.open.map(staffItem) : html`<p class="note">ไม่มีคำถามรอตอบ ✓</p>`}
          ${staff.answered.length ? html`<details class="more"><summary>ตอบแล้วล่าสุด (${staff.answered.length})</summary>
            ${staff.answered.map(function (q) {
              return html`<div class="qa-item"><div class="note">จาก ${q.asker} · ตอบโดย ${q.answered_by} · ${shortTime(q.answered_at)}${q.notified === false ? html` · <span class="err">ส่ง LINE ไม่สำเร็จ (ผู้ถามดูได้ในหน้านี้)</span>` : ''}</div>
                <div class="qa-q">${q.text}</div><div class="qa-a">${q.answer}</div></div>`;
            })}</details>` : ''}
        </section>` : ''}
        <section class="card">
          <h2>คำถามที่พบบ่อย</h2>
          <input type="search" id="faqSearch" placeholder="พิมพ์คำค้น เช่น ลืมทาน, หลังอาหาร" aria-label="ค้นหาคำถามที่พบบ่อย" enterkeyhint="search">
          <div id="faqList">${faqs.length ? faqs.map(faqItem) : html`<p class="note">ยังไม่มีคำถามที่พบบ่อย</p>`}</div>
          <p class="note" id="faqNone" hidden>ไม่พบคำถามที่ตรง${me.hasQaStaff ? ' ส่งคำถามถึง' + team + 'ด้านล่างได้เลย' : ''}</p>
        </section>
        ${me.hasQaStaff ? html`<form class="card" id="askForm" novalidate>
          <h2>ส่งคำถามถึง${team}</h2>
          <p class="urgent">⚠️ ${QA_URGENT}</p>
          <label class="field"><span>คำถาม</span><textarea name="text" rows="3" maxlength="500" placeholder="เช่น ยาความดันทานพร้อมยาแก้ปวดได้ไหม"></textarea></label>
          ${isFriend ? html`<p class="note">${team}จะตอบกลับทาง LINE และแสดงในหน้านี้</p>`
                     : html`<div class="card soft"><p>เพิ่มเพื่อนบัญชี LINE นี้ก่อน เพื่อรับคำตอบทาง LINE (ไม่เพิ่มก็ดูคำตอบในหน้านี้ได้)</p>
                        <a class="btn ghost small" href="https://line.me/R/ti/p/${encodeURIComponent(oa)}">เพิ่มเพื่อน</a></div>`}
          <div id="askResult" hidden></div>
          <p class="err" hidden></p>
          <button class="btn" type="submit">ส่งคำถาม</button>
        </form>` : html`<div class="card soft"><p>ยังไม่มี${team}ตอบคำถามในระบบ ถ้าไม่พบคำตอบ สอบถามแพทย์หรือพยาบาลที่โรงพยาบาลที่รักษา</p></div>`}
        <section class="card">
          <h2>คำถามของฉัน</h2>
          ${mine.length ? mine.map(myQuestionItem) : html`<p class="note">ยังไม่เคยส่งคำถาม · พิมพ์คำถามในแชต LINE ก็ได้</p>`}
        </section>`);

      // ค้นหา FAQ ในหน้า (ไม่เรียกเซิร์ฟเวอร์)
      var $search = $view.querySelector('#faqSearch'), $none = $view.querySelector('#faqNone');
      $search.addEventListener('input', function () {
        var k = qaNorm($search.value), shown = 0;
        faqs.forEach(function (f) {
          var el = $view.querySelector('[data-faq="' + f.faq_id + '"]');
          var hit = !k || qaNorm(f.question + ' ' + f.answer + ' ' + f.keywords).indexOf(k) >= 0;
          el.hidden = !hit; if (hit) shown++;
          if (k && hit && shown === 1) el.open = true;
        });
        $none.hidden = shown > 0 || !faqs.length;
      });

      var form = $view.querySelector('#askForm');
      if (form) {
        var send = function (force, faqId) {
          var btn = form.querySelector('button[type=submit]'), $err = form.querySelector('.err'), $res = form.querySelector('#askResult');
          var text = form.elements.text.value.trim();
          if (text.length < 3) { $err.textContent = 'พิมพ์คำถามอย่างน้อย 3 ตัวอักษร'; $err.hidden = false; return; }
          $err.hidden = true; btn.disabled = true;
          api('askQuestion', { text: text, patientId: state.patientId, force: !!force, faqId: faqId || '',
            displayName: (state.profile && state.profile.displayName) || '', isFriend: isFriend })
            .then(function (res) {
              btn.disabled = false;
              if (res.matched) {
                $res.hidden = false;
                $res.innerHTML = String(html`<div class="preview"><b>มีคำตอบสำหรับคำถามนี้แล้ว</b>
                  <p class="qa-q">${res.matched.question}</p><p class="faq-a">${res.matched.answer}</p></div>
                  <div class="dialog-actions">
                    <button class="btn" type="button" data-qa="ok">ได้คำตอบแล้ว</button>
                    <button class="btn secondary" type="button" data-qa="force" data-faq-id="${res.matched.faq_id}">ยังไม่ตรง ส่งถึง${team}</button>
                  </div>`);
                $res.scrollIntoView({ block: 'nearest' });
                return;
              }
              toast('ส่งคำถามถึง' + team + 'แล้ว ✓ จะตอบกลับทาง LINE');
              return pageQa();
            })
            .catch(function (err) { btn.disabled = false; $err.textContent = err.message; $err.hidden = false; });
        };
        form.addEventListener('submit', function (e) { e.preventDefault(); send(false); });
        form.addEventListener('click', function (e) {
          var b = e.target.closest('[data-qa]');
          if (!b) return;
          if (b.dataset.qa === 'force') return send(true, b.dataset.faqId);
          form.reset(); form.querySelector('#askResult').hidden = true; toast('ยินดีครับ 🙏');
        });
      }

      var box = $view.querySelector('#staffBox');
      if (box) {
        box.addEventListener('change', function (e) {
          if (e.target.name === 'addFaq') e.target.closest('form').querySelector('.faq-extra').hidden = !e.target.checked;
        });
        box.addEventListener('submit', function (e) {
          e.preventDefault();
          var f = e.target, btn = f.querySelector('button[type=submit]'), $err = f.querySelector('.err');
          var answer = f.elements.answer.value.trim();
          if (answer.length < 2) { $err.textContent = 'พิมพ์คำตอบก่อนกดส่ง'; $err.hidden = false; return; }
          $err.hidden = true; btn.disabled = true;
          api('answerQuestion', { questionId: f.dataset.qid, answer: answer, addFaq: f.elements.addFaq.checked,
            faqQuestion: f.elements.faqQuestion.value, keywords: f.elements.keywords.value })
            .then(function (res) {
              toast(res.pushed ? 'ส่งคำตอบทาง LINE แล้ว ✓' + (res.faq_id ? ' · เพิ่มเป็นคำถามที่พบบ่อยแล้ว' : '')
                               : 'บันทึกคำตอบแล้ว แต่ส่ง LINE ไม่สำเร็จ (ผู้ถามอาจยังไม่ได้เพิ่มเพื่อน) ผู้ถามดูได้ในหน้าถาม-ตอบ');
              return pageQa();
            })
            .catch(function (err) { btn.disabled = false; $err.textContent = err.message; $err.hidden = false; });
        });
      }
    });
  }

  function pageVideos(params) {
    if (params.video) return pageVideo(params.video);
    return api('videos').then(function (vs) {
      state.videos = vs;
      render(html`<div class="page-head"><div><h1>วิดีโอความรู้</h1><p class="sub">ดูจบแล้วทำแบบทดสอบสั้น ๆ</p></div></div>
        ${vs.length ? '' : html`<div class="empty">ยังไม่มีวิดีโอ</div>`}
        <div class="videos">${vs.map(function (v) {
          return html`<button class="video" data-video="${v.video_id}">
            ${/^[\w-]{11}$/.test(v.youtube_id) ? html`<img src="https://i.ytimg.com/vi/${v.youtube_id}/mqdefault.jpg" alt="" loading="lazy">` : html`<div class="thumb-ph"></div>`}
            <div><div class="dose-name">${v.title}</div><div class="note">${v.description || ''}</div>
              ${v.bestScore === null ? '' : html`<span class="badge ok">คะแนนดีที่สุด ${v.bestScore}</span>`}</div>
          </button>`;
        })}</div>`);
    });
  }

  function pageVideo(videoId) {
    var v = (state.videos || []).filter(function (x) { return x.video_id === videoId; })[0];
    var load = v ? Promise.resolve(v) : api('videos').then(function (vs) { state.videos = vs; return vs.filter(function (x) { return x.video_id === videoId; })[0]; });
    return load.then(function (v) {
      if (!v) throw new Error('ไม่พบวิดีโอ');
      return api('quiz', { videoId: videoId }).then(function (qs) {
        var ytOk = /^[\w-]{11}$/.test(v.youtube_id);
        render(html`
          <div class="page-head"><h1>${v.title}</h1><button class="btn ghost small" data-go="videos">กลับ</button></div>
          ${ytOk ? html`<div class="player"><iframe src="https://www.youtube-nocookie.com/embed/${v.youtube_id}?rel=0&playsinline=1" title="${v.title}" allow="encrypted-media; picture-in-picture" allowfullscreen></iframe></div>`
                 : html`<div class="card soft"><p class="note">ยังไม่ได้ตั้งค่าวิดีโอ (youtube_id)</p></div>`}
          ${v.description ? html`<p class="sub">${v.description}</p>` : ''}
          ${qs.length ? html`<form class="card" id="quizForm"><h2>แบบทดสอบ (${qs.length} ข้อ)</h2>
            ${qs.map(function (q, i) {
              return html`<fieldset class="q" style="border:0;padding:0;margin:0" data-q="${q.question_id}"><legend style="font-weight:600;margin-bottom:8px">${i + 1}. ${q.question}</legend>
                ${q.choices.map(function (c, j) { return html`<label class="choice"><input type="radio" name="${q.question_id}" value="${j}"><span>${c}</span></label>`; })}</fieldset>`;
            })}
            <p id="quizResult" hidden></p>
            <button class="btn" type="submit">ส่งคำตอบ</button></form>` : html`<p class="note">วิดีโอนี้ไม่มีแบบทดสอบ</p>`}`);
        var form = $view.querySelector('#quizForm');
        if (!form) return;
        form.addEventListener('submit', function (e) {
          e.preventDefault();
          var answers = {}, missing = 0;
          qs.forEach(function (q) { var c = form.querySelector('input[name="' + q.question_id + '"]:checked'); if (c) answers[q.question_id] = +c.value; else missing++; });
          if (missing) return toast('ยังตอบไม่ครบ ' + missing + ' ข้อ');
          var btn = form.querySelector('button[type=submit]'); btn.disabled = true;
          api('submitQuiz', { videoId: videoId, answers: answers }).then(function (r) {
            r.detail.forEach(function (d) {
              var fs = form.querySelector('[data-q="' + d.question_id + '"]');
              fs.querySelectorAll('.choice').forEach(function (lab, j) {
                lab.classList.toggle('correct', j === d.answer);
                lab.classList.toggle('wrong', j === answers[d.question_id] && !d.correct);
              });
            });
            var out = form.querySelector('#quizResult');
            out.hidden = false;
            out.innerHTML = String(html`<b style="font-size:22px">ได้ ${r.score}/${r.total} คะแนน</b> ${r.score === r.total ? 'ถูกทุกข้อ เยี่ยมมาก' : '· ข้อที่ถูกต้องแสดงเป็นสีเขียว'}`);
            btn.textContent = 'ทำใหม่'; btn.disabled = false; btn.type = 'button';
            btn.onclick = function () { go('videos', { video: videoId }); };
          }).catch(function (err) { btn.disabled = false; toast(err.message); });
        });
      });
    });
  }

  /* ───────────── events ───────────── */

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-go],[data-act],[data-take],[data-skip],[data-prn],[data-undo],[data-edit],[data-del],[data-rmcg],[data-video],.tabs a');
    if (!t || t.closest('dialog')) return;
    if (t.matches('.tabs a')) { e.preventDefault(); return go(t.dataset.page); }
    if (t.dataset.go) { e.preventDefault(); return go(t.dataset.go, t.dataset.mode ? { mode: t.dataset.mode } : {}); }
    if (t.dataset.video) return go('videos', { video: t.dataset.video });
    if (t.dataset.take) { t.disabled = true; return confirmDose(t.dataset.take, 'take'); }
    if (t.dataset.skip) return askSkip(t.dataset.skip);
    if (t.dataset.prn) {
      t.disabled = true;
      return api('logPrn', { medId: t.dataset.prn }).then(function (r) {
        toast('บันทึกแล้ว (วันนี้ครั้งที่ ' + r.count + (r.max ? '/' + r.max : '') + ')',
          { label: 'ยกเลิก', run: function () { undoDose(r.dose_id); } });
        return pageToday();
      }).catch(function (err) { t.disabled = false; toast(err.message); });
    }
    if (t.dataset.undo) { t.disabled = true; return undoDose(t.dataset.undo); }
    if (t.dataset.edit) return medForm((state.meds || []).filter(function (m) { return m.med_id === t.dataset.edit; })[0]);
    if (t.dataset.del) return askDelete(t.dataset.del);
    if (t.dataset.rmcg) return askRemoveCaregiver(t.dataset.rmcg, t.dataset.name, t.dataset.self === '1');
    switch (t.dataset.act) {
      case 'reload': return location.reload();
      case 'addMed': return medForm(null);
      case 'addTime': return t.insertAdjacentHTML('beforebegin', String(timeRow(suggestTime())));
      case 'rmTime':
        if ($view.querySelectorAll('input[name=time]').length > 1) t.closest('.time-row').remove();
        return;
      case 'createInvite': return createInvite();
      case 'shareInvite': return shareInvite();
      case 'copyInvite': return copyInvite();
    }
  });

  $select.addEventListener('change', function () {
    state.patientId = $select.value; store('patientId', state.patientId);
    go(state.page === 'join' ? 'today' : state.page);
  });

  /* ───────────── start ───────────── */

  function start() {
    // ลืมแก้ config.js เป็นข้อผิดพลาดที่พบบ่อยที่สุดตอนติดตั้ง → บอกตรง ๆ แทน error ของ LIFF ที่อ่านไม่รู้เรื่อง
    if (!CFG.LIFF_ID || /YOUR/.test(CFG.LIFF_ID) || !/^https:\/\/script\.google\.com\/.+\/exec$/.test(CFG.API_URL || '')) {
      return fail(new Error('ยังไม่ได้ตั้งค่า config.js: ใส่ LIFF_ID และ API_URL (Web app URL ที่ลงท้ายด้วย /exec) ตามคู่มือติดตั้ง ขั้นที่ 3'));
    }
    if (!window.liff) return fail(new Error('โหลด LIFF SDK ไม่สำเร็จ ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่'));
    liff.init({ liffId: CFG.LIFF_ID }).then(function () {
      if (!liff.isLoggedIn()) { liff.login({ redirectUri: location.href }); return; }
      var q = new URL(location.href).searchParams;
      return Promise.all([loadMe(), liff.getProfile().catch(function () { return null; })]).then(function (r) {
        state.profile = r[1];
        $tabs.hidden = false;
        var page = q.get('page') || 'today';
        go(page, page === 'join' ? { code: q.get('code') } : {});
      });
    }).catch(fail);
  }
  start();
})();
