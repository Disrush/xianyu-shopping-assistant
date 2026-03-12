# 🐟 闲鱼智能助手

AI 驱动的闲鱼二手商品自动搜索、智能筛选与自动询价工具。

## 功能特性

- **多关键词搜索** — 支持同时搜索多个关键词，自动翻页采集
- **智能筛选** — AI 两轮筛选（标题粗筛 + 详情页细筛），精准匹配需求
- **自动询价** — AI 模拟真人与卖家沟通，支持自定义谈价策略和聊天人设
- **实时看板** — WebSocket 实时推送，可视化任务进度、商品列表、聊天记录
- **灵活配置** — 支持多种 AI 服务商，自定义 Prompt 和筛选规则
- **任务恢复** — 中断后可从上次进度恢复，聊天会话自动接续

## 支持的 AI 服务商

通过前端「设置」面板配置，支持所有 OpenAI 兼容的 API 接口：

| 服务商 | 说明 |
|--------|------|
| OpenRouter | 聚合平台，支持数百个模型 |
| OpenAI | GPT-4o、GPT-4o Mini 等 |
| DeepSeek | DeepSeek V3、R1 |
| 通义千问 | Qwen Plus/Turbo/Max |
| SiliconFlow | 硅基流动，国内平台 |
| 智谱 AI | GLM-4 系列 |
| Moonshot | Kimi 系列 |
| Groq | Llama、Mixtral 等开源模型 |
| 自定义 | 任何 OpenAI 兼容端点 |

## 快速开始

### 环境要求

- [Node.js](https://nodejs.org/) v18 或更高版本
- Windows / macOS / Linux

### 方法一：一键启动（Windows）

1. 双击 `start.bat`
2. 浏览器打开 http://localhost:3000
3. 点击右上角「设置」配置你的 AI API 密钥
4. 点击「新建任务」开始使用

### 方法二：命令行启动

```bash
# 克隆项目
git clone https://github.com/your-username/xianyu-assistant.git
cd xianyu-assistant

# 安装依赖
npm install

# 安装 Playwright 浏览器
npx playwright install chromium

# 启动服务
npm start
```

打开 http://localhost:3000，在「设置」中配置 API 后即可使用。

## 使用流程

```
配置 API → 新建任务 → 自动搜索 → AI 粗筛 → AI 细筛 → 自动询价 → 查看结果
```

1. **配置 AI API** — 在设置面板中选择服务商、填入 API Key、选择模型
2. **新建任务** — 填写搜索关键词、价格区间、需求描述、谈价策略
3. **自动执行** — 系统自动完成搜索→筛选→询价全流程
4. **实时监控** — 在看板上实时查看进度、商品列表和聊天记录

## 项目结构

```
├── server.mjs          # Express + WebSocket 服务入口
├── start.bat           # Windows 一键启动脚本
├── package.json
├── public/
│   ├── index.html      # 前端页面
│   ├── app.js          # 前端逻辑
│   └── style.css       # 样式
├── lib/
│   ├── config.mjs      # API 配置管理
│   ├── ai.mjs          # AI 调用与 Prompt
│   ├── task.mjs        # 任务管理与流水线
│   ├── search.mjs      # 闲鱼搜索与采集
│   ├── filter.mjs      # AI 粗筛 / 细筛
│   ├── chat.mjs        # 自动聊天与询价
│   ├── login.mjs       # 登录状态检测
│   ├── browser.mjs     # Playwright 浏览器管理
│   └── utils.mjs       # 工具函数
└── data/               # 运行时数据（自动生成，已 gitignore）
```

## 注意事项

- 首次运行需要在闲鱼网页端手动登录一次，登录状态会自动保持
- 如遇到平台验证（滑块等），在弹出的浏览器窗口中手动完成即可
- 建议使用成本较低的模型（如 DeepSeek V3、GPT-4o Mini），任务会产生较多 API 调用
- API 密钥仅保存在本地 `data/config.json`，不会上传到任何地方

## License

MIT
