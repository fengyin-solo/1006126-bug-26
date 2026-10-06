<template>
  <section class="page" data-module="segment">
    <header class="page-head">
      <div>
        <h2>管片拼装管理</h2>
        <p class="page-desc">
          状态单向推进：待拼装 → 拼装中 → 已验收；验收不通过退回拼装中返工。验收结论与拼装进度写入同一条拼装记录。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出管片拼装清单</button>
      </div>
    </header>

    <!-- 当前身份：只有本拼装班组的质检员能提交验收，可切换身份当场验证越权被驳回。 -->
    <div class="identity-bar">
      <span class="identity-label">当前操作身份</span>
      <select :value="identityKey" class="identity-select" @change="switchIdentity">
        <option v-for="item in operatorOptions" :key="item.key" :value="item.key">
          {{ item.label }}
        </option>
      </select>
      <span class="identity-hint">判定标准（作数版本）：{{ criteriaVersion }}</span>
    </div>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value" :class="{ warn: item.warn }">{{ item.value }}</strong>
      </article>
    </div>

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

    <div class="split-layout">
      <table class="data-table segment-table">
        <thead>
          <tr>
            <th v-for="column in columns" :key="column">{{ column }}</th>
            <th>当前状态</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in rows"
            :key="String(row.id)"
            :class="{ 'row-selected': selectedId === Number(row.id) }"
            @click="selectRow(row)"
          >
            <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
            <td>
              <span class="status-pill" :class="statusClass(row.status)">{{ row.status }}</span>
            </td>
            <td class="row-actions" @click.stop>
              <button class="link" type="button" @click="startAssembly(row)">开始拼装</button>
              <button class="link" type="button" @click="openAccept(row)">提交验收</button>
            </td>
          </tr>
          <tr v-if="!rows.length">
            <td :colspan="columns.length + 2" class="empty-state">暂无管片拼装数据</td>
          </tr>
        </tbody>
      </table>

      <!-- 详情面板与报表读同一份 rows：列表改了状态，面板立刻一致，不会再出现两处对不上。 -->
      <aside class="detail-panel">
        <h3>管片环详情</h3>
        <template v-if="selected">
          <dl class="detail-list">
            <template v-for="column in columns" :key="column">
              <dt>{{ column }}</dt>
              <dd>{{ selected[column] ?? '—' }}</dd>
            </template>
            <dt>当前状态</dt>
            <dd><span class="status-pill" :class="statusClass(selected.status)">{{ selected.status }}</span></dd>
            <dt>最新验收结论</dt>
            <dd>{{ latest(selected)?.conclusion ?? '尚未验收' }}</dd>
            <dt>验收人</dt>
            <dd>{{ latest(selected)?.inspector ?? '—' }}</dd>
            <dt>判定标准版本</dt>
            <dd class="detail-break">{{ latest(selected)?.criteriaVersion ?? '—' }}</dd>
            <dt>返工原因</dt>
            <dd>{{ selected['返工原因'] || '—' }}</dd>
          </dl>

          <div v-if="history(selected).length" class="history-block">
            <h4>验收记录</h4>
            <ol class="history-list">
              <li v-for="event in history(selected)" :key="event.requestId">
                <span :class="event.conclusion === '合格' ? 'ok-text' : 'error-text'">
                  {{ event.conclusion }}
                </span>
                · {{ event.inspector }} · {{ formatTime(event.acceptedAt) }}
                <p v-if="event.reason" class="history-reason">{{ event.reason }}</p>
              </li>
            </ol>
          </div>

          <div v-if="hasOpenRework(selected)" class="rework-banner">
            该环存在未闭环返工待办，已同步到管片生产「返工待办」台账，复验合格后待办自动销项。
          </div>
        </template>
        <p v-else class="detail-empty">点击左侧任一行查看详情与验收记录</p>
      </aside>
    </div>

    <!-- 验收表单：结论（合格/不合格）与进度同一笔事务提交，写不成整笔退回。 -->
    <div v-if="acceptTarget" class="modal-mask" @click.self="closeAccept">
      <div class="modal-card">
        <h3>提交验收 · {{ acceptTarget['管片环号'] }}</h3>
        <p class="modal-sub">
          拼装班组：{{ acceptTarget['拼装班组'] }} ｜ 当前状态：{{ acceptTarget.status }} ｜
          质检员：{{ store.identity.name }}
        </p>
        <div class="form-row">
          <span class="form-label">验收结论</span>
          <label class="radio-line">
            <input v-model="acceptConclusion" type="radio" value="合格" /> 合格（推进至「已验收」）
          </label>
          <label class="radio-line">
            <input v-model="acceptConclusion" type="radio" value="不合格" /> 不通过（退回「拼装中」返工）
          </label>
        </div>
        <div class="form-row">
          <label class="form-label" for="rework-reason">返工/问题说明</label>
          <textarea
            id="rework-reason"
            v-model="acceptReason"
            rows="3"
            placeholder="验收不通过时必须写明缺哪一步、哪里不合格；合格可留空"
          ></textarea>
        </div>
        <p class="form-meta">判定标准：{{ criteriaVersion }} ｜ 流水号：{{ draftRequestId }}</p>
        <footer class="modal-foot">
          <span v-if="formMessage" class="error-text">{{ formMessage }}</span>
          <span class="modal-buttons">
            <button class="btn ghost" type="button" @click="closeAccept">取消</button>
            <button class="btn primary" type="button" @click="confirmAccept">提交验收</button>
          </span>
        </footer>
      </div>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条管片拼装记录，数据与管片生产「返工待办」同源</span>
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
} from '@/api/local-service'
import {
  getSegmentStats,
  listSegments,
  startAssembly as startAssemblyRequest,
  submitAcceptance,
} from '@/api/segment-service'
import {
  CURRENT_CRITERIA_VERSION,
  SWITCHABLE_OPERATORS,
  hasOpenRework,
  latestAcceptance,
  getAcceptHistory,
  type AcceptConclusion,
  type Operator,
} from '@/data/segment'
import type { EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const store = useSessionStore()
const meta = moduleMeta('segment')
const columns = ["管片环号", "管片型号", "拼装点位", "螺栓扭矩", "错台量", "拼装班组", "拼装日期", "拼装状态"]
const filterFields = ["管片环号", "拼装班组"]

const operatorOptions = SWITCHABLE_OPERATORS.map((item, index) => ({
  key: String(index),
  value: item,
  label: `${item.crew} · ${item.role} · ${item.name}`,
}))

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const selectedId = ref<number | null>(null)

const criteriaVersion = CURRENT_CRITERIA_VERSION
const identityKey = ref('0')

const stats = computed(() => {
  const summary = getSegmentStats()
  return [
    { label: '待拼装环数', value: summary.pending, warn: false },
    { label: '拼装中环数', value: summary.assembling, warn: false },
    { label: '已验收环数', value: summary.accepted, warn: false },
    { label: '返工环数（未闭环）', value: summary.rework, warn: summary.rework > 0 },
  ]
})

const statusSummary = computed(() =>
  ["待拼装", "拼装中", "已验收"].map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const selected = computed<EntryRow | null>(() =>
  selectedId.value === null ? null : rows.value.find((row) => Number(row.id) === selectedId.value) ?? null,
)

function latest(row: EntryRow) {
  return latestAcceptance(row)
}
function history(row: EntryRow) {
  return getAcceptHistory(row)
}

function statusClass(status: unknown): string {
  if (status === '已验收') return 'pill-ok'
  if (status === '拼装中') return 'pill-doing'
  return 'pill-wait'
}

function formatTime(value: string): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

function switchIdentity(event: Event) {
  const target = event.target as HTMLSelectElement
  identityKey.value = target.value
  const picked = operatorOptions[Number(target.value)]?.value as Operator | undefined
  if (picked) {
    store.setIdentity(picked)
    errorMessage.value = ''
  }
}

function selectRow(row: EntryRow) {
  selectedId.value = Number(row.id)
  errorMessage.value = ''
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function startAssembly(row: EntryRow) {
  errorMessage.value = ''
  const result = startAssemblyRequest(Number(row.id), store.identity)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

// 验收表单状态
const acceptTarget = ref<EntryRow | null>(null)
const acceptConclusion = ref<AcceptConclusion>('合格')
const acceptReason = ref('')
const draftRequestId = ref('')
const formMessage = ref('')

function openAccept(row: EntryRow) {
  // 先同步一次，保证拿到的是最新行
  selectRow(row)
  const fresh = listSegments().find((item) => Number(item.id) === Number(row.id)) ?? row
  acceptTarget.value = fresh
  acceptConclusion.value = '合格'
  acceptReason.value = ''
  formMessage.value = ''
  // 每次打开表单生成一笔新的提交流水号；同一流水号重复提交只生效一次。
  draftRequestId.value = `ACC-${fresh['管片环号']}-${Date.now()}`
}

function closeAccept() {
  acceptTarget.value = null
  formMessage.value = ''
}

function confirmAccept() {
  if (!acceptTarget.value) return
  const result = submitAcceptance({
    rowId: Number(acceptTarget.value.id),
    conclusion: acceptConclusion.value,
    reason: acceptReason.value,
    requestId: draftRequestId.value,
    operator: store.identity,
  })
  if (!result.ok) {
    // 当场挡回并写清缺哪一步/越权/重复，表单不关，提交原样退回。
    formMessage.value = result.message
    return
  }
  formMessage.value = ''
  closeAccept()
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    // 读取沿用既有拼装记录读取方式（同一个 segment 存储键，listEntries 过滤口径不变）。
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items as EntryRow[]
    total.value = payload.total
    // 详情面板基于同一份 rows 派生，选中行刷新后仍是同一对象来源。
    if (selectedId.value !== null && !rows.value.some((row) => Number(row.id) === selectedId.value)) {
      selectedId.value = null
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '管片拼装列表读取失败'
  }
}

onMounted(reload)
</script>
