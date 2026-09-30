// 巡展光照预算工作台 —— 前端逻辑（原生 JS）

const $ = (sel) => document.querySelector(sel);
const fmt = (n) => (n == null ? '–' : Number(n).toLocaleString('zh-CN'));
const pad = (n) => String(n).padStart(2, '0');

function isoToLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function localInputToIso(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

let state = null;          // 服务器返回的最新状态
let plannerRows = [];      // 排期编辑区行 { key, id, hall, start, end, lux, artwork_ids }
let rowSeq = 0;
let finishSlotId = null;

async function api(path, method, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
  return data;
}

function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = isError ? 'toast toast-error' : 'toast';
  t.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { t.hidden = true; }, isError ? 6000 : 3000);
}

// ---------- 渲染：作品 ----------

function artworkMap() {
  return new Map((state.artworks || []).map((a) => [a.id, a]));
}

function renderArtworks() {
  const tbody = $('#artTable tbody');
  tbody.innerHTML = '';
  for (const a of state.artworks) {
    const tr = document.createElement('tr');
    const neg = a.balance < 0;
    tr.innerHTML = `
      <td>${escapeHtml(a.code)}</td>
      <td>${escapeHtml(a.title)}</td>
      <td class="num">${fmt(a.cap)}</td>
      <td class="num">${fmt(a.existing)}</td>
      <td class="num">${fmt(a.used)}</td>
      <td class="num">${fmt(a.reservedFrozen + a.reservedScheduled)}
        <span class="hint">(进行中 ${fmt(a.reservedFrozen)} / 未开始 ${fmt(a.reservedScheduled)})</span></td>
      <td class="num ${neg ? 'neg' : 'ok'}">${fmt(a.balance)}</td>
      <td></td>`;
    const btn = document.createElement('button');
    btn.className = 'btn btn-ghost';
    btn.textContent = '编辑';
    btn.onclick = () => fillArtForm(a);
    tr.lastElementChild.appendChild(btn);
    tbody.appendChild(tr);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fillArtForm(a) {
  const f = $('#artForm');
  f.id.value = a.id;
  f.code.value = a.code;
  f.title.value = a.title;
  f.cap.value = a.cap;
  f.existing.value = a.existing ?? '';
  $('#artSubmit').textContent = '保存修改';
  $('#artCancel').hidden = false;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

$('#artCancel').addEventListener('click', () => resetArtForm());
function resetArtForm() {
  $('#artForm').reset();
  $('#artForm').id.value = '';
  $('#artSubmit').textContent = '录入作品';
  $('#artCancel').hidden = true;
  $('#artErrors').hidden = true;
}

$('#artForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  const body = {
    version: state.version,
    code: f.code.value.trim(),
    title: f.title.value.trim(),
    cap_lux_min: Number(f.cap.value),
    existing_lux_min: Number(f.existing.value),
  };
  const id = f.id.value;
  try {
    const next = id
      ? await api(`/api/artworks/${id}`, 'PATCH', body)
      : await api('/api/artworks', 'POST', body);
    applyState(next);
    resetArtForm();
    toast('作品已保存');
  } catch (err) {
    handleMutationError(err, $('#artErrors'));
  }
});

// ---------- 渲染：时段 ----------

function statusBadge(slot, blockedIds) {
  if (slot.status === 'finished') return '<span class="badge badge-finished">已结束</span>';
  if (slot.status === 'frozen') return '<span class="badge badge-frozen">进行中</span>';
  if (blockedIds.includes(slot.id)) return '<span class="badge badge-blocked">不可启动</span>';
  return '<span class="badge badge-scheduled">未开始</span>';
}

function renderSlots() {
  const blockedIds = state.blockedIds || [];
  const blockedMap = new Map(state.blocked.map((b) => [b.slot_id, b]));
  const tbody = $('#slotTable tbody');
  tbody.innerHTML = '';

  for (const s of state.slots) {
    const tr = document.createElement('tr');
    if (blockedIds.includes(s.id)) tr.classList.add('row-blocked');
    const chips = (s.artworks || [])
      .map((a) => `<span class="chip">${escapeHtml(a.code)} ${escapeHtml(a.title)}</span>`)
      .join('');
    tr.innerHTML = `
      <td>${s.id}</td>
      <td>${escapeHtml(s.hall)}</td>
      <td>${new Date(s.start_at).toLocaleString('zh-CN')}</td>
      <td>${new Date(s.end_at).toLocaleString('zh-CN')}</td>
      <td class="num">${fmt(s.lux)}</td>
      <td><div class="art-chips">${chips}</div></td>
      <td class="num">${fmt(s.planned_exposure)}</td>
      <td class="num">${s.actual_exposure == null ? '–' : fmt(s.actual_exposure)}</td>
      <td>${statusBadge(s, blockedIds)}</td>
      <td class="actions"></td>`;

    const actions = tr.lastElementChild;
    if (s.status === 'scheduled') {
      const b = blockedMap.get(s.id);
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.textContent = '开始（冻结）';
      btn.disabled = !!b;
      btn.title = b ? b.reasons.map((r) =>
        `${r.artwork.code} 缺口 ${fmt(r.gap)} lx·min`).join('；') : '冻结原排期并保留预占';
      btn.onclick = () => doStart(s.id);
      actions.appendChild(btn);
    } else if (s.status === 'frozen') {
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary';
      btn.textContent = '结束并补记';
      btn.onclick = () => openFinish(s);
      actions.appendChild(btn);
    }
    tbody.appendChild(tr);
  }
}

function renderBanners() {
  const bb = $('#blockBanner');
  if (state.blocked.length === 0) {
    bb.hidden = true;
  } else {
    bb.hidden = false;
    const items = state.blocked.map((b) => `
      <li>时段 #${b.slot_id}（${escapeHtml(b.hall)}，
        ${new Date(b.start_at).toLocaleString('zh-CN')} 起）
        不可启动：${b.reasons.map((r) =>
          `作品「${escapeHtml(r.artwork.code)} ${escapeHtml(r.artwork.title)}」需 ${fmt(r.required)}，
           可用 ${fmt(r.available)}，<span class="gap">缺口 ${fmt(r.gap)} lx·min</span>`).join('；')}</li>`).join('');
    bb.innerHTML = `以下未开始时段按开始时间/编号顺序无法启动（调整排期后重新核算）：<ul>${items}</ul>`;
  }

  const cb = $('#conflictBanner');
  if (state.conflicts.length === 0) {
    cb.hidden = true;
  } else {
    cb.hidden = false;
    cb.innerHTML = `检测到同一作品时段重叠：<ul>` +
      state.conflicts.map((c) => `
        <li>作品「${escapeHtml(c.artwork.code)} ${escapeHtml(c.artwork.title)}」：
          ${c.slots.map((s) => `#${s.slot_id} ${escapeHtml(s.hall)}`).join(' ⇄ ')}</li>`).join('') +
      `</ul>`;
  }
}

async function doStart(id) {
  try {
    applyState(await api(`/api/slots/${id}/start`, 'POST', { version: state.version }));
    toast(`时段 #${id} 已开始，原排期冻结`);
  } catch (err) {
    handleMutationError(err);
  }
}

// ---------- 结束补记弹窗 ----------

function openFinish(slot) {
  finishSlotId = slot.id;
  $('#fmSlotId').textContent = slot.id;
  $('#fmHall').textContent = slot.hall;
  const f = $('#finishForm');
  f.actual_start_at.value = isoToLocalInput(slot.actual_start_at || slot.start_at);
  f.actual_end_at.value = isoToLocalInput(slot.actual_end_at || slot.end_at);
  f.actual_lux.value = slot.actual_lux ?? slot.lux;
  $('#fmErrors').hidden = true;
  $('#finishModal').hidden = false;
}
$('#fmCancel').addEventListener('click', () => { $('#finishModal').hidden = true; });

$('#finishForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  const body = {
    version: state.version,
    actual_start_at: localInputToIso(f.actual_start_at.value),
    actual_end_at: localInputToIso(f.actual_end_at.value),
    actual_lux: Number(f.actual_lux.value),
  };
  try {
    const next = await api(`/api/slots/${finishSlotId}/finish`, 'POST', body);
    applyState(next);
    $('#finishModal').hidden = true;
    const nBlocked = next.blocked.length;
    toast(nBlocked
      ? `已结算；有 ${nBlocked} 个后续时段因预算不足被禁止启动`
      : '实际曝光已补记并替换预占');
  } catch (err) {
    handleMutationError(err, $('#fmErrors'));
  }
});

