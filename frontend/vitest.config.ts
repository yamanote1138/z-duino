import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import ui from '@nuxt/ui/vite'

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify('test')
  },
  plugins: [vue(), ui({ colorMode: false })],
  test: {
    environment: 'happy-dom',
    setupFiles: ['./test/setup.ts']
  }
})
