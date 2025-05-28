import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { _Object, S3ClientConfig } from '@aws-sdk/client-s3'
import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3'
import { encode } from 'blurhash'
import type { Exif } from 'exif-reader'
import exifReader from 'exif-reader'
import getRecipe from 'fuji-recipes'
import heicConvert from 'heic-convert'
import sharp from 'sharp'

import { env } from '../env.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// 解析命令行参数
const args = process.argv.slice(2)
const isForceMode = args.includes('--force')

console.info(`运行模式: ${isForceMode ? '全量更新' : '增量更新'}`)

// 创建 S3 客户端
const s3ClientConfig: S3ClientConfig = {
  region: env.S3_REGION,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  },
}

// 如果提供了自定义端点，则使用它
if (env.S3_ENDPOINT) {
  s3ClientConfig.endpoint = env.S3_ENDPOINT
}

const s3Client = new S3Client(s3ClientConfig)

// 支持的图片格式
const SUPPORTED_FORMATS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.bmp',
  '.tiff',
  '.heic',
  '.heif',
  '.hif',
])

// HEIC/HEIF 格式
const HEIC_FORMATS = new Set(['.heic', '.heif', '.hif'])

// 定义类型
interface PhotoInfo {
  title: string
  dateTaken: string
  views: number
  tags: string[]
  description: string
}

interface ImageMetadata {
  width: number
  height: number
  format: string
}

interface PhotoManifestItem {
  id: string
  title: string
  description: string
  dateTaken: string
  views: number
  tags: string[]
  originalUrl: string
  thumbnailUrl: string | null
  blurhash: string | null
  width: number
  height: number
  aspectRatio: number
  s3Key: string
  lastModified: string
  size: number
  exif: Exif | null
}

// 读取现有的 manifest
async function loadExistingManifest(): Promise<PhotoManifestItem[]> {
  try {
    const manifestPath = path.join(
      __dirname,
      '../src/data/photos-manifest.json',
    )
    const manifestContent = await fs.readFile(manifestPath, 'utf-8')
    return JSON.parse(manifestContent) as PhotoManifestItem[]
  } catch {
    console.info('未找到现有 manifest 文件，将创建新的')
    return []
  }
}

// 检查缩略图是否存在
async function thumbnailExists(photoId: string): Promise<boolean> {
  try {
    const thumbnailPath = path.join(
      __dirname,
      '../public/thumbnails',
      `${photoId}.webp`,
    )
    await fs.access(thumbnailPath)
    return true
  } catch {
    return false
  }
}

// 检查照片是否需要更新（基于最后修改时间）
function needsUpdate(
  existingItem: PhotoManifestItem | undefined,
  s3Object: _Object,
): boolean {
  if (!existingItem) return true
  if (!s3Object.LastModified) return true

  const existingModified = new Date(existingItem.lastModified)
  const s3Modified = s3Object.LastModified

  return s3Modified > existingModified
}

// 生成 blurhash
async function generateBlurhash(imageBuffer: Buffer): Promise<string | null> {
  try {
    const { data, info } = await sharp(imageBuffer)
      .raw()
      .ensureAlpha()
      .resize(32, 32, { fit: 'inside' })
      .toBuffer({ resolveWithObject: true })

    return encode(new Uint8ClampedArray(data), info.width, info.height, 4, 4)
  } catch (error) {
    console.error('生成 blurhash 失败:', error)
    return null
  }
}

// 生成缩略图
async function generateThumbnail(
  imageBuffer: Buffer,
  photoId: string,
  forceRegenerate = false,
): Promise<string | null> {
  try {
    const thumbnailDir = path.join(__dirname, '../public/thumbnails')
    await fs.mkdir(thumbnailDir, { recursive: true })

    const thumbnailPath = path.join(thumbnailDir, `${photoId}.webp`)
    const thumbnailUrl = `/thumbnails/${photoId}.webp`

    // 如果不是强制模式且缩略图已存在，直接返回URL
    if (!forceRegenerate && (await thumbnailExists(photoId))) {
      console.info(`缩略图已存在，跳过生成: ${photoId}`)
      return thumbnailUrl
    }

    await sharp(imageBuffer)
      .resize(600, 600, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 100 })
      .toFile(thumbnailPath)

    return thumbnailUrl
  } catch (error) {
    console.error('生成缩略图失败:', error)
    return null
  }
}

