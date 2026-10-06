import { allRows, commitRows, listRows } from '@/data/local-store'
import {
  SEGMENT_MODULE_KEY,
  SEGMENT_RECORD_VERSION,
  applyAcceptPlan,
  canStartAssembly,
  countReworkRings,
  getStatus,
  isSegmentAbnormal,
  migrateSegmentRows,
  planAcceptance,
  segmentStats,
  selectReworkTodos,
  type AcceptPlan,
  type AcceptRequest,
  type Operator,
} from '@/data/segment'
import type { ActionResult, EntryRow } from '@/data/types'

// 管片拼装专用服务：读取沿用既有的 listRows('segment')（拼装记录还在 segment 这一份里），
// 但写入不再走通用 runAction，而是经过领域状态机 + 同一笔原子事务提交。
// 管片生产页的返工待办也在这里取数，保证两边读到同一份、环数对得上。

function isMigrated(rows: EntryRow[]): boolean {
  return rows.every((row) => Number(row['_recordVersion']) >= SEGMENT_RECORD_VERSION)
}

// 存量迁移：按拼装日期回填，幂等，整份事务提交。
export function ensureSegmentMigrated(): void {
  const rows = listRows(SEGMENT_MODULE_KEY)
  if (isMigrated(rows)) {
    return
  }
  const migrated = migrateSegmentRows(rows)
  commitRows({ ...allRows(), [SEGMENT_MODULE_KEY]: migrated })
}

function readSegmentRows(): EntryRow[] {
  ensureSegmentMigrated()
  return listRows(SEGMENT_MODULE_KEY)
}

export function listSegments(): EntryRow[] {
  return readSegmentRows()
}

export function reworkTodos(): EntryRow[] {
  return selectReworkTodos(readSegmentRows())
}

export function reworkRingCount(): number {
  return countReworkRings(readSegmentRows())
}

export function getSegmentStats() {
  return segmentStats(readSegmentRows())
}

function segmentNotFound(id: number): ActionResult {
  return { ok: false, message: `没有找到编号为 ${id} 的管片环` }
}

// 开始拼装：待拼装 → 拼装中。护栏与权限都在领域层，服务只负责同一笔事务落库。
export function startAssembly(id: number, operator: Operator): ActionResult {
  const rows = readSegmentRows()
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return segmentNotFound(id)
  }
  const decision = canStartAssembly(rows[index], operator)
  if (!decision.ok) {
    return { ok: false, message: decision.message }
  }
  const nextRows = [...rows]
  nextRows[index] = {
    ...rows[index],
    status: decision.status,
    pending: decision.status !== '已验收',
    拼装状态: decision.status,
    _recordVersion: SEGMENT_RECORD_VERSION,
  }
  return commitOrReject(nextRows, `管片环 ${rows[index]['管片环号'] ?? id} 已开始拼装，状态「拼装中」`)
}

// 提交验收（合格/不合格）。
export type AcceptInput = Omit<AcceptRequest, 'rowId' | 'now'> & { rowId: number; now?: string }

export function submitAcceptance(input: AcceptInput): ActionResult {
  const rows = readSegmentRows()
  const request: AcceptRequest = { ...input, now: input.now ?? new Date().toISOString() }
  const plan = planAcceptance(rows, request)
  if (!plan.ok) {
    // 存不进去/不受理，原样退回，不做任何改动（重复提交也是这里挡回）。
    return { ok: false, message: plan.message }
  }

  const index = rows.findIndex((row) => Number(row.id) === request.rowId)
  if (index < 0) {
    return segmentNotFound(request.rowId)
  }

  const acceptedPlan = plan as Extract<AcceptPlan, { ok: true }>
  const nextRows = [...rows]
  // 验收结论与拼装进度同写进同一行，再随整份一次性落库。
  nextRows[index] = applyAcceptPlan(rows[index], acceptedPlan)

  const message =
    acceptedPlan.event.conclusion === '合格'
      ? `管片环 ${rows[index]['管片环号'] ?? request.rowId} 验收合格，状态「已验收」（${acceptedPlan.event.criteriaVersion}）`
      : `管片环 ${rows[index]['管片环号'] ?? request.rowId} 验收不通过，状态退回「拼装中」返工，已同步管片生产返工待办`
  return commitOrReject(nextRows, message)
}

// 整笔事务：落库失败（配额等）缓存不动，按「存不进去原样退回」处理。
function commitOrReject(nextRows: EntryRow[], successMessage: string): ActionResult {
  try {
    commitRows({ ...allRows(), [SEGMENT_MODULE_KEY]: nextRows })
    return { ok: true, message: successMessage }
  } catch (error) {
    return {
      ok: false,
      message: `写入失败，提交已整笔原样退回（数据未改动）：${
        error instanceof Error ? error.message : '存储不可用'
      }`,
    }
  }
}

export { getStatus, isSegmentAbnormal }
