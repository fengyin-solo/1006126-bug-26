import type { EntryRow } from './types'

// 管片拼装领域：状态机、验收权限、判定标准版本、返工待办、存量迁移都收在这一份里。
// 页面和服务不做业务判断，只调用这里的纯函数，保证「推进有护栏、两处一份数据」。

export const SEGMENT_MODULE_KEY = 'segment'
export const SEGMENT_RECORD_VERSION = 2

// 状态只能沿这条链单向推进：待拼装 → 拼装中 → 已验收。
// 「已返工」不是状态——验收不通过时环退回「拼装中」返工，是否处于返工由最新验收结论派生。
export const SEGMENT_STATUSES = ['待拼装', '拼装中', '已验收'] as const
export type SegmentStatus = (typeof SEGMENT_STATUSES)[number]

export const SEGMENT_FIELDS = [
  '管片环号',
  '管片型号',
  '拼装点位',
  '螺栓扭矩',
  '错台量',
  '拼装班组',
  '拼装日期',
  '拼装状态',
] as const

// 合法流转：键为当前状态，值为允许到达的状态。
// 「已验收」没有任何出边——已经验收的不许再回到已验收，也不许回到拼装中。
const ALLOWED_TRANSITIONS: Record<SegmentStatus, SegmentStatus[]> = {
  待拼装: ['拼装中'],
  拼装中: ['已验收', '拼装中'],
  已验收: [],
}

export type AcceptConclusion = '合格' | '不合格'

export type AcceptEvent = {
  requestId: string
  conclusion: AcceptConclusion
  reason: string
  inspector: string
  crew: string
  criteriaVersion: string
  acceptedAt: string
}

export type Operator = {
  name: string
  role: string
  crew: string
}

// 判定标准：当前以「盾构隧道管片拼装质量验收标准 2026-A 版」作数；
// 后续换版只改这里，存量记录保留验收当时的版本号，不回改历史。
export const CURRENT_CRITERIA_VERSION = '盾构隧道管片拼装质量验收标准 2026-A 版'

// 质检员名册：只有「本拼装班组」的在册质检员能提交验收。
// 拼装班组成员（工种含拼装）可以开始拼装；其他班组、其他角色一律越权驳回。
type CrewProfile = { name: string; roles: string[] }
export const ASSEMBLY_CREWS: Record<string, CrewProfile[]> = {
  拼装一班: [
    { name: '王质检', roles: ['质检员'] },
    { name: '赵拼装', roles: ['拼装工', '班组长'] },
  ],
  拼装二班: [
    { name: '李质检', roles: ['质检员'] },
    { name: '钱拼装', roles: ['拼装工', '班组长'] },
  ],
}

export const DEFAULT_OPERATOR: Operator = {
  name: '王质检',
  role: '质检员',
  crew: '拼装一班',
}

// 可用于演示的身份：含跨班组质检员、别的工种，用来当场验证越权被驳回。
export const SWITCHABLE_OPERATORS: Operator[] = [
  DEFAULT_OPERATOR,
  { name: '李质检', role: '质检员', crew: '拼装二班' },
  { name: '赵拼装', role: '班组长', crew: '拼装一班' },
  { name: '孙盾构', role: '盾构司机', crew: '掘进一班' },
]

export function isCrewInspector(operator: Operator, crew: string): boolean {
  if (operator.crew !== crew || operator.role !== '质检员') {
    return false
  }
  return (ASSEMBLY_CREWS[crew] ?? []).some(
    (member) => member.name === operator.name && member.roles.includes('质检员'),
  )
}

function isCrewAssembler(operator: Operator, crew: string): boolean {
  if (operator.crew !== crew) {
    return false
  }
  return (ASSEMBLY_CREWS[crew] ?? []).some(
    (member) => member.name === operator.name && member.roles.includes('拼装工'),
  )
}

function normalizeStatus(value: unknown): SegmentStatus {
  return value === '拼装中' || value === '已验收' ? value : '待拼装'
}

