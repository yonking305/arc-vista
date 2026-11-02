# ArcVista 观界 · 内网离线安装包

**一键安装、全程离线。** 不需要 npm registry、GitHub 或任何外网访问；插件本体和安装所需的文件都在 `payload/` 里。

| 内容 | 版本 |
| --- | --- |
| **dsh-arcvista**（DSH Web 插件 `dsh-arcvista`） | {{VERSION}} |
| 安装方式 | 复制到 DSH profile + 注册 bundle（可选走 pnpm） |
| 安装器 | Node.js 单文件脚本（无第三方依赖） |
| 支持平台 | Windows 10/11 · macOS · Linux |

安装后 DSH 左侧栏会出现 **ArcVista 观界** 入口，点击即可打开完整的架构观测台页面。

![DSH 中的 ArcVista](docs/dsh-plugin.png)

## 前置条件

- **已安装 DeepSeek Harness**，并且至少启动过一次（存在 `~/.dsh/profiles/web`）。Windows 便携版默认使用 `%USERPROFILE%\.dsh`。
- **Node.js 22.19+**（DSH 自带；`node -v` 确认）。插件使用 Node 内置 `node:sqlite`。
- 目标机器有 **git**（分析仓库时使用），被观测的 Git 仓库在内网可达。
- 磁盘空间：安装约 1 MB；分析仓库时按仓库大小额外占用（默认在 `~/.dsh/arcvista`）。

> 不需要预装 pnpm，也不需要 npm registry。安装器只做本地文件复制与 profile 注册。

## 一键安装

### Windows

双击 **`install.bat`**。如果 PowerShell 执行策略拦截，也可以：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

> 建议用 **7-Zip** 解压，避免 Windows 自带解压遇到路径过长问题。

### macOS

双击 **`install.command`**。如果系统提示无法打开（未签名），右键 → 打开，或在终端执行：

```bash
cd arc-vista-intranet-installer
./install.sh
```

### 任意平台（推荐给管理员）

```bash
cd arc-vista-intranet-installer
node install.mjs
```

先看看会做什么（不写文件）：

```bash
node install.mjs --dry-run
```

安装器会依次完成：

1. 定位 DSH 数据目录与 profile（默认 `~/.dsh` / `web`；profile 不存在时调用 `dsh` 初始化）；
2. 把已有的 `package.json` 和旧版插件备份到 `<profile>/.dsh-offline-plugins/backups/<时间戳>/`；
3. 把插件复制到 `<profile>/node_modules/dsh-arcvista`，并把离线 tarball 存到 `<profile>/.dsh-offline-plugins/`；
4. 在 `<profile>/package.json` 里写入 `file:` 依赖、在 `dsh.profile.bundles` 里注册插件；
5. 用 `dsh --profile <名字> --dump-config` 校验插件条目已进入配置树。

失败时会自动回滚到安装前的状态。

## 安装后

1. **退出并重新启动 DSH Web**（Host 插件在 DSH 启动时加载，热更新不生效）；
2. 左侧栏出现 **「ArcVista 观界」**，点击即可打开面板；
3. 面板顶部显示「已连接」即安装成功。也可以直接访问：

```text
http://127.0.0.1:3080/arcvista/
```

手工确认插件已进入配置树：

```bash
dsh --profile web --dump-config | grep -A2 arcvista
```

应能看到：

```yaml
- id: arcvista
  name: dsh-arcvista
```

重新检查安装状态（不写文件）：

```bash
node install.mjs --verify
```

## 常用参数

| 参数 | 说明 |
| --- | --- |
| `--dsh-home <目录>` | DSH 数据目录，默认 `$DSH_HOME`，否则 `~/.dsh`（Windows 为 `%USERPROFILE%\.dsh`） |
| `--profile <名称>` | DSH profile 名称，默认 `$DSH_PROFILE`，否则 `web` |
| `--dry-run` | 只打印安装 / 卸载计划，不写任何文件 |
| `--verify` | 只检查当前安装状态，不写任何文件 |
| `--uninstall` | 卸载插件（保留数据目录与备份） |
| `--no-backup` | 覆盖旧版时不保留备份 |
| `--no-verify` | 安装后不调用 `dsh --dump-config` 校验 |
| `--dsh-bin <路径>` | 指定 `dsh` 命令或 `lib/bin.js` 入口（找不到 `dsh` 时使用） |
| `-y`, `--yes` | 跳过交互确认（当前版本无需确认，保留兼容） |

示例：

```bash
# 装到自定义 DSH 数据目录 / profile
node install.mjs --dsh-home /data/dsh-home --profile web

# 卸载（数据目录 ~/.dsh/arcvista 保留）
node install.mjs --uninstall
```

## 数据、网络与权限

- **数据目录**：`~/.dsh/arcvista`（SQLite 数据库、仓库镜像、worktree、自动备份），与 DSH 其他数据分开；卸载不会删除。
- **网络**：安装器本身不联网。插件运行后，分析时会用 `git` 克隆 / 拉取**被观测仓库**，因此仓库地址必须在内网可达（或先用本地路径方式接入）。
- **模型**：分析语义增强使用 DSH 当前的默认模型，通过 DSH 内部 `llm` 服务调用，不需要在 ArcVista 里配置 Base URL / API Key；内网没有可用模型时，架构、依赖、安全守护、复杂度、覆盖率与知识图谱仍由静态分析引擎完整生成。
- **权限**：只读取被观测仓库的工作区文件，不会修改你的仓库；不需要管理员权限（写入用户目录即可）。

