import { defineStore } from 'pinia'

import { DEFAULT_OPERATOR, type Operator } from '@/data/segment'

export const useSessionStore = defineStore('session', {
  state: () => ({
    // 当前登录身份：是否有权提交验收，看的是这个人的角色与所属班组，而不是登录状态。
    identity: { ...DEFAULT_OPERATOR } as Operator,
    operator: DEFAULT_OPERATOR.name,
    shiftLabel: '白班 08:00-20:00',
    scope: '盾构隧道掘进施工管理平台',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    // 切换当前身份（演示跨班组/越权被挡回）。
    setIdentity(identity: Operator) {
      this.identity = { ...identity }
      this.operator = identity.name
    },
  },
})