function getCrew(row: EntryRow): string {
  return String(row['拼装班组'] ?? '')
}

export function getStatus(row: EntryRow): SegmentStatus {
  return normalizeStatus(row.status)
}

export function getAcceptHistory(row: EntryRow): AcceptEvent[] {
  const history = row['验收历史']
  return Array.isArray(history) ? (history as AcceptEvent[]) : []
}

// 最新一次验收结论；没有验过收就是 null。
export function latestAcceptance(row: EntryRow): AcceptEvent | null {
  const history = getAcceptHistory(row)
  return history.length ? history[history.length - 1] : null
}

// 返工待办：最新一次验收不通过且环还停在拼装中（即尚未复验合格）。
// 管片生产页与拼装页都从这一个函数取数，两边读到的返工环数必然一致。
export function hasOpenRework(row: EntryRow): boolean {
  return getStatus(row) === '拼装中' && latestAcceptance(row)?.conclusion === '不合格'
}

// 异常态：存在未闭环返工待办。供总览复用。
export function isSegmentAbnormal(row: EntryRow): boolean {
  return hasOpenRework(row)
}

// 统一推进护栏：返回目标状态是否合法；不合法时带上缺的那一步说明。
export function guardTransition(
  current: SegmentStatus,
  target: SegmentStatus,
): { ok: true } | { ok: false; missing?: string } {
  if (current === target) {
    return { ok: false }
  }
  if (ALLOWED_TRANSITIONS[current].includes(target)) {
    return { ok: true }
  }
  const currentIndex = SEGMENT_STATUSES.indexOf(current)
  const targetIndex = SEGMENT_STATUSES.indexOf(target)
  if (targetIndex < currentIndex) {
    // 已验收 → 任何更早状态都在这里被挡住（已验收无出边）。
    return { ok: false, missing: `「${current}」不能逆向流转到「${target}」` }
  }
  const missingSteps = SEGMENT_STATUSES.slice(currentIndex + 1, targetIndex)
  return {
    ok: false,
    missing:
      missingSteps.length > 0
        ? `缺步骤：${missingSteps.join('、')}，不能从「${current}」直接跳到「${target}」`
        : `当前「${current}」不允许流转到「${target}」`,
  }
}

export type StartResult =
  | { ok: true; status: SegmentStatus }
  | { ok: false; message: string }

// 开始拼装：待拼装 → 拼装中，仅本班组装人员可操作。
export function canStartAssembly(row: EntryRow, operator: Operator): StartResult {
  const current = getStatus(row)
  if (current !== '待拼装') {
    return {
      ok: false,
      message:
        current === '已验收'
          ? '该环已验收，不能重新开始拼装'
          : `该环已在「${current}」，无需重复开始拼装`,
    }
  }
  const crew = getCrew(row)
  if (!isCrewAssembler(operator, crew)) {
    return {
      ok: false,
      message: `只有「${crew}」的拼装班组成员能开始拼装，${operator.crew}·${operator.role}·${operator.name}无权操作`,
    }
  }
  return { ok: true, status: '拼装中' }
}

export type AcceptRequest = {
  rowId: number
  conclusion: AcceptConclusion
  reason: string
  requestId: string
  operator: Operator
  now: string
}

export type AcceptPlan =
  | {
      ok: true
      row: EntryRow
      nextStatus: SegmentStatus
      event: AcceptEvent
      duplicate?: never
    }
  | { ok: false; message: string; duplicate?: boolean }

