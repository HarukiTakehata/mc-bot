const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
for (const dir of [root, path.join(root, 'test'), __dirname]) {
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    const file = path.join(dir, name)
    const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' })
    if (result.status !== 0) process.exit(result.status || 1)
  }
}
console.log('JavaScript syntax checks passed')
