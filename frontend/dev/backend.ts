// Dev-only Vite plugin: `npm run dev` also runs the FastAPI backend, so one command starts EarthOS.
// - Skips starting it when something already answers on the API port (e.g. a backend you started yourself).
// - Restarts it when backend Python files change (Vite's polling watcher works in OneDrive folders).
// - Stops it when the dev server exits. Set BACKEND_AUTOSTART=0 to turn this off.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { Plugin, ViteDevServer } from 'vite'

const PORT = 8000

function findPython(backendDir: string): string {
  const candidates = [
    path.join(backendDir, '.venv', 'Scripts', 'python.exe'), // Windows venv
    path.join(backendDir, '.venv', 'bin', 'python'), // macOS / Linux venv
  ]
  return candidates.find((p) => existsSync(p)) ?? (process.platform === 'win32' ? 'python' : 'python3')
}

/** Kill a process and its children. On Windows a venv's python.exe is a launcher that starts the real
 * interpreter as a child, so killing only the launcher would leave the old server holding the port. */
function killTree(p: ChildProcess) {
  if (process.platform === 'win32' && p.pid) spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' })
  else p.kill()
}

async function apiIsUp(): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(800) })
    return r.ok
  } catch {
    return false
  }
}

export function backendDevServer(): Plugin {
  let child: ChildProcess | null = null
  let stopping = false
  let restartTimer: NodeJS.Timeout | undefined

  return {
    name: 'earthos-backend',
    apply: 'serve',
    async configureServer(server: ViteDevServer) {
      if (process.env.BACKEND_AUTOSTART === '0') return
      const log = server.config.logger
      const backendDir = path.resolve(server.config.root, '..', 'backend')
      if (!existsSync(path.join(backendDir, 'app', 'main.py'))) return

      if (await apiIsUp()) {
        log.info(`  [api] backend already running on :${PORT}; not starting another`)
        return
      }

      const python = findPython(backendDir)
      const start = () => {
        child = spawn(python, ['-m', 'uvicorn', 'app.main:app', '--port', String(PORT)], {
          cwd: backendDir,
          env: { ...process.env, PYTHONUNBUFFERED: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        const relay = (buf: Buffer) => {
          for (const line of buf.toString().split(/\r?\n/)) if (line.trim()) log.info(`  [api] ${line}`)
        }
        child.stdout?.on('data', relay)
        child.stderr?.on('data', relay)
        child.on('error', (e) => {
          log.error(`  [api] could not start the backend with "${python}": ${e.message}\n` +
            '  [api] Create it with: cd backend && python -m venv .venv && .venv/Scripts/pip install -r requirements-dev.txt')
        })
        child.on('exit', (code) => {
          if (!stopping && code) log.warn(`  [api] backend exited (code ${code}); it restarts when you save a backend file`)
          child = null
        })
      }
      const stop = async () => {
        if (!child) return
        stopping = true
        killTree(child)
        child = null
        // Wait until the old server has released the port before starting the new one.
        for (let i = 0; i < 25 && (await apiIsUp()); i++) await new Promise((r) => setTimeout(r, 200))
        stopping = false
      }

      log.info(`  [api] starting backend on :${PORT} (${python})`)
      start()

      // Restart on backend code changes.
      server.watcher.add(path.join(backendDir, 'app'))
      const onFile = (file: string) => {
        if (!file.startsWith(path.join(backendDir, 'app')) || !/\.(py|toml)$/.test(file)) return
        clearTimeout(restartTimer)
        restartTimer = setTimeout(async () => {
          log.info(`  [api] ${path.relative(backendDir, file)} changed; restarting backend`)
          await stop()
          start()
        }, 300)
      }
      server.watcher.on('change', onFile)
      server.watcher.on('add', onFile)

      const shutdown = () => {
        clearTimeout(restartTimer)
        stopping = true
        if (child) killTree(child)
      }
      server.httpServer?.once('close', shutdown)
      process.once('exit', shutdown)
      for (const sig of ['SIGINT', 'SIGTERM'] as const) {
        process.once(sig, () => {
          shutdown()
          process.exit(0)
        })
      }
    },
  }
}
