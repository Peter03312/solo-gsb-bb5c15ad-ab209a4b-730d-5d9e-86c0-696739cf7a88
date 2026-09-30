// 纯领域逻辑：曝光计算、预算汇总、批量排期校验
// 曝光单位：lx·min（勒克斯·分钟），时段区间统一按半开区间 [start, end) 处理。

export const STATUSES = ['scheduled', 'frozen', 'finished'];

export function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function minutesBetween(startIso, endIso) {
  const s = toDate(startIso);
  const e = toDate(endIso);
  if (!s || !e) return null;
  return Math.round((e.getTime() - s.getTime()) / 60000);
}

// 计划曝光：计划分钟数 × 计划照度
export function plannedExposure(slot) {
  const m = minutesBetween(slot.start_at, slot.end_at);
  return m == null ? null : m * slot.lux;
}

// 实际曝光：实际经过分钟数 × 实际照度
export function actualExposure(slot) {
  if (!slot.actual_start_at || !slot.actual_end_at || slot.actual_lux == null) return null;
  const m = minutesBetween(slot.actual_start_at, slot.actual_end_at);
  return m == null ? null : m * slot.actual_lux;
}

// 已冻结/已结束时段参与重叠判定时使用的真实区间：
// 已结束以实际补记时间为准，其余以计划时间为准。
export function effectiveInterval(slot) {
  if (slot.status === 'finished' && slot.actual_start_at && slot.actual_end_at) {
    return { start_at: slot.actual_start_at, end_at: slot.actual_end_at };
  }
  return { start_at: slot.start_at, end_at: slot.end_at };
}

// 半开区间重叠判定
export function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
  return new Date(aStart).getTime() < new Date(bEnd).getTime() &&
    new Date(bStart).getTime() < new Date(aEnd).getTime();
}

function artBrief(artwork) {
  return { id: artwork.id, code: artwork.code, title: artwork.title };
}

function slotBrief(slot) {
  return {
    slot_id: slot.id,
    hall: slot.hall,
    status: slot.status,
    start_at: slot.start_at,
    end_at: slot.end_at,
    actual_start_at: slot.actual_start_at,
    actual_end_at: slot.actual_end_at,
  };
}

/**
 * 汇总各作品预算，并按“开始时间 → 编号”顺序标记因预算不足而不可启动的未开始时段。
 *
 * 已用 used      = 既有累计 + 所有已结束时段实际曝光
 * 预占 reserved  = 进行中(冻结)时段计划曝光 + 全部未开始时段计划曝光（含被卡住时段）
 * 余额 balance   = 上限 - 已用 - 预占（可能为负）
 *
 * @param {Array} artworks 作品行
 * @param {Array} slots    时段行（含 artwork_ids）
 */
