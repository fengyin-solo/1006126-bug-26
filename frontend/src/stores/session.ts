import { defineStore } from 'pinia'

// 可切换的操作人：用于演示验收权限——只有本拼装班组的质检员能提交验收。
export const OPERATORS = [
  { name: '王质检（拼装一班）', role: '质检员', crew: '拼装一班' },
  { name: '李质检（拼装二班）', role: '质检员', crew: '拼装二班' },
  { name: '赵质检（拼装三班）', role: '质检员', crew: '拼装三班' },
  { name: '孙测量（拼装一班）', role: '测量员', crew: '拼装一班' },
  { name: '值班管理员', role: '值班管理员', crew: '' },
] as const

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '王质检（拼装一班）',
    role: '质检员' as string,
    crew: '拼装一班' as string,
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
    setOperator(name: string) {
      const found = OPERATORS.find((item) => item.name === name)
      this.operator = name
      this.role = found ? found.role : '值班管理员'
      this.crew = found ? found.crew : ''
    },
  },
})
