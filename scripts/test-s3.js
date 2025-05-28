import 'dotenv/config'

import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'

// AWS S3 配置
const AWS_REGION = process.env.S3_REGION || 'us-east-1'
const AWS_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID || ''
const AWS_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY || ''
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || ''
const S3_PREFIX = process.env.S3_PREFIX || 'photos/'
const S3_ENDPOINT = process.env.S3_ENDPOINT || ''

if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY || !S3_BUCKET_NAME) {
  console.error(
    '请设置 AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY 和 S3_BUCKET_NAME 环境变量',
  )
  throw new Error('Missing required AWS environment variables')
}

// 创建 S3 客户端
const s3Client = new S3Client({
  region: AWS_REGION,
  endpoint: S3_ENDPOINT,
  credentials: {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
  },
})

async function testS3Connection() {
  try {
    console.info('测试 S3 连接...')
    console.info(`存储桶: ${S3_BUCKET_NAME}`)
    console.info(`区域: ${AWS_REGION}`)
    console.info(`前缀: ${S3_PREFIX}`)

    const listCommand = new ListObjectsV2Command({
      Bucket: S3_BUCKET_NAME,
      Prefix: S3_PREFIX,
      MaxKeys: 10,
    })

    const response = await s3Client.send(listCommand)

    console.info('✅ S3 连接成功!')
    console.info(`找到 ${response.KeyCount || 0} 个对象`)

    if (response.Contents && response.Contents.length > 0) {
      console.info('前 10 个对象:')
      response.Contents.forEach((obj, index) => {
        console.info(
          `  ${index + 1}. ${obj.Key} (${obj.Size} bytes, ${obj.LastModified})`,
        )
      })
    } else {
      console.info('存储桶中没有找到对象')
    }
  } catch (error) {
    console.error('❌ S3 连接失败:', error.message)

    switch (error.name) {
      case 'NoSuchBucket': {
        console.error('存储桶不存在，请检查存储桶名称')

        break
      }
      case 'AccessDenied': {
        console.error('访问被拒绝，请检查 IAM 权限')

        break
      }
      case 'InvalidAccessKeyId': {
        console.error('无效的访问密钥 ID')

        break
      }
      case 'SignatureDoesNotMatch': {
        console.error('签名不匹配，请检查密钥')

        break
      }
      // No default
    }

    throw error
  }
}

testS3Connection()
