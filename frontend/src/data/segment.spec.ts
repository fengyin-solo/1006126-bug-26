// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'

import { __resetStoreForTest } from '@/data/local-store'
import {
  CURRENT_CRITERIA_VERSION,
  canStartAssembly,
  getAcceptHistory,
  guardTransition,
  hasOpenRework,
  latestAcceptance,
  migrateSegmentRows,
  planAcceptance,
  selectReworkTodos,
  type Operator,
} from '@/data/segment'
import type { EntryRow } from '@/data/types'

const 王质检: Operator = { name: '王质检', role: '质检员', crew: '拼装一班' }
const 李质检: Operator = { name: '李质检', role: '质检员', crew: '拼装二班' }
const 赵拼装: Operator = { name: '赵拼装', role: '班组长', crew: '拼装一班' }
const 孙盾构: Operator = { name: '孙盾构', role: '盾构司机', crew: '掘进一班' }

function row(id: number, status: string, crew = '拼装一班', extra: Partial<EntryRow> = {}): EntryRow {
  return {
    id,
    status,
    pending: status !== '已验收',
    abnormal: false,
    拼装班组: crew,
    管片环号: `R-${id}`,
    拼装日期: '2026-09-20',
    验收历史: [],
    已提交请求号: [],
    ...extra,
  }
}

beforeEach(() => {
  __resetStoreForTest()
})

describe('单向状态机', () => {
  it('只允许 待拼装→拼装中→已验收', () => {
    expect(guardTransition('待拼装', '拼装中').ok).toBe(true)
    expect(guardTransition('拼装中', '已验收').ok).toBe(true)
  })

  it('跳级提交被挡回并写清缺哪一步', () => {
    const result = guardTransition('待拼装', '已验收')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.missing).toContain('拼装中')
    }
  })

  it('已验收没有任何出边：不许再回已验收，也不许回拼装中', () => {
    expect(guardTransition('已验收', '已验收').ok).toBe(false)
    expect(guardTransition('已验收', '拼装中').ok).toBe(false)
    expect(guardTransition('已验收', '待拼装').ok).toBe(false)
  })
})

