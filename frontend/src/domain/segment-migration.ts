import { listRows, readMeta, saveRows, writeMeta } from '@/data/local-store'
import type { EntryRow } from '@/data/types'
import {
  ACTIVE_STANDARD,
  SEGMENT_KEY,
  SEGMENT_STATUSES,
  acceptanceHistory,
} from './segment'

/**
 * 存量管片环迁移：
 * - 按「拼装日期」升序分批回填，每批 MIGRATION_BATCH 环，进度记在 meta 里可续跑；
 * - 旧状态「已返工」并入单向流水线：回到「拼装中」并补一条 V2026-1 之前的
 *   不通过验收履历，使返工待办对存量环同样有数、两侧环数一致；
 * - 已在流水线内的状态只做幂等对齐（展示字段 / pending / abnormal），重复执行不改数据。
 */

const MIGRATION_NAME = 'segment-workflow-v1'
const MIGRATION_BATCH = 2

type MigrationCursor = {
  version: string
  // 已按拼装日期排好序的待迁移 id 队列；迁完一批弹掉一批。
  remainingIds: number[]
  done: number
}

export type MigrationProgress = {
  done: boolean
  migrated: number
  remaining: number
}

function loadCursor(): MigrationCursor | null {
  const raw = readMeta(MIGRATION_NAME)
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as { version?: string; remainingIds?: unknown; done?: number }
    if (parsed.version !== ACTIVE_STANDARD.version || !Array.isArray(parsed.remainingIds)) {
      return null
    }
    return {
      version: parsed.version,
      remainingIds: parsed.remainingIds.map((id) => Number(id)),
      done: Number(parsed.done ?? 0),
    }
  } catch {
    return null
  }
}

/** 迁移对象：所有存量环都过一遍，幂等字段对齐只写一次。 */
function buildCursor(rows: EntryRow[]): MigrationCursor {
  const sorted = [...rows].sort((a, b) =>
    String(a['拼装日期'] ?? '').localeCompare(String(b['拼装日期'] ?? '')),
  )
  return {
    version: ACTIVE_STANDARD.version,
    remainingIds: sorted.map((row) => Number(row.id)),
    done: 0,
  }
}

function migrateRow(row: EntryRow): EntryRow {
  const legacy = String(row.status)
  const history = acceptanceHistory(row)

  let status: (typeof SEGMENT_STATUSES)[number]
  if (SEGMENT_STATUSES.includes(legacy as (typeof SEGMENT_STATUSES)[number])) {
    status = legacy as (typeof SEGMENT_STATUSES)[number]
  } else if (legacy === '已返工') {
    status = '拼装中'
  } else {
    status = '待拼装'
  }

  let nextHistory = history
  if (legacy === '已返工' && !history.some((item) => item.verdict === '不通过')) {
    nextHistory = [
      ...history,
      {
        token: `migration-${Number(row.id)}`,
        verdict: '不通过' as const,
        standardVersion: '迁移前判定',
        reasons: ['存量返工环：迁移时归位为拼装中，按原返工记录继续返工'],
        inspector: '存量数据迁移',
        crew: String(row['拼装班组'] ?? ''),
        submittedAt: new Date(String(row['拼装日期'] ?? '')).toISOString(),
      },
    ]
  }

  return {
    ...row,
    status,
    pending: status !== '已验收',
    abnormal: status === '拼装中' && nextHistory.some((item) => item.verdict === '不通过'),
    拼装状态: status,
    ...(nextHistory.length ? { 验收履历: JSON.stringify(nextHistory) } : {}),
  }
}

/** 推进一步迁移（一批）。启动时反复调用到 done 即可，已完成再调零成本返回。 */
export function runSegmentMigration(): MigrationProgress {
  const rows = listRows(SEGMENT_KEY)
  const cursor = loadCursor() ?? buildCursor(rows)
  if (cursor.remainingIds.length === 0) {
    return { done: true, migrated: cursor.done, remaining: 0 }
  }

  const batch = cursor.remainingIds.slice(0, MIGRATION_BATCH)
  let migrated = 0
  const nextRows = rows.map((row) => {
    if (!batch.includes(Number(row.id))) {
      return row
    }
    migrated += 1
    return migrateRow(row)
  })

  saveRows(SEGMENT_KEY, nextRows)
  const nextCursor: MigrationCursor = {
    version: cursor.version,
    remainingIds: cursor.remainingIds.slice(MIGRATION_BATCH),
    done: cursor.done + migrated,
  }
  writeMeta(MIGRATION_NAME, JSON.stringify(nextCursor))
  return {
    done: nextCursor.remainingIds.length === 0,
    migrated: nextCursor.done,
    remaining: nextCursor.remainingIds.length,
  }
}

/** 一次性迁完存量（启动时调用）。 */
export function finishSegmentMigration(): MigrationProgress {
  let progress = runSegmentMigration()
  while (!progress.done) {
    progress = runSegmentMigration()
  }
  return progress
}

export function migrationStatus(): MigrationProgress {
  const rows = listRows(SEGMENT_KEY)
  const cursor = loadCursor()
  if (!cursor) {
    return { done: false, migrated: 0, remaining: rows.length }
  }
  return {
    done: cursor.remainingIds.length === 0,
    migrated: cursor.done,
    remaining: cursor.remainingIds.length,
  }
}
