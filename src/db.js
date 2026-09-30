import Database from 'better-sqlite3';
import {
  computeBudget,
  plannedExposure,
  actualExposure,
  validateArtwork,
  validateBatch,
  validateActual,
} from './budget.js';

export class ConflictError extends Error {
  constructor(status, body) {
    super(body?.error || 'conflict');
    this.status = status;
    this.body = body;
  }
}

export function openDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS artworks (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    code             TEXT NOT NULL UNIQUE,
    title            TEXT NOT NULL,
    cap_lux_min      INTEGER NOT NULL CHECK (cap_lux_min > 0),
    existing_lux_min INTEGER NOT NULL CHECK (existing_lux_min >= 0),
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS slots (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    hall            TEXT NOT NULL,
    start_at        TEXT NOT NULL,
    end_at          TEXT NOT NULL,
    lux             INTEGER NOT NULL CHECK (lux >= 0),
    status          TEXT NOT NULL DEFAULT 'scheduled'
                    CHECK (status IN ('scheduled','frozen','finished')),
    actual_start_at TEXT,
    actual_end_at   TEXT,
    actual_lux      INTEGER CHECK (actual_lux IS NULL OR actual_lux >= 0),
    frozen_at       TEXT,
    finished_at     TEXT
  );
  CREATE TABLE IF NOT EXISTS slot_artworks (
    slot_id    INTEGER NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
    artwork_id INTEGER NOT NULL REFERENCES artworks(id) ON DELETE RESTRICT,
    PRIMARY KEY (slot_id, artwork_id)
  );
  `);

  const row = db.prepare(`SELECT value FROM meta WHERE key='version'`).get();
  if (!row) {
    db.prepare(`INSERT INTO meta(key, value) VALUES ('version', '1')`).run();
    seed(db);
  }
  return db;
}

function iso(d) {
  return d.toISOString();
}
function at(base, dayOffset, h, m = 0) {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + dayOffset);
  d.setUTCHours(h, m, 0, 0);
  return iso(d);
}

function seed(db) {
  // 相对初始化时刻造一组演示数据：一件已结束（超量）、一件进行中、若干未开始（含被卡住）
  const base = new Date();
  base.setUTCHours(0, 0, 0, 0);

  const insArt = db.prepare(
    `INSERT INTO artworks(code, title, cap_lux_min, existing_lux_min)
     VALUES (?, ?, ?, ?)`);
  // A01 上限 260000：既有 120000 + 已结束实际 84000 = 204000，
  // 明日时段 36000 可容纳（240000），后日再 36000 将超出 → 该时段被标记不可启动（缺口 16000）。
  const a1 = insArt.run('A01', '青绿山水卷', 260000, 120000).lastInsertRowid;
  const a2 = insArt.run('A02', '鎏金铜造像', 500000, 90000).lastInsertRowid;
  const a3 = insArt.run('A03', '彩绘漆棺', 800000, 200000).lastInsertRowid;

  const insSlot = db.prepare(
    `INSERT INTO slots(hall, start_at, end_at, lux, status,
                       actual_start_at, actual_end_at, actual_lux,
                       frozen_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insLink = db.prepare(
    `INSERT INTO slot_artworks(slot_id, artwork_id) VALUES (?, ?)`);

  function addSlot({ hall, start, end, lux, status, links, actualStart, actualEnd, actualLux }) {
    const id = insSlot.run(
      hall, start, end, lux, status,
      actualStart ?? null, actualEnd ?? null, actualLux ?? null,
      status === 'frozen' || status === 'finished' ? start : null,
      status === 'finished' ? end : null,
    ).lastInsertRowid;
    for (const a of links) insLink.run(id, a);
    return id;
  }

  // 已结束（昨日 10:00-16:00，计划 150lx×360min=54000；实际 200lx×420min=84000，超量 30000）
  addSlot({
    hall: '1号厅', start: at(base, -1, 10), end: at(base, -1, 16), lux: 150,
    status: 'finished', links: [a1],
    actualStart: at(base, -1, 10), actualEnd: at(base, -1, 17), actualLux: 200,
  });
  // 进行中（今天 08:00-12:00，200lx×240min=48000）
  addSlot({
    hall: '2号厅', start: at(base, 0, 8), end: at(base, 0, 12), lux: 200,
    status: 'frozen', links: [a3],
  });
  // 未开始
  addSlot({ hall: '1号厅', start: at(base, 1, 9), end: at(base, 1, 12), lux: 200, status: 'scheduled', links: [a1] });
  addSlot({ hall: '2号厅', start: at(base, 1, 9), end: at(base, 1, 13), lux: 150, status: 'scheduled', links: [a2] });
  addSlot({ hall: '3号厅', start: at(base, 1, 14), end: at(base, 1, 18), lux: 120, status: 'scheduled', links: [a3] });
  addSlot({ hall: '1号厅', start: at(base, 2, 9), end: at(base, 2, 12), lux: 200, status: 'scheduled', links: [a1] });
  addSlot({ hall: '3号厅', start: at(base, 2, 14), end: at(base, 2, 17), lux: 100, status: 'scheduled', links: [a2, a3] });
}

// ---------- 读取 ----------

function loadArtworks(db) {
  return db.prepare(`SELECT * FROM artworks ORDER BY id`).all();
}

function loadSlots(db) {
  const slots = db.prepare(`SELECT * FROM slots ORDER BY id`).all();
  const links = db.prepare(`SELECT slot_id, artwork_id FROM slot_artworks`).all();
  const map = new Map(slots.map((s) => [s.id, { ...s, artwork_ids: [] }]));
  for (const l of links) map.get(l.slot_id)?.artwork_ids.push(l.artwork_id);
  return [...map.values()].map((s) => ({
    ...s,
    planned_exposure: plannedExposure(s),
    actual_exposure: actualExposure(s),
  }));
}

export function getState(db) {
  const version = db.prepare(`SELECT value FROM meta WHERE key='version'`).get().value;
  const artworks = loadArtworks(db);
  const slots = loadSlots(db);
  return {
    version: Number(version),
    server_time: new Date().toISOString(),
    ...computeBudget(artworks, slots),
  };
}

function getVersion(db) {
  return Number(db.prepare(`SELECT value FROM meta WHERE key='version'`).get().value);
}

function bumpVersion(db) {
  const row = db.prepare(`SELECT value FROM meta WHERE key='version'`).get();
  const next = Number(row.value) + 1;
  db.prepare(`UPDATE meta SET value=? WHERE key='version'`).run(String(next));
  return next;
}

function latestStateBody(db) {
  const artworks = loadArtworks(db);
  const slots = loadSlots(db);
  return { version: getVersion(db), ...computeBudget(artworks, slots) };
}

function expectVersion(db, version) {
  if (!Number.isInteger(version)) {
    throw new ConflictError(400, { error: '必须携带当前 version（整数）' });
  }
  const current = getVersion(db);
  if (version !== current) {
    throw new ConflictError(409, {
      error: '版本已过期：排期已被其他人修改，请以最新预算重新调整',
      ...latestStateBody(db),
    });
  }
}

// ---------- 作品 ----------

export function createArtwork(db, version, body) {
  const tx = db.transaction(() => {
    expectVersion(db, version);
    const artworks = loadArtworks(db);
    const v = validateArtwork(body ?? {}, { artworks });
    if (!v.ok) throw new ConflictError(422, { error: '作品录入校验失败', details: v.errors });
    db.prepare(
      `INSERT INTO artworks(code, title, cap_lux_min, existing_lux_min)
       VALUES (?, ?, ?, ?)`)
      .run(v.value.code, v.value.title, v.value.cap_lux_min, v.value.existing_lux_min);
    bumpVersion(db);
  });
  tx();
  return latestStateBody(db);
}

export function updateArtwork(db, id, version, body) {
  const tx = db.transaction(() => {
    expectVersion(db, version);
    const current = db.prepare(`SELECT * FROM artworks WHERE id=?`).get(id);
    if (!current) throw new ConflictError(404, { error: `作品 #${id} 不存在` });
    const merged = {
      code: body?.code ?? current.code,
      title: body?.title ?? current.title,
      cap_lux_min: body?.cap_lux_min ?? current.cap_lux_min,
      existing_lux_min: body?.existing_lux_min ?? current.existing_lux_min,
    };
    const v = validateArtwork(merged, { artworks: loadArtworks(db), selfId: id });
    if (!v.ok) throw new ConflictError(422, { error: '作品信息校验失败', details: v.errors });
    db.prepare(
      `UPDATE artworks SET code=?, title=?, cap_lux_min=?, existing_lux_min=? WHERE id=?`)
      .run(v.value.code, v.value.title, v.value.cap_lux_min, v.value.existing_lux_min, id);
    bumpVersion(db);
  });
  tx();
  return latestStateBody(db);
}

// ---------- 批量排期：整批替换未开始时段 ----------

export function replaceSchedule(db, version, payload) {
  const tx = db.transaction(() => {
    expectVersion(db, version);
    const artworks = loadArtworks(db);
    const slots = loadSlots(db);

    // 提交里可携带 id：已存在的 scheduled 时段须属于未开始，frozen/finished 不得改动
    const submittedIds = new Set();
    for (const raw of payload?.slots ?? []) {
      if (raw?.id != null) {
        if (!Number.isInteger(raw.id)) {
          throw new ConflictError(422, {
            error: '排期校验失败',
            details: [{ field: 'id', message: '时段 id 必须为整数' }],
          });
        }
        submittedIds.add(raw.id);
      }
    }
    const staleIds = [];
    for (const sid of submittedIds) {
      const s = slots.find((x) => x.id === sid);
      if (!s) staleIds.push(sid);
    }
    if (staleIds.length > 0) {
      throw new ConflictError(422, {
        error: '排期校验失败',
        details: staleIds.map((id) => ({
          field: 'id', message: `时段 #${id} 不存在（可能已启动，请刷新后重试）`,
        })),
      });
    }

    const committedSlots = slots.filter((s) => s.status !== 'scheduled');
    const result = validateBatch(payload ?? {}, artworks, committedSlots);
    if (!result.ok) {
      throw new ConflictError(422, { error: '排期校验失败：整批拒绝', details: result.errors });
    }

    // 未出现在提交中的旧 scheduled 时段删除；其余重建
    const keepIds = new Set(
      (payload.slots || []).map((s) => s.id).filter((id) => id != null));
    const toDelete = slots
      .filter((s) => s.status === 'scheduled' && !keepIds.has(s.id))
      .map((s) => s.id);
    const delLink = db.prepare(`DELETE FROM slot_artworks WHERE slot_id=?`);
    const delSlot = db.prepare(`DELETE FROM slots WHERE id=?`);
    for (const id of toDelete) {
      delLink.run(id);
      delSlot.run(id);
    }

    const insSlot = db.prepare(
      `INSERT INTO slots(hall, start_at, end_at, lux, status) VALUES (?, ?, ?, ?, 'scheduled')`);
    const updSlot = db.prepare(
      `UPDATE slots SET hall=?, start_at=?, end_at=?, lux=? WHERE id=?`);
    const insLink = db.prepare(
      `INSERT INTO slot_artworks(slot_id, artwork_id) VALUES (?, ?)`);
    const delLinks = db.prepare(`DELETE FROM slot_artworks WHERE slot_id=?`);

    for (const [i, raw] of (payload.slots || []).entries()) {
      const r = result.rows[i];
      let slotId = raw.id ?? null;
      if (slotId == null) {
        slotId = insSlot.run(
          r.hall, r.start.toISOString(), r.end.toISOString(), r.lux).lastInsertRowid;
      } else {
        updSlot.run(
          r.hall, r.start.toISOString(), r.end.toISOString(), r.lux, slotId);
        delLinks.run(slotId);
      }
      for (const aid of r.artwork_ids) insLink.run(slotId, aid);
    }

    bumpVersion(db);
  });
  tx();
  return latestStateBody(db);
}

// ---------- 开始：冻结原排期、保留预占；预算不足则禁止启动 ----------

export function startSlot(db, slotId, version) {
  const tx = db.transaction(() => {
    expectVersion(db, version);
    const artworks = loadArtworks(db);
    const slots = loadSlots(db);
    const slot = slots.find((s) => s.id === slotId);
    if (!slot) throw new ConflictError(404, { error: `时段 #${slotId} 不存在` });
    if (slot.status === 'finished') {
      throw new ConflictError(422, { error: `时段 #${slotId} 已结束，不能启动` });
    }
    if (slot.status === 'frozen') {
      throw new ConflictError(422, { error: `时段 #${slotId} 已在进行中` });
    }

    // 当前预算下该未开始时段已被判定不可启动 → 禁止启动；
    // 未被标记则可安全冻结（贪心核算已把它作为后续时段的已提交额度）。
    const budget = computeBudget(artworks, slots);
    if (budget.blockedIds.includes(slotId)) {
      const own = budget.blocked.find((b) => b.slot_id === slotId);
      throw new ConflictError(422, {
        error: `时段 #${slotId}（${slot.hall}）不可启动：作品预算缺口`,
        code: 'cannot_start',
        blocked_slot: own,
        blocked: budget.blocked,
      });
    }
    db.prepare(
      `UPDATE slots SET status='frozen', frozen_at=COALESCE(frozen_at, ?) WHERE id=?`)
      .run(new Date().toISOString(), slotId);
    bumpVersion(db);
  });
  tx();
  return latestStateBody(db);
}

// ---------- 结束：补记实际起止与照度，实际曝光替换预占，重算不可启动清单 ----------

export function finishSlot(db, slotId, version, body) {
  const tx = db.transaction(() => {
    expectVersion(db, version);
    const slot = db.prepare(`SELECT * FROM slots WHERE id=?`).get(slotId);
    if (!slot) throw new ConflictError(404, { error: `时段 #${slotId} 不存在` });
    if (slot.status === 'finished') {
      throw new ConflictError(422, { error: `时段 #${slotId} 已结束` });
    }
    if (slot.status === 'scheduled') {
      throw new ConflictError(422, {
        error: `时段 #${slotId} 尚未开始，请先启动（冻结排期）`,
      });
    }
    const v = validateActual(body ?? {});
    if (!v.ok) throw new ConflictError(422, { error: '补记信息校验失败', details: v.errors });

    db.prepare(
      `UPDATE slots SET status='finished',
                        actual_start_at=?, actual_end_at=?, actual_lux=?,
                        finished_at=?
       WHERE id=?`)
      .run(v.value.actual_start_at, v.value.actual_end_at, v.value.actual_lux,
        new Date().toISOString(), slotId);
    bumpVersion(db);
  });
  tx();
  return latestStateBody(db);
}
