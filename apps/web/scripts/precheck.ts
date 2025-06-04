import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { builderConfig } from '@builder'
import { $ } from 'execa'

import { pullAndLinkRemoteRepo } from './pull-remote'

export const precheck = async () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const workdir = path.resolve(__dirname, '..')

  // 检查是否存在 public/thumbnails 和 src/data/photos-manifest.json
  const thumbnailsDir = path.resolve(workdir, 'public', 'thumbnails')
  const photosManifestPath = path.resolve(
    workdir,
    'src',
    'data',
    'photos-manifest.json',
  )
  const isExistThumbnails = existsSync(thumbnailsDir)
  const isExistPhotosManifest = existsSync(photosManifestPath)

  const shouldDoBuildOrClone = !isExistThumbnails || !isExistPhotosManifest

  // 检查 builder 配置
  if (shouldDoBuildOrClone) {
    if (builderConfig.repo.enable) {
      await pullAndLinkRemoteRepo()
    } else {
      await $({ cwd: workdir, stdio: 'inherit' })`pnpm build:manifest`
    }
  }
}
