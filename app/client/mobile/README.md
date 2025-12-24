# ONE-AI Mobile

基于 UniApp + Vue 3 + TypeScript + Vite 的移动端应用

## 技术栈

- **框架**: UniApp + Vue 3
- **语言**: TypeScript
- **构建工具**: Vite 5
- **状态管理**: Pinia
- **样式方案**: Windi CSS + SCSS
- **国际化**: Vue-i18n
- **HTTP 请求**: Axios
- **Markdown 渲染**: Markdown-it

## 项目结构

```
mobile/
├── src/
│   ├── api/          # API 接口定义
│   ├── assets/       # 静态资源
│   ├── components/   # 公共组件
│   ├── hooks/        # 自定义 Hooks
│   ├── pages/        # 页面文件
│   ├── store/        # Pinia 状态管理
│   ├── styles/       # 全局样式
│   ├── utils/        # 工具函数
│   ├── App.vue       # 应用主组件
│   ├── main.ts       # 应用入口
│   ├── pages.json    # 页面路由配置
│   └── manifest.json # 应用配置清单
├── build/            # 构建工具
├── types/            # 类型定义
├── package.json      # 项目依赖
├── vite.config.ts    # Vite 配置
├── tsconfig.json     # TypeScript 配置
└── windi.config.ts   # Windi CSS 配置
```

## 开发

```bash
# 安装依赖
pnpm install

# 启动开发服务器（H5）
pnpm dev

# 构建生产版本
pnpm build

# 类型检查
pnpm type-check
```

## 环境变量

项目支持多环境配置：

- `.env.development` - 开发环境
- `.env.test` - 测试环境
- `.env.production` - 生产环境

## 支持平台

- H5
- 微信小程序（可按需添加其他小程序平台支持）

## 特性

- ✅ TypeScript 类型安全
- ✅ Pinia 状态管理
- ✅ 原子化 CSS（Windi CSS）
- ✅ 自动组件导入
- ✅ 路径别名（@/ 和 #/）
- ✅ 代码规范（ESLint + Prettier）
- ✅ 国际化支持
- ✅ Markdown 渲染
- ✅ SSE 支持
