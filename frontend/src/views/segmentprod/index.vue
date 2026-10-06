<template>
  <section class="page" data-module="segmentprod">
    <header class="page-head">
      <div>
        <h2>管片生产管理</h2>
        <p class="page-desc">维护管片，围绕管片编号、管片型号、生产模具、钢筋笼批号做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记管片</button>
        <button class="btn" type="button" @click="exportRows">导出管片生产清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <!-- 返工待办取管片拼装的同一份记录，与拼装报表返工环数一致 -->
    <section class="rework-box">
      <header class="rework-head">
        <h3>管片返工待办（源自管片拼装验收结论）</h3>
        <span class="muted-text">待返工环数：{{ reworkTodos.length }}</span>
      </header>
      <table v-if="reworkTodos.length" class="data-table rework-table">
        <thead>
          <tr><th>管片环号</th><th>拼装班组</th><th>不通过原因</th><th>判定版本</th><th>验收人</th><th>验收时间</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in reworkTodos" :key="item.id">
            <td>{{ item.ringNo }}</td>
            <td>{{ item.crew }}</td>
            <td>{{ item.reasons.join('；') }}</td>
            <td>{{ item.standardVersion }}</td>
            <td>{{ item.inspector }}</td>
            <td>{{ formatTime(item.submittedAt) }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty-state">当前没有验收不通过的管片环，返工待办为空</p>
    </section>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无管片生产数据，可先登记管片</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条管片生产记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { listReworkTodos } from '@/domain/segment'
import type { ReworkTodo } from '@/domain/segment'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('segmentprod')
const columns = ["管片编号", "管片型号", "生产模具", "钢筋笼批号", "养护天数", "出厂强度", "检验人员", "生产状态"]
const actions = ["开始浇筑", "确认养护", "办理出厂"]
const statuses = ["待浇筑", "养护中", "待出厂", "已出厂"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

// 返工待办与返工环数：直接从管片拼装记录读取，不在这里另存一份。
const reworkTodos = ref<ReworkTodo[]>([])
const stats = computed(() => [
  {"label": "养护中管片", "value": rows.value.filter((row) => String(row.status) === '养护中').length},
  {"label": "待出厂管片", "value": rows.value.filter((row) => String(row.status) === '待出厂').length},
  {"label": "返工待办环数", "value": reworkTodos.value.length},
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function formatTime(value: string): string {
  const time = Date.parse(value)
  return Number.isNaN(time) ? value : new Date(time).toLocaleString('zh-CN', { hour12: false })
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '管片登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    reworkTodos.value = listReworkTodos()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '管片生产列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.rework-box {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #fff;
  padding: 10px 12px;
  margin-bottom: 12px;
}
.rework-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 8px;
}
.rework-head h3 {
  margin: 0;
  font-size: 14px;
}
.rework-table {
  margin-top: 6px;
}
.muted-text {
  color: var(--muted);
  font-size: 12px;
}
</style>