export function computeBudget(artworks, slots) {
  const aMap = new Map(artworks.map((a) => [a.id, a]));

  const byArt = new Map();
  for (const a of artworks) {
    byArt.set(a.id, {
      id: a.id,
      code: a.code,
      title: a.title,
      cap: a.cap_lux_min,
      existing: a.existing_lux_min,
      used: a.existing_lux_min,
      reservedFrozen: 0,
      reservedScheduled: 0,
      reservedBlocked: 0,
      balance: a.cap_lux_min - a.existing_lux_min,
    });
  }

  const enriched = slots.map((s) => {
    const planned = plannedExposure(s);
    const actual = actualExposure(s);
    const iv = effectiveInterval(s);
    const arts = (s.artwork_ids || [])
      .map((id) => aMap.get(id))
      .filter(Boolean)
      .map(artBrief);
    return {
      ...s,
      planned_exposure: planned,
      actual_exposure: actual,
      effective_start_at: iv.start_at,
      effective_end_at: iv.end_at,
      artworks: arts,
    };
  });

  // 1) 先累加已结束实际曝光与进行中预占
  for (const s of enriched) {
    if (s.status === 'finished') {
      for (const id of s.artwork_ids || []) {
        const b = byArt.get(id);
        if (b && s.actual_exposure != null) {
          b.used += s.actual_exposure;
          b.balance -= s.actual_exposure;
        }
      }
    } else if (s.status === 'frozen') {
      for (const id of s.artwork_ids || []) {
        const b = byArt.get(id);
        if (b && s.planned_exposure != null) {
          b.reservedFrozen += s.planned_exposure;
          b.balance -= s.planned_exposure;
        }
      }
    }
  }

  // 2) 未开始时段按开始时间、编号排序，贪心检查可启动性
  const scheduled = enriched
    .filter((s) => s.status === 'scheduled')
    .sort((a, b) =>
      new Date(a.start_at).getTime() - new Date(b.start_at).getTime() || a.id - b.id);

  const committed = new Map();
  for (const a of artworks) committed.set(a.id, 0);

  const blocked = [];
  const blockedIds = new Set();

  for (const s of scheduled) {
    const reasons = [];
    for (const id of s.artwork_ids || []) {
      const b = byArt.get(id);
      if (!b || s.planned_exposure == null) continue;
      const required = s.planned_exposure;
      const available = b.cap - b.used - b.reservedFrozen - committed.get(id);
      if (required > available) {
        reasons.push({
          artwork: artBrief(aMap.get(id)),
          required,
          available,
          gap: required - available,
        });
      }
    }
    if (reasons.length > 0) {
      blocked.push({
        slot_id: s.id,
        hall: s.hall,
        start_at: s.start_at,
        end_at: s.end_at,
        planned_exposure: s.planned_exposure,
        reasons,
      });
      blockedIds.add(s.id);
    }
    // 无论是否被卡住，该时段仍在排期中，继续占用后续额度
    for (const id of s.artwork_ids || []) {
      const b = byArt.get(id);
      if (b && s.planned_exposure != null) {
        committed.set(id, committed.get(id) + s.planned_exposure);
        b.reservedScheduled += s.planned_exposure;
        b.balance -= s.planned_exposure;
        if (blockedIds.has(s.id)) b.reservedBlocked += s.planned_exposure;
      }
    }
  }

  // 3) 作品维度冲突：同一作品任意两个时段区间重叠（半开）
  const conflicts = [];
  for (const a of artworks) {
    const entries = enriched
      .filter((s) => (s.artwork_ids || []).includes(a.id))
      .map((s) => ({ s, iv: effectiveInterval(s) }))
      .sort((x, y) =>
        new Date(x.iv.start_at).getTime() - new Date(y.iv.start_at).getTime() ||
        x.s.id - y.s.id);
    const hitSlots = new Set();
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const x = entries[i];
        const y = entries[j];
        if (
          intervalsOverlap(
            x.iv.start_at, x.iv.end_at,
            y.iv.start_at, y.iv.end_at,
          )
        ) {
          hitSlots.add(x.s.id);
          hitSlots.add(y.s.id);
        }
      }
    }
    if (hitSlots.size > 0) {
      conflicts.push({
        artwork: artBrief(a),
        slots: enriched.filter((s) => hitSlots.has(s.id)).map(slotBrief),
      });
    }
  }

  const slotsOut = enriched.sort((a, b) =>
    new Date(effectiveInterval(a).start_at).getTime() -
      new Date(effectiveInterval(b).start_at).getTime() || a.id - b.id);

  return {
    artworks: [...byArt.values()],
    slots: slotsOut,
    blocked,
    blockedIds: [...blockedIds],
    conflicts,
  };
}

// ---------- 作品录入校验 ----------

