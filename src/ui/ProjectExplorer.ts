import { XMLParser } from "fast-xml-parser";
import { statSync, readFileSync, readdirSync, mkdirSync, symlinkSync, rmSync, existsSync } from "fs";
import { basename, dirname, extname, join, normalize, resolve, sep } from "path";
import type {
    Event, ExtensionContext, ProviderResult, TreeDataProvider,
    OutputChannel,
    StatusBarItem
} from "vscode";
import {
    commands, EventEmitter, l10n,
    TreeItem, TreeItemCollapsibleState, Uri, workspace, window
} from "vscode";

import type { IView } from "../core/IView";
import { KeilProject } from "../core/KeilProject";
import { FileGroup } from "../core/FileGroup";
import { Source } from "../core/Source";
import { ResourceManager } from "../ResourceManager";
import { File } from '../node_utility/File';
import type { PTarget } from "../target/PTarget";


export class ProjectExplorer implements TreeDataProvider<IView> {

    private itemClickCommand = 'Item.Click';

    onDidChangeTreeData: Event<IView>;
    private viewEvent: EventEmitter<IView>;

    private prjList: Map<string, KeilProject>;
    private curActiveProject: KeilProject | undefined;
    private workspacePath: string;
    // 记录本插件动态添加到工作区的文件夹路径（规范化、小写），用于切换 Target/关闭工程时清理
    private managedFolderPaths: Set<string> = new Set();
    // 正在执行 syncWorkspaceFolders 标记，避免内部 updateWorkspaceFolders 触发的事件循环
    private isSyncing = false;
    // 事件 debounce 定时器，合并短时间内多次 onDidChangeWorkspaceFolders 触发
    private syncDebounceTimer: ReturnType<typeof setTimeout> | undefined;
    // 虚拟工作区统一根目录：一个固定的 JCVM，里面按 工程名/TargetName/GroupName 组织所有源码符号链接
    // 放在扩展全局存储中，绝不写入用户的工程目录
    private virtualStorageRoot: string;
    // 每个工程上一次生成的虚拟树状态：signature 未变化时直接复用，避免无谓的删除/重建
    private virtualStateByPrj: Map<string, { prjSubdir: string; signature: string; linked: Set<string> }> = new Map();
    // 当前环境是否支持创建符号链接（探测到 EPERM 后置为 true，不再重复尝试）
    private symlinkUnsupported = false;

