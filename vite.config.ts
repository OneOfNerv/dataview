import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import cesium from 'vite-plugin-cesium'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    cesium(),
    tailwindcss(),
  ],
  worker: {
    format: 'es',
  },
    server: {
    host: '0.0.0.0',
    port: 5178,
    open: true,
  },
})
