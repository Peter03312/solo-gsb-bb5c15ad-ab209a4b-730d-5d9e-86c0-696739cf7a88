// 领域与数据层端到端测试（无需启动 HTTP）：node test/test.js
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  openDb, getState, createArtwork, replaceSchedule,
  startSlot, finishSlot, updateArtwork, ConflictError,
} from '../src/db.js';
import { validateArtwork, validateBatch, computeBudget } from '../src/budget.js';

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}

const dir = mkdtempSync(path.join(tmpdir(), 'light-test-'));
const db = openDb(path.join(dir, 't.db'));

const H = 3600000;
const now = Date.now();
const iso = (t) => new Date(t).toISOString();
const isoOffset = (h) => iso(now + h * H);

function expectConflict(fn, status) {
  try {
    fn();
    assert.fail('应抛出 ConflictError');
  } catch (e) {
    assert.ok(e instanceof ConflictError, `期望 ConflictError，实际 ${e.constructor.name}`);
    if (status) assert.equal(e.status, status);
    return e;
  }
}

const V = () => getState(db).version;

// 清出干净作品集（seed 数据保留，但用专用作品互不影响）
let aN = 100;
function makeArt(cap, existing = 0) {
  const s = getState(db);
  const code = `T${aN++}`;
  const next = createArtwork(db, s.version, {
    code, title: `测试作品${code}`, cap_lux_min: cap, existing_lux_min: existing,
  });
  return next.artworks.find((a) => a.code === code).id;
}

function slot(hall, hStart, hEnd, lux, artwork_ids, id = null) {
  return {
    id, hall,
    start_at: isoOffset(hStart), end_at: isoOffset(hEnd),
    lux, artwork_ids: Array.isArray(artwork_ids) ? artwork_ids : [artwork_ids],
  };
}

function put(version, slots) {
  return replaceSchedule(db, version, { version, slots });
}

await test('初始化数据：A01 第 2 日时段因预算不足被标记不可启动并给出缺口', () => {
  const s = getState(db);
  const a01 = s.artworks.find((a) => a.code === 'A01');
  assert.equal(a01.used, 204000); // 120000 既有 + 84000 实际
  const blockedA01 = s.blocked.filter((b) =>
    b.reasons.some((r) => r.artwork.code === 'A01'));
  assert.equal(blockedA01.length, 1);
  const r = blockedA01[0].reasons.find((x) => x.artwork.code === 'A01');
  assert.equal(r.required, 36000);
  assert.equal(r.available, 20000);
  assert.equal(r.gap, 16000);
});

await test('作品录入：负值、超上限、重复编号均被拒绝', () => {
  assert.equal(validateArtwork({ code: '', title: '', cap_lux_min: 0, existing_lux_min: 0 }).ok, false);
  assert.equal(validateArtwork({ code: 'X', title: 'x', cap_lux_min: 10, existing_lux_min: -1 }).ok, false);
  assert.equal(validateArtwork({ code: 'X', title: 'x', cap_lux_min: 10, existing_lux_min: 11 }).ok, false);
  const e = expectConflict(() => createArtwork(db, V(), {
    code: 'A01', title: '重号', cap_lux_min: 1000, existing_lux_min: 0,
  }), 422);
  assert.match(e.body.details[0].message, /已存在/);
});

const art = makeArt(100000);

await test('整批提交合法排期成功并推进版本', () => {
  const before = V();
  const next = put(before, [
    slot('东厅', 24, 30, 100, art),       // 6h×100 = 36000
    slot('西厅', 48, 52, 100, art),       // 4h×100 = 24000
  ]);
  assert.equal(next.version, before + 1);
  const row = next.artworks.find((a) => a.id === art);
  assert.equal(row.reservedScheduled, 60000);
  assert.equal(row.balance, 40000);
});

let schedIds;
await test('同一作品时段重叠 → 整批拒绝并指出作品与冲突行', () => {
  const s = getState(db);
  schedIds = s.slots.filter((x) => x.artworks.some((a) => a.id === art) && x.status === 'scheduled');
  const e = expectConflict(() => put(s.version, [
    { ...slot('东厅', 24, 30, 100, art), id: schedIds[0].id },
    slot('重叠厅', 29, 32, 100, art),
  ]), 422);
  assert.ok(e.body.details.some((d) => d.code === 'overlap'));
  assert.match(e.body.error, /整批拒绝/);
  // 被拒绝后状态不变
  const after = getState(db);
  assert.equal(after.version, s.version);
});

