<div align="center">

# 🐟 闲鱼扫货助手

**告别手动翻页、逐个砍价的低效扫货方式**

AI 帮你搜、帮你筛、帮你聊 —— 你只需要告诉它"你想买什么"

[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Playwright](https://img.shields.io/badge/Playwright-Chromium-2EAD33?logo=playwright&logoColor=white)](https://playwright.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

</div>

---

## 它能做什么？

> "我想买一台 MacBook Air M4，成色9新以上，电池健康90%+，预算4500以内"

你只需要像这样描述需求，然后：

| 步骤 | 做什么 | 谁来做 |
|:---:|--------|:---:|
| 1 | 在闲鱼搜索多个关键词，自动翻页采集商品 | 🤖 |
| 2 | 根据标题批量粗筛，排除明显不相关的 | 🤖 |
| 3 | 逐个打开详情页，深度判断是否符合需求 | 🤖 |
| 4 | 模拟真人跟卖家聊天、询价、砍价 | 🤖 |
| 5 | 看看结果，挑一个满意的下单 | **你** |

整个过程你可以在实时看板上全程围观。

## 核心亮点

🔍 **智能搜索** — 多关键词并行、价格/地区/个人闲置多维筛选，一次覆盖不遗漏

🧠 **AI 双重筛选** — 标题粗筛 + 详情页细筛，像有经验的买家一样精准判断

💬 **自动询价砍价** — AI 用高情商话术与卖家聊天，有策略地谈价，聊到满意为止

🎯 **目标达成检测** — 自动判断何时谈妥、何时放弃，不浪费时间在死单上

📊 **实时看板** — 搜了多少、筛了多少、聊到哪了，全部一目了然

🔌 **自带 API 配置面板** — 不改代码，在界面上选供应商、填Key、选模型就能用

## 30 秒上手

```bash
git clone https://github.com/Disrush/xianyu-shopping-assistant.git
cd xianyu-shopping-assistant
npm install
npx playwright install chromium
npm start
```

打开 http://localhost:3000 → 点「设置」配置 API Key → 点「新建任务」开始扫货

> **Windows 用户** 更简单：双击 `start.bat`，全自动安装启动

## 支持的 AI 服务商

开箱预设了 **8 大主流服务商**，也可以填任何 OpenAI 兼容的自定义端点：

| 服务商 | 推荐模型 | 说明 |
|--------|---------|------|
| **DeepSeek** | DeepSeek V3 | 性价比之王，中文能力强 |
| **OpenRouter** | 自选 | 聚合平台，一个Key用几百个模型 |
| **OpenAI** | GPT-4o Mini | 经典选择 |
| **通义千问** | Qwen Plus | 阿里出品，国内直连快 |
| **SiliconFlow** | DeepSeek V3 | 硅基流动，国内平台免翻墙 |
| **智谱 AI** | GLM-4 Flash | 免费额度多 |
| **Moonshot** | Kimi 128K | 长上下文 |
| **Groq** | Llama 3.3 70B | 推理最快 |
| **自定义** | 任意 | 填入你自己的 Base URL |

> 💡 **推荐**：用 DeepSeek V3 或 GPT-4o Mini，性价比最高。单次任务约消耗几分钱到几毛钱。

## 使用流程

```
⚙️ 配置 API  →  📝 新建任务  →  🔍 自动搜索  →  🧠 AI 粗筛  →  🔬 AI 细筛  →  💬 自动聊天  →  🎯 查看结果
```

**新建任务时你可以配置：**

- 搜索关键词（支持多个，逗号分隔）
- 价格区间、地区、仅个人闲置
- 自然语言需求描述（AI 筛选依据）
- 谈价策略（心理价位、砍价节奏）
- 聊天人设（默认是高情商女大学生买家）
- 粗筛/细筛 Prompt（高级用户可自定义）

## 项目结构

```
├── server.mjs           # Express + WebSocket 主服务
├── start.bat            # Windows 一键启动
├── public/
│   ├── index.html       # 看板界面
│   ├── app.js           # 前端逻辑（任务管理、配置、实时更新）
│   └── style.css        # 暗色主题样式
├── lib/
│   ├── config.mjs       # API 配置管理（多供应商支持）
│   ├── ai.mjs           # LLM 调用、Prompt 工程
│   ├── task.mjs         # 任务流水线编排
│   ├── search.mjs       # 闲鱼搜索与商品采集
│   ├── filter.mjs       # AI 粗筛 / 细筛
│   ├── chat.mjs         # 自动聊天引擎
│   ├── login.mjs        # 登录状态检测
│   ├── browser.mjs      # Playwright 浏览器管理
│   └── utils.mjs        # 工具函数
└── data/                # 运行时数据（gitignore）
```

## 常见问题

<details>
<summary><b>首次运行要登录吗？</b></summary>
是的。首次启动时会弹出 Chromium 浏览器，你需要在闲鱼网页端手动登录一次。之后登录状态会自动保持。
</details>

<details>
<summary><b>遇到滑块验证怎么办？</b></summary>
在弹出的浏览器窗口中手动完成验证即可，系统会自动检测并等待你完成，之后继续执行。
</details>

<details>
<summary><b>任务中断了数据会丢吗？</b></summary>
不会。所有进度都实时保存，重新启动任务会从上次中断的阶段恢复。
</details>

<details>
<summary><b>API Key 安全吗？</b></summary>
API Key 仅保存在你本地的 <code>data/config.json</code> 中，该文件已加入 .gitignore，不会被提交或上传。
</details>

<details>
<summary><b>一次任务大概花多少 API 费用？</b></summary>
取决于商品数量和聊天轮次。典型场景（搜3页、筛选50个、聊天5个卖家）大约消耗 ¥0.05 ~ ¥0.5。
</details>

## 环境要求

- **Node.js** v18+（[下载](https://nodejs.org/)）
- **操作系统** Windows / macOS / Linux
- **网络** 能访问闲鱼(goofish.com) + 你选择的 AI 服务商

## License

MIT — 随便用，觉得有用给个 Star ⭐