// 转换 HEIC/HEIF 格式到 JPEG
async function convertHeicToJpeg(heicBuffer: Buffer): Promise<Buffer> {
  try {
    console.info('正在转换 HEIC/HEIF 格式到 JPEG...')
    const jpegBuffer = await heicConvert({
      buffer: heicBuffer,
      format: 'JPEG',
      quality: 0.95, // 高质量转换
    })

    return Buffer.from(jpegBuffer)
  } catch (error) {
    console.error('HEIC/HEIF 转换失败:', error)
    throw error
  }
}

// 预处理图片 Buffer（处理 HEIC/HEIF 格式）
async function preprocessImageBuffer(
  buffer: Buffer,
  key: string,
): Promise<Buffer> {
  const ext = path.extname(key).toLowerCase()

  // 如果是 HEIC/HEIF 格式，先转换为 JPEG
  if (HEIC_FORMATS.has(ext)) {
    console.info(`检测到 HEIC/HEIF 格式，正在转换: ${key}`)
    return await convertHeicToJpeg(buffer)
  }

  // 其他格式直接返回原始 buffer
  return buffer
}

// 从 S3 获取图片
async function getImageFromS3(key: string): Promise<Buffer | null> {
  try {
    const command = new GetObjectCommand({
      Bucket: env.S3_BUCKET_NAME,
      Key: key,
    })

    const response = await s3Client.send(command)

    if (!response.Body) {
      console.error(`S3 响应中没有 Body: ${key}`)
      return null
    }

    // 处理不同类型的 Body
    if (response.Body instanceof Buffer) {
      return response.Body
    }

    // 如果是 Readable stream
    const chunks: Uint8Array[] = []
    const stream = response.Body as NodeJS.ReadableStream

    return new Promise((resolve, reject) => {
      stream.on('data', (chunk: Uint8Array) => {
        chunks.push(chunk)
      })

      stream.on('end', () => {
        resolve(Buffer.concat(chunks))
      })

      stream.on('error', (error) => {
        console.error(`从 S3 获取图片失败 ${key}:`, error)
        reject(error)
      })
    })
  } catch (error) {
    console.error(`从 S3 获取图片失败 ${key}:`, error)
    return null
  }
}

// 获取图片元数据
async function getImageMetadata(
  imageBuffer: Buffer,
): Promise<ImageMetadata | null> {
  try {
    const metadata = await sharp(imageBuffer).metadata()

    if (!metadata.width || !metadata.height || !metadata.format) {
      console.error('图片元数据不完整')
      return null
    }

    return {
      width: metadata.width,
      height: metadata.height,
      format: metadata.format,
    }
  } catch (error) {
    console.error('获取图片元数据失败:', error)
    return null
  }
}

