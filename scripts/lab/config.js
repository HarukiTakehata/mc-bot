// Shared configuration for disposable local game-server tests. Parsing has no side effects.
const path = require('node:path')

function loadLabConfig(env = process.env) {
  const container = String(env.LAB_CONTAINER || '').trim()
  if (!container) throw new Error('LAB_CONTAINER is required; choose a disposable local test-server container')
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(container)) throw new Error('LAB_CONTAINER must be a Docker container name or ID')

  const portText = String(env.LAB_PORT ?? '25577').trim()
  const port = Number(portText)
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('LAB_PORT must be an integer from 1 to 65535')

  const root = path.resolve(__dirname, '../..')
  const rconConfig = env.LAB_RCON_CONFIG?.trim()
  return Object.freeze({
    container,
    host: '127.0.0.1',
    port,
    version: env.LAB_VERSION?.trim() || '26.1',
    root,
    outputDir: path.resolve(env.LAB_EVIDENCE || env.LAB_OUT || path.join(root, 'logs', 'lab')),
    rconArgs: (command) => ['exec', container, 'rcon-cli', ...(rconConfig ? ['--config', rconConfig] : []), command],
  })
}

module.exports = { loadLabConfig }
