import type { BuilderConfig } from '@builder'
import { builderConfig } from '@builder'

import { logger } from '../logger/index.js'
import {
  handleDeletedPhotos,
  loadExistingManifest,
  saveManifest,
} from '../manifest/manager.js'
import type { PhotoProcessorOptions } from '../photo/processor.js'
import { processPhoto } from '../photo/processor.js'
import { StorageManager } from '../storage/index.js'
import type { PhotoManifestItem, ProcessPhotoResult } from '../types/photo.js'
import { ClusterPool } from '../worker/cluster-pool.js'
import { WorkerPool } from '../worker/pool.js'

export interface BuilderOptions {
  isForceMode: boolean
  isForceManifest: boolean
  isForceThumbnails: boolean
  concurrencyLimit?: number // 可选，如果未提供则使用配置文件中的默认值
}

export class PhotoGalleryBuilder {
  private storageManager: StorageManager
  private config: BuilderConfig

  constructor(config?: Partial<BuilderConfig>) {
    // 合并用户配置和默认配置
    this.config = this.mergeConfig(builderConfig, config)

    // 创建存储管理器
    this.storageManager = new StorageManager(this.config.storage)

    // 配置日志级别
    this.configureLogging()
  }

  private mergeConfig(
    baseConfig: BuilderConfig,
    userConfig?: Partial<BuilderConfig>,
  ): BuilderConfig {
    if (!userConfig) return baseConfig

    return {
      repo: { ...baseConfig.repo, ...userConfig.repo },
      storage: { ...baseConfig.storage, ...userConfig.storage },
      options: { ...baseConfig.options, ...userConfig.options },
      logging: { ...baseConfig.logging, ...userConfig.logging },
      performance: {
        ...baseConfig.performance,
        ...userConfig.performance,
        worker: {
          ...baseConfig.performance.worker,
          ...userConfig.performance?.worker,
        },
      },
    }
  }

  private configureLogging(): void {
    // 这里可以根据配置调整日志设置
    // 目前日志配置在 logger 模块中处理
  }

  /**
   * 构建照片清单
   * @param options 构建选项
   */
  async buildManifest(options: BuilderOptions): Promise<void> {
    const startTime = Date.now()

    try {
      this.logBuildStart()

      // 读取现有的 manifest（如果存在）
      const existingManifest = await this.loadExistingManifest(options)
      const existingManifestMap = new Map(
        existingManifest.map((item) => [item.s3Key, item]),
      )

      logger.main.info(`现有 manifest 包含 ${existingManifest.length} 张照片`)

      // 列出存储中的所有文件
      const allObjects = await this.storageManager.listAllFiles()
      logger.main.info(`存储中找到 ${allObjects.length} 个文件`)

      // 检测 Live Photo 配对（如果启用）
      const livePhotoMap = await this.detectLivePhotos(allObjects)
      if (this.config.options.enableLivePhotoDetection) {
        logger.main.info(`检测到 ${livePhotoMap.size} 个 Live Photo`)
      }

      // 列出存储中的所有图片文件
      const imageObjects = await this.storageManager.listImages()
      logger.main.info(`存储中找到 ${imageObjects.length} 张照片`)

      // 检查照片数量限制
      if (imageObjects.length > this.config.options.maxPhotos) {
        logger.main.warn(
          `⚠️ 照片数量 (${imageObjects.length}) 超过配置限制 (${this.config.options.maxPhotos})`,
        )
      }

      // 创建存储中存在的图片 key 集合，用于检测已删除的图片
      const s3ImageKeys = new Set(imageObjects.map((obj) => obj.key))

      const manifest: PhotoManifestItem[] = []
      let processedCount = 0
      let skippedCount = 0
      let newCount = 0
      let deletedCount = 0

      if (imageObjects.length > 0) {
        // 获取并发限制
        const concurrency =
          options.concurrencyLimit ?? this.config.options.defaultConcurrency

        // 根据配置选择处理模式
        const { useClusterMode } = this.config.performance.worker

        logger.main.info(
          `开始${useClusterMode ? '多进程' : '并发'}处理任务，${useClusterMode ? '进程' : 'Worker'}数：${concurrency}${useClusterMode ? `，每进程并发：${this.config.performance.worker.workerConcurrency}` : ''}`,
        )

        const processorOptions: PhotoProcessorOptions = {
          isForceMode: options.isForceMode,
          isForceManifest: options.isForceManifest,
          isForceThumbnails: options.isForceThumbnails,
        }

        let results: ProcessPhotoResult[]

        if (useClusterMode) {
          // 创建 Cluster 池（多进程模式）
          const clusterPool = new ClusterPool<ProcessPhotoResult>(
            {
              concurrency,
              totalTasks: imageObjects.length,
              workerConcurrency:
                this.config.performance.worker.workerConcurrency,
              workerEnv: {
                FORCE_MODE: processorOptions.isForceMode.toString(),
                FORCE_MANIFEST: processorOptions.isForceManifest.toString(),
                FORCE_THUMBNAILS: processorOptions.isForceThumbnails.toString(),
              },
            },
            logger,
          )

          // 执行多进程并发处理
          results = await clusterPool.execute()
        } else {
          // 创建传统 Worker 池（主线程并发模式）
          const workerPool = new WorkerPool<ProcessPhotoResult>(
            {
              concurrency,
              totalTasks: imageObjects.length,
            },
            logger,
          )

          // 执行并发处理
          results = await workerPool.execute(async (taskIndex, workerId) => {
            const obj = imageObjects[taskIndex]

            // 转换 StorageObject 到旧的 _Object 格式以兼容现有的 processPhoto 函数
            const legacyObj = {
              Key: obj.key,
              Size: obj.size,
              LastModified: obj.lastModified,
              ETag: obj.etag,
            }

            // 转换 Live Photo Map
            const legacyLivePhotoMap = new Map()
            for (const [key, value] of livePhotoMap) {
              legacyLivePhotoMap.set(key, {
                Key: value.key,
                Size: value.size,
                LastModified: value.lastModified,
                ETag: value.etag,
              })
            }

            return await processPhoto(
              legacyObj,
              taskIndex,
              workerId,
              imageObjects.length,
              existingManifestMap,
              legacyLivePhotoMap,
              processorOptions,
              logger,
            )
          })
        }

        // 统计结果并添加到 manifest
        for (const result of results) {
          if (result.item) {
            manifest.push(result.item)

            switch (result.type) {
              case 'new': {
                newCount++
                processedCount++
                break
              }
              case 'processed': {
                processedCount++
                break
              }
              case 'skipped': {
                skippedCount++
                break
              }
            }
          }
        }
      }

      // 检测并处理已删除的图片
      if (
        !options.isForceMode &&
        !options.isForceManifest &&
        existingManifest.length > 0
      ) {
        deletedCount = await handleDeletedPhotos(
          existingManifest,
          s3ImageKeys,
          logger.main,
          logger.fs,
        )
      }

      // 保存 manifest
      await saveManifest(manifest, logger.fs)

      // 显示构建结果
      if (this.config.options.showDetailedStats) {
        this.logBuildResults(
          manifest,
          {
            newCount,
            processedCount,
            skippedCount,
            deletedCount,
          },
          Date.now() - startTime,
        )
      }
    } catch (error) {
      logger.main.error('❌ 构建 manifest 失败：', error)
      throw error
    }
  }