// 清理 EXIF 数据中的空字符和无用信息
function cleanExifData(exifData: any): any {
  if (!exifData || typeof exifData !== 'object') {
    return exifData
  }

  if (Array.isArray(exifData)) {
    return exifData.map((item) => cleanExifData(item))
  }

  // 如果是 Date 对象，直接返回
  if (exifData instanceof Date) {
    return exifData
  }

  const cleaned: any = {}

  // 重要的日期字段，不应该被过度清理
  const importantDateFields = new Set([
    'DateTimeOriginal',
    'DateTime',
    'DateTimeDigitized',
    'CreateDate',
    'ModifyDate',
  ])

  for (const [key, value] of Object.entries(exifData)) {
    if (value === null || value === undefined) {
      continue
    }

    if (typeof value === 'string') {
      // 对于重要的日期字段，只移除空字符，不进行过度清理
      if (importantDateFields.has(key)) {
        const cleanedString = value.replaceAll('\0', '')
        if (cleanedString.length > 0) {
          cleaned[key] = cleanedString
        }
      } else {
        // 对于其他字符串字段，移除空字符并清理空白字符
        const cleanedString = value.replaceAll('\0', '').trim()
        if (cleanedString.length > 0) {
          cleaned[key] = cleanedString
        }
      }
    } else if (value instanceof Date) {
      // Date 对象直接保留
      cleaned[key] = value
    } else if (typeof value === 'object') {
      // 递归清理嵌套对象
      const cleanedNested = cleanExifData(value)
      if (cleanedNested && Object.keys(cleanedNested).length > 0) {
        cleaned[key] = cleanedNested
      }
    } else {
      // 其他类型直接保留
      cleaned[key] = value
    }
  }

  return cleaned
}

// 提取 EXIF 数据
async function extractExifData(
  imageBuffer: Buffer,
  originalBuffer?: Buffer,
): Promise<Exif | null> {
  try {
    // 首先尝试从处理后的图片中提取 EXIF
    let metadata = await sharp(imageBuffer).metadata()

    // 如果处理后的图片没有 EXIF 数据，且提供了原始 buffer，尝试从原始图片提取
    if (!metadata.exif && originalBuffer) {
      console.info('处理后的图片缺少 EXIF 数据，尝试从原始图片提取...')
      try {
        metadata = await sharp(originalBuffer).metadata()
      } catch (error) {
        console.warn('从原始图片提取 EXIF 失败，可能是不支持的格式:', error)
      }
    }

    if (!metadata.exif) {
      return null
    }

    let startIndex = 0
    for (let i = 0; i < metadata.exif.length; i++) {
      if (
        metadata.exif.toString('ascii', i, i + 2) === 'II' ||
        metadata.exif.toString('ascii', i, i + 2) === 'MM'
      ) {
        startIndex = i
        break
      }
      if (metadata.exif.toString('ascii', i, i + 4) === 'Exif') {
        startIndex = i
        break
      }
    }
    const exifBuffer = metadata.exif.subarray(startIndex)

    // 使用 exif-reader 解析 EXIF 数据
    const exifData = exifReader(exifBuffer)

    if (exifData.Photo?.MakerNote) {
      const recipe = getRecipe(exifData.Photo.MakerNote)
      ;(exifData as any).FujiRecipe = recipe
    }

    delete exifData.Photo?.MakerNote
    delete exifData.Photo?.UserComment
    delete exifData.Photo?.PrintImageMatching
    delete exifData.Image?.PrintImageMatching

    if (!exifData) {
      return null
    }

    // 清理 EXIF 数据中的空字符和无用数据
    const cleanedExifData = cleanExifData(exifData)

    return cleanedExifData
  } catch (error) {
    console.error('提取 EXIF 数据失败:', error)
    return null
  }
}