export function validateArtwork(body, { artworks = [], selfId = null } = {}) {
  const errors = [];
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!code) errors.push({ field: 'code', message: '作品编号必填' });
  else if (artworks.some((a) => a.code === code && a.id !== selfId)) {
    errors.push({ field: 'code', message: `作品编号 ${code} 已存在` });
  }
  if (!title) errors.push({ field: 'title', message: '作品名称必填' });

  const cap = body.cap_lux_min;
  const existing = body.existing_lux_min;
  if (!Number.isInteger(cap) || cap <= 0) {
    errors.push({ field: 'cap_lux_min', message: '展期曝光上限须为正整数（lx·min）' });
  }
  if (!Number.isInteger(existing) || existing < 0) {
    errors.push({ field: 'existing_lux_min', message: '既有累计曝光须为非负整数（lx·min）' });
  }
  if (Number.isInteger(cap) && cap > 0 && Number.isInteger(existing) && existing > cap) {
    errors.push({
      field: 'existing_lux_min',
      message: '既有累计曝光不得超过展期曝光上限',
    });
  }
  return {
    ok: errors.length === 0,
    errors,
    value: errors.length === 0 ? { code, title, cap_lux_min: cap, existing_lux_min: existing } : null,
  };
}

// ---------- 批量排期校验 ----------

