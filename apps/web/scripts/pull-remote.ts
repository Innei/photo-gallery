import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { builderConfig } from '@builder'
import { $ } from 'execa'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const workdir = path.resolve(__dirname, '..')

export const pullAndLinkRemoteRepo = async () => {
  const hasExist = existsSync(path.resolve(workdir, 'assets-git'))
  if (!hasExist) {
    await $({
      cwd: workdir,
      stdio: 'inherit',
    })`git clone ${builderConfig.repo.url} assets-git`
  } else {
    await $({
      cwd: path.resolve(workdir, 'assets-git'),
      stdio: 'inherit',
    })`git pull --rebase`
  }

  // 删除 public/thumbnails 目录，并建立软连接到 assets-git/thumbnails
  const thumbnailsDir = path.resolve(workdir, 'public', 'thumbnails')
  if (existsSync(thumbnailsDir)) {
    await $({ cwd: workdir, stdio: 'inherit' })`rm -rf ${thumbnailsDir}`
  }
  await $({
    cwd: workdir,
    stdio: 'inherit',
  })`ln -s ${path.resolve(workdir, 'assets-git', 'thumbnails')} ${thumbnailsDir}`
  // 删除src/data/photos-manifest.json，并建立软连接到 assets-git/photos-manifest.json
  const photosManifestPath = path.resolve(
    workdir,
    'src',
    'data',
    'photos-manifest.json',
  )
  if (existsSync(photosManifestPath)) {
    await $({ cwd: workdir, stdio: 'inherit' })`rm -rf ${photosManifestPath}`
  }
  await $({ cwd: workdir, stdio: 'inherit' })`ln -s ${path.resolve(
    workdir,
    'assets-git',
    'photos-manifest.json',
  )} ${photosManifestPath}`
}