describe('验收权限', () => {
  it('只有本拼装班组的在册质检员能验收', () => {
    const rows = [row(1, '拼装中', '拼装一班')]
    expect(planAcceptance(rows, {
      rowId: 1, conclusion: '合格', reason: '', requestId: 'a', operator: 王质检, now: '2026-09-21T00:00:00.000Z',
    }).ok).toBe(true)
  })

  it('跨班组质检员被驳回', () => {
    const rows = [row(1, '拼装中', '拼装一班')]
    const result = planAcceptance(rows, {
      rowId: 1, conclusion: '合格', reason: '', requestId: 'b', operator: 李质检, now: '2026-09-21T00:00:00.000Z',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('跨班组')
  })

  it('越权角色（其他工种）被驳回', () => {
    const rows = [row(1, '拼装中', '拼装一班')]
    const result = planAcceptance(rows, {
      rowId: 1, conclusion: '合格', reason: '', requestId: 'c', operator: 孙盾构, now: '2026-09-21T00:00:00.000Z',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('无权操作')
  })

  it('本班组拼装工不能代替质检员验收，但可以开始拼装', () => {
    const rows = [row(1, '待拼装', '拼装一班'), row(2, '拼装中', '拼装一班')]
    const denied = planAcceptance(rows, {
      rowId: 2, conclusion: '合格', reason: '', requestId: 'd', operator: 赵拼装, now: '2026-09-21T00:00:00.000Z',
    })
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.message).toContain('质检员')
    expect(canStartAssembly(rows[0], 赵拼装).ok).toBe(true)
    // 跨班组开始拼装也驳回
    expect(canStartAssembly(rows[0], { ...赵拼装, crew: '拼装二班' }).ok).toBe(false)
  })
})

describe('验收结论与流转', () => {
  it('待拼装直接提交验收：当场挡回并指出缺「拼装中」', () => {
    const rows = [row(1, '待拼装')]
    const result = planAcceptance(rows, {
      rowId: 1, conclusion: '合格', reason: '', requestId: 'e', operator: 王质检, now: '2026-09-21T00:00:00.000Z',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('缺步骤')
  })

  it('验收合格：拼装中→已验收，结论与判定版本写进同一条记录', () => {
    const rows = [row(1, '拼装中')]
    const plan = planAcceptance(rows, {
      rowId: 1, conclusion: '合格', reason: '', requestId: 'f', operator: 王质检, now: '2026-09-21T00:00:00.000Z',
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) throw new Error('应当通过')
    expect(plan.nextStatus).toBe('已验收')
    expect(plan.event.criteriaVersion).toBe(CURRENT_CRITERIA_VERSION)
  })

  it('验收不通过：退回拼装中并形成返工待办', () => {
    const rows = [row(1, '拼装中')]
    const plan = planAcceptance(rows, {
      rowId: 1, conclusion: '不合格', reason: '错台超限', requestId: 'g', operator: 王质检, now: '2026-09-21T00:00:00.000Z',
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) throw new Error('应当通过')
    expect(plan.nextStatus).toBe('拼装中')
    expect(hasOpenRework({ ...rows[0], 验收历史: [plan.event], status: '拼装中' })).toBe(true)
  })

  it('不通过但没写原因：整笔退回', () => {
    const rows = [row(1, '拼装中')]
    const result = planAcceptance(rows, {
      rowId: 1, conclusion: '不合格', reason: '   ', requestId: 'h', operator: 王质检, now: '2026-09-21T00:00:00.000Z',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('返工原因')
  })

  it('复验合格后返工待办销项', () => {
    // 先不合格
    let rows = [row(1, '拼装中')]
    const fail = planAcceptance(rows, {
      rowId: 1, conclusion: '不合格', reason: '螺栓松动', requestId: 'i1', operator: 王质检, now: '2026-09-21T00:00:00.000Z',
    })
    if (!fail.ok) throw new Error('应当通过')
    rows = [{ ...rows[0], status: '拼装中', 验收历史: [fail.event] }]
    expect(selectReworkTodos(rows)).toHaveLength(1)
    // 复验合格
    const pass = planAcceptance(rows, {
      rowId: 1, conclusion: '合格', reason: '', requestId: 'i2', operator: 王质检, now: '2026-09-22T00:00:00.000Z',
    })
    expect(pass.ok).toBe(true)
    if (!pass.ok) throw new Error('复验应当通过')
    const done = { ...rows[0], status: '已验收', 验收历史: [fail.event, pass.event] }
    expect(hasOpenRework(done)).toBe(false)
    expect(latestAcceptance(done)?.conclusion).toBe('合格')
    // 历史仍保留不合格那一笔，可追溯
    expect(getAcceptHistory(done)).toHaveLength(2)
  })

  it('已验收再次提交验收：不许再回到已验收', () => {
    const rows = [row(1, '已验收')]
    const result = planAcceptance(rows, {
      rowId: 1, conclusion: '合格', reason: '', requestId: 'j', operator: 王质检, now: '2026-09-21T00:00:00.000Z',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('已经验收')
  })
})

describe('幂等：重复提交只生效一次', () => {
  it('同一流水号重放被识别为重复提交', () => {
    const rows = [row(1, '拼装中')]
    const req = {
      rowId: 1, conclusion: '合格' as const, reason: '', requestId: 'dup-1', operator: 王质检, now: '2026-09-21T00:00:00.000Z',
    }
    expect(planAcceptance(rows, req).ok).toBe(true)
    const stored = { ...rows[0], 验收历史: [
      { requestId: 'dup-1', conclusion: '合格', reason: '', inspector: '王质检', crew: '拼装一班', criteriaVersion: CURRENT_CRITERIA_VERSION, acceptedAt: req.now },
    ] }
    const again = planAcceptance([stored], req)
    expect(again.ok).toBe(false)
    if (!again.ok) {
      expect(again.duplicate).toBe(true)
      expect(again.message).toContain('重复提交')
    }
  })
})

describe('存量迁移回填', () => {
  it('旧状态「已返工」退回拼装中并补不合格结论', () => {
    const legacy: EntryRow[] = [row(9, '已返工', '拼装二班', { 拼装日期: '2026-09-10' })]
    const [migrated] = migrateSegmentRows(legacy)
    expect(migrated.status).toBe('拼装中')
    expect(migrated['拼装状态']).toBe('拼装中')
    expect(hasOpenRework(migrated)).toBe(true)
    expect(latestAcceptance(migrated)?.criteriaVersion).toBe(CURRENT_CRITERIA_VERSION)
  })

  it('已验收存量环回填合格结论，待拼装保持无验收', () => {
    const legacy: EntryRow[] = [
      row(1, '已验收', '拼装一班', { 拼装日期: '2026-09-01' }),
      row(2, '待拼装', '拼装一班', { 拼装日期: '2026-09-12' }),
    ]
    const migrated = migrateSegmentRows(legacy)
    expect(migrated[0].status).toBe('已验收')
    expect(latestAcceptance(migrated[0])?.conclusion).toBe('合格')
    expect(getAcceptHistory(migrated[1])).toHaveLength(0)
  })

  it('按拼装日期从早到晚处理且迁移幂等', () => {
    const legacy: EntryRow[] = [
      row(1, '已验收', '拼装一班', { 拼装日期: '2026-09-12' }),
      row(2, '已验收', '拼装一班', { 拼装日期: '2026-09-01' }),
    ]
    const once = migrateSegmentRows(legacy)
    const twice = migrateSegmentRows(once)
    // 顺序不变、内容不重复追加
    expect(twice.map((item) => item.id)).toEqual([1, 2])
    expect(getAcceptHistory(twice[0])).toHaveLength(1)
    expect(getAcceptHistory(twice[1])).toHaveLength(1)
  })
})
