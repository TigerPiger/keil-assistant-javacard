# 工程开发历史记录

> 本文档记录每次开发迭代的主要改动，面向开发者阅读。插件对外发布说明请见 `CHANGELOG.md`。

---

## v2.0.0 — 2026-11-10

### 新增：按活动 Target 动态同步 VS Code 工作区文件夹

**问题**：Keil 工程引用的源码文件若不在 `.uvprojx` 所在文件夹下，则既不在 VS Code 原生资源管理器中显示，也无法通过 `Ctrl+Shift+F` 全局搜索覆盖。

**根因**：VS Code 原生 Explorer 和全局搜索都只覆盖"工作区文件夹"范围内的文件；本插件加载工程时仅打开 `.uvprojx` 所在目录作为工作区，工程中引用的外部源码文件不在工作区内。

**实现**（`src/ui/ProjectExplorer.ts`）：

| 改动 | 说明 |
|------|------|
| 新增 `managedFolderPaths: Set<string>` | 记录本插件动态添加的工作区文件夹路径（规范化小写），用于切换 Target 时清理旧目录 |
| `collectActiveTargetSourceDirs()` | 仅收集**当前活动 Target** 的源码文件目录（而非所有 Target），覆盖 FileGroup → Source → `.d` 依赖子文件 |
| `removeWorkspaceFolderAt(index)` | 逐个删除工作区文件夹的 Promise 封装；每次删除后等待 `onDidChangeWorkspaceFolders` 事件，符合 VS Code API 约束，带 1s 超时兜底 |
| `removeManagedFolders()` | 从后往前循环移除所有由本插件管理的工作区文件夹 |
| `syncWorkspaceFolders()` | 升级为异步；先移除旧管理目录，再追加当前活动 Target 所需、且未被现有工作区覆盖的目录（取最小集合：若 A 是 B 的子目录则丢弃 A） |

**触发时机**：

- `openProject`：工程加载后同步一次
- `loadWorkspace`：全部工程加载完毕后同步一次
- `switchTargetByProject`：**用户切换 Target 后立即重新同步**
- `statusBarSwitchTargetByProject`：状态栏切换 Target 后立即重新同步
- `closeProject`：关闭工程后清理其源码目录

**效果**：工作区文件夹随活动 Target 动态变化 → 原生 Explorer 可显示外部源码，`Ctrl+Shift+F` 全局搜索覆盖当前 Target 的所有源码。

### 工程化修复：npm 环境适配

原仓库脚本全部使用 `yarn`，但构建环境只有 npm。

| 改动 | 说明 |
|------|------|
| `package.json` scripts | 所有 `yarn` 调用改为 `npm run`；`vsce-package` 等移除 `--yarn` 参数 |
| 运行时依赖 `ini` | 原 package.json 只有 `@types/ini`（类型声明），缺少运行时包，已执行 `npm install ini --save` 补全 |
| vsce 打包 | 因仓库存在 `.yarnrc` 需显式加 `--no-yarn` 强制使用 npm，否则 vsce 会默认用 yarn 执行 prepublish 脚本 |

### 构建与打包

```powershell
npm install
npx tsc --noEmit
npx ts-node esbuild.ts --production    # 产物 dist/extension.js（约 616 KB）
npx vsce package --no-yarn --no-dependencies
# 产物 keil-vscode-assistant-2.0.0.vsix（约 842 KB）
```

### 分支与提交

- 分支 `javacard`，commit `8f4e48a`
- 提交文件：`src/ui/ProjectExplorer.ts`、`package.json`、`IMPLEMENTATION.md`

### Bug 修复：工作区文件夹同步不生效（时序与空值检查）

**实测问题**：手动点击"打开 Keil 工程"选择 `.uvprojx` 后，原生资源管理器仍只显示 `.uvprojx` 所在文件夹，外部源码目录未加入工作区。

**根因分析**（两个时序/判定 bug 叠加）：

| Bug | 位置 | 说明 |
|-----|------|------|
| 时序倒置 | `extension.ts` `explorer.open` | `openProject()` → `syncWorkspaceFolders()` 先于 `openWorkspace()` 执行，sync 时工作区还是旧的/空的 |
| 空值判定错误 | `openProject` 第 324 行 | `workspacePath` 初始值是 `''`（空字符串），但条件写的是 `=== undefined`，永远不触发工作区准备逻辑 |

**修复方案**：

