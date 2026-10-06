import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

/**
 * 管片拼装领域：全平台只有这一份能读写拼装记录。
 * - 页面（拼装报表 / 详情面板）与管片生产返工待办都走这里取数，不再各写一份；
 * - 验收结论与拼装进度落在同一条管片环记录上，一笔保存；
 * - 状态单向推进，跳级当场挡回并写清缺哪一步。
 */

export const SEGMENT_KEY = 'segment'

/** 拼装流水线：只能按下标依次推进。 */
export const SEGMENT_STATUSES = ['待拼装', '拼装中', '已验收'] as const
export type SegmentStatus = (typeof SEGMENT_STATUSES)[number]

/** 验收结论。 */
export type AcceptVerdict = '合格' | '不通过'

/** 一条验收履历：验收结论与拼装进度同处一条环记录的履历里。 */
export type AcceptanceRecord = {
  /**
   * 幂等令牌：一张验收单对应一个令牌，由调用方在开单时生成并随重试保持不变；
   * 同一令牌重复提交只生效一次。重新发起一轮验收（如返工后复验）须另开新单、
   * 使用新令牌。
   */
  token: string
  verdict: AcceptVerdict
  standardVersion: string
  reasons: string[]
  inspector: string
  crew: string
  submittedAt: string
}

/** 当前操作人：必须是本拼装班组的质检员才能提交验收。 */
export type Operator = {
  name: string
  role: string
  crew: string
}

export type SubmitAcceptanceInput = {
  id: number
  operator: Operator
  token: string
}

/**
 * 作数的判定标准：《管片拼装质量验收标准 V2026-1》。
 * 历史结论按当时记录保留，标准升级不重判存量结论。
 */
export const ACTIVE_STANDARD = {
  version: 'V2026-1',
  name: '管片拼装质量验收标准',
  torqueRule: '螺栓扭矩达标',
  maxStepMm: 10,
} as const

/**
 * 返工待办条目：管片生产侧读到的返工环数与拼装侧完全一致，
 * 因为两边都由这一个函数从同一份拼装记录派生。
 */
export type ReworkTodo = {
  id: number
  ringNo: string
  crew: string
  latestVerdict: AcceptVerdict
  reasons: string[]
  standardVersion: string
  inspector: string
  submittedAt: string
}

function fail(message: string): ActionResult {
  return { ok: false, message }
}

function getRow(id: number): { row: EntryRow; index: number } | null {
  const rows = listRows(SEGMENT_KEY)
  const index = rows.findIndex((item) => Number(item.id) === id)
  return index < 0 ? null : { row: rows[index], index }
}

/** 反序列化验收履历；脏数据不采信，按无履历处理。 */
export function acceptanceHistory(row: EntryRow): AcceptanceRecord[] {
  const raw = row['验收履历']
  if (typeof raw !== 'string' || raw.trim() === '') {
    return []
  }
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed.filter(
      (item): item is AcceptanceRecord =>
        typeof item === 'object' &&
        item !== null &&
        (item.verdict === '合格' || item.verdict === '不通过') &&
        typeof item.token === 'string',
    )
  } catch {
    return []
  }
}

/** 最近一条验收结论，详情面板、返工待办共用。 */
export function latestAcceptance(row: EntryRow): AcceptanceRecord | null {
  const history = acceptanceHistory(row)
  return history.length ? history[history.length - 1] : null
}

/** 是否处于「验收不通过、等待返工复验」：异常标记与返工待办同口径。 */
function isAwaitingRework(row: EntryRow): boolean {
  const latest = latestAcceptance(row)
  return latest !== null && latest.verdict === '不通过' && String(row.status) !== '已验收'
}

/** 待拼装 → 拼装中：唯一的推进入口。 */
export function startAssemble(id: number): ActionResult {
  const found = getRow(id)
  if (!found) {
    return fail(`没有找到编号为 ${id} 的管片环`)
  }
  const guard = guardAdvance(String(found.row.status), '拼装中')
  if (!guard.ok) {
    return guard
  }
  persist(found.index, { ...found.row, status: '拼装中', pending: true, abnormal: isAwaitingRework(found.row) })
  return { ok: true, message: `管片环已开始拼装，当前状态「拼装中」` }
}

/**
 * 提交验收：
 * 1. 已经验收的不许再验收（重复结论 / 重复点击都挡）；
 * 2. 只有「拼装中」能提交，跳级当场挡回并写清缺哪一步；
 * 3. 只有本拼装班组的质检员能提交，跨班组 / 越权一概驳回；
 * 4. 同一令牌只生效一次，重复提交原样退回；
 * 5. 结论与进度一笔落库，写不成整笔退回。
 */
