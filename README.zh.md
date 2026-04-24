# opencode-copilot-multi-auth

[English](README.md)

npm 上的包主页: https://www.npmjs.com/package/@gnahz77/opencode-copilot-multi-auth

这个分支（fork）将旧的 GitHub Copilot chat-auth 流程替换为更新的 Copilot CLI 风格的 OAuth 流程，并使 `opencode` 使用您的账户实时获取的 Copilot 模型元数据。

## 如何使用

将该插件添加到您的 `opencode` 配置中：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "@gnahz77/opencode-copilot-multi-auth@0.1.4"
  ]
}
```

然后启动 `opencode` 并登录到 `github-copilot` 供应商。该插件处理类似 Copilot CLI 风格的设备授权流程，并在之后重用存储的 GitHub OAuth 令牌。

如果您还希望使用该包提供的 TUI 命令支持，请将相同的插件添加到您的 `tui.json` 或 `tui.jsonc` 中：

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "@gnahz77/opencode-copilot-multi-auth@0.1.4"
  ]
}
```

重新启动 OpenCode TUI 后，您可以打开命令面板并运行 `copilot-usage`，或直接输入 `/copilot-usage`。
插件会打开一个弹窗，显示从拆分的本地存储中加载的所有账户：

- OAuth/账户数据：`~/.local/share/opencode/copilot-auth.json`
- 单账户路由策略：`~/.config/opencode/copilot-auth.json`

对于发布前的本地开发，您可以直接加载该文件：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "file:///absolute/path/to/dist/index.js"
  ]
}
```

重要提示：如果文件路径包含 `opencode-copilot-auth`，当前的 `opencode` 构建可能会因为硬编码的插件名称过滤器而跳过加载它。请使用不包含该子字符串的路径。

如果您在开发过程中在本地加载插件并希望使用 `copilot-usage`，请同时将构建的 TUI 入口添加到您的 TUI 配置中：

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "file:///absolute/path/to/dist/tui.js"
  ]
}
```

## `copilot-usage` 命令

此包现在包含一个名为 `copilot-usage` 的 TUI 命令。

- 命令面板入口：`copilot-usage`
- Slash 命令：`/copilot-usage`

它的功能：

- 从合并后的本地池中读取每个 Copilot 账户，池子组装自：
  - `~/.local/share/opencode/copilot-auth.json` (OAuth/账户数据)
  - `~/.config/opencode/copilot-auth.json` (路由策略)
- 使用该账户的 OAuth 令牌，为每个账户调用 GitHub Copilot 的配额端点 `/copilot_internal/user`
- 打开一个弹窗界面，为每个账户显示：
  - 账户名称
  - 已使用 / 总额度条
  - 使用百分比

注意事项：

- 该命令是此包 TUI 目标的一部分，所以只配置 `opencode.json` 是不够的；`tui.json` 必须也加载此插件。
- 被禁用的账户仍然会显示在弹窗中，并会被标记为已禁用。
- 如果某个账户加载使用数据失败，弹窗仍会显示其他账户，并在行内包含该账户的错误消息。

## 这个分支有什么改变

- 授权流程：使用了类似 Copilot CLI 风格的 OAuth 客户端流程，并直接保留了 GitHub OAuth 令牌。
- 授权配额：获取 `/copilot_internal/user`，并使用授权提供的 Copilot API 基础 URL。
- 令牌交换：不再调用 `/copilot_internal/v2/token`。
- 请求配置：使用较新的 `copilot-developer-cli` 请求头，替代了旧版的聊天配置。
- 模型元数据：通过插件的 `provider.models` 钩子获取实时的 Copilot `/models` 响应，以便最终的 `opencode` 模型列表来源于 Copilot API 所支持的实时配额。

## 上下文窗口与模型限制

与上游的主要实际区别在于，此分支从 Copilot 动态应用实时的按模型限制，而不是仅依赖静态元数据。

这意味着 `opencode` 可以看到 Copilot 宣告的以下各项的值：

- `limit.context`
- `limit.input`
- `limit.output`