  private async loadExistingManifest(
    options: BuilderOptions,
  ): Promise<PhotoManifestItem[]> {
    return options.isForceMode || options.isForceManifest
      ? []
      : await loadExistingManifest()
  }

  private async detectLivePhotos(
    allObjects: Awaited<ReturnType<StorageManager['listAllFiles']>>,
  ): Promise<Map<string, (typeof allObjects)[0]>> {
    if (!this.config.options.enableLivePhotoDetection) {
      return new Map()
    }

    return await this.storageManager.detectLivePhotos(allObjects)
  }

  private logBuildStart(): void {
    switch (this.config.storage.provider) {
      case 's3': {
        const endpoint = this.config.storage.endpoint || '默认 AWS S3'
        const customDomain = this.config.storage.customDomain || '未设置'
        const { bucket } = this.config.storage
        const prefix = this.config.storage.prefix || '无前缀'

        logger.main.info('🚀 开始从存储获取照片列表...')
        logger.main.info(`🔗 使用端点：${endpoint}`)
        logger.main.info(`🌐 自定义域名：${customDomain}`)
        logger.main.info(`🪣 存储桶：${bucket}`)
        logger.main.info(`📂 前缀：${prefix}`)
        break
      }
      case 'github': {
        const { owner, repo, branch, path } = this.config.storage
        logger.main.info('🚀 开始从存储获取照片列表...')
        logger.main.info(`👤 仓库所有者：${owner}`)
        logger.main.info(`🏷️ 仓库名称：${repo}`)
        logger.main.info(`🌲 分支：${branch}`)
        logger.main.info(`📂 路径：${path}`)
        break
      }
    }
  }

  private logBuildResults(
    manifest: PhotoManifestItem[],
    stats: {
      newCount: number
      processedCount: number
      skippedCount: number
      deletedCount: number
    },
    totalDuration: number,
  ): void {
    const durationSeconds = Math.round(totalDuration / 1000)
    const durationMinutes = Math.floor(durationSeconds / 60)
    const remainingSeconds = durationSeconds % 60

    logger.main.success(`🎉 Manifest 构建完成!`)
    logger.main.info(`📊 处理统计:`)
    logger.main.info(`   📸 总照片数：${manifest.length}`)
    logger.main.info(`   🆕 新增照片：${stats.newCount}`)
    logger.main.info(`   🔄 处理照片：${stats.processedCount}`)
    logger.main.info(`   ⏭️ 跳过照片：${stats.skippedCount}`)
    logger.main.info(`   🗑️ 删除照片：${stats.deletedCount}`)
    logger.main.info(
      `   ⏱️ 总耗时：${durationMinutes > 0 ? `${durationMinutes}分${remainingSeconds}秒` : `${durationSeconds}秒`}`,
    )
  }

  /**
   * 获取当前使用的存储管理器
   */
  getStorageManager(): StorageManager {
    return this.storageManager
  }

  /**
   * 获取当前配置
   */
  getConfig(): BuilderConfig {
    return { ...this.config }
  }
}

// 导出默认的构建器实例
export const defaultBuilder = new PhotoGalleryBuilder()
