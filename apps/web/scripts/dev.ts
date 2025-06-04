import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { $ } from 'execa'

import { precheck } from './precheck'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const workdir = path.resolve(__dirname, '..')

async function main() {
  await precheck()
  // Get command line arguments excluding node and script name
  const args = process.argv.slice(2)
  await $({ cwd: workdir, stdio: 'inherit' })`vite ${args}`
}

main()