截至 2026 年 3 月 10 日，此分支使用的实时 GitHub Copilot `/models` 响应暴露了 Copilot CLI 的模型配置。下表比较了实时 Copilot CLI 的上下文窗口与 [`models.dev`](https://models.dev) 上的静态 `github-copilot` 目录。

| 模型                  | 此分支 (CLI 上下文) | `models.dev` 上下文 | 差异    |
| ------------------- | ----------------------: | -------------------: | ---------: |
| `claude-opus-4.6`   |                 200,000 |              128,000 |    +72,000 |
| `claude-sonnet-4.6` |                 200,000 |              128,000 |    +72,000 |
| `claude-haiku-4.5`  |                 144,000 |              128,000 |    +16,000 |

实际收获是，该分支比静态的 `models.dev` 值提供了更大的实时 Claude 上下文窗口。

此分支观察到的例子：

- `claude-sonnet-4.6`
  - context window (上下文窗口): `200000`
  - prompt/input limit (提示/输入限制): `168000`
  - output limit (输出限制): `32000`
- `claude-opus-4.6`
  - context window (上下文窗口): `200000`
  - prompt/input limit (提示/输入限制): `168000`
  - output limit (输出限制): `64000`
- `claude-haiku-4.5`
  - context window (上下文窗口): `144000`
  - prompt/input limit (提示/输入限制): `128000`
  - output limit (输出限制): `32000`

如果不打这些补丁，`opencode` 可能会因为其使用的初始静态模型目录而显示过期或偏小的限制。

## Claude 思考预算 (thinking budget) 行为

此分支还改变了 Copilot Claude 请求的行为：

- 当选择 `thinking` 变体时，它发送 `thinking_budget: 16000`
- 当未选择变体时，它完全省略 `thinking_budget`

这不同于上游的 `opencode`，上游目前为内置的 `thinking` 变体发送 `thinking_budget: 4000`。

该插件故意不尝试修改 `opencode` 的核心 UI。所以可见的 Claude 变体列表依然由 `opencode` 本身控制；该分支改变的是请求行为，而不是内置变体选择器的标签。

## 发布 (Publishing)

```zsh
./script/publish.ts
```

## 多账户支持

此分支在分离的本地文件中保存 Copilot 的账户状态：

- OAuth 必需的账户数据：`~/.local/share/opencode/copilot-auth.json`
- 单账户路由策略：`~/.config/opencode/copilot-auth.json`

在启动时，该插件会自动将旧版的单文件存储迁移到这种双文件布局中。

每次成功的 OAuth 登录都会自动更新该池：用一个具有特定作用域部署的新账户登录会追加一条新记录，而在同一部署上用相同的 GitHub 身份再次登录会更新现有记录，而不是创建重复项。

在运行时，插件将这两个文件合并为路由所用的同一内存中 `version: 2` 池结构 (`accounts`)。

| 字段 | 含义 |
| --- | --- |
| `id` | 与账户记录一起存储的稳定的人类友好标识符。 |
| `name` | 账户的显示名称。 |
| `enabled` | 该账户是否能参与自动路由。被禁用的账户依然会保存，但在挑选赢家时会被忽略。 |
| `priority` | 当多个已启用的账户都可以提供同一个原始模型 ID 的服务时，较低的值优先（即数字越小优先级越高）。 |
| `allowlist` | 此账户获准提供服务的原始模型 ID 或 `*` 通配符模式。如果不为空，则账户只能提供与这些条目之一匹配的模型。 |
| `blocklist` | 此账户绝对不能提供服务的原始模型 ID 或 `*` 通配符模式。如果 `allowlist` 和 `blocklist` 均不为空，插件会首先检查 `allowlist`，然后应用 `blocklist`。 |

自动路由是基于 `opencode` 已经使用的原始 Copilot 模型 ID 来工作的。插件根据 `enabled` 过滤合格的账户，然后首先检查 `allowlist`（当不为空时，模型必须匹配其精确条目或通配符模式之一），然后应用 `blocklist`，最后通过最低的 `priority` 挑选出唯一的一个获胜账户（带有一个稳定的基于 key 的平局决胜机制）。模型 ID 本身没有被重写，因此账户标识不会出现在模型 ID 中。

通配符匹配区分大小写，且目前支持用 `*` 表示模式中任意位置的零个或多个字符。例如，`claude-*` 可以匹配 `claude-sonnet-4.6` 和 `claude-opus-4.6`。

示例授权文件 (`~/.local/share/opencode/copilot-auth.json`)：

```json
{
  "version": 2,
  "accounts": [
    {
      "key": "github.com:12345678",
      "deployment": "github.com",
      "domain": "github.com",
      "baseUrl": "https://api.githubcopilot.com",
      "identity": {
        "login": "octocat",
        "userId": 12345678
      },
      "auth": {
        "type": "oauth",
        "refresh": "<oauth token>"
      },
      "createdAt": "2026-04-15T00:00:00.000Z",
      "updatedAt": "2026-04-15T00:00:00.000Z"
    }
  ]
}
```

示例策略文件 (`~/.config/opencode/copilot-auth.json`)：

```json
{
  "version": 2,
  "accounts": [
    {
      "key": "github.com:12345678",
      "enabled": true,
      "priority": 100,
      "allowlist": ["claude-*"],
      "blocklist": []
    }
  ]
}
```
