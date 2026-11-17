# FileDock

**FileDock** 是一个本地运行的文件处理工具，参考 **Notepad++** 与 **Beyond Compare**：

- 多标签文本 / 代码编辑器，语法高亮、查找替换、编码与换行符处理
- Markdown 实时预览、JSON 格式化与高亮视图，覆盖常见的文本 / 配置文件格式
- 文件并排 / 行内差异对比，行级 + 词级高亮
- 文件夹递归对比，左右两栏按路径对齐，支持过滤、单文件与批量同步
- **Everything 式快速查找文件**：后台建立文件名索引，跨文件夹、跨磁盘即时搜索
- 文件、文件夹直接拖进窗口即可打开

界面为中文，只在本机运行。

---

## 运行方式

FileDock 只有一个运行时：**Tauri 2 桌面应用**。Rust 进程同时提供界面与 `/api` 接口，前端资源在编译期嵌入可执行文件，不依赖 Node.js，也不打包 Chromium，安装包约 4 MB。

```bash
npm install          # 首次，安装 Tauri CLI
npm run desktop      # 开发模式启动（需要 Rust 工具链）
npm run dist         # 打包 Windows 安装包
```

打包产物（`npm run dist` 会自动复制到 `dist/`）：

- `dist/FileDock_<版本>_x64-setup.exe`：安装版（NSIS，当前用户安装）
- `dist/FileDock.exe`：可直接复制的单文件免安装版

Windows 下也可以双击 `start.bat` 启动 `dist/` 里已打包的版本。

桌面版特性：

- 无系统标题栏，窗口按钮与拖拽区域由界面自带
- 关闭时检测未保存修改，确认后才退出
- 窗口大小 / 位置 / 最大化状态自动记住
- 单实例运行，重复启动会聚焦已打开的窗口
- 支持从资源管理器把文件或文件夹拖进窗口打开
- 界面静态资源与示例项目编译进可执行文件；示例项目首次运行释放到
  `%LOCALAPPDATA%\FileDock\demo`，可直接编辑
- 本地服务固定使用 `127.0.0.1:5278`（可用 `FILEDOCK_DESKTOP_PORT` 修改），
  只对应用自身窗口开放
- 首次启动会接管旧版 TwinPad 的窗口状态与索引缓存

## 快速查找文件（Everything 式）

按 **Ctrl + P**，或点击工具栏的「查找文件」。

1. 首次搜索某个范围时，FileDock 会在后台扫描并建立文件名索引；结果会随着扫描进度持续出现。
2. 顶部下拉框可以切换搜索范围：
   - 当前文件夹
   - 主目录
   - 桌面 / 文档 / 下载
   - 各个磁盘（C:、D: 等）
3. 输入文件名、路径片段，支持空格分隔多个关键词，也支持 `*` / `?` 通配符：
   - `report 2026`
   - `*.json`
   - `src app`
4. 键盘操作：
   - `↑` / `↓` 选择
   - `Enter` 打开文件；选中文件夹时切换资源管理器根目录
   - `Shift + Enter` 在系统资源管理器中定位
   - `F5` 或「刷新索引」重新扫描当前范围
   - `Esc` 关闭

索引缓存保存在本机：

