import { XMLParser } from "fast-xml-parser";
import { statSync, readFileSync, readdirSync, mkdirSync, symlinkSync, linkSync, rmSync, existsSync } from "fs";
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
    // 虚拟工作区统一根目录：放在扩展全局存储中，绝不写入用户的工程目录
    // 内部并列两个子目录：JCVM/（工程源码 symlink）和 JCRE/（Java Card 运行时 API symlink）
    private virtualStorageRoot: string;
    // 每个工程上一次生成的 JCVM 源码虚拟树状态
    private virtualStateByPrj: Map<string, { prjSubdir: string; signature: string; linked: Set<string> }> = new Map();
    // 每个工程上一次生成的 JCRE 虚拟树状态
    private jcreStateByPrj: Map<string, { prjSubdir: string; signature: string; linked: Set<string> }> = new Map();
    // 当前环境是否支持创建符号链接（探测到 EPERM 后置为 true，不再重复尝试）
    private symlinkUnsupported = false;

    constructor(context: ExtensionContext, private channel: OutputChannel, private myStatusBarItem: StatusBarItem) {
        this.prjList = new Map();
        this.viewEvent = new EventEmitter();
        this.onDidChangeTreeData = this.viewEvent.event;
        this.workspacePath = '';
        // 虚拟符号链接统一根：放在扩展全局存储里，下面并列 JCVM/ 和 JCRE/ 两个子目录
        // 这样一个 workspace folder 就同时暴露两类虚拟内容，不污染工程目录
        this.virtualStorageRoot = join(context.globalStorageUri.fsPath, 'keil-workspace');
        this.channel.appendLine(
            `[keil-assistant] ProjectExplorer 构造: globalStorageUri=${context.globalStorageUri.fsPath}, virtualStorageRoot=${this.virtualStorageRoot}`
        );
        // 同时输出已安装的插件版本号，确认用户跑的是最新包
        try {
            const pkgJsonPath = join(context.extensionPath, 'package.json');
            const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));

            this.channel.appendLine(`[keil-assistant] 插件版本: ${pkgJson.version}`);
        } catch {
            /* 忽略 */
        }

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

    /** 合并短时间内的多次同步请求，避免重复执行；防抖 300ms 后真正调用 syncWorkspaceFolders */
    private scheduleSync(): void {
        this.channel.appendLine('[keil-assistant] scheduleSync: 防抖 300ms 后执行 syncWorkspaceFolders');
        if (this.syncDebounceTimer) clearTimeout(this.syncDebounceTimer);
        // 注意：setTimeout 回调里调 syncWorkspaceFolders（async），不能写成 scheduleSync 自己！
        // 之前的 bug 是调了 this.scheduleSync()，导致无限递归 debounce，syncWorkspaceFolders 永远不执行
        this.syncDebounceTimer = setTimeout(() => {
            this.syncWorkspaceFolders().catch(err => {
                this.channel.appendLine(`[keil-assistant] syncWorkspaceFolders 异常: ${err}`);
            });
        }, 300);
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

        // 虚拟根下并列 JCVM/ 和 JCRE/ 两个子目录
        const jcvmRoot = join(this.virtualStorageRoot, 'JCVM');
        const prjSubdir = this.sanitizeDirName(prj.label);
        const prjRoot = join(jcvmRoot, prjSubdir);

        const signature = JSON.stringify(targets.map(t => [t.target.targetName, t.plan]));
        const prev = this.virtualStateByPrj.get(prj.prjID);

        const totalFiles = targets.reduce((sum, t) => sum + t.plan.reduce((s, g) => s + g.files.length, 0), 0);
        this.channel.appendLine(
            `[keil-assistant] JCVM 构建开始: prj=${prj.label}, Targets=[${targets.map(t => t.target.targetName).join(',')}], 文件总数=${totalFiles}`
        );

        // 内容没变且子目录还在 → 直接复用，不做任何磁盘操作
        if (prev && prev.signature === signature && existsSync(prjRoot)) {
            this.channel.appendLine(
                `[keil-assistant] JCVM 签名未变化，复用上次结果（${prev.linked.size} 个 symlink，路径 ${prjRoot}）`
            );

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

                        // 权限类错误说明 symlink 不可用 → 回退 hardlink
                        if (code === 'EPERM' || code === 'EACCES' || code === 'UNKNOWN') {
                            try {
                                linkSync(realPath, linkPath);
                                linked.add(norm(realPath));
                                // hardlink 静默成功，不刷屏（JCVM 可能有大量文件）
                            } catch (err2) {
                                // hardlink 也失败 → 完全放弃，降级 junction
                                this.channel.appendLine(
                                    `[keil-assistant] JCVM symlink+hardlink 均失败 ${basename(realPath)}: ${(err2 as NodeJS.ErrnoException).code || (err2 as Error).message} —— 降级 junction`
                                );
                                aborted = true;
                                break;
                            }
                        } else {
                            failedCount++;
                        }
                    }
                }
            }
        }

        // symlink + hardlink 均失败：清掉半成品，降级到 junction（目录联接，普通用户权限即可）
        // junction 是 NTFS Reparse Point，指向整个目录，VS Code 完全透明
        // 注意：不再设置全局 symlinkUnsupported，因为 JCRE 有自己的 hardlink 回退机制，两者独立工作
        if (aborted) {
            this.channel.appendLine(
                '[keil-assistant] symlink+hardlink 均失败，自动降级到 junction（目录联接）—— 无需管理员/开发者模式'
            );
            try { rmSync(prjRoot, { recursive: true, force: true }); } catch { /* 忽略 */ }
            this.virtualStateByPrj.delete(prj.prjID);
            // this.symlinkUnsupported = true; // 不再设置，不影响 JCRE 的 hardlink 回退

            // junction 模式：按 Group 的物理目录聚合，每个物理目录建一个 junction
            // MH1701 实测 11 个 Group 全是单物理目录，junction 模式完美覆盖
            return this.buildVirtualTreeByJunction(prj, targets, norm, jcvmRoot, prjRoot);
        }

        // --- symlink 成功的正常路径 ---
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
     * junction 模式：按 Group 的物理目录聚合，每个物理目录建一个 junction（目录联接）。
     *
     * junction 是 NTFS Reparse Point，普通用户权限即可创建（无需开发者模式/管理员）。
     * VS Code 完全透明：Explorer 里直接展开真实目录内容，Ctrl+Shift+F 能搜到，
     * 在虚拟树里编辑就是直接编辑原文件（junction 透明转发所有文件系统操作）。
     *
     * 适用于 symlink 权限不足时的自动降级路径。
     * MH1701 实测 11 个 Group 全是单物理目录 → 完美覆盖，一个 junction 代替 N 个 symlink。
     */
    private buildVirtualTreeByJunction(
        prj: KeilProject,
        targets: { target: PTarget; plan: { group: string; files: string[] }[] }[],
        norm: (p: string) => string,
        jcvmRoot: string,
        prjRoot: string,
    ): { linked: Set<string> } | undefined {
        this.channel.appendLine('[keil-assistant] JCVM junction 降级开始（无需管理员权限）');

        // 确保 jcvmRoot 存在（调用方可能没建）
        try { mkdirSync(jcvmRoot, { recursive: true }); } catch { /* 忽略 */ }
        try { mkdirSync(prjRoot, { recursive: true }); } catch (err) {
            this.channel.appendLine(`[keil-assistant] junction 创建 prjRoot 失败: ${prjRoot}, msg: ${(err as Error).message}`);
            return undefined;
        }

        const linked = new Set<string>();
        const junctionList: string[] = [];

        for (const { target, plan } of targets) {
            const targetDir = join(prjRoot, this.sanitizeDirName(target.targetName));

            try { mkdirSync(targetDir, { recursive: true }); } catch { continue; }

            for (const g of plan) {
                // 1) 把该 Group 的文件按物理目录分桶
                const dirBuckets = new Map<string, string[]>();

                for (const file of g.files) {
                    const realDir = dirname(file);

                    if (!dirBuckets.has(realDir)) dirBuckets.set(realDir, []);
                    dirBuckets.get(realDir)!.push(file);
                }

                // 2) 每个物理目录建一个 junction，挂到 Target 目录下
                //    junction 名 = 物理目录的 basename；冲突时用 GroupName 前缀
                const usedNames = new Set<string>();
                let bucketIdx = 0;

                for (const [realDir, files] of dirBuckets) {
                    if (!existsSync(realDir)) continue; // 真实目录不存在则跳过

                    let junctionName = basename(realDir);

                    if (usedNames.has(junctionName)) {
                        // 冲突 → 用 GroupName 前缀
                        junctionName = `${this.sanitizeDirName(g.group)}_${junctionName}`;
                    }
                    // 单目录且 GroupName == basename → 直接用 GroupName（更直观）
                    if (dirBuckets.size === 1) {
                        const groupName = this.sanitizeDirName(g.group);

                        if (!usedNames.has(groupName)) junctionName = groupName;
                    }
                    usedNames.add(junctionName);

                    const junctionPath = join(targetDir, junctionName);

                    if (existsSync(junctionPath)) {
                        // 已存在且是 junction → 清理了重建（避免残留脏 junction）
                        try { rmSync(junctionPath, { recursive: true, force: true }); } catch { /* 忽略 */ }
                    }

                    try {
                        symlinkSync(realDir, junctionPath, 'junction');
                        junctionList.push(junctionName);
                        for (const f of files) linked.add(norm(f));
                    } catch (err) {
                        const code = (err as NodeJS.ErrnoException).code;

                        if (code === 'EPERM' || code === 'EACCES') {
                            this.channel.appendLine(
                                `[keil-assistant] junction 也没权限（EPERM），完全无权限环境——跳过虚拟树，走 minimalCommonRoot 兜底`
                            );
                            // 清掉已建的 junction 半成品
                            try { rmSync(prjRoot, { recursive: true, force: true }); } catch { /* 忽略 */ }
                            this.virtualStateByPrj.delete(prj.prjID);

                            return undefined;
                        }
                        this.channel.appendLine(
                            `[keil-assistant] junction 失败 ${realDir} → ${junctionName}: ${code || (err as Error).message}`
                        );
                    }
                    bucketIdx++;
                }
            }
        }

        if (linked.size === 0) {
            this.channel.appendLine('[keil-assistant] junction 模式：0 个成功，跳过虚拟树。');
            return undefined;
        }

        const prjSubdir = this.sanitizeDirName(prj.label);
        const signature = JSON.stringify(['junction', ...targets.map(t => [t.target.targetName, t.plan])]);
        this.virtualStateByPrj.set(prj.prjID, { prjSubdir, signature, linked });

        this.channel.appendLine(
            `[keil-assistant] JCVM junction 完成: prj=${prj.label}, ${junctionList.length} 个 junction, 暴露 ${linked.size} 个文件`
        );

        return { linked };
    }

    // ==================== JCRE 相关 ====================

    /**
     * 扫描工程中所有 mask.c 文件，从 class@ 注释里抽取引用的 Java Card 标准 API 类名。
     * 正则匹配形如（C 注释块内）：
     *   class@0x00828cb4:0x0001: public abstract interface javacard/security/SecretKey
     *   class@...: public class visa/openplatform/ProviderSecurityDomain
     * 返回去重后的完整类名集合（包路径用 / 分隔）。
     */
    private scanMaskClasses(prj: KeilProject): { classes: string[]; maskFiles: string[] } {
        const classes = new Set<string>();
        const maskFiles: string[] = [];

        // 遍历所有 Target → Group → Source，找文件名是 mask.c 的
        const targets = prj.getActiveTarget() ? [prj.getActiveTarget()!] : prj.getTargets();

        for (const target of targets) {
            const groups = target.getChildViews() as FileGroup[] | undefined;

            if (!groups) continue;
            for (const group of groups) {
                for (const source of group.sources) {
                    if (!source.file.isFile()) continue;
                    const name = basename(source.file.path).toLowerCase();

                    if (!name.endsWith('.c')) continue;
                    // 宽松匹配：只要文件名里含 mask 就扫（mask.c, mask_a51.c 等）
                    if (!name.includes('mask')) continue;

                    maskFiles.push(source.file.path);

                    try {
                        const content = readFileSync(source.file.path, 'utf-8');
                        // class@...: 地址: [访问修饰符] [其他修饰符...] [class/interface] <全限定名>
                        // 注意：实际 mask.c 注释格式灵活，有的省略了 class/interface 关键字，
                        // 还可能出现 final/static/native 等修饰符，所以这里全部做成可选
                        const re = /class@[^:]*:\s*0x[0-9a-fA-F]+:\s*(?:(?:public|private|protected)\s+)?(?:(?:abstract|final|native|static|synchronized|transient|strictfp)\s+)*(?:(?:interface|class)\s+)?([a-zA-Z_][\w/.]*)/g;
                        let m: RegExpExecArray | null;

                        while ((m = re.exec(content)) !== null) {
                            classes.add(m[1]);
                        }
                    } catch (err) {
                        this.channel.appendLine(
                            `[keil-assistant] 读取 mask.c 失败 ${source.file.path}: ${(err as Error).message}`
                        );
                    }
                }
            }
        }

        return { classes: [...classes], maskFiles };
    }

    /**
     * 构建 JCRE 源码虚拟树：
     *   <virtualStorageRoot>/JCRE/{工程名}/{javacard/framework/AppletEvent.java} → symlink(JCRE/src/javacard/framework/AppletEvent.java)
     *
     * @returns 成功创建 symlink 的真实 .java 文件集合；undefined 表示跳过或完全没连上
     */
    private buildJcreTree(
        prj: KeilProject,
        jcrePath: string,
        norm: (p: string) => string,
    ): { linked: Set<string> } | undefined {
        // JCRE 不再降级到 junction：junction 是目录级别的，会把整个包目录下所有 .java 都暴露出来
        // （例如 mask.c 只引用了 CardException，但 OwnerPINx.java、package-info.java 也会出现）
        // 这里改为始终尝试 symlink，symlink EPERM 时回退到 hardlink（NTFS 普通用户权限即可创建）
        // hardlink 是文件级别的，能精确暴露 mask.c 引用的那些类

        if (!jcrePath || !existsSync(jcrePath)) {
            if (jcrePath) {
                this.channel.appendLine(`[keil-assistant] Keil.JCRE 配置的路径不存在: ${jcrePath}`);
            }

            return undefined;
        }

        // 1) 扫描所有 mask.c，拿到类名
        const { classes, maskFiles } = this.scanMaskClasses(prj);

        if (maskFiles.length === 0) {
            this.channel.appendLine(`[keil-assistant] ${prj.label}: 工程中未找到 mask.c，跳过 JCRE 扫描。`);

            return undefined;
        }

        this.channel.appendLine(
            `[keil-assistant] JCRE 构建开始: prj=${prj.label}, mask.c 数量=${maskFiles.length}, 扫描到 class/interface=${classes.length}, JCRE_SRC=${jcrePath}`
        );

        if (classes.length === 0) {
            this.channel.appendLine(`[keil-assistant] ${prj.label}: mask.c 中未识别到任何 class@ 注释。`);

            return undefined;
        }

        // 2) 在 JCRE 路径下定位 .java
        const mappings: { cls: string; realPath: string }[] = [];
        const missing: string[] = [];

        for (const cls of classes) {
            const javaPath = resolve(jcrePath, cls.replace(/\//g, sep) + '.java');

            if (existsSync(javaPath) && statSync(javaPath).isFile()) {
                mappings.push({ cls, realPath: javaPath });
            } else {
                missing.push(cls);
            }
        }

        if (missing.length > 0) {
            const preview = missing.slice(0, 5);

            this.channel.appendLine(
                `[keil-assistant] ${prj.label}/JCRE: ${missing.length}/${classes.length} 个类未找到 .java（${preview.join(', ')}${missing.length > 5 ? ' ...' : ''}）—— 可能是 visa/cn/com 等扩展，不影响标准 javacard.*`
            );
        }

        if (mappings.length === 0) {
            this.channel.appendLine(`[keil-assistant] ${prj.label}/JCRE: 0 个匹配，跳过。`);

            return undefined;
        }

        // 3) 签名比对，没变化就复用
        const prjSubdir = this.sanitizeDirName(prj.label);
        const jcreRoot = join(this.virtualStorageRoot, 'JCRE');
        const prjRoot = join(jcreRoot, prjSubdir);
        const signature = mappings.map(m => m.cls).join('|');
        const prev = this.jcreStateByPrj.get(prj.prjID);

        if (prev && prev.signature === signature && existsSync(prjRoot)) {
            this.channel.appendLine(
                `[keil-assistant] JCRE 签名未变化，复用上次结果（${prev.linked.size} 个 symlink，路径 ${prjRoot}）`
            );

            return { linked: prev.linked };
        }

        // 4) 创建根目录
        try {
            if (!existsSync(jcreRoot)) mkdirSync(jcreRoot, { recursive: true });
            if (existsSync(prjRoot)) rmSync(prjRoot, { recursive: true, force: true });
            mkdirSync(prjRoot, { recursive: true });
        } catch (err) {
            this.channel.appendLine(`[keil-assistant] 创建 JCRE 虚拟目录失败: ${prjRoot}, msg: ${(err as Error).message}`);
            this.jcreStateByPrj.delete(prj.prjID);

            return undefined;
        }

        // 5) 按包路径创建目录并 symlink
        const linked = new Set<string>();
        let failedCount = 0;

        for (const { cls, realPath } of mappings) {
            // cls = javacard/framework/AppletEvent → 目录 javacard/framework/，文件名 AppletEvent.java
            const parts = cls.split('/');
            const fileName = parts.pop() + '.java';
            const pkgDir = join(prjRoot, ...parts);

            try {
                mkdirSync(pkgDir, { recursive: true });
            } catch (err) {
                this.channel.appendLine(`[keil-assistant] 创建 JCRE 包目录失败 ${pkgDir}: ${(err as Error).message}`);
                continue;
            }

            const linkPath = join(pkgDir, fileName);

            try {
                symlinkSync(realPath, linkPath, 'file');
                linked.add(norm(realPath));
            } catch (err) {
                const code = (err as NodeJS.ErrnoException).code;

                if (code === 'EPERM' || code === 'EACCES' || code === 'UNKNOWN') {
                    // symlink 权限不足 → 回退到 hardlink
                    // hardlink 在 NTFS 上普通用户权限即可创建，且是文件级别的
                    // （不会像 junction 那样暴露整个包目录的无关文件）
                    try {
                        linkSync(realPath, linkPath);
                        linked.add(norm(realPath));
                        this.channel.appendLine(
                            `[keil-assistant] JCRE symlink 失败（${code}），已回退到 hardlink: ${fileName}`
                        );
                    } catch (err2) {
                        const code2 = (err2 as NodeJS.ErrnoException).code;
                        // hardlink 可能失败：EXDEV（跨卷不支持）、EPERM/EACCES（权限）等
                        this.channel.appendLine(
                            `[keil-assistant] JCRE hardlink 也失败 ${fileName}: ${code2 || (err2 as Error).message} —— 跳过此文件`
                        );
                        failedCount++;
                    }
                } else {
                    failedCount++;
                }
            }
        }

        // 清理空的 JCVM/JCRE 共用虚拟根
        try {
            if (existsSync(jcreRoot) && readdirSync(jcreRoot).length === 0) rmSync(jcreRoot);
        } catch { /* 忽略 */ }

        this.jcreStateByPrj.set(prj.prjID, { prjSubdir, signature, linked });

        this.channel.appendLine(
            `[keil-assistant] ${prj.label}/JCRE: 成功 ${linked.size}/${mappings.length} 个 Java Card API 源码 symlink（来自 ${maskFiles.length} 个 mask.c）`
        );
        if (failedCount > 0) {
            this.channel.appendLine(`[keil-assistant] ${prj.label}/JCRE: ${failedCount} 个 symlink 创建失败。`);
        }

        return { linked };
    }

    /**
     * JCRE junction 模式：按包根目录聚合，每个包根目录建一个 junction。
     * 与 JCVM 同理，普通用户权限即可创建，VS Code 完全透明。
     *
     * 示例：mask.c 里有 javacard/framework/AppletEvent、javacard/framework/ISO7816
     * → 真实目录 JCRE/src/javacard/framework/ → 一个 junction 挂到
     *   {JCRE 虚拟根}/{工程名}/javacard/framework/ → 整目录暴露
     */
    private buildJcreTreeByJunction(
        prj: KeilProject,
        jcrePath: string,
        norm: (p: string) => string,
    ): { linked: Set<string> } | undefined {
        this.channel.appendLine('[keil-assistant] JCRE junction 降级开始（无需管理员权限）');

        if (!jcrePath || !existsSync(jcrePath)) {
            if (jcrePath) this.channel.appendLine(`[keil-assistant] Keil.JCRE 路径无效: ${jcrePath}`);
            return undefined;
        }

        const { classes, maskFiles } = this.scanMaskClasses(prj);

        if (maskFiles.length === 0 || classes.length === 0) {
            this.channel.appendLine(`[keil-assistant] ${prj.label}: 无 mask.c 或无 class@，跳过 JCRE。`);
            return undefined;
        }

        // 1) 在 JCRE 路径下定位 .java
        const mappings: { cls: string; realPath: string }[] = [];
        const missing: string[] = [];

        for (const cls of classes) {
            const javaPath = resolve(jcrePath, cls.replace(/\//g, sep) + '.java');

            if (existsSync(javaPath) && statSync(javaPath).isFile()) {
                mappings.push({ cls, realPath: javaPath });
            } else {
                missing.push(cls);
            }
        }

        if (missing.length > 0) {
            const preview = missing.slice(0, 5);

            this.channel.appendLine(
                `[keil-assistant] ${prj.label}/JCRE junction: ${missing.length}/${classes.length} 未找到 .java（${preview.join(', ')}...）—— 扩展 API 忽略`
            );
        }

        if (mappings.length === 0) {
            this.channel.appendLine(`[keil-assistant] ${prj.label}/JCRE junction: 0 匹配，跳过。`);
            return undefined;
        }

        // 2) 按包根目录聚合
        //    cls = javacard/framework/AppletEvent → 包根 = javacard/framework/
        //    真实目录 = JCRE/src/javacard/framework/
        const pkgBuckets = new Map<string, { realDir: string; files: string[] }>();

        for (const { cls, realPath } of mappings) {
            const parts = cls.split('/');
            parts.pop(); // 去掉类名 → 剩下包路径 javacard/framework/
            const pkgRel = parts.join(sep); // javacard\framework
            const realDir = dirname(realPath); // JCRE/src/javacard/framework

            if (!pkgBuckets.has(pkgRel)) pkgBuckets.set(pkgRel, { realDir, files: [] });
            pkgBuckets.get(pkgRel)!.files.push(realPath);
        }

        // 3) 签名比对
        const prjSubdir = this.sanitizeDirName(prj.label);
        const jcreRoot = join(this.virtualStorageRoot, 'JCRE');
        const prjRoot = join(jcreRoot, prjSubdir);
        const signature = 'junction|' + [...pkgBuckets.keys()].sort().join('|');
        const prev = this.jcreStateByPrj.get(prj.prjID);

        if (prev && prev.signature === signature && existsSync(prjRoot)) {
            this.channel.appendLine(
                `[keil-assistant] JCRE junction 签名未变化，复用上次结果（${prev.linked.size} 个文件）`
            );
            return { linked: prev.linked };
        }

        // 4) 创建虚拟根
        try {
            mkdirSync(jcreRoot, { recursive: true });
            if (existsSync(prjRoot)) rmSync(prjRoot, { recursive: true, force: true });
            mkdirSync(prjRoot, { recursive: true });
        } catch (err) {
            this.channel.appendLine(`[keil-assistant] JCRE junction 创建虚拟根失败: ${prjRoot}, msg: ${(err as Error).message}`);
            this.jcreStateByPrj.delete(prj.prjID);
            return undefined;
        }

        // 5) 每个包根目录建一个 junction
        const linked = new Set<string>();
        let junctionCount = 0;

        for (const [pkgRel, { realDir, files }] of pkgBuckets) {
            if (!existsSync(realDir)) continue;

            const pkgVirtualDir = join(prjRoot, pkgRel);

            // 先建中间父目录（javacard/、javacard/framework/）
            const parentDir = dirname(pkgVirtualDir);

            if (parentDir !== prjRoot) {
                try { mkdirSync(parentDir, { recursive: true }); } catch { /* 忽略 */ }
            }

            try {
                symlinkSync(realDir, pkgVirtualDir, 'junction');
                junctionCount++;
                for (const f of files) linked.add(norm(f));
            } catch (err) {
                const code = (err as NodeJS.ErrnoException).code;

                if (code === 'EPERM' || code === 'EACCES') {
                    this.channel.appendLine(
                        '[keil-assistant] JCRE junction 也没权限（EPERM）—— 完全无权限环境，跳过 JCRE 虚拟树'
                    );
                    try { rmSync(prjRoot, { recursive: true, force: true }); } catch { /* 忽略 */ }
                    this.jcreStateByPrj.delete(prj.prjID);
                    return undefined;
                }
                this.channel.appendLine(
                    `[keil-assistant] JCRE junction 失败 ${pkgRel}: ${code || (err as Error).message}`
                );
            }
        }

        if (linked.size === 0) {
            this.channel.appendLine('[keil-assistant] JCRE junction: 0 成功，跳过。');
            return undefined;
        }

        this.jcreStateByPrj.set(prj.prjID, { prjSubdir, signature, linked });

        this.channel.appendLine(
            `[keil-assistant] ${prj.label}/JCRE junction 完成: ${junctionCount} 个包 junction, 暴露 ${linked.size} 个 Java 文件`
        );

        return { linked };
    }

    /**
     * 清理虚拟目录（指定工程或全部）。
     * JCVM/{工程名} 和 JCRE/{工程名} 都会被清理；根目录空了会一并删除。
     */
    private cleanupVirtualDirs(prj?: KeilProject): void {
        const removeJCVM = (subdir: string) => {
            const fullPath = join(this.virtualStorageRoot, 'JCVM', subdir);

            if (existsSync(fullPath)) {
                try { rmSync(fullPath, { recursive: true, force: true }); } catch { /* 忽略 */ }
            }
        };
        const removeJCRE = (subdir: string) => {
            const fullPath = join(this.virtualStorageRoot, 'JCRE', subdir);

            if (existsSync(fullPath)) {
                try { rmSync(fullPath, { recursive: true, force: true }); } catch { /* 忽略 */ }
            }
        };
        // 如果根目录已空（JCVM 和 JCRE 都空了），一并删除
        const cleanupRoot = () => {
            try {
                if (existsSync(this.virtualStorageRoot) && readdirSync(this.virtualStorageRoot).length === 0) {
                    rmSync(this.virtualStorageRoot, { recursive: true, force: true });
                }
            } catch { /* 忽略 */ }
        };

        if (prj) {
            const jcvmState = this.virtualStateByPrj.get(prj.prjID);

            if (jcvmState) {
                removeJCVM(jcvmState.prjSubdir);
                this.virtualStateByPrj.delete(prj.prjID);
            }
            const jcreState = this.jcreStateByPrj.get(prj.prjID);

            if (jcreState) {
                removeJCRE(jcreState.prjSubdir);
                this.jcreStateByPrj.delete(prj.prjID);
            }
            cleanupRoot();
        } else {
            // 清理全部
            if (existsSync(this.virtualStorageRoot)) {
                try { rmSync(this.virtualStorageRoot, { recursive: true, force: true }); } catch { /* 忽略 */ }
            }
            this.virtualStateByPrj.clear();
            this.jcreStateByPrj.clear();
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
            //    统一虚拟根下并列 JCVM/（工程源码 symlink）和 JCRE/（Java Card 运行时 API symlink）
            //    这两类内容共用一个 workspace folder，Ctrl+Shift+F 能同时搜到工程源码和 JCRE 标准库
            const virtualFolders: { path: string; name: string }[] = [];
            const linkedFiles = new Set<string>();
            let anyVirtualLinked = false;

            if (addStrategy === 'virtualSymlink') {
                // 4a) JCVM：工程源码
                for (const { prj, targets } of plansByPrj.values()) {
                    const state = this.buildVirtualTree(prj, targets, norm);

                    if (state && state.linked.size > 0) {
                        state.linked.forEach(f => linkedFiles.add(f));
                        anyVirtualLinked = true;
                    }
                }

                // 4b) JCRE：mask.c 引用的 Java Card 标准 API 源码
                //     需要 KeilAssistant.Keil.JCRE 配置指向 JCRE 源码根；未配置则跳过
                const jcrePath = resMgr.getJcrePath();

                for (const { prj } of plansByPrj.values()) {
                    if (!jcrePath) break;
                    const jcreState = this.buildJcreTree(prj, jcrePath, norm);

                    if (jcreState && jcreState.linked.size > 0) {
                        jcreState.linked.forEach(f => linkedFiles.add(f));
                        anyVirtualLinked = true;
                    }
                }

                // 任何 symlink 成功 → 把统一根加入工作区
                if (anyVirtualLinked) {
                    virtualFolders.push({ path: this.virtualStorageRoot, name: 'Keil Virtual' });
                }
            } else if (this.virtualStateByPrj.size > 0 || this.jcreStateByPrj.size > 0) {
                // 已切到 minimalCommonRoot 策略 → 清理旧的虚拟树（JCVM + JCRE）
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
        this.channel.appendLine(`[keil-assistant] openProject: path=${path}, hasMultiplyProject=${hasMultiplyProject}`);

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
                this.channel.appendLine(`[keil-assistant] 加载工程: label=${nPrj.label}, prjID=${nPrj.prjID}`);

                // 【修复】先注册 dataChanged 监听，再 load：load() 内部会触发 notifyUpdateView() 发 dataChanged，
                // 如果注册在 load 之后，首次加载的事件就没人接，scheduleSync 也就不会被触发。
                nPrj.on('dataChanged', () => {
                    this.updateView();
                    this.scheduleSync();
                });

                await nPrj.load();
                this.prjList.set(nPrj.prjID, nPrj);
                this.channel.appendLine(`[keil-assistant] 工程加载完成: ${nPrj.label}, Targets=${nPrj.getTargets().length}`);

                if (this.curActiveProject === undefined) {
                    this.curActiveProject = nPrj;
                    this.curActiveProject.active();
                }

                this.updateView();
                // 工程加载完成后立即触发一次同步（不用等 debounce，确保自动生效）
                this.channel.appendLine(`[keil-assistant] openProject 触发 scheduleSync（防抖 300ms）`);
                this.scheduleSync();

                return nPrj;
            } else {
                this.channel.appendLine(`[keil-assistant] 工程已存在，跳过重复加载: ${path}`);
            }
        }

        return undefined;
    }

    async closeProject(pID: string) {
        const prj = this.prjList.get(pID);

        if (prj) {
            this.channel.appendLine(`[keil-assistant] closeProject: prj=${prj.label}, prjID=${pID}`);
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
        const prevLabel = this.curActiveProject?.label;

        this.curActiveProject?.deactive();
        const project = this.prjList.get(view.prjID);

        project?.active();
        this.curActiveProject = project;
        this.channel.appendLine(
            `[keil-assistant] activeProject: ${prevLabel ?? '无'} → ${project?.label ?? '无'}`
        );
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
            const oldTarget = prj.getActiveTarget()?.targetName;
            const targetName = await window.showQuickPick(tList.map((ele) => ele.targetName), {
                canPickMany: false,
                placeHolder: l10n.t('please select a target name for keil project')
            });

            if (targetName) {
                prj.setActiveTarget(targetName);
                this.channel.appendLine(
                    `[keil-assistant] switchTarget: prj=${prj.label}, ${oldTarget ?? '无'} → ${targetName}`
                );
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