export function submitAcceptance(input: SubmitAcceptanceInput): ActionResult {
  const found = getRow(input.id)
  if (!found) {
    return fail(`没有找到编号为 ${input.id} 的管片环`)
  }
  const { row, index } = found

  const history = acceptanceHistory(row)
  if (history.some((item) => item.token === input.token)) {
    return fail('该验收已提交过，重复提交不生效，原记录保持不变')
  }
  if (String(row.status) === '已验收') {
    return fail('管片环已验收，验收结论不得再改')
  }

  const guard = guardAdvance(String(row.status), '已验收')
  if (!guard.ok) {
    return guard
  }

  const crew = String(row['拼装班组'] ?? '')
  if (input.operator.role !== '质检员') {
    return fail(`只有质检员能提交验收（当前身份：${input.operator.role || '未知'}），越权操作驳回`)
  }
  if (input.operator.crew !== crew) {
    return fail(`只能验收本班组拼装的管片环（本环班组：${crew}，操作人班组：${input.operator.crew || '未知'}），跨班组操作驳回`)
  }

  const judgment = judge(row)
  const record: AcceptanceRecord = {
    token: input.token,
    verdict: judgment.verdict,
    standardVersion: ACTIVE_STANDARD.version,
    reasons: judgment.reasons,
    inspector: input.operator.name,
    crew,
    submittedAt: new Date().toISOString(),
  }

  // 不通过：状态退回拼装中返工；通过：推进到已验收。
  const nextStatus: SegmentStatus = judgment.verdict === '合格' ? '已验收' : '拼装中'
  const nextRow: EntryRow = {
    ...row,
    status: nextStatus,
    pending: nextStatus !== '已验收',
    abnormal: judgment.verdict === '不通过',
    验收标准版本: ACTIVE_STANDARD.version,
    验收履历: JSON.stringify([...history, record]),
  }
  try {
    persist(index, nextRow)
  } catch {
    return fail('验收结果保存失败，整笔退回，拼装进度与结论均未改动')
  }

  return judgment.verdict === '合格'
    ? { ok: true, message: `验收合格（依据 ${ACTIVE_STANDARD.version}），管片环状态推进为「已验收」` }
    : {
        ok: true,
        message: `验收不通过（依据 ${ACTIVE_STANDARD.version}）：${judgment.reasons.join('；')}。状态退回「拼装中」并已进入管片生产返工待办`,
      }
}

/**
 * 单向推进护栏：目标必须恰好是当前状态的下一步。
 * 已验收是终点，任何离开它的动作都挡回。
 */
export function guardAdvance(current: string, target: string): ActionResult {
  const from = SEGMENT_STATUSES.indexOf(current as SegmentStatus)
  const to = SEGMENT_STATUSES.indexOf(target as SegmentStatus)
  if (from < 0) {
    return fail(`当前状态「${current}」不在拼装流水线内，禁止流转`)
  }
  if (to < 0) {
    return fail(`目标状态「${target}」不在拼装流水线内，禁止流转`)
  }
  if (to === from) {
    return fail(`管片环已经是「${current}」，无需重复推进`)
  }
  if (to <= from) {
    return fail(`拼装状态只能单向推进，「${current}」不能退回「${target}」`)
  }
  if (to > from + 1) {
    const missing = SEGMENT_STATUSES.slice(from + 1, to).join('、')
    return fail(`不能从「${current}」直接跳到「${target}」，还差一步：${missing}`)
  }
  return { ok: true, message: '' }
}

/**
 * 依据现行有效标准判定：螺栓扭矩须「达标」，错台量不超过 10mm；任一不符即不通过。
 */
export function judge(row: EntryRow): { verdict: AcceptVerdict; reasons: string[] } {
  const reasons: string[] = []
  const torque = String(row['螺栓扭矩'] ?? '').trim()
  if (torque !== '达标') {
    reasons.push(`螺栓扭矩未达标（实测：${torque || '未记录'}）`)
  }
  const step = Number(row['错台量'])
  if (!Number.isFinite(step) || step > ACTIVE_STANDARD.maxStepMm) {
    const shown = Number.isFinite(step) ? `${step}mm` : '未记录'
    reasons.push(`错台量超出 ${ACTIVE_STANDARD.maxStepMm}mm 限值（实测：${shown}）`)
  }
  return reasons.length ? { verdict: '不通过', reasons } : { verdict: '合格', reasons: [] }
}

/**
 * 返工待办：验收不通过且尚未复验合格的环，管片生产台账直接取这一份。
 * 两处读的是同一份拼装记录，返工环数必然对得上。
 */
export function listReworkTodos(): ReworkTodo[] {
  const todos: ReworkTodo[] = []
  for (const row of listRows(SEGMENT_KEY)) {
    const latest = latestAcceptance(row)
    if (!latest || latest.verdict !== '不通过' || String(row.status) === '已验收') {
      continue
    }
    todos.push({
      id: Number(row.id),
      ringNo: String(row['管片环号'] ?? ''),
      crew: latest.crew,
      latestVerdict: '不通过',
      reasons: latest.reasons,
      standardVersion: latest.standardVersion,
      inspector: latest.inspector,
      submittedAt: latest.submittedAt,
    })
  }
  return todos
}

/** 返工环数：拼装报表与管片生产台账共用此计数。 */
export function reworkRingCount(): number {
  return listReworkTodos().length
}

function persist(index: number, row: EntryRow): void {
  // 展示字段「拼装状态」始终由唯一状态源派生，不允许各写各的。
  const synced: EntryRow = { ...row, 拼装状态: row.status }
  const rows = [...listRows(SEGMENT_KEY)]
  rows[index] = synced
  saveRows(SEGMENT_KEY, rows)
}