- Windows：`%LOCALAPPDATA%\FileDock\index\`
- 其他系统：`~/.cache/filedock-index/`

索引默认最多收录 **500,000** 项，可通过环境变量调整：

```powershell
$env:FILEDOCK_INDEX_MAX = "1000000"
.\dist\FileDock.exe
```

默认跳过 `.git`、`node_modules`、`__pycache__`、`$RECYCLE.BIN`、`System Volume Information`、`WinSxS` 等目录。文件内容修改会增量更新索引；外部程序造成的变更会在下次刷新或索引过期后重新扫描。

## 编辑器

- CodeMirror 5：语法高亮、括号匹配、自动补全括号、代码折叠、当前行高亮
- 多标签、未保存标记、可选自动保存、会话恢复
- 编码识别：UTF-8、UTF-8 BOM、UTF-16 LE/BE、GBK（读取）
- 换行符切换：LF / CRLF / CR
- 查找 / 替换、转到行、格式化 JSON、大小写转换、行操作
- 快速打开最近文件、命令面板
- 常见格式开箱即用：Markdown、JSON / JSONC、YAML、TOML、INI、HTML / XML、CSS / SCSS、
  JavaScript / TypeScript、Python、Go、Rust、SQL、Shell、PowerShell 等
- Markdown 预览：打开 `.md` 后点工具栏的眼睛按钮，或按 **Ctrl + Shift + V**，
  右侧实时渲染标题、列表、代码块、表格与引用
- JSON 预览：`.json` / `.jsonc` 可切换为高亮视图，并提示是否有效、对象键数量

## 文件与文件夹对比

- 文件对比：并排或行内视图，逐行 / 逐词差异
- 可忽略大小写、空白、空行
- 文件夹对比：左右两栏按相对路径对齐，中间显示状态；支持快速模式（大小 + 时间）与内容哈希模式
- 状态筛选：相同 / 修改 / 仅左 / 仅右
- 单文件复制、整批同步、在编辑器中打开左右版本
- 支持 include / exclude 通配符

## 快捷键

| 操作 | 快捷键 |
| --- | --- |
| 新建文件 | Ctrl + N |
| 打开文件 / 文件夹 | Ctrl + O / Ctrl + Shift + O |
| 保存 / 另存为 | Ctrl + S / Ctrl + Shift + S |
| 快速查找文件 | Ctrl + P |
| 命令面板 | Ctrl + Shift + P |
| 当前文件查找 / 替换 | Ctrl + F / Ctrl + H |
| 文件夹内容搜索 | Ctrl + Shift + F |
| 比较文件 / 文件夹 | Ctrl + Alt + C / Ctrl + Alt + D |
| 下一个 / 上一个差异 | Alt + ↓ / Alt + ↑ |
| 显示 / 隐藏侧边栏 | Ctrl + B |
| 预览 Markdown / JSON | Ctrl + Shift + V |
| 设置 / 快捷键帮助 | Ctrl + , / F1 |

## 安全说明

- 服务只监听 `127.0.0.1`，并校验 Host 与 `x-app-token`。
- 每次启动生成随机访问令牌，页面通过 `x-app-token` 调用本地 API。
- 桌面版窗口只加载本机地址；文件操作只在本机进行，不上传任何内容。
- 删除为永久删除（不进入回收站），界面会有确认。
- 可通过 `FILEDOCK_ROOT` 限制可访问的根目录：

```powershell
$env:FILEDOCK_ROOT = "D:\Projects"
.\dist\FileDock.exe
```

## 项目结构

```text
Cargo.toml                Rust 依赖与 release 体积配置
build.rs                  声明监听 public/ 与 demo/，前端改动触发重新内嵌
tauri.conf.json           NSIS / WebView2 / 图标配置
src/main.rs               Tauri 启动、单实例、本地服务线程
src/api.rs                axum 路由、18 个 /api 接口、静态资源与令牌校验
src/fsutil.rs             路径解析、编码读写、遍历、搜索、替换、目录 diff
src/index.rs              Everything 式文件名索引（后台构建 + gzip 缓存）
src/window.rs             无边框窗口、窗口状态、关闭确认、原生拖放事件
src/assets.rs             内嵌前端静态资源与示例项目释放
icons/                    应用图标（由 `npx tauri icon` 生成）
capabilities/             Tauri 权限配置
gen/                      Tauri 生成的配置 schema（可忽略）
web/                      内嵌占位页（窗口实际加载本地服务）
build/icon.png            应用图标源文件（由 scripts/make-icon.mjs 生成）
dist/                     打包产物（安装包与免安装 exe）
public/
  index.html              界面骨架
  css/app.css             主题与全部样式
  js/app.js               主控制器、菜单、命令、快速查找 UI
  js/bridge.js            桌面窗口 / 拖放桥（仅桌面版生效）
  js/editor.js            CodeMirror 封装
  js/compare.js           文件 / 文件夹对比视图
  js/explorer.js          资源树与文件操作
  js/diff.js              行级 / 词级 diff
  js/preview.js           Markdown 渲染与 JSON 高亮视图
  js/ui.js                DOM、弹窗、选择器、提示
  js/api.js               带令牌的 API 客户端
  vendor/codemirror/      CodeMirror 5
demo/left, demo/right      示例对比项目
scripts/                  资源下载 / 图标生成脚本
```

## 开发

```bash
npm run desktop      # Tauri 桌面模式（Rust + WebView2）
npm run dist         # 生成 Windows 安装包（产物在 dist/）
npm run check        # cargo check，快速检查 Rust 代码
npm run vendor       # 重新下载 CodeMirror 资源
npm run icons        # 生成 Lucide 图标模块
npm run app-icon     # 重新生成 build/icon.png
```

`public/` 与 `demo/` 在编译期嵌入可执行文件：修改后重新运行 `npm run desktop`
会重新编译（`build.rs` 已声明监听这两个目录）。修改 Rust 代码时 Tauri
会自动重新编译。发布前可用 `npm run check` 做快速检查。