await test('预算超限 → 整批拒绝，缺口按开始时间顺序定位', () => {
  const s = getState(db);
  const e = expectConflict(() => put(s.version, [
    slot('东厅', 24, 30, 100, art),   // 36000
    slot('西厅', 48, 52, 100, art),   // 24000
    slot('南厅', 60, 70, 100, art),   // 60000 → 累计 120000 > 100000，缺 20000
  ]), 422);
  const budgetErr = e.body.details.find((d) => d.code === 'budget');
  assert.ok(budgetErr);
  assert.equal(budgetErr.row_index, 2);
  assert.equal(budgetErr.reasons[0].gap, 20000);
  assert.equal(getState(db).version, s.version);
});

await test('无效时序与负值照度被拒绝', () => {
  const s = getState(db);
  expectConflict(() => put(s.version, [
    slot('东厅', 30, 24, 100, art),   // 结束早于开始
  ]), 422);
  expectConflict(() => put(s.version, [
    slot('东厅', 24, 30, -5, art),    // 负照度
  ]), 422);
  expectConflict(() => put(s.version, [
    { ...slot('东厅', 24, 30, 100, []), artwork_ids: [] }, // 无作品
  ]), 422);
  assert.equal(getState(db).version, s.version);
});

await test('过期版本提交 → 409 并返回最新预算', () => {
  const stale = V();
  put(stale, [slot('东厅', 24, 26, 100, art)]);
  const e = expectConflict(() => put(stale, [slot('西厅', 28, 30, 100, art)]), 409);
  assert.equal(e.body.version, getState(db).version);
  assert.ok(Array.isArray(e.body.slots));
});

await test('开始时段即冻结原排期并保留预占；冻结后不可再改', () => {
  // 临界作品：上限 60000，排两个 30000 时段（恰好排满）
  const tight = makeArt(60000);
  const s0 = getState(db);
  const next = put(s0.version, [
    slot('一号', 24, 29, 100, tight), // 30000
    slot('二号', 30, 35, 100, tight), // 30000
  ]);
  const ids = next.slots
    .filter((x) => x.artworks.some((a) => a.id === tight))
    .sort((a, b) => new Date(a.start_at) - new Date(b.start_at))
    .map((x) => x.id);

  // 启动成功：冻结、保留 30000 预占
  const started = startSlot(db, ids[0], next.version);
  const frozen = started.slots.find((x) => x.id === ids[0]);
  assert.equal(frozen.status, 'frozen');
  assert.equal(started.artworks.find((a) => a.id === tight).reservedFrozen, 30000);
  // 重复启动被拒
  expectConflict(() => startSlot(db, ids[0], started.version), 422);

  // 已冻结时段不能再通过排期修改（提交里携带其 id 或与冻结区间重叠 → 拒绝）
  expectConflict(() => put(started.version, [
    slot('一号', 24, 29, 120, tight, frozen.id),
    slot('二号', 30, 35, 100, tight, ids[1]),
  ]), 422);
  assert.equal(getState(db).version, started.version);

  globalThis.__tight = { id: tight, frozenId: ids[0], nextId: ids[1], version: started.version };
});

await test('结束补记实际起止/照度：实际曝光替换预占', () => {
  const { id: tight, frozenId, version } = globalThis.__tight;
  // 实际仅 4h × 50lx = 12000（原预占 30000）
  const next = finishSlot(db, frozenId, version, {
    actual_start_at: isoOffset(24),
    actual_end_at: isoOffset(28),
    actual_lux: 50,
  });
  const done = next.slots.find((x) => x.id === frozenId);
  assert.equal(done.status, 'finished');
  assert.equal(done.actual_exposure, 12000);
  const row = next.artworks.find((a) => a.id === tight);
  assert.equal(row.used, 12000);
  assert.equal(row.reservedFrozen, 0);
});

await test('实际超量导致后续预算不足：标出不可开始时段与缺口并禁止启动', () => {
  const art2 = makeArt(1000000);
  let st = getState(db);
  st = put(st.version, [
    slot('超量厅', 72, 74, 50, art2),  // 计划 6000
    slot('后续厅', 80, 82, 100, art2), // 12000
    slot('再后续', 90, 96, 100, art2), // 36000
  ]);
  const ids = st.slots
    .filter((x) => x.artworks.some((a) => a.id === art2))
    .sort((a, b) => new Date(a.start_at) - new Date(b.start_at))
    .map((x) => x.id);
  st = startSlot(db, ids[0], st.version);
  // 实际 2h × 8400lx = 1008000，已超上限（计划仅 6000）；实际结束于 74，不与后续重叠
  st = finishSlot(db, ids[0], st.version, {
    actual_start_at: isoOffset(72),
    actual_end_at: isoOffset(74),
    actual_lux: 8400,
  });
  // 两件后续均不可启动，顺序为开始时间顺序
  const blocked = st.blocked.filter((b) => ids.slice(1).includes(b.slot_id));
  assert.equal(blocked.length, 2);
  assert.deepEqual(blocked.map((b) => b.slot_id), [ids[1], ids[2]]);
  const firstGap = blocked[0].reasons.find((r) => r.artwork.id === art2);
  assert.equal(firstGap.required, 12000);
  assert.equal(firstGap.available, -8000);
  assert.equal(firstGap.gap, 20000);
  // 禁止启动
  expectConflict(() => startSlot(db, ids[1], st.version), 422);
  // 调整排期（删除超限后续）后重新核算：余额恢复
  const adjusted = put(st.version, []);
  assert.equal(adjusted.blocked.filter((b) => ids.includes(b.slot_id)).length, 0);
  globalThis.__art2 = art2;
});

