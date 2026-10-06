<template>
  <section class="page" data-module="segment">
    <header class="page-head">
      <div>
        <h2>管片拼装管理</h2>
        <p class="page-desc">
          状态单向推进：待拼装 → 拼装中 → 已验收；验收不通过退回拼装中并进入管片生产返工待办。
          验收依据《{{ standardName }} {{ standardVersion }}》。
        </p>
      </div>
      <div class="page-actions">
        <label class="operator-switch">
          当前操作人
          <select :value="store.operator" @change="switchOperator(($event.target as HTMLSelectElement).value)">
            <option v-for="item in operators" :key="item.name" :value="item.name">{{ item.name }}</option>
          </select>
        </label>
        <button class="btn" type="button" @click="exportRows">导出管片拼装清单</button>
      </div>
    </header>

    <!-- 报表统计：与下方表格、右侧详情、管片生产台账读的是同一份拼装记录 -->
    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item">判定标准作数版本：{{ standardVersion }}</span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <div class="segment-layout">
      <table class="data-table">
        <thead>
          <tr>
            <th v-for="column in columns" :key="column">{{ column }}</th>
            <th>当前状态</th>
            <th>验收结论</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="String(row.id)" :class="{ selected: selectedId === row.id }">
            <td v-for="column in columns" :key="column">{{ row[column] || '—' }}</td>
            <td>
              <button class="link" type="button" @click="selectRow(row)">{{ row.status }}</button>
            </td>
            <td>
              <template v-if="latestOf(row)">
                <span :class="latestOf(row)?.verdict === '合格' ? 'pass-text' : 'fail-text'">
                  {{ latestOf(row)?.verdict }}
                </span>
                <span class="muted-text">（{{ latestOf(row)?.standardVersion }}）</span>
              </template>
              <span v-else class="muted-text">未验收</span>
            </td>
            <td class="row-actions">
              <button
                v-if="String(row.status) === '待拼装'"
                class="link"
                type="button"
                @click="doStart(row)"
              >
                开始拼装
              </button>
              <button
                v-if="String(row.status) === '拼装中'"
                class="link"
                type="button"
                @click="openAcceptance(row)"
              >
                提交验收
              </button>
              <span v-if="String(row.status) === '已验收'" class="muted-text">—</span>
            </td>
          </tr>
          <tr v-if="!rows.length">
            <td :colspan="columns.length + 3" class="empty-state">暂无管片拼装数据</td>
          </tr>
        </tbody>
      </table>

      <!-- 详情面板：与列表同一份数据，点击状态打开 -->
      <aside v-if="selected" class="detail-panel">
        <h3>管片环详情</h3>
        <dl class="detail-list">
          <div v-for="column in columns" :key="column">
            <dt>{{ column }}</dt>
            <dd>{{ selected[column] || '—' }}</dd>
          </div>
          <div>
            <dt>当前状态</dt>
            <dd>{{ selected.status }}</dd>
          </div>
        </dl>
        <h4>验收履历</h4>
        <ul v-if="historyOf(selected).length" class="history-list">
          <li v-for="(item, index) in historyOf(selected)" :key="item.token || index">
            <span :class="item.verdict === '合格' ? 'pass-text' : 'fail-text'">{{ item.verdict }}</span>
            <span class="muted-text">
              {{ item.standardVersion }} · {{ item.inspector }} · {{ formatTime(item.submittedAt) }}
            </span>
            <p v-if="item.reasons.length" class="fail-text">{{ item.reasons.join('；') }}</p>
          </li>
        </ul>
        <p v-else class="muted-text">暂无验收记录</p>
        <button class="btn ghost" type="button" @click="selectedId = null">关闭面板</button>
      </aside>
    </div>

    <!-- 验收单：一张单子一个令牌，重复提交只生效一次 -->
    <div v-if="acceptTarget" class="modal-mask" @click.self="closeAcceptance">
      <div class="modal-card">
        <h3>提交验收单 · {{ acceptTarget['管片环号'] }}</h3>
        <p class="muted-text">
          验收依据《{{ standardName }} {{ standardVersion }}》：螺栓扭矩须「达标」，
          错台量不超过 10mm，任一不符即验收不通过，状态退回「拼装中」。
        </p>
        <dl class="detail-list">
          <div><dt>拼装班组</dt><dd>{{ acceptTarget['拼装班组'] }}</dd></div>
          <div><dt>螺栓扭矩</dt><dd>{{ acceptTarget['螺栓扭矩'] || '未记录' }}</dd></div>
          <div><dt>错台量</dt><dd>{{ acceptTarget['错台量'] === '' ? '未记录' : `${acceptTarget['错台量']}mm` }}</dd></div>
          <div><dt>提交人</dt><dd>{{ store.operator }}（{{ store.role }}{{ store.crew ? ` · ${store.crew}` : '' }}）</dd></div>
        </dl>
        <p class="muted-text">验收单编号：{{ acceptToken }}</p>
        <footer class="modal-actions">
          <button class="btn" type="button" :disabled="submitting" @click="closeAcceptance">取消</button>
          <button class="btn primary" type="button" :disabled="submitting" @click="confirmAcceptance">
            {{ submitting ? '提交中…' : '确认提交验收' }}
          </button>
        </footer>
      </div>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条管片拼装记录</span>
      <span v-if="message" :class="messageOk ? 'pass-text' : 'error-text'">{{ message }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  setSegmentOperator,
} from '@/api/local-service'
import {
  ACTIVE_STANDARD,
  acceptanceHistory,
  latestAcceptance,
  reworkRingCount,
  startAssemble,
  submitAcceptance,
} from '@/domain/segment'
import type { AcceptanceRecord } from '@/domain/segment'
import { useSessionStore, OPERATORS } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('segment')
const columns = ['管片环号', '管片型号', '拼装点位', '螺栓扭矩', '错台量', '拼装班组', '拼装日期', '拼装状态']
const statuses = ['待拼装', '拼装中', '已验收']
const operators = OPERATORS
const standardName = ACTIVE_STANDARD.name
const standardVersion = ACTIVE_STANDARD.version