1. **监听 `workspace.onDidChangeWorkspaceFolders`**（构造函数内注册）
   - 覆盖所有工作区变更场景：`openWorkspace`（vscode.openFolder）、手动调整、`updateWorkspaceFolders` 等
   - 回调中调用 `syncWorkspaceFolders()`，在工作区真正就绪后自动触发
   - 加 `isSyncing` 标记：`syncWorkspaceFolders` 内部自己调用 `updateWorkspaceFolders` 会再次触发事件，用 try/finally 包裹避免循环

2. **`openProject` 改造**（废弃破坏性 `vscode.openFolder`）
   - `workspacePath` 为空时：用非破坏性的 `workspace.updateWorkspaceFolders` 把 `.uvprojx` 所在目录加入工作区（而非弹窗→`openFolder`→return 中断流程）
   - 设 `this.workspacePath` 后继续加载工程，不再 return
   - 移除 `openProject` 内的直接 `syncWorkspaceFolders` 调用（统一由事件监听触发）

3. **`extension.ts` `explorer.open` 简化**
   - 移除冗余的 "switch workspace" 提示弹窗（`openProject` 内部已自动处理工作区）
   - 移除不再使用的 `dirname`、`File` import

**涉及文件**：
- `src/ui/ProjectExplorer.ts`
- `src/extension.ts`
- `package.json`（版本号 2.0.0）

### 性能优化：幂等差集更新 + 事件 debounce，避免频繁刷新

**实测问题**：打开文件或滑动窗口时扩展会频繁触发完整的工作区重建。

**根因**：`syncWorkspaceFolders` 每次调用都执行 remove-all → add-all 的破坏性操作；`onDidChangeWorkspaceFolders` 事件无 debounce 直接触发；没有一致性短路判定。

**修复**（`src/ui/ProjectExplorer.ts`）：

1. **事件 debounce**（300ms）
   - 构造函数里的 `onDidChangeWorkspaceFolders` 回调改为 setTimeout 延迟 300ms 执行
   - 短时间内多次触发自动合并为一次 sync

2. **一致性短路返回**
   - `syncWorkspaceFolders` 计算差集（toRemove/toAdd），如果都为空 → 直接 return，不做任何工作区变更
   - 这是最关键的优化：正常打开文件、滚动窗口等非工作区变更场景下，sync 会在第一步就短路返回

3. **幂等差集更新**（替代原来的 remove-all + add-all）
   - 区分"本插件 managed 目录"和"外部已有目录"
   - 只删除不在目标集合里的 managed 目录（从后往前逐个删，避免索引偏移）
   - 只追加目标集合里新出现的目录
   - 被外部已有目录覆盖的目标目录自动跳过



### 虚拟工作区：按 FileGroup/Source 层级组织源码（symlink + 物理目录 fallback）

**需求**：将活动 Target 的所有源码文件在 VS Code 原生 Explorer 中按 uvprojx 的 FileGroup→Source 层级组织到一个虚拟文件夹（如 JCVM）中，而不是散落的物理目录聚合。

**实现**（src/ui/ProjectExplorer.ts）：

虚拟目录结构：
`
{uvprojx所在目录}/_keil_virtual/{TargetName}/
  ├── {GroupName_1}/
  │   ├── src_file.c       → symlink → 真实文件绝对路径
  │   └── src_file.h
  └── {GroupName_2}/
      └── ...
`

| 方法 | 说明 |
|------|------|
| createVirtualTargetDirs(prj, target) | 遍历 Target 的 FileGroup→Source，创建虚拟目录树；每个 Source 文件优先用 s.symlinkSync 创建文件符号链接，失败 fallback 到 s.linkSync（硬链接，不需要权限），都失败则跳过 |
| collectActiveTargetSourceDirs() | 活动 Target 的物理源码目录集合（symlink 创建失败时的 fallback） |
| syncWorkspaceFolders() | 差集更新：虚拟目录优先，物理目录补充；虚拟目录若被外部工作区覆盖则跳过；差集为空直接短路返回 |
| cleanupVirtualDirs(prj) | 清理指定工程的虚拟根目录（关闭工程时调用） |

触发时机：openProject、closeProject、ctiveProject、switchTargetByProject、statusBarSwitchTargetByProject、onDidChangeWorkspaceFolders（debounce 300ms）

**Windows symlink 权限**：默认需要管理员权限或开启开发者模式。若 symlink + hardlink 都失败，自动 fallback 到物理目录聚合方案，不影响功能可用性。
