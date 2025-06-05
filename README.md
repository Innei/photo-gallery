# Photo Gallery Site

> [!IMPORTANT]
> 此项目已迁移到 [Iris-Photo-Gallery/Iris](https://github.com/Iris-Photo-Gallery/Iris)。


⚠️警告：此项目多数代码都由 Claude 4 生成，请谨慎使用。

一个现代化的照片画廊网站，支持从 S3 存储自动同步照片，具有瀑布流布局、EXIF 信息展示、缩略图生成等功能。

Preview: https://gallery.innei.in

## 特点

- 高性能 WebGL 图像渲染器
- HEIC/HEIF 格式支持
- 支持缩略图生成
- 支持 EXIF 信息展示
- 瀑布流布局
- 支持富士胶片模拟信息读取

## 环境配置

创建 `.env` 文件并配置以下环境变量：

```env
# S3 配置
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=your_access_key_id
S3_SECRET_ACCESS_KEY=your_secret_access_key
S3_ENDPOINT=https://s3.us-east-1.amazonaws.com
S3_BUCKET_NAME=your_bucket_name
S3_PREFIX=photos/
S3_CUSTOM_DOMAIN=your_custom_domain.com
```

## Photo Gallery Builder

基于适配器模式重构的照片库构建器，提供灵活的存储抽象和可配置的构建选项。

### 配置文件

在项目根目录的 `builder.config.ts` 中可以配置构建器的各种选项：

```typescript
export const builderConfig: BuilderConfig = {
  storage: {
    provider: 's3',
    bucket: 'my-bucket',
    region: 'us-east-1',
    // ... 其他存储配置
  },
  
  options: {
    defaultConcurrency: 8,        // 默认并发数
    maxPhotos: 5000,             // 最大照片数量限制
    enableLivePhotoDetection: true, // 启用 Live Photo 检测
    showProgress: true,          // 显示进度
    showDetailedStats: true,     // 显示详细统计
  },
  
  logging: {
    verbose: true,               // 详细日志
    level: 'debug',             // 日志级别
    outputToFile: false,        // 是否输出到文件
  },
  
  performance: {
    worker: {
      timeout: 30000,           // Worker 超时时间
    },
    memoryLimit: 512,           // 内存限制（MB）
    enableCache: true,          // 启用缓存
  },
}
```

#### 自定义存储提供商

如果需要使用其他存储服务（如阿里云 OSS），可以：

1. 实现新的存储提供商类
2. 在配置中指定使用新的提供商

```typescript
const builder = new PhotoGalleryBuilder({
  storage: {
    provider: 'oss', // 假设已经实现了 OSS 提供商
    bucket: 'my-oss-bucket',
    // ... OSS 特定配置
  },
})
```

## 🚀 使用

### 开发模式

```bash
pnpm dev
```

### 构建照片清单

```bash
# 增量更新（默认）
pnpm run build:manifest

# 全量更新
pnpm run build:manifest -- --force
```

### 构建生产版本

```bash
pnpm run build
```

## License

2025 © Innei, Released under the MIT License.

> [Personal Website](https://innei.in/) · GitHub [@Innei](https://github.com/innei/)
