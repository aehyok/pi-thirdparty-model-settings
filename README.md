# pi-thirdparty-model-settings

在 [pi](https://pi.dev) 终端里输入 `/dsf-config`（dsf 即"第三方"的拼音首字母），浏览器会打开一个本地配置页，填写第三方 API 的 Base URL、API Key 和模型，保存后 `/model` 里立即可见，无需重启。

## 安装

```bash
# 从 npm 安装（推荐）
pi install npm:pi-thirdparty-model-settings

# 或从 GitHub 安装
pi install git:github.com/aehyok/pi-thirdparty-model-settings

# 只想试用一次，不写入设置
pi -e npm:pi-thirdparty-model-settings
```

安装后重启 pi 或使用 `/reload` 即可启用插件。卸载：`pi remove npm:pi-thirdparty-model-settings`。

## 使用

| 命令 | 作用 |
|---|---|
| `/dsf-config` | 启动本地服务并在浏览器打开配置页（已打开时再次唤起） |
| `/dsf-config stop` | 关闭配置页服务 |

配置页功能：

- 新建 / 编辑 / 删除 Provider
- 接口协议：OpenAI 兼容、OpenAI Responses、Anthropic、Gemini
- 从接口 `GET {baseUrl}/models` 拉取模型列表，点选添加
- 每个模型可设置显示名、上下文、最大输出（支持 `128k`、`1M` 写法）、推理、图片输入
- 浅色 / 深色 / 跟随系统主题

## 工作方式

- 配置写入 `~/.pi/agent/models.json`（或 `PI_CODING_AGENT_DIR` 指定的目录），写入前备份为 `models.json.bak`；原文件不是合法 JSON 时拒绝覆盖。
- 保存后只刷新改动的 Provider，不受其他服务商联网刷新超时影响。
- 本地服务仅监听 `127.0.0.1`，URL 带随机 token；15 分钟无操作自动关闭。

## 安全提示

API Key 默认以明文写入 `models.json`。如不希望明文保存，可在 Key 一栏填写 `$ENV_NAME`，pi 会在请求时读取该环境变量。

## 要求

pi（`@earendil-works/pi-coding-agent`）1.3.0 及以上。

## License

MIT