// ---------- 排期编辑区 ----------

function syncPlannerFromState() {
  plannerRows = state.slots
    .filter((s) => s.status === 'scheduled')
    .sort((a, b) => new Date(a.start_at) - new Date(b.start_at) || a.id - b.id)
    .map((s) => ({
      key: ++rowSeq,
      id: s.id,
      hall: s.hall,
      start: isoToLocalInput(s.start_at),
      end: isoToLocalInput(s.end_at),
      lux: s.lux,
      artwork_ids: [...s.artwork_ids],
    }));
  renderPlanner();
}

function rowExposure(row) {
  const s = localInputToIso(row.start);
  const e = localInputToIso(row.end);
  if (!s || !e || e <= s) return null;
  const minutes = Math.round((new Date(e) - new Date(s)) / 60000);
  return minutes * Number(row.lux || 0);
}

function renderPlanner() {
  const tbody = $('#planTable tbody');
  tbody.innerHTML = '';
  $('#planVersion').textContent = state.version;

  const artOptions = state.artworks
    .map((a) => `<option value="${a.id}">${escapeHtml(a.code)} ${escapeHtml(a.title)}</option>`)
    .join('');

  plannerRows.forEach((row, idx) => {
    const tr = document.createElement('tr');
    tr.dataset.key = row.key;
    tr.innerHTML = `
      <td>${idx + 1}${row.id ? `<div class="hint">#${row.id}</div>` : '<div class="hint">新增</div>'}</td>
      <td><input data-f="hall" value="${escapeHtml(row.hall)}" placeholder="如 1号厅" /></td>
      <td><input data-f="start" type="datetime-local" step="1" value="${row.start}" /></td>
      <td><input data-f="end" type="datetime-local" step="1" value="${row.end}" /></td>
      <td><input data-f="lux" type="number" min="0" step="1" value="${row.lux}" /></td>
      <td><select data-f="artwork_ids" multiple size="3">${artOptions}</select></td>
      <td class="num exp"></td>
      <td><button type="button" class="btn btn-danger-text del">删除</button></td>`;
    const sel = tr.querySelector('select');
    for (const opt of sel.options) {
      if (row.artwork_ids.includes(Number(opt.value))) opt.selected = true;
    }
    tr.querySelectorAll('[data-f]').forEach((el) => {
      el.addEventListener('input', () => {
        row[el.dataset.f] = el.type === 'select-multiple'
          ? [...el.selectedOptions].map((o) => Number(o.value))
          : el.dataset.f === 'lux' ? Number(el.value) : el.value;
        updateRowExposure(tr, row);
        updatePlanSummary();
      });
    });
    tr.querySelector('.del').addEventListener('click', () => {
      plannerRows = plannerRows.filter((r) => r.key !== row.key);
      renderPlanner();
    });
    tbody.appendChild(tr);
    updateRowExposure(tr, row);
  });
  updatePlanSummary();
}

function updateRowExposure(tr, row) {
  const exp = rowExposure(row);
  const cell = tr.querySelector('.exp');
  cell.textContent = exp == null ? '–' : fmt(exp);
  cell.classList.toggle('neg', exp != null && exp < 0);
}

function updatePlanSummary() {
  const totals = new Map(state.artworks.map((a) => [a.id, 0]));
  for (const r of plannerRows) {
    const exp = rowExposure(r) || 0;
    for (const id of r.artwork_ids) totals.set(id, totals.get(id) + exp);
  }
  $('#planSummary').innerHTML = state.artworks.map((a) => {
    const base = a.used + a.reservedFrozen; // 已用+进行中（未开始旧预占将被整批替换）
    const total = base + totals.get(a.id);
    return `<span class="chip ${total > a.cap ? 'neg' : ''}">${escapeHtml(a.code)}: ${fmt(total)}/${fmt(a.cap)}${total > a.cap ? ' 超' : ''}</span>`;
  }).join(' ');
}

$('#addRow').addEventListener('click', () => {
  const last = plannerRows[plannerRows.length - 1];
  plannerRows.push({
    key: ++rowSeq, id: null, hall: '',
    start: last?.end || '', end: '', lux: 100, artwork_ids: [],
  });
  renderPlanner();
});
$('#reloadPlan').addEventListener('click', () => { syncPlannerFromState(); toast('编辑区已重置为服务器排期'); });

$('#submitPlan').addEventListener('click', async () => {
  const slots = plannerRows.map((r) => ({
    id: r.id,
    hall: r.hall.trim(),
    start_at: localInputToIso(r.start),
    end_at: localInputToIso(r.end),
    lux: Number(r.lux),
    artwork_ids: r.artwork_ids,
  }));
  try {
    const next = await api('/api/schedule', 'PUT', { version: state.version, slots });
    applyState(next);
    syncPlannerFromState();
    $('#planErrors').hidden = true;
    toast(`排期已整批提交，新版本 ${next.version}`);
  } catch (err) {
    handleMutationError(err, $('#planErrors'));
  }
});

// ---------- 错误展示 / 版本过期 ----------

function showErrorList(container, details) {
  if (!container) return;
  container.hidden = false;
  const list = (details || []).map((d) => {
    const where = d.row_index != null
      ? `<span class="err-row" data-row="${d.row_index}">第 ${d.row_index + 1} 行</span>` : '';
    let msg = `${where ? where + '：' : ''}${escapeHtml(d.message || '')}`;
    if (d.code === 'budget' && d.reasons) {
      msg += '<ul>' + d.reasons.map((r) =>
        `<li>作品「${escapeHtml(r.artwork.code)} ${escapeHtml(r.artwork.title)}」需 ${fmt(r.required)}，可用 ${fmt(r.available)}，缺口 ${fmt(r.gap)}</li>`).join('') + '</ul>';
    }
    return `<li>${msg}</li>`;
  }).join('');
  container.innerHTML = `<b>${escapeHtml(details ? '提交被拒绝' : '错误')}</b><ul>${list}</ul>`;
  container.querySelectorAll('.err-row').forEach((el) => {
    el.addEventListener('click', () => {
      const row = document.querySelectorAll('#planTable tbody tr')[Number(el.dataset.row)];
      row?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      row?.classList.add('row-error');
      setTimeout(() => row?.classList.remove('row-error'), 2500);
    });
  });
}

function handleMutationError(err, container) {
  if (err.status === 409 && err.data?.slots) {
    // 版本过期：服务器返回最新预算
    applyState(err.data);
    syncPlannerFromState();
    toast('版本已过期：已载入他人修改后的最新预算，请重新调整', true);
    return;
  }
  toast(err.message, true);
  if (container && err.data?.details) showErrorList(container, err.data.details);
  if (err.data?.blocked) applyBlocked(err.data);
}

function applyBlocked(data) {
  // 启动被拒绝时，服务器给出的 blocked 为假设计算结果，不覆盖本地 state，仅提示
  const items = data.blocked.map((b) =>
    `时段 #${b.slot_id}（${b.hall}）：` +
    b.reasons.map((r) => `${r.artwork.code} 缺口 ${fmt(r.gap)}`).join('；')).join('\n');
  toast(`不可启动：\n${items}`, true);
}

// ---------- 全局状态 ----------

function applyState(next) {
  state = next;
  $('#version').textContent = state.version;
  renderArtworks();
  renderSlots();
  renderBanners();
  updatePlanSummary();
}

async function refresh() {
  try {
    const next = await api('/api/state', 'GET');
    const firstLoad = !state;
    applyState(next);
    if (firstLoad || plannerRows.length === 0) syncPlannerFromState();
  } catch (err) {
    toast('加载状态失败：' + err.message, true);
  }
}

function tickClock() {
  $('#clock').textContent = new Date().toLocaleString('zh-CN');
}

$('#refreshBtn').addEventListener('click', refresh);

refresh();
tickClock();
setInterval(tickClock, 1000);
setInterval(refresh, 15000); // 多人协作时周期性同步版本