// 从文件名提取照片信息
function extractPhotoInfo(key: string, exifData?: Exif | null): PhotoInfo {
  const fileName = path.basename(key, path.extname(key))

  // 尝试从文件名解析信息，格式示例: "2024-01-15_城市夜景_1250views"
  let title = fileName
  let dateTaken = new Date().toISOString()
  let views = 0
  const tags: string[] = []

  // 优先使用 EXIF 中的 DateTimeOriginal
  if (exifData?.Photo?.DateTimeOriginal) {
    try {
      const dateTimeOriginal = exifData.Photo.DateTimeOriginal as any

      // 如果是 Date 对象，直接使用
      if (dateTimeOriginal instanceof Date) {
        dateTaken = dateTimeOriginal.toISOString()
      } else if (typeof dateTimeOriginal === 'string') {
        // 如果是字符串，按原来的方式处理
        // EXIF 日期格式通常是 "YYYY:MM:DD HH:MM:SS"
        const formattedDateStr = dateTimeOriginal.replace(
          /^(\d{4}):(\d{2}):(\d{2})/,
          '$1-$2-$3',
        )
        dateTaken = new Date(formattedDateStr).toISOString()
      } else {
        console.warn(
          `未知的 DateTimeOriginal 类型: ${typeof dateTimeOriginal}`,
          dateTimeOriginal,
        )
      }
    } catch (error) {
      console.warn(
        `解析 EXIF DateTimeOriginal 失败: ${exifData.Photo.DateTimeOriginal}`,
        error,
      )
    }
  } else {
    // 如果 EXIF 中没有日期，尝试从文件名解析
    const dateMatch = fileName.match(/(\d{4}-\d{2}-\d{2})/)
    if (dateMatch) {
      dateTaken = new Date(dateMatch[1]).toISOString()
    }
  }

  // 如果文件名包含浏览次数
  const viewsMatch = fileName.match(/(\d+)views?/i)
  if (viewsMatch) {
    views = Number.parseInt(viewsMatch[1])
  }

  // 从文件名中提取标题（移除日期和浏览次数）
  title = fileName
    .replaceAll(/\d{4}-\d{2}-\d{2}[_-]?/g, '')
    .replaceAll(/[_-]?\d+views?/gi, '')
    .replaceAll(/[_-]+/g, ' ')
    .trim()

  // 如果标题为空，使用文件名
  if (!title) {
    title = path.basename(key, path.extname(key))
  }

  return {
    title,
    dateTaken,
    views,
    tags,
    description: '', // 可以从 EXIF 或其他元数据中获取
  }
}

// 生成 S3 公共 URL
function generateS3Url(key: string): string {
  const bucketName = env.S3_BUCKET_NAME

  // 如果设置了自定义域名，直接使用自定义域名
  if (env.S3_CUSTOM_DOMAIN) {
    const customDomain = env.S3_CUSTOM_DOMAIN.replace(/\/$/, '') // 移除末尾的斜杠
    return `${customDomain}/${bucketName}/${key}`
  }

  // 如果使用自定义端点，构建相应的 URL
  const endpoint = env.S3_ENDPOINT

  // 检查是否是标准 AWS S3 端点
  if (endpoint.includes('amazonaws.com')) {
    return `https://${bucketName}.s3.${env.S3_REGION}.amazonaws.com/${bucketName}/${key}`
  }

  // 对于自定义端点（如 MinIO 等）
  const baseUrl = endpoint.replace(/\/$/, '') // 移除末尾的斜杠
  return `${baseUrl}/${bucketName}/${key}`
}