await test('补记无效时序/负值照度拒绝；未开始不能直接结束', () => {
  const art3 = makeArt(900000);
  let st = getState(db);
  st = put(st.version, [slot('校验厅', 100, 102, 100, art3)]);
  const [sid] = st.slots
    .filter((x) => x.artworks.some((a) => a.id === art3))
    .map((x) => x.id);
  expectConflict(() => finishSlot(db, sid, st.version, {
    actual_start_at: isoOffset(100), actual_end_at: isoOffset(99), actual_lux: 100,
  }), 422);
  expectConflict(() => finishSlot(db, sid, st.version, {
    actual_start_at: isoOffset(100), actual_end_at: isoOffset(102), actual_lux: -1,
  }), 422);
  // 未开始直接结束
  expectConflict(() => finishSlot(db, sid, st.version, {
    actual_start_at: isoOffset(100), actual_end_at: isoOffset(102), actual_lux: 100,
  }), 422);
  assert.equal(getState(db).version, st.version);
});

await test('编辑作品上限下调使排期超额：重算 blocked；上调后解除', () => {
  const art4 = makeArt(100000);
  let st = getState(db);
  st = put(st.version, [
    slot('调光厅', 120, 124, 100, art4), // 24000
    slot('调光厅', 130, 136, 100, art4), // 36000
  ]);
  const ids = st.slots.filter((x) => x.artworks.some((a) => a.id === art4)).map((x) => x.id);
  assert.equal(st.blocked.filter((b) => ids.includes(b.slot_id)).length, 0);
  const cur = st.artworks.find((a) => a.id === art4);
  st = updateArtwork(db, art4, st.version, {
    code: cur.code, title: cur.title, cap_lux_min: 50000, existing_lux_min: 0,
  });
  // 24000 通过；36000 时累计 60000 > 50000
  const blockedIds = st.blocked.map((b) => b.slot_id);
  assert.ok(blockedIds.includes(ids[1]));
  assert.ok(!blockedIds.includes(ids[0]));
  st = updateArtwork(db, art4, st.version, {
    code: cur.code, title: cur.title, cap_lux_min: 100000, existing_lux_min: 0,
  });
  assert.equal(st.blocked.filter((b) => ids.includes(b.slot_id)).length, 0);
});

await test('已结束时段以实际区间参与重叠判定', () => {
  const art5 = makeArt(900000, 0);
  let st = getState(db);
  st = put(st.version, [slot('实厅', 140, 142, 100, art5)]);
  const sid = st.slots.find((x) => x.hall === '实厅' &&
    x.artworks.some((a) => a.id === art5)).id;
  st = startSlot(db, sid, st.version);
  // 实际拖延到 145
  st = finishSlot(db, sid, st.version, {
    actual_start_at: isoOffset(140), actual_end_at: isoOffset(145), actual_lux: 100,
  });
  // 新排期与实际区间（结束于145）重叠 → 拒绝
  const e = expectConflict(() => put(st.version, [
    slot('挤厅', 144, 147, 100, art5),
  ]), 422);
  assert.ok(e.body.details.some((d) => d.code === 'overlap_existing'));
  // 不重叠 → 通过
  const ok = put(st.version, [slot('挤厅', 146, 147, 100, art5)]);
  assert.equal(ok.conflicts.length, 0);
});

await test('纯函数：半开区间首尾相接不算重叠', () => {
  const artworks = [{ id: 1, code: 'P', title: 'p', cap_lux_min: 1000000, existing_lux_min: 0 }];
  const slots = [
    { id: 1, hall: 'a', start_at: isoOffset(200), end_at: isoOffset(202), lux: 1, status: 'scheduled', artwork_ids: [1] },
    { id: 2, hall: 'b', start_at: isoOffset(202), end_at: isoOffset(204), lux: 1, status: 'scheduled', artwork_ids: [1] },
  ];
  const r = computeBudget(artworks, slots);
  assert.equal(r.conflicts.length, 0);
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n全部通过：${passed} 项`);
if (process.exitCode) console.error('存在失败用例');