function asInt(v) {
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

/**
 * 校验“整批替换未开始时段”。
 * @param {object} payload       { slots: [...] }
 * @param {Array}  artworks      全部作品
 * @param {Array}  committedSlots 已存在的冻结/已结束时段（不可移动）
 * @returns {{ok, errors, rows}}
 */
export function validateBatch(payload, artworks, committedSlots) {
  const errors = [];
  const aMap = new Map(artworks.map((a) => [a.id, a]));

  if (!payload || !Array.isArray(payload.slots)) {
    return { ok: false, errors: [{ field: 'slots', message: 'slots 必须为数组' }], rows: [] };
  }

  const rows = [];
  payload.slots.forEach((raw, i) => {
    const row = { row_index: i, hall: '', start: null, end: null, lux: null, artwork_ids: [] };
    const hall = typeof raw?.hall === 'string' ? raw.hall.trim() : '';
    if (!hall) errors.push({ row_index: i, field: 'hall', message: '展厅/时段名称必填' });
    row.hall = hall;

    const start = toDate(raw?.start_at);
    const end = toDate(raw?.end_at);
    if (!start) {
      errors.push({ row_index: i, field: 'start_at', message: '开始时间无效' });
    }
    if (!end) {
      errors.push({ row_index: i, field: 'end_at', message: '结束时间无效' });
    }
    if (start && end && end.getTime() <= start.getTime()) {
      errors.push({ row_index: i, field: 'end_at', message: '结束时间必须晚于开始时间' });
    }
    row.start = start;
    row.end = end;

    const lux = asInt(raw?.lux);
    if (lux === null || lux < 0) {
      errors.push({ row_index: i, field: 'lux', message: '照度须为非负整数（lx）' });
    }
    row.lux = lux;

    const ids = raw?.artwork_ids;
    if (!Array.isArray(ids) || ids.length === 0) {
      errors.push({ row_index: i, field: 'artwork_ids', message: '至少选择一件展出作品' });
    } else {
      const seen = new Set();
      for (const id of ids) {
        if (!Number.isInteger(id)) {
          errors.push({ row_index: i, field: 'artwork_ids', message: '作品编号格式不正确' });
          break;
        }
        if (seen.has(id)) {
          errors.push({ row_index: i, field: 'artwork_ids', message: '同一时段内作品重复' });
          break;
        }
        seen.add(id);
        if (!aMap.has(id)) {
          errors.push({ row_index: i, field: 'artwork_ids', message: `作品 #${id} 不存在` });
        }
      }
      row.artwork_ids = [...seen];
    }

    if (start && end && lux !== null && lux >= 0) {
      row.exposure =
        Math.round((end.getTime() - start.getTime()) / 60000) * lux;
    }
    rows.push(row);
  });

  if (errors.length > 0) {
    return { ok: false, errors, rows };
  }

  // 1) 批次内同一作品时段不得重叠
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const r = rows[i];
      const t = rows[j];
      if (!intervalsOverlap(r.start.toISOString(), r.end.toISOString(),
        t.start.toISOString(), t.end.toISOString())) continue;
      for (const id of r.artwork_ids) {
        if (!t.artwork_ids.includes(id)) continue;
        const a = aMap.get(id);
        for (const [ri, other] of [[i, t], [j, r]]) {
          errors.push({
            row_index: ri,
            code: 'overlap',
            message: `作品「${a.code} ${a.title}」与批次内第 ${other.row_index + 1} 行时段重叠`,
            artwork: artBrief(a),
            other_row_index: other.row_index,
          });
        }
      }
    }
  }

  // 2) 不得与已冻结/已结束时段重叠
  for (const r of rows) {
    for (const s of committedSlots) {
      const iv = effectiveInterval(s);
      if (!intervalsOverlap(
        r.start.toISOString(), r.end.toISOString(), iv.start_at, iv.end_at)) continue;
      for (const id of r.artwork_ids) {
        if (!(s.artwork_ids || []).includes(id)) continue;
        const a = aMap.get(id);
        errors.push({
          row_index: r.row_index,
          code: 'overlap_existing',
          message: `作品「${a.code} ${a.title}」与${s.status === 'finished' ? '已结束' : '进行中'}时段 #${s.id}（${s.hall}）重叠`,
          artwork: artBrief(a),
          slot: slotBrief(s),
        });
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors, rows };
  }

  // 3) 预算贪心：已用 + 进行中预占为基线，按开始时间/提交顺序累加
  const base = new Map();
  for (const a of artworks) base.set(a.id, a.existing_lux_min);
  for (const s of committedSlots) {
    for (const id of s.artwork_ids || []) {
      if (s.status === 'finished' && s.actual_exposure != null) {
        base.set(id, (base.get(id) || 0) + s.actual_exposure);
      } else if (s.planned_exposure != null) {
        base.set(id, (base.get(id) || 0) + s.planned_exposure);
      }
    }
  }
  const committed = new Map(base);

  const ordered = rows
    .map((r) => ({ r, t: r.start.getTime() }))
    .sort((x, y) => x.t - y.t || x.r.row_index - y.r.row_index);

  for (const { r } of ordered) {
    const reasons = [];
    for (const id of r.artwork_ids) {
      const a = aMap.get(id);
      const required = r.exposure;
      const available = a.cap_lux_min - (committed.get(id) || 0);
      if (required > available) {
        reasons.push({
          artwork: artBrief(a),
          required,
          available,
          gap: required - available,
        });
      }
    }
    if (reasons.length > 0) {
      errors.push({
        row_index: r.row_index,
        code: 'budget',
        message: `第 ${r.row_index + 1} 行时段（${r.hall}）超出作品预算`,
        reasons,
      });
    }
    for (const id of r.artwork_ids) committed.set(id, (committed.get(id) || 0) + r.exposure);
  }

  return { ok: errors.length === 0, errors, rows };
}

// 启动/补记实际的参数校验
export function validateActual(body) {
  const errors = [];
  const start = toDate(body?.actual_start_at);
  const end = toDate(body?.actual_end_at);
  const lux = asInt(body?.actual_lux);
  if (!start) errors.push({ field: 'actual_start_at', message: '实际开始时间无效' });
  if (!end) errors.push({ field: 'actual_end_at', message: '实际结束时间无效' });
  if (start && end && end.getTime() <= start.getTime()) {
    errors.push({ field: 'actual_end_at', message: '实际结束时间必须晚于实际开始时间' });
  }
  if (lux === null || lux < 0) {
    errors.push({ field: 'actual_lux', message: '实际照度须为非负整数（lx）' });
  }
  return {
    ok: errors.length === 0,
    errors,
    value: errors.length === 0
      ? { actual_start_at: start.toISOString(), actual_end_at: end.toISOString(), actual_lux: lux }
      : null,
  };
}
