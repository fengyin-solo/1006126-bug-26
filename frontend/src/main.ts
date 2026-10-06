import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import { ensureSegmentMigrated } from './api/segment-service'
import './styles/global.css'

// 存量管片环按拼装日期迁移回填，先迁移再挂页面，保证首屏读到的就是同一份新结构。
ensureSegmentMigrated()

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
