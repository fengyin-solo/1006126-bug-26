import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import './styles/global.css'
import { finishSegmentMigration } from './domain/segment-migration'

// 存量管片环按拼装日期迁移回填到单向流水线，刷新幂等、可续跑。
finishSegmentMigration()

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
