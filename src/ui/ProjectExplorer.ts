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
    // 虚拟工作区根目录：所有符号链接都创建在这里，按 TargetName/GroupName 层级组织
    // 格式：{uvprojx所在目录}/_keil_virtual/
    private virtualRootByPrj: Map<string, string> = new Map();

    constructor(context: ExtensionContext, private channel: OutputChannel, private myStatusBarItem: StatusBarItem) {
        this.prjList = new Map();
        this.viewEvent = new EventEmitter();
        this.onDidChangeTreeData = this.viewEvent.event;
        context.subscriptions.push(window.registerTreeDataProvider('project', this));
        context.subscriptions.push(commands.registerCommand(this.itemClickCommand, (item: IView) => this.onItemClick(item)));
        this.workspacePath = '';

        // 监听工作区文件夹变更，做 debounce 后触发 syncWorkspaceFolders
        context.subscriptions.push(workspace.onDidChangeWorkspaceFolders(() => {
            if (this.isSyncing) return;
            if (this.syncDebounceTimer) clearTimeout(this.syncDebounceTimer);
            this.syncDebounceTimer = setTimeout(() => {
                void this.syncWorkspaceFolders();
            }, 300);
        }));
    }

    // ========== 虚拟工作区 & 工作区同步 相关方法 ==========

    /**
     * 从视图节点树递归收集所有 Source 文件的物理所在目录（绝对路径，规范化）。
     * 用于 symlink 创建失败时的物理目录 fallback。
     */
    private collectSourceDirsFromView(view: IView | undefined, dirs: Set<string>): void {
        if (!view) return;
        if (view instanceof Source && view.file.isFile()) {
            dirs.add(normalize(dirname(view.file.path)).replace(/\\/g, '/'));
        }
        const children = view.getChildViews();
        if (children) children.forEach(c => this.collectSourceDirsFromView(c, dirs));
    }

    /**
     * 从活动 Target 收集所有 Source 文件的物理所在目录。
     */
    private collectActiveTargetSourceDirs(): Set<string> {
        const dirs = new Set<string>();
        for (const prj of this.prjList.values()) {
            const activeTarget = prj.getActiveTarget();
            if (activeTarget) this.collectSourceDirsFromView(activeTarget, dirs);
        }
        return dirs;
    }

    /**
     * 按 FileGroup→Source 层级创建虚拟工作区目录树。
     *
     * 目录结构：
     *   {uvprojx所在目录}/_keil_virtual/{TargetName}/{GroupName}/{SourceName} → symlink 指向真实文件
     *
     * symlink 创建策略（Windows 权限兼容）：
     *   1. 先用 fs.symlinkSync(target, path, 'file') 尝试文件符号链接
     *   2. 失败 (EACCES) 时用 fs.linkSync(target, path) 硬链接（不需要权限，仅限同卷）
     *   3. 都失败则跳过该文件（fallback 到物理目录聚合）
     *
     * @returns 虚拟 Target 目录路径，或 null（symlink 全部失败）
     */
    private createVirtualTargetDirs(prj: KeilProject, target: PTarget): string | null {
        const uvprjDir = dirname(prj.uvprjFile.path);
        const virtualRoot = join(uvprjDir, '_keil_virtual');

        // 记录虚拟根，用于关闭工程时清理
        this.virtualRootByPrj.set(prj.prjID, virtualRoot);

        // 虚拟 Target 目录：TargetName（去空格避免路径问题）
        const targetDirName = target.targetName.replace(/[<>"|?*]/g, '_');
        const targetDir = join(virtualRoot, targetDirName);

        // 清理旧 Target 目录后重建（避免残留）
        if (existsSync(targetDir)) {
            try { rmSync(targetDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
        }

        try {
            mkdirSync(targetDir, { recursive: true });
        } catch (err) {
            this.channel.appendLine(`[keil-assistant] 创建虚拟目录失败: ${targetDir}, msg: ${(err as Error).message}`);

            return null;
        }

        let successCount = 0;
        let skipCount = 0;

        // 遍历 FileGroup → Source
        const fGroups = target.getChildViews() as FileGroup[] | undefined;

        if (!fGroups) {
            this.channel.appendLine(`[keil-assistant] Target '${target.targetName}' 无 FileGroup。`);

            return null;
        }

        for (const group of fGroups) {
            // Group 目录名：保留原始 label，非法字符替换
            const groupDirName = group.label.replace(/[<>"|?*]/g, '_').trim() || '_Group';
            const groupDir = join(targetDir, groupDirName);

            try {
                mkdirSync(groupDir, { recursive: true });
            } catch (err) {
                this.channel.appendLine(`[keil-assistant] 创建 FileGroup 目录失败: ${groupDir}, msg: ${(err as Error).message}`);

                continue;
            }

            for (const source of group.sources) {
                if (!source.file.isFile()) {
                    skipCount++;
                    continue;
                }
                const realPath = source.file.path;

                // 处理同名文件（不同物理路径但文件名相同）：添加父目录前缀避免冲突
                let linkName = source.file.name;
                const linkPath = join(groupDir, linkName);

                // 如果同名冲突，加父目录名前缀
                if (existsSync(linkPath)) {
                    const parentName = basename(dirname(realPath));
                    linkName = `${parentName}_${source.file.name}`;
                }
                const finalLinkPath = join(groupDir, linkName);

                // 尝试创建符号链接
                try {
                    // 先删可能存在的旧链接
                    if (existsSync(finalLinkPath)) {
                        try { rmSync(finalLinkPath, { force: true }); } catch { /* 忽略 */ }
                    }
                    symlinkSync(realPath, finalLinkPath, 'file');
                    successCount++;
                } catch {
                    // symlink 失败（通常是权限问题），尝试硬链接
                    try {
                        linkSync(realPath, finalLinkPath);
                        successCount++;
                    } catch {
                        // 都失败，跳过这个文件
                        skipCount++;
                    }
                }
            }
        }

        this.channel.appendLine(
            `[keil-assistant] Target '${target.targetName}' 虚拟目录: 成功 ${successCount} 个链接, 跳过 ${skipCount} 个文件, 路径 ${targetDir}`
        );

        return successCount > 0 ? targetDir : null;
    }

    /**
     * 清理指定工程的虚拟工作区根目录。
     */
    private cleanupVirtualDirs(prj?: KeilProject): void {
        if (prj) {
            const root = this.virtualRootByPrj.get(prj.prjID);

            if (root && existsSync(root)) {
                try { rmSync(root, { recursive: true, force: true }); } catch { /* 忽略 */ }
                this.virtualRootByPrj.delete(prj.prjID);
                this.channel.appendLine(`[keil-assistant] 已清理虚拟目录: ${root}`);
            }
        } else {
            // 清理所有
            for (const root of this.virtualRootByPrj.values()) {
                if (existsSync(root)) {
                    try { rmSync(root, { recursive: true, force: true }); } catch { /* 忽略 */ }
                }
            }
            this.virtualRootByPrj.clear();
        }
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
     * 根据活动 Target 同步 VS Code 工作区文件夹。
     *
     * 策略（优先级从高到低）：
     *   1. 尝试创建虚拟工作区目录（FileGroup→Source 层级 + symlink）
     *   2. 若虚拟目录创建成功 → 把虚拟 Target 目录加入工作区
     *   3. 若虚拟目录创建失败 → fallback 到物理源码目录聚合（旧方案）
     *   4. 差集为空时直接短路返回（幂等）
     */
    private async syncWorkspaceFolders(): Promise<void> {
        this.isSyncing = true;

        try {
            if (!workspace.workspaceFolders || workspace.workspaceFolders.length === 0) {
                return;
            }

            if (this.prjList.size === 0) {
                return;
            }

            const norm = (p: string) => normalize(p).replace(/\\/g, '/').toLowerCase();

            // 第一步：为每个工程的活动 Target 创建虚拟目录
            const virtualDirsToAdd: string[] = [];

            for (const prj of this.prjList.values()) {
                const target = prj.getActiveTarget();

                if (!target) continue;
                const vDir = this.createVirtualTargetDirs(prj, target);

                if (vDir) virtualDirsToAdd.push(vDir);
            }

            // 第二步：收集物理源码目录（作为 fallback 或补充）
            const sourceDirs = this.collectActiveTargetSourceDirs();
            const dirArray = Array.from(sourceDirs);

            // 计算最小物理目录集合
            const minimalDirs = dirArray.filter(dir => {
                const d = norm(dir);

                return !dirArray.some(other => {
                    const o = norm(other);

                    return o !== d && d.startsWith(o + '/');
                });
            });

            // 第三步：计算最终需要加入的目录
            // 虚拟目录优先：虚拟 Target 目录覆盖了其下所有源码文件所在物理目录 → 可以 skip 这些物理目录
            const virtualPathsLower = new Set(virtualDirsToAdd.map(norm));

            const targetPhysicalDirs = minimalDirs.filter(dir => {
                const dirLower = norm(dir);

                // 如果某个虚拟目录是该物理目录的祖先或相同，则物理目录被覆盖
                for (const vp of virtualPathsLower) {
                    if (dirLower === vp || dirLower.startsWith(vp + '/')) {
                        return false;
                    }
                }
                return true;
            });

            const targetAllDirs = [...virtualDirsToAdd, ...targetPhysicalDirs].map(norm);
            const targetSet = new Set(targetAllDirs);

            // 第四步：与当前 managed 集合计算差集
            const externalPaths = workspace.workspaceFolders
                .map(f => norm(f.uri.fsPath))
                .filter(p => !this.managedFolderPaths.has(p));

            const toRemove: string[] = [];
            const toAdd: { uri: Uri; name: string; path: string }[] = [];

            for (const p of this.managedFolderPaths) {
                if (!targetSet.has(p)) toRemove.push(p);
            }

            const managedCopy = new Set(this.managedFolderPaths);

            for (const dir of [...virtualDirsToAdd, ...targetPhysicalDirs]) {
                const dirLower = norm(dir);

                // 被外部已有目录覆盖的 skip
                if (externalPaths.some(ep => dirLower === ep || dirLower.startsWith(ep + '/'))) continue;
                if (!managedCopy.has(dirLower)) {
                    toAdd.push({ uri: Uri.file(dir), name: basename(dir), path: dirLower });
                }
            }

            // 一致性短路
            if (toRemove.length === 0 && toAdd.length === 0) {
                return;
            }

            // 第五步：先删除，再追加
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

            if (toAdd.length > 0) {
                const ok = workspace.updateWorkspaceFolders(workspace.workspaceFolders.length, 0, ...toAdd);

                if (ok) {
                    for (const item of toAdd) this.managedFolderPaths.add(item.path);
                    const vCount = toAdd.filter(a => virtualPathsLower.has(a.path)).length;
                    this.channel.appendLine(
                        `[keil-assistant] 已同步工作区文件夹：新增 ${toAdd.length} 个 (虚拟 ${vCount} + 物理 ${toAdd.length - vCount}), 移除 ${toRemove.length} 个。`
                    );
                } else {
                    this.channel.appendLine(`[keil-assistant] 追加源码目录到工作区失败。`);
                }
            } else if (toRemove.length > 0) {
                this.channel.appendLine(`[keil-assistant] 已同步工作区文件夹：移除 ${toRemove.length} 个。`);
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

                await nPrj.load();
                nPrj.on('dataChanged', () => this.updateView());
                this.prjList.set(nPrj.prjID, nPrj);

                if (this.curActiveProject === undefined) {
                    this.curActiveProject = nPrj;
                    this.curActiveProject.active();
                }

                this.updateView();
                // 工程加载后触发 syncWorkspaceFolders（虚拟目录 + 工作区文件夹同步）
                void this.syncWorkspaceFolders();

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
            void this.syncWorkspaceFolders();
        }
    }


    async activeProject(view: IView) {
        this.curActiveProject?.deactive();
        const project = this.prjList.get(view.prjID);

        project?.active();
        this.curActiveProject = project;
        this.updateView();
        // 激活工程后重新同步工作区文件夹
        void this.syncWorkspaceFolders();

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
                void this.syncWorkspaceFolders();
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
                void this.syncWorkspaceFolders();
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