    constructor(context: ExtensionContext, private channel: OutputChannel, private myStatusBarItem: StatusBarItem) {
        this.prjList = new Map();
        this.viewEvent = new EventEmitter();
        this.onDidChangeTreeData = this.viewEvent.event;
        this.workspacePath = '';
        // 虚拟符号链接统一根：固定命名为 JCVM，所有工程的符号链接都放在这里
        // 路径位于扩展全局存储中，绝不写入用户工程目录
        this.virtualStorageRoot = join(context.globalStorageUri.fsPath, 'keil-workspace', 'JCVM');

        context.subscriptions.push(window.registerTreeDataProvider('project', this));
        context.subscriptions.push(commands.registerCommand(this.itemClickCommand, (item: IView) => this.onItemClick(item)));

        // 监听工作区文件夹变更，做 debounce 后触发 syncWorkspaceFolders
        context.subscriptions.push(workspace.onDidChangeWorkspaceFolders(() => {
            if (this.isSyncing) return;
            this.scheduleSync();
        }));

        // 监听插件配置变化：切换 Target 处理模式/添加策略等配置后立即重新同步工作区
        context.subscriptions.push(workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('KeilAssistant.Workspace') || e.affectsConfiguration('search.followSymlinks')) {
                this.scheduleSync();
            }
        }));
    }

    /** 合并短时间内的多次同步请求，避免重复执行 */
    private scheduleSync(): void {
        if (this.syncDebounceTimer) clearTimeout(this.syncDebounceTimer);
        this.syncDebounceTimer = setTimeout(() => { this.scheduleSync(); }, 300);
    }

    // ========== 虚拟工作区 & 工作区同步 相关方法 ==========

    /** 把任意名称转换为安全的目录名（去掉 Windows 非法字符与结尾的点/空格） */
    private sanitizeDirName(name: string): string {
        const s = `${name ?? ''}`.replace(/[<>:"/\\|?*]/g, '_').replace(/[. ]+$/g, '').trim();

        return s || '_';
    }

    /**
     * 收集某个 Target 的"分组 → 真实文件"计划（只读解析，不落盘）。
     * 缺失文件不会进入计划，而是记入 missingPaths 供上层提示。
     */
    private collectTargetPlan(target: PTarget, missingPaths: string[]): { group: string; files: string[] }[] {
        const groups = target.getChildViews() as FileGroup[] | undefined;
        const plan: { group: string; files: string[] }[] = [];

        if (!groups) return plan;

        for (const group of groups) {
            const files: string[] = [];

            for (const source of group.sources) {
                const realPath = normalize(source.file.path);

                if (!source.file.isFile()) {
                    missingPaths.push(realPath);
                    continue;
                }
                files.push(realPath);
            }
            plan.push({ group: group.label, files });
        }

        return plan;
    }

    /**
     * 生成组内唯一的链接文件名：冲突时先加父目录前缀，仍冲突则追加 ~2/~3 序号。
     * @param used 本组已使用的文件名（小写，Windows 大小写不敏感）
     */
    private makeUniqueLinkName(used: Set<string>, realPath: string): string {
        const base = basename(realPath);
        let name = base;
        const lower = (s: string) => s.toLowerCase();

        if (used.has(lower(name))) {
            name = `${basename(dirname(realPath))}_${base}`;
        }

        let i = 2;

        while (used.has(lower(name))) {
            const dot = base.lastIndexOf('.');

            name = dot > 0 ? `${base.slice(0, dot)}~${i}${base.slice(dot)}` : `${base}~${i}`;
            i++;
        }
        used.add(lower(name));

        return name;
    }

    /**
     * 构建/更新某个工程在统一虚拟根（JCVM）下的目录树：
     *   <globalStorage>/keil-workspace/JCVM/{工程名}/{TargetName}/{GroupName}/{FileName} → symlink(真实文件)
     *
     * 设计要点：
     *  - 全局统一一个 JCVM 目录，所有工程的符号链接都放在这里，工作区里只需要加入这一个 folder
     *  - 重建时只删当前工程的子目录（JCVM/{工程名}/），不影响其他工程的链接
     *  - 内容签名未变化时直接复用上次结果，避免无谓删除/重建
     *  - 只创建符号链接（不创建硬链接）：硬链接在 VS Code 保存（临时文件 + rename）时会被切断，
     *    会导致"在虚拟树里编辑，原文件不更新"的数据丢失问题
     *
     * @returns 该工程成功链接的真实文件集合；undefined 表示本次完全没有 symlink（权限问题）
     */
    private buildVirtualTree(
        prj: KeilProject,
        targets: { target: PTarget; plan: { group: string; files: string[] }[] }[],
        norm: (p: string) => string,
    ): { linked: Set<string> } | undefined {
        // 已知当前环境不支持符号链接 → 直接跳过虚拟树，走物理目录兜底
        if (this.symlinkUnsupported) return undefined;

        // 统一虚拟根：固定叫 JCVM，整个应用生命周期里只建一次
        const jcvmRoot = this.virtualStorageRoot;
        const prjSubdir = this.sanitizeDirName(prj.label);
        const prjRoot = join(jcvmRoot, prjSubdir);

        const signature = JSON.stringify(targets.map(t => [t.target.targetName, t.plan]));
        const prev = this.virtualStateByPrj.get(prj.prjID);

        // 内容没变且子目录还在 → 直接复用，不做任何磁盘操作
        if (prev && prev.signature === signature && existsSync(prjRoot)) {
            return { linked: prev.linked };
        }

        // 确保统一根存在（所有工程共用这一个目录）
        try {
            if (!existsSync(jcvmRoot)) mkdirSync(jcvmRoot, { recursive: true });
        } catch (err) {
            this.channel.appendLine(`[keil-assistant] 创建虚拟根目录失败: ${jcvmRoot}, msg: ${(err as Error).message}`);
            this.virtualStateByPrj.delete(prj.prjID);

            return undefined;
        }

        // 只重建当前工程的子目录（JCVM/{工程名}/），保留其他工程的链接不受影响
        try {
            if (existsSync(prjRoot)) rmSync(prjRoot, { recursive: true, force: true });
            mkdirSync(prjRoot, { recursive: true });
        } catch (err) {
            this.channel.appendLine(`[keil-assistant] 创建工程虚拟目录失败: ${prjRoot}, msg: ${(err as Error).message}`);
            this.virtualStateByPrj.delete(prj.prjID);

            return undefined;
        }

        const linked = new Set<string>();
        let failedCount = 0;
        let aborted = false;

        for (const { target, plan } of targets) {
            if (aborted) break;

            const targetDir = join(prjRoot, this.sanitizeDirName(target.targetName));

            try {
                mkdirSync(targetDir, { recursive: true });
            } catch (err) {
                this.channel.appendLine(`[keil-assistant] 创建 Target 目录失败: ${targetDir}, msg: ${(err as Error).message}`);
                continue;
            }

            for (const g of plan) {
                if (aborted) break;

                const groupDir = join(targetDir, this.sanitizeDirName(g.group));

                try {
                    mkdirSync(groupDir, { recursive: true });
                } catch (err) {
                    this.channel.appendLine(`[keil-assistant] 创建 Group 目录失败: ${groupDir}, msg: ${(err as Error).message}`);
                    continue;
                }

                const usedNames = new Set<string>();

                for (const realPath of g.files) {
                    const linkPath = join(groupDir, this.makeUniqueLinkName(usedNames, realPath));

                    try {
                        symlinkSync(realPath, linkPath, 'file');
                        linked.add(norm(realPath));
                    } catch (err) {
                        const code = (err as NodeJS.ErrnoException).code;

                        // 权限类错误说明当前环境根本不支持符号链接（Windows 未开启开发者模式/非管理员）
                        // → 立即放弃整个虚拟树，避免对成百上千个文件逐个失败
                        if (code === 'EPERM' || code === 'EACCES' || code === 'UNKNOWN') {
                            aborted = true;
                            break;
                        }
                        failedCount++;
                    }
                }
            }
        }

        // 环境不支持符号链接：清掉半成品，标记后不再尝试
        if (aborted) {
            try { rmSync(prjRoot, { recursive: true, force: true }); } catch { /* 忽略 */ }
            // 如果 JCVM 根已经空了，也一并删掉，保持干净
            try {
                if (existsSync(jcvmRoot) && readdirSync(jcvmRoot).length === 0) {
                    rmSync(jcvmRoot, { recursive: true, force: true });
                }
            } catch { /* 忽略 */ }
            this.virtualStateByPrj.delete(prj.prjID);
            this.symlinkUnsupported = true;
            const tip = '无法创建符号链接（EPERM）。请在 Windows 设置 → 隐私和安全性 → 开发者选项 里开启「开发人员模式」，或让 VS Code 以管理员身份运行。开启后重启 VS Code 再执行一次 "Keil: Sync Workspace Folders"。当前将自动切换到 minimalCommonRoot 扁平策略，Ctrl+Shift+F 全局搜索不受影响。';

            this.channel.appendLine(`[keil-assistant] ${tip}`);
            window.showInformationMessage(`Keil Assistant: ${tip}`);

            return undefined;
        }

        this.virtualStateByPrj.set(prj.prjID, { prjSubdir, signature, linked });

        if (failedCount > 0) {
            this.channel.appendLine(
                `[keil-assistant] ${prj.label}/${targets.map(t => t.target.targetName).join(', ')}: ${failedCount} 个文件符号链接失败，改由物理目录兜底。`
            );
        }
        this.channel.appendLine(
            `[keil-assistant] 虚拟目录已更新: ${prjRoot}（${linked.size} 个文件）`
        );

        return { linked };
    }

    /**
     * 清理虚拟目录（指定工程或全部）。
     * 所有工程共用一个 JCVM 根，清理时只删某工程的子目录，不碰其他工程的链接。
     */
    private cleanupVirtualDirs(prj?: KeilProject): void {
        const removePrjSubdir = (subdir: string) => {
            const fullPath = join(this.virtualStorageRoot, subdir);

            if (existsSync(fullPath)) {
                try { rmSync(fullPath, { recursive: true, force: true }); } catch { /* 忽略 */ }
            }
            // 如果 JCVM 根已空，也一并清掉
            try {
                if (existsSync(this.virtualStorageRoot) && readdirSync(this.virtualStorageRoot).length === 0) {
                    rmSync(this.virtualStorageRoot, { recursive: true, force: true });
                }
            } catch { /* 忽略 */ }
        };

        if (prj) {
            const state = this.virtualStateByPrj.get(prj.prjID);

            if (state) {
                removePrjSubdir(state.prjSubdir);
                this.virtualStateByPrj.delete(prj.prjID);
                this.channel.appendLine(`[keil-assistant] 已清理虚拟目录: ${join(this.virtualStorageRoot, state.prjSubdir)}`);
            }
        } else {
            // 清理全部：整个 JCVM 根干掉
            if (existsSync(this.virtualStorageRoot)) {
                try { rmSync(this.virtualStorageRoot, { recursive: true, force: true }); } catch { /* 忽略 */ }
            }
            this.virtualStateByPrj.clear();
            this.channel.appendLine(`[keil-assistant] 已清理全部虚拟目录: ${this.virtualStorageRoot}`);
        }
    }

    /**
     * 清理本插件 managed 的所有工作区文件夹条目（当 AutoAddExternalSources 禁用时调用）。
     */
    private async cleanupManagedWorkspaceFolders(): Promise<void> {
        const norm = (p: string) => normalize(p).replace(/\\/g, '/').toLowerCase();

        if (!workspace.workspaceFolders) return;

        const allFolders = workspace.workspaceFolders;
        const removeIndices: number[] = [];

        for (const managedPath of this.managedFolderPaths) {
            const idx = allFolders.findIndex(f => norm(f.uri.fsPath) === managedPath);

            if (idx !== -1) removeIndices.push(idx);
        }

        if (removeIndices.length > 0) {
            // 从大到小删除，避免索引偏移
            removeIndices.sort((a, b) => b - a);
            for (const idx of removeIndices) {
                await this.removeWorkspaceFolderAt(idx);
            }
            this.channel.appendLine(
                `[keil-assistant] AutoAddExternalSources 已禁用，清理了 ${removeIndices.length} 个 managed 工作区条目。`
            );
        }

        this.managedFolderPaths.clear();
        this.cleanupVirtualDirs();
    }

    /**
     * 删除工作区中指定索引的文件夹，并等待工作区变更事件完成。
     */
    private removeWorkspaceFolderAt(index: number): Promise<void> {
        return new Promise((resolve) => {
            const disposable = workspace.onDidChangeWorkspaceFolders(() => {
                disposable.dispose();
                resolve();
            });

            workspace.updateWorkspaceFolders(index, 1);
            // 兜底超时
            setTimeout(() => { disposable.dispose(); resolve(); }, 1000);
        });
    }

    /**
     * 同步 VS Code 工作区文件夹，使 .uvprojx 引用的外部源码可被 Explorer 看到、被 Ctrl+Shift+F 搜索到。
     *
     * 处理流程：
     *   1. AutoAddExternalSources 关闭 → 清理本插件添加的条目后返回
     *   2. 按 ProcessMode（activeTarget / allTargets）解析每个 Target 的"分组 → 真实文件"计划
     *   3. AddStrategy = virtualSymlink 时构建虚拟目录树（TargetName/GroupName 层级，供 Explorer 展示）
     *   4. 计算需要加入工作区的目录：
     *      - 虚拟根（层级展示）
     *      - 未被虚拟树完整覆盖的物理源码目录（保证 Ctrl+Shift+F 一定搜得到）
     *   5. 与当前 managed 集合求差集 → 先精确移除过期条目，再追加新增条目（幂等，可重复加载）
     *
     * 说明：只改动工作区文件夹列表，不修改 .uvprojx 与工程内任何文件。
     */
    private async syncWorkspaceFolders(): Promise<void> {
        this.isSyncing = true;

        try {
            const resMgr = ResourceManager.getInstance();

            this.channel.appendLine('[keil-assistant] syncWorkspaceFolders START');

            // 1) 功能总开关关闭 → 清理历史添加项
            if (!resMgr.isAutoAddExternalSources()) {
                this.channel.appendLine('[keil-assistant] sync: AutoAddExternalSources=false，跳过');

                if (this.managedFolderPaths.size > 0) {
                    await this.cleanupManagedWorkspaceFolders();
                }
                return;
            }

            if (!workspace.workspaceFolders || workspace.workspaceFolders.length === 0) {
                this.channel.appendLine('[keil-assistant] sync: workspaceFolders 为空，跳过');

                return;
            }

            if (this.prjList.size === 0) {
                this.channel.appendLine('[keil-assistant] sync: prjList 为空，跳过（工程还没加载）');

                return;
            }

            const norm = (p: string) => normalize(p).replace(/\\/g, '/').toLowerCase();
            const processMode = resMgr.getProcessMode();
            const addStrategy = resMgr.getAddStrategy();
            const missingPaths: string[] = [];

            this.channel.appendLine(
                `[keil-assistant] sync: prjCount=${this.prjList.size}, processMode=${processMode}, addStrategy=${addStrategy}, workspaceFolders=${workspace.workspaceFolders.length}`
            );
            this.channel.appendLine(
                `[keil-assistant] sync: 当前工作区 folders: ${workspace.workspaceFolders.map(f => f.uri.fsPath).join(' || ')}`
            );

            // 2) 解析每个工程待处理 Target 的文件计划（纯读取，无磁盘写入）
            const plansByPrj = new Map<string, {
                prj: KeilProject;
                targets: { target: PTarget; plan: { group: string; files: string[] }[] }[];
            }>();

            for (const prj of this.prjList.values()) {
                const targets = processMode === 'allTargets'
                    ? prj.getTargets()
                    : (prj.getActiveTarget() ? [prj.getActiveTarget()!] : []);

                plansByPrj.set(prj.prjID, {
                    prj,
                    targets: targets.map(t => ({ target: t, plan: this.collectTargetPlan(t, missingPaths) })),
                });
            }

            // 缺失文件提示（去重，最多展示 10 条）
            if (missingPaths.length > 0) {
                const uniqueMissing = Array.from(new Set(missingPaths));
                const preview = uniqueMissing.slice(0, 10);

                this.channel.appendLine(
                    `[keil-assistant] 发现 ${uniqueMissing.length} 个工程引用但实际不存在的文件：\n  ${preview.join('\n  ')}${uniqueMissing.length > 10 ? '\n  ...' : ''}`
                );
            }

            // 3) 汇总"物理目录 → 其下源文件集合"，用于判断虚拟树是否已完整覆盖该目录
            const filesByDir = new Map<string, Set<string>>();

            for (const { targets } of plansByPrj.values()) {
                for (const { plan } of targets) {
                    for (const g of plan) {
                        for (const f of g.files) {
                            const dirLower = norm(dirname(f));
                            let set = filesByDir.get(dirLower);

                            if (!set) {
                                set = new Set();
                                filesByDir.set(dirLower, set);
                            }
                            set.add(norm(f));
                        }
                    }
                }
            }

            // 4) 构建虚拟目录树（virtualSymlink 策略）
            const virtualFolders: { path: string; name: string }[] = [];
            const linkedFiles = new Set<string>();

            if (addStrategy === 'virtualSymlink') {
                let anyLinked = false;

                for (const { prj, targets } of plansByPrj.values()) {
                    const state = this.buildVirtualTree(prj, targets, norm);

                    if (state && state.linked.size > 0) {
                        state.linked.forEach(f => linkedFiles.add(f));
                        anyLinked = true;
                    }
                }
                // 所有工程共用一个 JCVM 虚拟根，成功创建至少一个 symlink 就把它加入工作区
                if (anyLinked) {
                    virtualFolders.push({ path: this.virtualStorageRoot, name: 'JCVM' });
                }
            } else if (this.virtualStateByPrj.size > 0) {
                // 已切到 minimalCommonRoot 策略 → 清理旧的虚拟树
                this.cleanupVirtualDirs();
            }

            // 5) 计算最小物理目录集合（去掉被祖先覆盖的子目录）
            const physicalDirs = Array.from(filesByDir.keys());
            const minimalDirs = physicalDirs.filter(d => !physicalDirs.some(o => o !== d && d.startsWith(o + '/')));

            // 6) 决定要加入工作区的目录
            //    虚拟树完整覆盖 + 搜索会跟随符号链接 → 跳过物理目录，避免同一文件出现两条搜索结果；
            //    否则保留物理目录，确保 Ctrl+Shift+F 一定能搜到（例如 symlink 创建失败、或用户关闭了 followSymlinks）。
            const followSymlinks = workspace.getConfiguration('search').get<boolean>('followSymlinks', true);
            const dirsToAdd: { path: string; name: string }[] = [...virtualFolders];
            let skippedPhysicalCount = 0;

            for (const dir of minimalDirs) {
                const files = filesByDir.get(dir) ?? new Set<string>();
                const fullyLinked = addStrategy === 'virtualSymlink' && followSymlinks &&
                    files.size > 0 && Array.from(files).every(f => linkedFiles.has(f));

                if (fullyLinked) {
                    skippedPhysicalCount++;
                    continue;
                }
                dirsToAdd.push({ path: dir, name: basename(dir) });
            }

            if (skippedPhysicalCount > 0 && followSymlinks) {
                this.channel.appendLine(
                    `[keil-assistant] ${skippedPhysicalCount} 个物理源码目录已被虚拟层级完整覆盖，未重复加入工作区（避免搜索结果重复）。`
                );
            }

            if (!followSymlinks && addStrategy === 'virtualSymlink' && minimalDirs.length > 0) {
                this.channel.appendLine(
                    '[keil-assistant] 检测到 search.followSymlinks 已关闭：符号链接中的文件不会被 Ctrl+Shift+F 搜索，已改为同时加入物理源码目录。建议开启该设置以获得去重后的搜索结果。'
                );
            }

            // 7) 与 managed 集合求差集
            //    注意：VS Code 重启后 managedFolderPaths 会丢失，因此把位于扩展存储目录下的虚拟根也视为"本插件所有"，
            //    否则旧会话残留的虚拟目录既不会被清理、也会让本次同步误判为"已被外部目录覆盖"
            const targetSet = new Set(dirsToAdd.map(d => norm(d.path)));
            const virtualStoragePrefix = `${norm(this.virtualStorageRoot)}/`;
            const ours = new Set(this.managedFolderPaths);

            for (const f of workspace.workspaceFolders) {
                const p = norm(f.uri.fsPath);

                if (p.startsWith(virtualStoragePrefix)) ours.add(p);
            }

            const externalPaths = workspace.workspaceFolders
                .map(f => norm(f.uri.fsPath))
                .filter(p => !ours.has(p));

            const toRemove: string[] = [];
            const toAdd: { uri: Uri; name: string; path: string; isVirtual: boolean }[] = [];

            for (const p of ours) {
                if (!targetSet.has(p)) toRemove.push(p);
            }

            const managedCopy = new Set(ours);

            for (const dir of dirsToAdd) {
                const dirLower = norm(dir.path);

                // 已被外部（用户自带）工作区文件夹覆盖 → 不重复添加
                if (externalPaths.some(ep => dirLower === ep || dirLower.startsWith(ep + '/'))) continue;

                // 已被更上层的待添加目录覆盖（如物理目录位于另一个物理目录之下）→ 跳过
                if (dirsToAdd.some(other => {
                    const o = norm(other.path);

                    return o !== dirLower && dirLower.startsWith(o + '/');
                })) continue;

                if (!managedCopy.has(dirLower)) {
                    toAdd.push({
                        uri: Uri.file(dir.path),
                        name: dir.name,
                        path: dirLower,
                        isVirtual: virtualFolders.some(v => norm(v.path) === dirLower),
                    });
                }
            }

            // 幂等短路：无变更时什么都不做
            if (toRemove.length === 0 && toAdd.length === 0) {
                return;
            }

            // 8) 用户确认（可选）
            if (toAdd.length > 0 && resMgr.isConfirmBeforeAdd()) {
                const confirmMsg = `Keil Assistant 将把以下 ${toAdd.length} 个外部源码目录加入工作区：\n${toAdd.map(a => `  ${a.path}`).join('\n')}`;
                const result = await window.showInformationMessage(confirmMsg, '确认', '取消');

                if (result !== '确认') {
                    this.channel.appendLine('[keil-assistant] 用户取消了外部源码目录加入。');

                    return;
                }
            }

            // 9) 先按索引倒序精准移除过期条目（保留用户原有工作区文件夹）
            if (toRemove.length > 0) {
                const allFolders = workspace.workspaceFolders;

                if (allFolders) {
                    const removeIndices: number[] = [];

                    for (const removePath of toRemove) {
                        const idx = allFolders.findIndex(f => norm(f.uri.fsPath) === removePath);

                        if (idx !== -1) removeIndices.push(idx);
                    }
                    removeIndices.sort((a, b) => b - a);
                    for (const idx of removeIndices) {
                        await this.removeWorkspaceFolderAt(idx);
                    }
                    for (const p of toRemove) this.managedFolderPaths.delete(p);
                }
            }

            // 10) 追加新增条目
            if (toAdd.length > 0) {
                const folders = workspace.workspaceFolders;
                const newEntries = toAdd.map(a => ({ uri: a.uri, name: a.name }));
                const insertIndex = folders ? folders.length : 0;

                this.channel.appendLine(
                    `[keil-assistant] sync: 调用 updateWorkspaceFolders(${insertIndex}, 0, ${newEntries.length} 个)`
                );

                const ok = folders
                    ? workspace.updateWorkspaceFolders(insertIndex, 0, ...newEntries)
                    : false;

                this.channel.appendLine(`[keil-assistant] sync: updateWorkspaceFolders 返回 ${ok}`);

                if (ok) {
                    for (const item of toAdd) this.managedFolderPaths.add(item.path);
                    const vCount = toAdd.filter(a => a.isVirtual).length;
                    this.channel.appendLine(
                        `[keil-assistant] 已同步工作区文件夹：新增 ${toAdd.length} 个（虚拟层级 ${vCount} + 物理源码 ${toAdd.length - vCount}），移除 ${toRemove.length} 个。`
                    );
                } else {
                    this.channel.appendLine('[keil-assistant] 追加源码目录到工作区失败！');
                }
            } else if (toRemove.length > 0) {
                this.channel.appendLine(`[keil-assistant] 已同步工作区文件夹：移除 ${toRemove.length} 个。`);
            } else {
                this.channel.appendLine('[keil-assistant] syncWorkspaceFolders END（无变更，幂等短路）');
            }
        } finally {
            this.isSyncing = false;
        }
    }

    // ========== 虚拟工作区 & 工作区同步 相关方法 结束 ==========

    private parseUvmpwFile(uvwPath: string, xmlParser: XMLParser): string[] {
        try {
            const uvmpwXml = readFileSync(uvwPath);
            const uvmpw = xmlParser.parse(uvmpwXml);
            const projectList = uvmpw['ProjectWorkspace']['project'];

            if (Array.isArray(projectList)) {
                return projectList.map<string>(p => {
                    const path = p['PathAndName'] as string;

                    return resolve(dirname(uvwPath), path);
                });
            }
        } catch (error) {
            this.channel.appendLine(`Error parsing .uvmpw file ${uvwPath}: ${error}`);
        }

        return [];
    }

    /** 命令入口：手动触发一次工作区同步（方便用户排障） */
    public async syncNow(): Promise<void> {
        this.channel.show();
        this.channel.appendLine('[keil-assistant] 用户命令触发 syncWorkspaceFolders');
        await this.syncWorkspaceFolders();
    }

    async loadWorkspace() {
        this.channel.show();
        if (!workspace.workspaceFolders || workspace.workspaceFolders.length === 0) {
            this.channel.appendLine('No workspace folders found.');

            return;
        }

        this.workspacePath = workspace.workspaceFile && workspace.workspaceFile.toString().startsWith('file:')
            ? dirname(workspace.workspaceFile.fsPath)
            : workspace.workspaceFolders[0].uri.fsPath;

        const prjWorkspace = new File(this.workspacePath);
        const searchDepth = ResourceManager.getInstance().getProjectFileFindMaxDepth();

        if (!prjWorkspace.isDir()) {
            this.channel.appendLine('Error: this assistant works only in a folder.');

            return;
        }

        this.channel.appendLine('search uvprj[x] project file >>>>> ');
        const excludeList = ResourceManager.getInstance().getProjectExcludeList();
        let uvList: string[] = [];

        // Multiply project workspace
        const uvmwList = await this.findProject(prjWorkspace.path, [/\.uvmpw$/i], searchDepth);

        if (uvmwList && uvmwList.length > 0) {
            const options = {
                attributeNamePrefix: "@_",
                attrNodeName: "attr", //default is 'false'
                textNodeName: "#text",
                ignoreAttributes: false,
                ignoreNameSpace: false,
                allowBooleanAttributes: false,
                parseNodeValue: true,
                parseAttributeValue: false,
                trimValues: true,
                cdataTagName: "__cdata", //default is 'false'
                cdataPositionChar: "\\c",
                parseTrueNumberOnly: false,
                arrayMode: false, //"strict"
                // attrValueProcessor: (val: any, attrName: any) => decode(val, { isAttributeValue: true }),//default is a=>a
                // tagValueProcessor: (val: any, tagName: any) => decode(val), //default is a=>a
                stopNodes: ["parse-me-as-string"]
            };
            const xmlParser = new XMLParser(options);

            uvList = uvmwList.flatMap(uvwPath => this.parseUvmpwFile(uvwPath, xmlParser));
        }

        // Search for .uvproj and .uvprojx files if no .uvmpw files are found
        if (uvList.length === 0) {
            uvList = await this.findProject(prjWorkspace.path, [/\.uvproj[x]?$/i], searchDepth);
        }

        // Add additional project file locations
        uvList.push(...ResourceManager.getInstance().getProjectFileLocationList());

        // Filter out excluded files
        uvList = uvList.filter(path => !excludeList.includes(extname(path).toLowerCase()));

        const hasMultiplyProject = uvList.length > 1; //Multiply

        // Load each project file
        for (const uvPath of uvList) {
            try {
                await this.openProject(uvPath, hasMultiplyProject);
            } catch (error) {
                this.channel.appendLine(`Error: open project ${error}`);
                window.showErrorMessage(`Failed to open project: '${uvPath}', Error: ${error}`);
            }
        }
    }

    async findProject(dir: string, fileFilter?: RegExp[], deep = 0): Promise<string[]> {
        const list: string[] = [];
        const items = readdirSync(dir);

        for (const item of items) {
            if (item === '.' || item === '..') {
                continue;
            }
            const fullPath = join(dir, item);
            const stat = statSync(fullPath);

            if (stat.isFile()) {
                if (fileFilter) {
                    const extension = extname(item); // 优化：直接使用 extname 获取扩展名

                    if (fileFilter.some(reg => reg.test(extension))) {
                        list.push(fullPath);
                    }
                } else {
                    list.push(fullPath);
                }
            } else if (stat.isDirectory() && deep > 0) {
                const subFiles = await this.findProject(fullPath, fileFilter, deep - 1);

                list.push(...subFiles);
            }
        }

        return list;
    }

    async openProject(path: string, hasMultiplyProject: boolean): Promise<KeilProject | undefined> {
        // workspacePath 初始值为空字符串 ''，不是 undefined；空值代表"未设置"
        if (!this.workspacePath) {
            const prjDir = dirname(path);
            const folderName = basename(prjDir);
            const folder = { uri: Uri.file(prjDir), name: folderName };

            if (!workspace.workspaceFolders || workspace.workspaceFolders.length === 0) {
                workspace.updateWorkspaceFolders(0, 0, folder);
            } else {
                const exists = workspace.workspaceFolders.some(
                    f => normalize(f.uri.fsPath).toLowerCase() === normalize(prjDir).toLowerCase()
                );

                if (!exists) {
                    workspace.updateWorkspaceFolders(workspace.workspaceFolders.length, 0, folder);
                }
            }
            this.workspacePath = prjDir;
        }

        const nPrj = new KeilProject(this.channel, new File(path), this.workspacePath, hasMultiplyProject);

        if (nPrj) {
            if (!this.prjList.has(nPrj.prjID)) {

                // 【修复】先注册 dataChanged 监听，再 load：load() 内部会触发 notifyUpdateView() 发 dataChanged，
                // 如果注册在 load 之后，首次加载的事件就没人接，scheduleSync 也就不会被触发。
                nPrj.on('dataChanged', () => {
                    this.updateView();
                    this.scheduleSync();
                });

                await nPrj.load();
                this.prjList.set(nPrj.prjID, nPrj);

                if (this.curActiveProject === undefined) {
                    this.curActiveProject = nPrj;
                    this.curActiveProject.active();
                }

                this.updateView();
                // 工程加载完成后立即触发一次同步（不用等 debounce，确保自动生效）
                this.scheduleSync();

                return nPrj;
            }
        }

        return undefined;
    }

    async closeProject(pID: string) {
        const prj = this.prjList.get(pID);

        if (prj) {
            prj.deactive();
            prj.close();
            this.prjList.delete(pID);
            // 清理该工程的虚拟目录
            this.cleanupVirtualDirs(prj);
            this.updateView();
            // 关闭工程后重新同步工作区文件夹
            this.scheduleSync();
        }
    }


    async activeProject(view: IView) {
        this.curActiveProject?.deactive();
        const project = this.prjList.get(view.prjID);

        project?.active();
        this.curActiveProject = project;
        this.updateView();
        // 激活工程后重新同步工作区文件夹
        this.scheduleSync();

    }

    async switchTargetByProject(view: IView) {
        let prj = undefined;
        if (view !== undefined && view.prjID !== undefined) {
            prj = this.prjList.get(view.prjID);
        } else {
            prj = this.curActiveProject;
        }

        if (prj) {
            const tList = prj.getTargets();
            const targetName = await window.showQuickPick(tList.map((ele) => ele.targetName), {
                canPickMany: false,
                placeHolder: l10n.t('please select a target name for keil project')
            });

            if (targetName) {
                prj.setActiveTarget(targetName);
                // 切换 Target 后重新同步工作区文件夹（重建虚拟目录）
                this.scheduleSync();
            }
        }
    }

    async statusBarSwitchTargetByProject() {
        if (this.curActiveProject) {
            const tList = this.curActiveProject.getTargets();
            const targetName = await window.showQuickPick(tList.map((ele) => ele.targetName), {
                canPickMany: false,
                placeHolder: l10n.t('please select a target name for keil project')
            });

            if (targetName) {
                this.curActiveProject?.setActiveTarget(targetName);
                // 切换 Target 后重新同步工作区文件夹
                this.scheduleSync();
            }
        }
    }

    getTarget(view?: IView): PTarget | undefined {
        if (view) {
            const prj = this.prjList.get(view.prjID);

            if (prj) {
                const targets = prj.getTargets();
                const index = targets.findIndex((target) => target.targetName === view.label);

                if (index !== -1) {
                    return targets[index];
                }
            }
        } else { // get active target
            if (this.curActiveProject) {
                return this.curActiveProject.getActiveTarget();
            } else {
                window.showWarningMessage(l10n.t('Not found any active project !'));
            }
        }
    }

    updateView(v?: IView) {
        this.updateStatusBarItem(this.curActiveProject?.activeTargetName);
        this.viewEvent.fire(v!);
    }

    //----------------------------------

    itemClickInfo: any = undefined;

    private async onItemClick(item: IView) {
        if (item.contextVal === 'Source') {
            const source = item as Source;
            const file = new File(normalize(source.file.path));

            if (file.isFile()) { // file exist, open it

                let isPreview = true;

                if (this.itemClickInfo &&
                    this.itemClickInfo.name === file.path &&
                    this.itemClickInfo.time + 260 > Date.now()) {
                    isPreview = false;
                }

                // reset prev click info
                this.itemClickInfo = {
                    name: file.path,
                    time: Date.now()
                };

                window.showTextDocument(Uri.parse(file.toUri()), { preview: isPreview });

            } else {
                const msg = l10n.t('Not found file');

                window.showWarningMessage(`${msg}: ${source.file.path}`);
            }
        }
    }

    getTreeItem(element: IView): TreeItem {
        const res = new TreeItem(element.label);

        res.contextValue = element.contextVal;
        res.tooltip = element.tooltip;
        res.collapsibleState = element.getChildViews() === undefined ?
            TreeItemCollapsibleState.None : TreeItemCollapsibleState.Collapsed;

        if (element instanceof Source) {
            res.command = {
                title: element.label,
                command: this.itemClickCommand,
                arguments: [element]
            };
        }

        if (element.icons) {
            res.iconPath = {
                light: ResourceManager.getInstance().getIconByName(element.icons.light),
                dark: ResourceManager.getInstance().getIconByName(element.icons.dark)
            };
        }

        return res;
    }

    getChildren(element?: IView | undefined): ProviderResult<IView[]> {
        if (element === undefined) {
            return Array.from(this.prjList.values());
        } else {
            return element.getChildViews();
        }
    }

    openWorkspace(wsFile: File) {
        commands.executeCommand('vscode.openFolder', Uri.parse(wsFile.toUri()));
    }

    private updateStatusBarItem(prjName: string | undefined): void {
        if (prjName !== undefined) {
            this.myStatusBarItem.text = prjName;
            this.myStatusBarItem.tooltip = l10n.t('switch project target');
            this.myStatusBarItem.show();
        } else {
            this.myStatusBarItem.hide();
        }
    }

}