## 升级

1. 退出 DSH Web；
2. 解压新版安装包；
3. 重新运行安装器。

安装器会把旧版插件目录和 `package.json` 备份到 `<profile>/.dsh-offline-plugins/backups/`，升级失败可据此回滚。

## 卸载

```bash
node install.mjs --uninstall
```

会移除插件目录、`package.json` 里的依赖与 `dsh.profile.bundles` 注册；旧文件移到 `<profile>/.dsh-offline-plugins/backups/`。数据目录 `~/.dsh/arcvista` 保留，确认不再需要后可手动删除。

## 版本与校验

| 项目 | 值 |
| --- | --- |
| 插件版本 | `{{VERSION}}` |
| 离线包 | `payload/dsh-arcvista-{{VERSION}}.tgz` |
| SHA-256 | `{{SHA256}}` |
| 生成日期 | {{DATE}} |

安装器会自动核对 tarball 的 SHA-256 与 `manifest.json`；不一致会中止安装，提示重新拷贝。

手动校验：

```bash
# macOS / Linux
shasum -a 256 payload/dsh-arcvista-{{VERSION}}.tgz
# Windows PowerShell
Get-FileHash payload\dsh-arcvista-{{VERSION}}.tgz -Algorithm SHA256
```

## 独立运行（不安装 DSH 也能用）

`payload/dsh-arcvista/` 同时是一个可独立运行的服务端：

```bash
node payload/dsh-arcvista/server.js
# 打开 http://127.0.0.1:4321
```

独立模式使用自身目录下的 `data/`，没有 DSH 模型增强，但架构图、安全守护、知识图谱、复杂度、覆盖率与分支对比都可用。适合只想快速试用、或内网暂时不方便装 DSH 的场景。

## 常见问题

**找不到 Node.js / 版本过低**

安装器要求 Node.js 22.19+。DSH 便携版自带 Node（Windows 为 `%LOCALAPPDATA%\DeepSeekHarness\app\node\node.exe`），`install.bat` 会自动使用；手动运行时可先 `node -v` 确认。

**提示 profile 不存在**

说明目标机器还没启动过 DSH。先启动一次 DSH Web（或运行 `dsh --profile web`），再重新执行安装器；安装器在能找到 `dsh` 命令时也会自动初始化 profile。

**找不到 dsh 命令**

不影响安装，只会跳过 `--dump-config` 校验。DSH 便携版的 `dsh` 在安装目录里，PATH 未生效时可以 `--dsh-bin` 指定，例如：

```powershell
node install.mjs --dsh-bin "%LOCALAPPDATA%\DeepSeekHarness\dsh.cmd"
```

**重启后左侧栏没有「ArcVista 观界」**

1. 确认 `<profile>/node_modules/dsh-arcvista/package.json` 存在；
2. 确认 `<profile>/package.json` 的 `dsh.profile.bundles` 包含 `dsh-arcvista`；
3. 运行 `node install.mjs --verify` 或 `dsh --profile web --dump-config | grep arcvista`；
4. 确认 DSH 进程**完全退出**后重启（Windows 注意托盘图标 / 任务管理器里的残留进程）。

**面板显示「插件后端未就绪」**

插件 Host 部分没有激活。通常是改完文件没有重启 DSH，或 `/arcvista` 路由被其它服务占用。完全重启 DSH Web 后再试；仍失败请把 DSH 启动日志发给管理员。

**Windows SmartScreen / 杀毒软件提示**

安装包没有商业代码签名，确认来源可信后点「更多信息 → 仍要运行」；杀毒软件误报 `node.exe` 时把安装目录加入白名单。本包只包含 Node.js 脚本和插件文件，不运行远程脚本。

**macOS 提示「无法验证开发者」**

右键 `install.command` → 打开；或执行：

```bash
xattr -dr com.apple.quarantine arc-vista-intranet-installer
```

**后续想继续用 pnpm 管理插件**

profile 里的依赖写成了 `file:.dsh-offline-plugins/dsh-arcvista-{{VERSION}}.tgz`，pnpm 可以离线解析。请保留 `<profile>/.dsh-offline-plugins/` 目录，不要在未安装前运行 `pnpm install --force` 之类的清理操作。如果内网有 pnpm，也可以直接用离线 tarball 走官方命令：

```bash
dsh plugin --profile web add ./payload/dsh-arcvista-{{VERSION}}.tgz
```

**数据太大 / 想清空**

仓库镜像在 `~/.dsh/arcvista/repos` 与 `worktrees`，可直接删除，重新分析会重建；数据库备份在 `~/.dsh/arcvista/backups`（默认保留 12 份）。

## 说明

- 安装器**只做本地文件复制与 DSH profile 注册**，不下载、不执行远程脚本，不含 `install` / `prepare` 等生命周期脚本。
- 插件不修改 DSH 核心，不占用 `@deepseek-ai/*` 命名空间。
- 许可：MIT。
