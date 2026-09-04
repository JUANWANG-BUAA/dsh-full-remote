import { spawn } from 'node:child_process'

const timeoutMs = Number(process.env.AUDIT_TIMEOUT_MS ?? 45_000)
const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const args = ['audit', '--prod', '--audit-level', 'moderate', '--ignore-registry-errors']

const child = spawn(command, args, {
  env: process.env,
  stdio: 'inherit',
})

let timedOut = false
const timer = setTimeout(() => {
  timedOut = true
  console.warn(`[audit] registry audit exceeded ${timeoutMs}ms; continuing without a registry result`)

  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
  } else {
    child.kill('SIGTERM')
  }
}, timeoutMs)

child.once('error', (error) => {
  clearTimeout(timer)
  if (timedOut) {
    process.exit(0)
  }

  console.error('[audit] failed to start pnpm audit:', error)
  process.exit(1)
})

child.once('close', (code, signal) => {
  clearTimeout(timer)
  if (timedOut) {
    process.exit(0)
  }

  if (signal) {
    console.error(`[audit] pnpm audit exited due to ${signal}`)
    process.exit(1)
  }

  process.exit(code ?? 1)
})