// 主函数
async function buildManifest(): Promise<void> {
  try {
    console.info('开始从 S3 获取照片列表...')
    console.info(`使用端点: ${env.S3_ENDPOINT || '默认 AWS S3'}`)
    console.info(`自定义域名: ${env.S3_CUSTOM_DOMAIN || '未设置'}`)
    console.info(`存储桶: ${env.S3_BUCKET_NAME}`)
    console.info(`前缀: ${env.S3_PREFIX || '无前缀'}`)

    // 读取现有的 manifest（如果存在）
    const existingManifest = isForceMode ? [] : await loadExistingManifest()
    const existingManifestMap = new Map(
      existingManifest.map((item) => [item.s3Key, item]),
    )

    console.info(`现有 manifest 包含 ${existingManifest.length} 张照片`)

    // 列出 S3 中的所有图片文件
    const listCommand = new ListObjectsV2Command({
      Bucket: env.S3_BUCKET_NAME,
      Prefix: env.S3_PREFIX,
      MaxKeys: 1000, // 最多获取 1000 张照片
    })

    const listResponse = await s3Client.send(listCommand)
    const objects = listResponse.Contents || []

    // 过滤出图片文件
    const imageObjects = objects.filter((obj: _Object) => {
      if (!obj.Key) return false
      const ext = path.extname(obj.Key).toLowerCase()
      return SUPPORTED_FORMATS.has(ext)
    })

    console.info(`S3 中找到 ${imageObjects.length} 张照片`)

    // 创建 S3 中存在的图片 key 集合，用于检测已删除的图片
    const s3ImageKeys = new Set(
      imageObjects.map((obj) => obj.Key).filter(Boolean),
    )

    const manifest: PhotoManifestItem[] = []
    let processedCount = 0
    let skippedCount = 0
    let newCount = 0
    let deletedCount = 0

    // 并发处理函数
    async function processPhoto(
      obj: _Object,
      index: number,
    ): Promise<{
      item: PhotoManifestItem | null
      type: 'processed' | 'skipped' | 'new' | 'failed'
    }> {
      const key = obj.Key
      if (!key) {
        console.warn(`跳过没有 Key 的对象`)
        return { item: null, type: 'failed' }
      }

      const photoId = path.basename(key, path.extname(key))
      const existingItem = existingManifestMap.get(key)

      console.info(`处理照片 ${index + 1}/${imageObjects.length}: ${key}`)

      // 检查是否需要更新
      if (!isForceMode && existingItem && !needsUpdate(existingItem, obj)) {
        // 检查缩略图是否存在，如果不存在则需要重新处理
        const hasThumbnail = await thumbnailExists(photoId)
        if (hasThumbnail) {
          console.info(`照片未更新且缩略图存在，跳过处理: ${key}`)
          return { item: existingItem, type: 'skipped' }
        } else {
          console.info(`照片未更新但缩略图缺失，重新生成缩略图: ${key}`)
        }
      }

      // 需要处理的照片（新照片、更新的照片或缺失缩略图的照片）
      const isNewPhoto = !existingItem
      if (isNewPhoto) {
        console.info(`新照片: ${key}`)
      } else {
        console.info(`更新照片: ${key}`)
      }

      try {
        // 获取图片数据
        const rawImageBuffer = await getImageFromS3(key)
        if (!rawImageBuffer) return { item: null, type: 'failed' }

        // 预处理图片（处理 HEIC/HEIF 格式）
        let imageBuffer: Buffer
        try {
          imageBuffer = await preprocessImageBuffer(rawImageBuffer, key)
        } catch (error) {
          console.error(`预处理图片失败 ${key}:`, error)
          return { item: null, type: 'failed' }
        }

        // 获取图片元数据
        const metadata = await getImageMetadata(imageBuffer)
        if (!metadata) return { item: null, type: 'failed' }

        // 如果是增量更新且已有 blurhash，可以复用
        let blurhash: string | null = null
        if (!isForceMode && existingItem?.blurhash) {
          blurhash = existingItem.blurhash
          console.info(`复用现有 blurhash: ${photoId}`)
        } else {
          blurhash = await generateBlurhash(imageBuffer)
        }

        // 如果是增量更新且已有 EXIF 数据，可以复用
        let exifData: Exif | null = null
        if (!isForceMode && existingItem?.exif) {
          exifData = existingItem.exif
          console.info(`复用现有 EXIF 数据: ${photoId}`)
        } else {
          // 传入原始 buffer 以便在转换后的图片缺少 EXIF 时回退
          const ext = path.extname(key).toLowerCase()
          const originalBuffer = HEIC_FORMATS.has(ext)
            ? rawImageBuffer
            : undefined
          exifData = await extractExifData(imageBuffer, originalBuffer)
        }

        // 提取照片信息（在获取 EXIF 数据之后，以便使用 DateTimeOriginal）
        const photoInfo = extractPhotoInfo(key, exifData)

        // 生成缩略图（会自动检查是否需要重新生成）
        const thumbnailUrl = await generateThumbnail(
          imageBuffer,
          photoId,
          isForceMode,
        )

        const aspectRatio = metadata.width / metadata.height

        const photoItem: PhotoManifestItem = {
          id: photoId,
          title: photoInfo.title,
          description: photoInfo.description,
          dateTaken: photoInfo.dateTaken,
          views: photoInfo.views,
          tags: photoInfo.tags,
          originalUrl: generateS3Url(key),
          thumbnailUrl,
          blurhash,
          width: metadata.width,
          height: metadata.height,
          aspectRatio,
          s3Key: key,
          lastModified:
            obj.LastModified?.toISOString() || new Date().toISOString(),
          size: obj.Size || 0,
          exif: exifData,
        }

        return { item: photoItem, type: isNewPhoto ? 'new' : 'processed' }
      } catch (error) {
        console.error(`处理照片失败 ${key}:`, error)
        return { item: null, type: 'failed' }
      }
    }

    // 工作池模式并发处理照片，限制并发数为 5
    const CONCURRENCY_LIMIT = 5
    const results: {
      item: PhotoManifestItem | null
      type: 'processed' | 'skipped' | 'new' | 'failed'
    }[] = Array.from({ length: imageObjects.length })

    console.info(`开始并发处理照片，工作池模式，并发数: ${CONCURRENCY_LIMIT}`)

    // 创建任务队列
    let taskIndex = 0
    const totalTasks = imageObjects.length

    // Worker 函数
    async function worker(): Promise<void> {
      while (taskIndex < totalTasks) {
        const currentIndex = taskIndex++
        if (currentIndex >= totalTasks) break

        const obj = imageObjects[currentIndex]
        console.info(
          `Worker 开始处理照片 ${currentIndex + 1}/${totalTasks}: ${obj.Key}`,
        )

        const result = await processPhoto(obj, currentIndex)
        results[currentIndex] = result

        console.info(
          `Worker 完成照片 ${currentIndex + 1}/${totalTasks}: ${obj.Key} (${result.type})`,
        )
      }
    }

    // 启动工作池
    const workers = Array.from({ length: CONCURRENCY_LIMIT }, () => worker())
    await Promise.all(workers)

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

    // 检测并处理已删除的图片
    if (!isForceMode && existingManifest.length > 0) {
      console.info('检查已删除的图片...')

      for (const existingItem of existingManifest) {
        // 如果现有 manifest 中的图片在 S3 中不存在了
        if (!s3ImageKeys.has(existingItem.s3Key)) {
          console.info(`检测到已删除的图片: ${existingItem.s3Key}`)
          deletedCount++

          // 删除对应的缩略图文件
          try {
            const thumbnailPath = path.join(
              __dirname,
              '../public/thumbnails',
              `${existingItem.id}.webp`,
            )
            await fs.unlink(thumbnailPath)
            console.info(`已删除缩略图: ${existingItem.id}.webp`)
          } catch (error) {
            // 缩略图可能已经不存在，忽略错误
            console.warn(`删除缩略图失败 ${existingItem.id}.webp:`, error)
          }
        }
      }
    }

    // 按日期排序（最新的在前）
    manifest.sort(
      (a, b) =>
        new Date(b.dateTaken).getTime() - new Date(a.dateTaken).getTime(),
    )

    // 保存 manifest
    const manifestPath = path.join(
      __dirname,
      '../src/data/photos-manifest.json',
    )
    await fs.mkdir(path.dirname(manifestPath), { recursive: true })
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2))

    console.info(`✅ 成功生成 manifest，包含 ${manifest.length} 张照片`)
    console.info(`📊 统计信息:`)
    console.info(`   - 新增照片: ${newCount}`)
    console.info(`   - 处理照片: ${processedCount}`)
    console.info(`   - 跳过照片: ${skippedCount}`)
    console.info(`   - 删除照片: ${deletedCount}`)
    console.info(`📁 Manifest 保存至: ${manifestPath}`)
  } catch (error) {
    console.error('构建 manifest 失败:', error)
    throw error
  }
}

buildManifest()