// 规划一笔验收，不做任何写入。校验顺序即提交时的拦截顺序：
// 幂等（重复提交只生效一次）→ 权限（本班质检员）→ 护栏（单向推进、不许跳级/回流）→ 结论。
export function planAcceptance(rows: EntryRow[], request: AcceptRequest): AcceptPlan {
  const row = rows.find((item) => Number(item.id) === request.rowId)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${request.rowId} 的管片环` }
  }

  // 同一请求号重放：直接原样返回首次结果，不再生效第二次。
  const existing = getAcceptHistory(row).find((event) => event.requestId === request.requestId)
  if (existing) {
    return {
      ok: false,
      duplicate: true,
      message: `该验收提交（流水号 ${request.requestId}）已生效，结论「${existing.conclusion}」，重复提交不再受理`,
    }
  }

  const crew = getCrew(row)
  if (!isCrewInspector(request.operator, crew)) {
    if (request.operator.role !== '质检员') {
      return {
        ok: false,
        message: `只有质检员能提交验收，${request.operator.role}·${request.operator.name}无权操作`,
      }
    }
    return {
      ok: false,
      message: `只有本拼装班组（${crew}）的质检员能提交验收，${request.operator.crew}质检员${request.operator.name}跨班组操作被驳回`,
    }
  }

  const current = getStatus(row)
  // 不合格：验收不通过时状态退回/留在「拼装中」返工。
  // 拼装中→拼装中 是返工退回的合法自环（验收结论本身是新事件），不走推进护栏；
  // 合格才沿单向链推进到「已验收」，需要护栏挡跳级。
  if (request.conclusion === '不合格') {
    if (current === '待拼装') {
      return {
        ok: false,
        message:
          '跳级提交当场挡回：该环尚在「待拼装」，缺步骤「拼装中」，必须先开始拼装并完成拼装后才能提交验收',
      }
    }
    if (current === '已验收') {
      return {
        ok: false,
        message:
          '该环已经验收合格，不许再次提交验收，更不能退回已验收/拼装中；如需处理请走复验外的流程',
      }
    }
  } else {
    const guard = guardTransition(current, '已验收')
    if (!guard.ok) {
      if (current === '已验收') {
        return {
          ok: false,
          message:
            '该环已经验收合格，不许再次提交验收，更不能退回已验收/拼装中；如需处理请走复验外的流程',
        }
      }
      if (current === '待拼装') {
        return {
          ok: false,
          message:
            '跳级提交当场挡回：该环尚在「待拼装」，缺步骤「拼装中」，必须先开始拼装并完成拼装后才能提交验收',
        }
      }
      return { ok: false, message: guard.missing ?? '当前状态不允许提交验收' }
    }
  }

  if (request.conclusion !== '合格' && request.conclusion !== '不合格') {
    return { ok: false, message: '验收结论必须是「合格」或「不合格」' }
  }
  if (request.conclusion === '不合格' && request.reason.trim() === '') {
    return { ok: false, message: '验收不通过必须写明返工原因，整笔退回' }
  }

  const event: AcceptEvent = {
    requestId: request.requestId,
    conclusion: request.conclusion,
    reason: request.reason.trim(),
    inspector: request.operator.name,
    crew,
    criteriaVersion: CURRENT_CRITERIA_VERSION,
    acceptedAt: request.now,
  }
  const nextStatus: SegmentStatus = request.conclusion === '合格' ? '已验收' : '拼装中'
  return { ok: true, row, nextStatus, event }
}

// 按规划结果生成新行（不修改入参）：结论与进度落在同一条记录里，一起写。
export function applyAcceptPlan(row: EntryRow, plan: Extract<AcceptPlan, { ok: true }>): EntryRow {
  const history = [...getAcceptHistory(row), plan.event]
  const nextStatus = plan.nextStatus
  return {
    ...row,
    status: nextStatus,
    pending: nextStatus !== '已验收',
    abnormal: isSegmentAbnormal({ ...row, status: nextStatus, 验收历史: history }),
    // 列表里的「拼装状态」列与真实 status 同源同步，报表与详情不会再对不上。
    拼装状态: nextStatus,
    验收时间: plan.event.acceptedAt,
    验收结论: plan.event.conclusion,
    验收人: plan.event.inspector,
    判定标准版本: plan.event.criteriaVersion,
    返工原因: plan.event.conclusion === '不合格' ? plan.event.reason : '',
    验收历史: history,
    已提交请求号: dedupedRequestIds(row, plan.event.requestId),
    _recordVersion: SEGMENT_RECORD_VERSION,
  }
}

function dedupedRequestIds(row: EntryRow, requestId: string): string[] {
  const raw = row['已提交请求号']
  const list = Array.isArray(raw) ? (raw as string[]) : []
  return list.includes(requestId) ? list : [...list, requestId]
}

// 存量管片环按拼装日期迁移回填：先按拼装日期从早到晚排序处理，只做补齐不改写业务结论。
export function migrateSegmentRows(rows: EntryRow[]): EntryRow[] {
  const order = rows
    .map((row, index) => ({ row, index, date: String(row['拼装日期'] ?? '') }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.index - b.index))

  const migrated = order.map(({ row }) => migrateOne(row))
  // 按原顺序放回，只改内容不重排。
  const result: EntryRow[] = new Array(rows.length)
  migrated.forEach((row, position) => {
    result[order[position].index] = row
  })
  return result
}

function migrateOne(raw: EntryRow): EntryRow {
  if (Number(raw['_recordVersion']) >= SEGMENT_RECORD_VERSION) {
    return raw
  }
  const row: EntryRow = { ...raw }
  const rawStatus = String(row.status ?? '')

  // 旧版「已返工」是状态外的脏值：验收不通过应退回拼装中。
  const status: SegmentStatus = normalizeStatus(rawStatus === '已返工' ? '拼装中' : rawStatus)
  const assembleDate = String(row['拼装日期'] ?? '')

  let history: AcceptEvent[] = []
  let abnormal = false
  let reworkReason = ''

  if (rawStatus === '已返工') {
    // 旧的返工记录：补一笔「不合格」结论，状态退回拼装中，形成未闭环返工待办。
    history = [
      {
        requestId: `migration-${row.id}-1`,
        conclusion: '不合格',
        reason: '存量迁移：历史返工记录回填，待复验',
        inspector: String(row['验收人'] ?? '存量数据回填'),
        crew: getCrew(row),
        criteriaVersion: CURRENT_CRITERIA_VERSION,
        acceptedAt: assembleDate,
      },
    ]
    abnormal = true
    reworkReason = '存量迁移：历史返工记录回填，待复验'
  } else if (status === '已验收') {
    // 存量已验收环：回填一笔合格结论与作数标准版本。
    history = [
      {
        requestId: `migration-${row.id}-1`,
        conclusion: '合格',
        reason: '存量迁移：已验收环回填',
        inspector: String(row['验收人'] ?? '存量数据回填'),
        crew: getCrew(row),
        criteriaVersion: CURRENT_CRITERIA_VERSION,
        acceptedAt: assembleDate,
      },
    ]
  }

  return {
    ...row,
    status,
    pending: status !== '已验收',
    abnormal,
    拼装状态: status,
    验收历史: history,
    已提交请求号: [] as string[],
    验收时间: history.length ? history[0].acceptedAt : '',
    验收结论: history.length ? history[0].conclusion : '',
    验收人: history.length ? history[0].inspector : '',
    判定标准版本: history.length ? CURRENT_CRITERIA_VERSION : '',
    返工原因: reworkReason,
    _recordVersion: SEGMENT_RECORD_VERSION,
  }
}

// 返工待办选择器：管片拼装页与管片生产页共用这一份口径。
export function selectReworkTodos(rows: EntryRow[]): EntryRow[] {
  return rows.filter(hasOpenRework)
}

export function countReworkRings(rows: EntryRow[]): number {
  return selectReworkTodos(rows).length
}

export type SegmentStats = {
  pending: number
  assembling: number
  accepted: number
  rework: number
}

export function segmentStats(rows: EntryRow[]): SegmentStats {
  return {
    pending: rows.filter((row) => getStatus(row) === '待拼装').length,
    assembling: rows.filter((row) => getStatus(row) === '拼装中' && !hasOpenRework(row)).length,
    accepted: rows.filter((row) => getStatus(row) === '已验收').length,
    rework: countReworkRings(rows),
  }
}
