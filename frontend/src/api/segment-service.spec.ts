// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { __resetStoreForTest, allRows, saveRows } from '@/data/local-store'
import { runAction } from '@/api/local-service'
import {
  ensureSegmentMigrated,
  getSegmentStats,
  listSegments,
  reworkRingCount,
  reworkTodos,
  startAssembly,
  submitAcceptance,
} from '@/api/segment-service'
import type { Operator } from '@/data/segment'
import type { EntryRow } from '@/data/types'

const 王质检: Operator = { name: '王质检', role: '质检员', crew: '拼装一班' }
const 李质检: Operator = { name: '李质检', role: '质检员', crew: '拼装二班' }
const 赵拼装: Operator = { name: '赵拼装', role: '班组长', crew: '拼装一班' }

function legacyRow(id: number, status: string, date: string, crew = '拼装一班'): EntryRow {
  return {
    id,
    status,
    pending: status !== '已验收',
    abnormal: false,
    管片环号: `R-${1000 + id}`,
    拼装班组: crew,
    拼装日期: date,
    拼装状态: status === '已返工' ? '已返工' : status,
  }
}

beforeEach(() => {
  __resetStoreForTest()
})

describe('存量迁移在服务启动时自动执行', () => {
  it('读取前按拼装日期回填，旧返工进入返工待办', () => {
    saveRows('segment', [
      legacyRow(1, '待拼装', '2026-09-12'),
      legacyRow(2, '拼装中', '2026-09-11'),
      legacyRow(3, '已返工', '2026-09-10', '拼装二班'),
      legacyRow(4, '已验收', '2026-09-01'),
    ])
    ensureSegmentMigrated()
    const rows = listSegments()
    const reworkRing = rows.find((item) => item.id === 3)
    expect(reworkRing?.status).toBe('拼装中')
    expect(reworkRing?.abnormal).toBe(true)
    expect(reworkRingCount()).toBe(1)
    expect(getSegmentStats().accepted).toBe(1)
    // 再次读取不重复迁移
    ensureSegmentMigrated()
    expect(reworkRingCount()).toBe(1)
  })
})

describe('开始拼装', () => {
  it('完整链路：待拼装→拼装中→验收合格→已验收', () => {
    saveRows('segment', [legacyRow(1, '待拼装', '2026-09-12')])
    expect(startAssembly(1, 赵拼装).ok).toBe(true)
    expect(listSegments()[0].status).toBe('拼装中')

    const accepted = submitAcceptance({
      rowId: 1, conclusion: '合格', reason: '', requestId: 'svc-1', operator: 王质检,
    })
    expect(accepted.ok, accepted.message).toBe(true)
    const row = listSegments()[0]
    expect(row.status).toBe('已验收')
    expect(row.pending).toBe(false)
    // 报表列与真实状态同源
    expect(row['拼装状态']).toBe('已验收')
    expect(row['判定标准版本']).toContain('2026-A')
  })

  it('质检员不能点开始拼装（越权），跳级提交也被挡回', () => {
    saveRows('segment', [legacyRow(1, '待拼装', '2026-09-12')])
    expect(startAssembly(1, 王质检).ok).toBe(false)
    const jump = submitAcceptance({
      rowId: 1, conclusion: '合格', reason: '', requestId: 'svc-2', operator: 王质检,
    })
    expect(jump.ok).toBe(false)
    expect(jump.message).toContain('缺步骤')
    expect(listSegments()[0].status).toBe('待拼装')
  })
})

describe('验收不通过：退回拼装中并同步管片生产返工待办', () => {
  it('两份台账读到的返工环数一致；复验合格后同步销项', () => {
    saveRows('segment', [legacyRow(1, '拼装中', '2026-09-12', '拼装二班')])
    const fail = submitAcceptance({
      rowId: 1, conclusion: '不合格', reason: '错台超限，复拼', requestId: 'svc-3', operator: 李质检,
    })
    expect(fail.ok, fail.message).toBe(true)
    expect(listSegments()[0].status).toBe('拼装中')
    // 拼装侧与生产侧共用选择器
    expect(reworkRingCount()).toBe(1)
    expect(reworkTodos()).toHaveLength(1)
    expect(reworkTodos()[0]['返工原因']).toBe('错台超限，复拼')

    const pass = submitAcceptance({
      rowId: 1, conclusion: '合格', reason: '', requestId: 'svc-4', operator: 李质检,
    })
    expect(pass.ok, pass.message).toBe(true)
    expect(reworkRingCount()).toBe(0)
    expect(listSegments()[0].status).toBe('已验收')
  })
})

describe('幂等与原子性', () => {
  it('重复提交（同一流水号）只生效一次', () => {
    saveRows('segment', [legacyRow(1, '拼装中', '2026-09-12')])
    const input = {
      rowId: 1, conclusion: '合格' as const, reason: '', requestId: 'svc-dup', operator: 王质检,
    }
    expect(submitAcceptance(input).ok).toBe(true)
    const again = submitAcceptance(input)
    expect(again.ok).toBe(false)
    expect(again.message).toContain('重复提交')
    // 只保留一笔验收
    const history = listSegments()[0]['验收历史'] as unknown[]
    expect(history).toHaveLength(1)
  })

  it('存储写失败时整笔退回，缓存数据不改动', () => {
    saveRows('segment', [legacyRow(1, '拼装中', '2026-09-12')])
    // 先让存量迁移落好，再模拟「验收这一笔」写入时存储失败。
    ensureSegmentMigrated()
    const original = JSON.stringify(allRows())
    const spy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new DOMException('QuotaExceededError', 'QuotaExceededError')
      })
    try {
      const result = submitAcceptance({
        rowId: 1, conclusion: '合格', reason: '', requestId: 'svc-fail', operator: 王质检,
      })
      expect(result.ok).toBe(false)
      expect(result.message).toContain('原样退回')
    } finally {
      spy.mockRestore()
    }
    // 内存仍是提交前的样子
    expect(listSegments()[0].status).toBe('拼装中')
    expect(JSON.stringify(allRows())).toBe(original)
  })
})

describe('通用动作入口对管片拼装关闭', () => {
  it('runAction 不再放行任何拼装状态改动', () => {
    saveRows('segment', [legacyRow(1, '待拼装', '2026-09-12')])
    const result = runAction('segment', 1, '提交验收')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('拼装专用入口')
    expect(listSegments()[0].status).toBe('待拼装')
  })
})