const store = useSessionStore()
const rows = ref<EntryRow[]>([])
const total = ref(0)
const message = ref('')
const messageOk = ref(false)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const selectedId = ref<number | null>(null)
const acceptTarget = ref<EntryRow | null>(null)
const acceptToken = ref('')
const submitting = ref(false)

const selected = computed(() =>
  selectedId.value === null ? null : rows.value.find((row) => Number(row.id) === selectedId.value) ?? null,
)

const stats = computed(() => [
  { label: '待拼装环数', value: rows.value.filter((row) => String(row.status) === '待拼装').length },
  { label: '拼装中环数', value: rows.value.filter((row) => String(row.status) === '拼装中').length },
  { label: '已验收环数', value: rows.value.filter((row) => String(row.status) === '已验收').length },
  { label: '返工环数', value: reworkRingCount() },
])

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function latestOf(row: EntryRow): AcceptanceRecord | null {
  return latestAcceptance(row)
}

function historyOf(row: EntryRow): AcceptanceRecord[] {
  return acceptanceHistory(row)
}

function formatTime(value: string): string {
  const time = Date.parse(value)
  return Number.isNaN(time) ? value : new Date(time).toLocaleString('zh-CN', { hour12: false })
}

function switchOperator(name: string) {
  store.setOperator(name)
  setSegmentOperator({ name: store.operator, role: store.role, crew: store.crew })
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function selectRow(row: EntryRow) {
  selectedId.value = Number(row.id)
}

function notify(ok: boolean, text: string) {
  messageOk.value = ok
  message.value = text
}

function doStart(row: EntryRow) {
  const result = startAssemble(Number(row.id))
  notify(result.ok, result.message)
  reload()
}

/** 打开一张新验收单：令牌此刻生成一次，重试提交沿用它，保证重复提交只生效一次。 */
function openAcceptance(row: EntryRow) {
  acceptTarget.value = row
  acceptToken.value = `acc-${Number(row.id)}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function closeAcceptance() {
  if (submitting.value) {
    return
  }
  acceptTarget.value = null
  acceptToken.value = ''
}

function confirmAcceptance() {
  if (!acceptTarget.value) {
    return
  }
  submitting.value = true
  const result = submitAcceptance({
    id: Number(acceptTarget.value.id),
    operator: { name: store.operator, role: store.role, crew: store.crew },
    token: acceptToken.value,
  })
  submitting.value = false
  notify(result.ok, result.message)
  acceptTarget.value = null
  acceptToken.value = ''
  reload()
}

function reload() {
  message.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    if (selectedId.value !== null && !rows.value.some((row) => Number(row.id) === selectedId.value)) {
      selectedId.value = null
    }
  } catch (error) {
    notify(false, error instanceof Error ? error.message : '管片拼装列表读取失败')
  }
}

onMounted(() => {
  setSegmentOperator({ name: store.operator, role: store.role, crew: store.crew })
  reload()
})
</script>

<style scoped>
.segment-layout {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
.data-table {
  flex: 1;
}
.data-table tr.selected td {
  background: #eef4ff;
}
.detail-panel {
  width: 300px;
  flex: none;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #fff;
  padding: 12px;
  position: sticky;
  top: 12px;
}
.detail-panel h3,
.detail-panel h4 {
  margin: 0 0 8px;
}
.detail-list {
  margin: 0 0 10px;
}
.detail-list div {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 13px;
  padding: 3px 0;
  border-bottom: 1px dashed var(--border);
}
.detail-list dt {
  color: var(--muted);
}
.detail-list dd {
  margin: 0;
  text-align: right;
}
.history-list {
  list-style: none;
  margin: 0 0 10px;
  padding: 0;
  font-size: 13px;
}
.history-list li {
  padding: 6px 0;
  border-bottom: 1px dashed var(--border);
}
.history-list p {
  margin: 2px 0 0;
}
.pass-text {
  color: #067647;
}
.fail-text {
  color: #b42318;
}
.muted-text {
  color: var(--muted);
  font-size: 12px;
}
.operator-switch {
  font-size: 12px;
  color: var(--muted);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
}
.modal-card {
  width: 460px;
  background: #fff;
  border-radius: 10px;
  padding: 18px;
}
.modal-card h3 {
  margin: 0 0 8px;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}
.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
