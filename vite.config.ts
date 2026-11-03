import { defineConfig, type ViteDevServer, type PreviewServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import dts from 'vite-plugin-dts'
import path from 'path'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import type { IncomingMessage, ServerResponse } from 'node:http'

// Local bootstrap only. Product RPC/events go directly to the independent Host.
function hostDiscovery() {
  const middleware = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (req.url !== '/__flycut/connection') { next(); return }
    if (req.method !== 'GET' || !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host ?? '')
      || (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)) {
      res.writeHead(403); res.end(); return
    }
    try {
      const home = process.env.FLYCUT_HOST_HOME ?? path.join(homedir(), '.flycut-caption/host')
      const json = await readFile(path.join(home, 'connection.json'), 'utf8')
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(json)
    } catch { res.writeHead(503); res.end(JSON.stringify({ error: 'Start FlyCut Host with pnpm dev or pnpm host:dev' })) }
  }
  return { name: 'flycut-host-discovery',
    configureServer(server: ViteDevServer | PreviewServer) { server.middlewares.use(middleware) },
    configurePreviewServer(server: ViteDevServer | PreviewServer) { server.middlewares.use(middleware) },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const isLibrary = mode === 'library'
  // package.json 是版本号的唯一来源，src/index.ts 导出的 version 由这里注入
  const { version } = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'))

  return {
    define: {
      __FLYCUT_VERSION__: JSON.stringify(version),
    },
    plugins: [
      react(),
      tailwindcss(),
      hostDiscovery(),
      ...(isLibrary ? [dts({
        insertTypesEntry: true,
        tsconfigPath: './tsconfig.app.json',
        rollupTypes: true,
        outDir: 'dist',
        entryRoot: 'src',
        copyDtsFiles: false,
        staticImport: true
      })] : [])
    ],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    ...(isLibrary ? {
      build: {
        lib: {
          entry: path.resolve(__dirname, 'src/index.ts'),
          name: 'FlyCutCaption',
          formats: ['es'],
          fileName: () => `index.js`
        },
        rollupOptions: {
          external: [
            'react',
            'react-dom',
            'react/jsx-runtime'
          ],
          output: {
            globals: {
              'react': 'React',
              'react-dom': 'ReactDOM',
              'react/jsx-runtime': 'React.jsxRuntime'
            }
          }
        },
        cssCodeSplit: false,
        sourcemap: true,
        emptyOutDir: true
      }
    } : {})
  }
})
