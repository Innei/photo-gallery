import cluster from 'node:cluster'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { builderConfig } from '@builder'
import { $ } from 'execa'

import { defaultBuilder } from './builder/index.js'
import { logger } from './logger/index.js'
import { runAsWorker } from './runAsWorker.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
async function main() {
  // 检查是否作为 cluster worker 运行
  if (
    process.env.CLUSTER_WORKER === 'true' ||
    process.argv.includes('--cluster-worker') ||
    cluster.isWorker
  ) {
    await runAsWorker()
    return
  }

  // 如果配置了远程仓库，则使用远程仓库
  if (builderConfig.repo.enable) {
    // 拉取远程仓库
    const workdir = path.resolve(__dirname, '..', '..')
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

  process.title = 'photo-gallery-builder-main'

  // 解析命令行参数
  const args = new Set(process.argv.slice(2))
  const isForceMode = args.has('--force')
  const isForceManifest = args.has('--force-manifest')
  const isForceThumbnails = args.has('--force-thumbnails')

  // 显示帮助信息
  if (args.has('--help') || args.has('-h')) {
    logger.main.info(`
照片库构建工具 (新版本 - 使用适配器模式)

用法：tsx src/core/cli.ts [选项]

选项：
  --force              强制重新处理所有照片
  --force-manifest     强制重新生成 manifest
  --force-thumbnails   强制重新生成缩略图
  --config             显示当前配置信息
  --help, -h          显示帮助信息

示例：
  tsx src/core/cli.ts                           # 增量更新
  tsx src/core/cli.ts --force                   # 全量更新
  tsx src/core/cli.ts --force-thumbnails        # 强制重新生成缩略图
  tsx src/core/cli.ts --config                  # 显示配置信息

配置：
  在 builder.config.ts 中设置 performance.worker.useClusterMode = true 
  可启用多进程集群模式，发挥多核心优势。
`)
    return
  }

  // 显示配置信息
  if (args.has('--config')) {
    const config = defaultBuilder.getConfig()
    logger.main.info('🔧 当前配置：')
    logger.main.info(`   存储提供商：${config.storage.provider}`)

    switch (config.storage.provider) {
      case 's3': {
        logger.main.info(`   存储桶：${config.storage.bucket}`)
        logger.main.info(`   区域：${config.storage.region || '未设置'}`)
        logger.main.info(`   端点：${config.storage.endpoint || '默认'}`)
        logger.main.info(
          `   自定义域名：${config.storage.customDomain || '未设置'}`,
        )
        logger.main.info(`   前缀：${config.storage.prefix || '无'}`)
        break
      }
      case 'github': {
        logger.main.info(`   仓库所有者：${config.storage.owner}`)
        logger.main.info(`   仓库名称：${config.storage.repo}`)
        logger.main.info(`   分支：${config.storage.branch || 'main'}`)
        logger.main.info(`   路径：${config.storage.path || '无'}`)
        logger.main.info(`   使用原始 URL：${config.storage.useRawUrl || '否'}`)
        break
      }
    }
    logger.main.info(`   默认并发数：${config.options.defaultConcurrency}`)
    logger.main.info(`   最大照片数：${config.options.maxPhotos}`)
    logger.main.info(
      `   Live Photo 检测：${config.options.enableLivePhotoDetection ? '启用' : '禁用'}`,
    )
    logger.main.info(`   Worker 数：${config.performance.worker.workerCount}`)
    logger.main.info(`   Worker 超时：${config.performance.worker.timeout}ms`)
    logger.main.info(
      `   集群模式：${config.performance.worker.useClusterMode ? '启用' : '禁用'}`,
    )
    return
  }

  // 确定运行模式
  let runMode = '增量更新'
  if (isForceMode) {
    runMode = '全量更新'
  } else if (isForceManifest && isForceThumbnails) {
    runMode = '强制刷新 manifest 和缩略图'
  } else if (isForceManifest) {
    runMode = '强制刷新 manifest'
  } else if (isForceThumbnails) {
    runMode = '强制刷新缩略图'
  }

  const config = defaultBuilder.getConfig()
  const concurrencyLimit = config.performance.worker.workerCount
  const finalConcurrency = concurrencyLimit ?? config.options.defaultConcurrency
  const processingMode = config.performance.worker.useClusterMode
    ? '多进程集群'
    : '并发线程池'

  logger.main.info(`🚀 运行模式：${runMode}`)
  logger.main.info(`⚡ 最大并发数：${finalConcurrency}`)
  logger.main.info(`🔧 处理模式：${processingMode}`)
  logger.main.info(`🏗️ 使用构建器：PhotoGalleryBuilder (适配器模式)`)

  // 启动构建过程
  await defaultBuilder.buildManifest({
    isForceMode,
    isForceManifest,
    isForceThumbnails,
    concurrencyLimit,
  })
}

// 运行主函数
main().catch((error) => {
  logger.main.error('构建失败：', error)
  throw error
})
