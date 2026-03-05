import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  server: {
    host: "0.0.0.0",
    port: 3000,
    watch: { usePolling: true },
    // ДОБАВЬ ЭТОТ БЛОК:
    proxy: {
      '/api': {
        target: 'http://nginx', // Имя сервиса из docker-compose
        changeOrigin: true,
      }
    }
  }
})