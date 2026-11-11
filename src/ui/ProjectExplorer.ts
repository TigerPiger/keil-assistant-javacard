import { XMLParser } from "fast-xml-parser";
import { statSync, readFileSync, readdirSync, existsSync } from "fs";
import { dirname, extname, join, normalize, resolve, sep, relative, basename } from "path";
import type {
    Event, ExtensionContext, ProviderResult, TreeDataProvider,
    OutputChannel,
    StatusBarItem
} from "vscode";
import {
    commands, EventEmitter, l10n, ConfigurationTarget,
    TreeItem, TreeItemCollapsibleState, Uri, workspace, window
} from "vscode";

import type { IView } from "../core/IView";
import { KeilProject } from "../core/KeilProject";
import { Source } from "../core/Source";
import { FileGroup } from "../core/FileGroup";
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

    // 扁平工作区模式下插件管理的 workspace folder 路径，用于清理
    private flatManagedFolders: Set<string> = new Set();
    // 上一次应用的 files.exclude 配置签名，用于幂等短路
    private lastFlatSignature: string | undefined;

    constructor(context: ExtensionContext, private channel: OutputChannel, private myStatusBarItem: StatusBarItem) {
        this.prjList = new Map();
        this.viewEvent = new EventEmitter();
        this.onDidChangeTreeData = this.viewEvent.event;
        context.subscriptions.push(window.registerTreeDataProvider('project', this));
        context.subscriptions.push(commands.registerCommand(this.itemClickCommand, (item: IView) => this.onItemClick(item)));
        this.workspacePath = '';
    }
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
        if (this.workspacePath === undefined) {
            const msg = l10n.t('The workspace directory is empty, Goto open the workspace directory?');
            const result = await window.showInformationMessage(msg, l10n.t('Ok'), l10n.t('Cancel'));

            if (result === l10n.t('Ok')) {
                this.openWorkspace(new File(dirname(path)));

                return;
            }
            if (result === l10n.t('Cancel')) {
                const fmsg = l10n.t('Error: open project');
                const msg = l10n.t('Failed, The workspace Path');
                const emsg = l10n.t('is NULL , Please use vscode open the project folder.');
                const errorMsg = `${fmsg} ${path} ${msg} ${this.workspacePath} ${emsg}`;

                this.channel.appendLine(errorMsg);
                window.showErrorMessage(errorMsg);
                throw Error(errorMsg);
            }
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

                // FlatMode：工程加载完成后触发同步
                void this.setupFlatWorkspace();

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
            this.updateView();
        }
    }


    async activeProject(view: IView) {
        this.curActiveProject?.deactive();
        const project = this.prjList.get(view.prjID);

        project?.active();
        this.curActiveProject = project;
        this.updateView();

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

                // FlatMode：Target 切换后触发同步（不同 Target 引用的源文件可能不同）
                void this.setupFlatWorkspace();
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

                // FlatMode：Target 切换后触发同步
                void this.setupFlatWorkspace();
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

    // ============================================================
    // 扁平工作区模式：零磁盘写入，用 files.exclude 过滤无关文件
    // ============================================================

    /**
     * 扁平模式主入口：收集 JCVM/JCRE 文件 → 计算根目录 → 更新 files.exclude → 加入 workspaceFolders
     * 触发时机：工程加载完成、Target 切换、用户手动触发
     */
    async setupFlatWorkspace(): Promise<void> {
        const resMgr = ResourceManager.getInstance();

        if (!resMgr.isFlatModeEnabled()) {
            this.channel.appendLine('[keil-assistant] FlatMode 未启用，跳过 setupFlatWorkspace');
            return;
        }

        if (this.prjList.size === 0) {
            this.channel.appendLine('[keil-assistant] prjList 为空，跳过 setupFlatWorkspace（工程还没加载）');
            return;
        }

        this.channel.appendLine('===== FlatMode 扁平工作区同步 START =====');

        const norm = (p: string) => normalize(p).replace(/\\/g, '/').toLowerCase();

        // ---- 1) 收集 JCVM 文件（工程源码）----
        const jcvmFiles = this.collectAllJCVMFilePaths();
        this.channel.appendLine(`JCVM: 共 ${jcvmFiles.size} 个源文件（${Array.from(this.prjList.values()).map(p => p.label).join(', ')}）`);

        // ---- 2) 收集 JCRE 文件（mask.c 引用的 Java Card API）----
        const jcrePath = resMgr.getJcrePath();
        const jcreFiles = new Set<string>();

        if (jcrePath && existsSync(jcrePath)) {
            const classes = this.scanMaskClasses();
            this.channel.appendLine(`JCRE: mask.c 提取 ${classes.length} 个类名`);

            const mapping = this.findJavaFilesInJCRE(jcrePath, classes);
            for (const p of mapping.values()) jcreFiles.add(p);
            this.channel.appendLine(`JCRE: 找到 ${jcreFiles.size}/${classes.length} 个 .java`);

            if (classes.length > 0) {
                const missing = classes.filter(c => !mapping.has(c));

                if (missing.length > 0) {
                    this.channel.appendLine(`JCRE: ⚠️ 以下 ${missing.length} 个类在 JCRE 路径下未找到 .java：`);
                    for (const c of missing.slice(0, 10)) this.channel.appendLine(`  - ${c}`);
                    if (missing.length > 10) this.channel.appendLine(`  ... 还有 ${missing.length - 10} 个`);
                }
            }
        } else {
            this.channel.appendLine('JCRE: 未配置 KeilAssistant.Keil.JCRE 或路径不存在，跳过 JCRE');
        }

        // ---- 3) 合并 + 计算根目录 ----
        const keepFiles = new Set<string>();

        for (const p of jcvmFiles) keepFiles.add(norm(p));
        for (const p of jcreFiles) keepFiles.add(norm(p));

        this.channel.appendLine(`JCVM+JCRE 总计: ${keepFiles.size} 个保留文件`);

        // ---- 4) 计算各根目录 ----
        const rootsToAdd: { path: string; name: string }[] = [];

        // JCVM 根：所有源文件的最小公共祖先目录
        if (jcvmFiles.size > 0) {
            const jcvmRoot = this.computeCommonAncestor(Array.from(jcvmFiles));

            if (jcvmRoot) {
                rootsToAdd.push({ path: jcvmRoot, name: `JCVM (${basename(jcvmRoot)})` });
                this.channel.appendLine(`JCVM 根目录: ${jcvmRoot}`);
            }
        }

        // JCRE 根：用户直接配置的路径
        if (jcrePath && existsSync(jcrePath) && jcreFiles.size > 0) {
            rootsToAdd.push({ path: jcrePath, name: `JCRE (${basename(jcrePath)})` });
            this.channel.appendLine(`JCRE 根目录: ${jcrePath}`);
        }

        if (rootsToAdd.length === 0) {
            this.channel.appendLine('无有效根目录，跳过 FlatMode 同步');
            return;
        }

        // ---- 5) 收集所有根目录下的文件 → 计算 exclude ----
        const allFilesUnderRoots = this.collectAllFilesUnder(rootsToAdd.map(r => r.path));

        this.channel.appendLine(`根目录下共 ${allFilesUnderRoots.size} 个文件，其中 ${keepFiles.size} 个保留，${allFilesUnderRoots.size - keepFiles.size} 个排除`);

        const excludeConfig = this.buildExcludeConfig(allFilesUnderRoots, keepFiles, norm);

        // ---- 6) 更新 files.exclude（workspace 级别）----
        try {
            const config = workspace.getConfiguration('files');
            const prev = config.get<Record<string, boolean>>('exclude') ?? {};

            // 合并：保留用户之前在 exclude 里的自定义项（不以 keil: 前缀的）
            const userCustom: Record<string, boolean> = {};

            for (const [k, v] of Object.entries(prev)) {
                if (!k.startsWith('keil:')) userCustom[k] = v;
            }

            const merged = { ...userCustom, ...excludeConfig };
            await config.update('exclude', merged, ConfigurationTarget.Workspace);
            this.channel.appendLine(`✅ files.exclude 已更新: ${Object.keys(excludeConfig).length} 条（keil 托管）+ ${Object.keys(userCustom).length} 条（用户自定义）`);
        } catch (err) {
            this.channel.appendLine(`❌ 更新 files.exclude 失败: ${(err as Error).message}`);
            window.showErrorMessage(`FlatMode: 更新 files.exclude 失败 — ${(err as Error).message}`);
        }

        // ---- 7) 把根目录加入 workspaceFolders（如果还没有）----
        await this.addFlatRootsToWorkspace(rootsToAdd, norm);

        this.channel.appendLine('===== FlatMode 扁平工作区同步 END =====');
    }

    /** 从所有工程的活动 Target 中收集所有启用的源文件完整路径 */
    private collectAllJCVMFilePaths(): Set<string> {
        const result = new Set<string>();

        for (const prj of this.prjList.values()) {
            const activeTarget = prj.getActiveTarget();

            if (!activeTarget) continue;

            // 兼容不同 Target 实现：有的 getChildViews 返回 FileGroup[]
            const groups = (activeTarget as any).fGroups as FileGroup[] | undefined;

            if (!groups) {
                const children = activeTarget.getChildViews() as FileGroup[] | undefined;

                if (children) {
                    for (const g of children) {
                        for (const src of g.sources) {
                            if (src.enable && src.file.isFile()) result.add(src.file.path);
                        }
                    }
                }
                continue;
            }

            for (const g of groups) {
                for (const src of g.sources) {
                    if (src.enable && src.file.isFile()) result.add(src.file.path);
                }
            }
        }

        return result;
    }

    /**
     * 扫描所有工程目录下的 mask.c 文件，提取 Java Card 类名。
     * mask.c 是 Java Card JCRE 的"链接器映射文件"，注释格式：
     *   /* class@0x008281d3:0x0005: public javacard/framework/CardException *\/
     *   /* class@0x00828229:0x005b: public final javacard/framework/JCSystem *\/
     */
    private scanMaskClasses(): string[] {
        const results = new Set<string>();

        for (const prj of this.prjList.values()) {
            // 从工程目录和 workspace 根开始找 mask.c
            const prjDir = dirname(prj.uvprjFile.path);
            const candidates: string[] = [];

            // 深度 3 以内递归找 mask.c
            const walkMask = (dir: string, depth: number) => {
                if (depth < 0) return;

                let entries: string[];

                try {
                    entries = readdirSync(dir);
                } catch {
                    return;
                }

                for (const name of entries) {
                    if (name === 'mask.c' || name === 'mask.C') {
                        candidates.push(join(dir, name));
                    } else {
                        const full = join(dir, name);

                        try {
                            if (statSync(full).isDirectory()) walkMask(full, depth - 1);
                        } catch { /* 忽略 */ }
                    }
                }
            };

            walkMask(prjDir, 3);

            if (this.workspacePath && this.workspacePath !== prjDir) {
                walkMask(this.workspacePath, 3);
            }

            // 解析每个 mask.c
            for (const maskPath of candidates) {
                try {
                    const content = readFileSync(maskPath, 'utf8');
                    // class@地址:0x段号: [修饰符...] [class/interface] 全限定名
                    // 修饰符和 class/interface 都可能省略，全限定名必须是 [\w/.]+
                    const re = /class@[^:]*:\s*0x[0-9a-fA-F]+:\s*(?:(?:public|private|protected)\s+)?(?:(?:abstract|final|native|static|synchronized|transient|strictfp)\s+)*(?:(?:interface|class)\s+)?([a-zA-Z_][\w/.]*)(?=\s|$|\*\/|")/g;
                    let m: RegExpExecArray | null;

                    while ((m = re.exec(content)) !== null) {
                        results.add(m[1]);
                    }

                    this.channel.appendLine(`  mask.c 解析: ${maskPath} → 提取 ${results.size} 个类名（累计）`);
                } catch (err) {
                    this.channel.appendLine(`  mask.c 读取失败 ${maskPath}: ${(err as Error).message}`);
                }
            }
        }

        return Array.from(results);
    }

    /** 在 jcreRoot 下递归查找指定类名对应的 .java 文件。
     * 支持嵌套目录结构（api/java/lang/Object.java, gpsrc/org/globalplatform/CVM.java）。
     * 只在首次调用时 walk 一次构建索引，后续 O(1) 查表。 */
    private findJavaFilesInJCRE(jcreRoot: string, classes: string[]): Map<string, string> {
        const result = new Map<string, string>();

        if (!existsSync(jcreRoot)) return result;

        // 构建索引 Map<fileName, 完整路径[]>，只 walk 一次
        const index = new Map<string, string[]>();

        const walk = (dir: string) => {
            let entries: string[];

            try {
                entries = readdirSync(dir);
            } catch {
                return;
            }

            for (const name of entries) {
                const full = join(dir, name);
                let st: ReturnType<typeof statSync>;

                try {
                    st = statSync(full);
                } catch {
                    continue;
                }

                if (st.isDirectory()) {
                    walk(full);
                } else if (st.isFile() && name.endsWith('.java')) {
                    const list = index.get(name);

                    if (list) {
                        list.push(full);
                    } else {
                        index.set(name, [full]);
                    }
                }
            }
        };

        walk(jcreRoot);

        this.channel.appendLine(`  JCRE 索引构建: ${jcreRoot} 共 ${index.size} 个不同 .java 文件名`);

        // 对每个类找文件
        for (const cls of classes) {
            const parts = cls.split('/');
            const fileName = parts[parts.length - 1] + '.java';
            const exactTail = parts.join(sep) + '.java';
            const candidates = index.get(fileName);

            if (!candidates || candidates.length === 0) continue;

            // 优先路径尾巴完全匹配
            let found = candidates.find(c => c.endsWith(exactTail));

            if (!found) {
                // 次优：正斜杠格式匹配
                const slashTail = cls + '.java';

                found = candidates.find(c => c.replace(/\\/g, '/').endsWith(slashTail));
            }

            if (!found) {
                // 兜底：第一个候选
                found = candidates[0];
            }

            if (found) result.set(cls, found);
        }

        return result;
    }

    /** 计算多个路径的最小公共祖先目录（Windows 盘符也要算） */
    private computeCommonAncestor(paths: string[]): string | undefined {
        if (paths.length === 0) return undefined;
        if (paths.length === 1) return dirname(paths[0]);

        // 用正斜杠统一处理
        const normalized = paths.map(p => normalize(p).replace(/\\/g, '/').toLowerCase());

        let ancestor = normalized[0];

        for (let i = 1; i < normalized.length; i++) {
            // 逐步缩短 ancestor，直到是当前路径的前缀
            while (ancestor.length > 0 && !normalized[i].startsWith(ancestor + '/')) {
                const lastSlash = ancestor.lastIndexOf('/');

                if (lastSlash <= 0) {
                    ancestor = ancestor.split('/')[0]; // 盘符或根
                    break;
                }
                ancestor = ancestor.substring(0, lastSlash);
            }
        }

        // 转回原始路径格式（用 sep）
        return ancestor.replace(/\//g, sep);
    }

    /** 递归收集多个根目录下的所有文件绝对路径（完整遍历，后续用 keepSet 过滤） */
    private collectAllFilesUnder(roots: string[]): Set<string> {
        const result = new Set<string>();

        for (const root of roots) {
            if (!existsSync(root)) continue;

            const walk = (dir: string) => {
                let entries: string[];

                try {
                    entries = readdirSync(dir);
                } catch {
                    return;
                }

                for (const name of entries) {
                    const full = join(dir, name);
                    let st: ReturnType<typeof statSync>;

                    try {
                        st = statSync(full);
                    } catch {
                        continue;
                    }

                    if (st.isDirectory()) {
                        walk(full);
                    } else if (st.isFile()) {
                        result.add(normalize(full));
                    }
                }
            };

            walk(root);
        }

        return result;
    }

    /**
     * 计算 VS Code files.exclude 配置。
     * 策略：对每个不在 keepSet 里的文件，生成相对 workspace 根的 glob 模式。
     * 但 files.exclude 不支持"排除单个文件"的精细模式，只能用 glob。
     *
     * 优化：对每个根目录，找到"保留文件所在的所有子目录"，然后排除该根下所有不在这些子目录里的内容。
     * 如果根下只有少数文件保留（如 mask.c 模式），直接排除除保留文件外所有。
     *
     * 返回 { [globPattern]: true } 格式，key 以 "keil:" 前缀开头（用于下次识别和合并用户自定义项）。
     */
    private buildExcludeConfig(
        allFiles: Set<string>,
        keepFiles: Set<string>,
        norm: (p: string) => string,
    ): Record<string, boolean> {
        const result: Record<string, boolean> = {};

        // 计算要排除的文件
        const exclude = new Set<string>();

        for (const f of allFiles) {
            if (!keepFiles.has(norm(f))) exclude.add(f);
        }

        this.channel.appendLine(`  待排除文件: ${exclude.size}/${allFiles.size}`);

        // 策略：对每个排除文件，按目录分组后生成 glob
        // VS Code files.exclude 格式：相对于 workspaceFolder 的 glob
        // 我们用 **/xxx 排除所有名为 xxx 的文件，或 目录/** 排除整个目录
        const dirExcludeCount = new Map<string, number>();
        const dirKeepCount = new Map<string, number>();

        for (const f of allFiles) {
            const dir = dirname(norm(f));
            const isKeep = keepFiles.has(norm(f));

            if (isKeep) {
                dirKeepCount.set(dir, (dirKeepCount.get(dir) ?? 0) + 1);
            } else {
                dirExcludeCount.set(dir, (dirExcludeCount.get(dir) ?? 0) + 1);
            }
        }

        // 如果某个目录下所有文件都要排除，直接排除整个目录
        const allDirs = new Set<string>([...dirExcludeCount.keys(), ...dirKeepCount.keys()]);

        for (const dir of allDirs) {
            const excludeCount = dirExcludeCount.get(dir) ?? 0;
            const keepCount = dirKeepCount.get(dir) ?? 0;

            if (excludeCount > 0 && keepCount === 0) {
                // 这个目录全部排除 → 加一条 glob
                const relGlob = '**/' + dir.replace(/\\/g, '/').replace(/^[A-Za-z]:\//, '') + '/**';

                result[relGlob] = true;
            } else if (excludeCount > 0 && keepCount > 0 && excludeCount <= 5) {
                // 少量文件排除 → 按文件名排除
                // 收集这个目录下要排除的文件名
                const filesToExclude = Array.from(exclude).filter(f => dirname(norm(f)) === dir).map(f => basename(f));

                for (const fileName of filesToExclude) {
                    result['**/' + fileName] = true;
                }
            }
            // 如果 excludeCount 很大但 keepCount 也有 → 让 VS Code 显示出来，用户手动处理
        }

        this.channel.appendLine(`  生成 ${Object.keys(result).length} 条 exclude glob`);

        return result;
    }

    /** 把 FlatMode 管理的根目录加入 workspaceFolders */
    private async addFlatRootsToWorkspace(
        roots: { path: string; name: string }[],
        norm: (p: string) => string,
    ): Promise<void> {
        if (!workspace.workspaceFolders) return;

        const currentPaths = new Set(workspace.workspaceFolders.map(f => norm(f.uri.fsPath)));

        // 先移除插件之前管理过但本次不再需要的
        const toRemove: string[] = [];

        for (const managed of this.flatManagedFolders) {
            if (!roots.some(r => norm(r.path) === managed)) {
                toRemove.push(managed);
            }
        }

        if (toRemove.length > 0) {
            const all = workspace.workspaceFolders;

            if (all) {
                const indices = toRemove
                    .map(p => all.findIndex(f => norm(f.uri.fsPath) === p))
                    .filter(i => i !== -1)
                    .sort((a, b) => b - a);

                for (const idx of indices) {
                    await workspace.updateWorkspaceFolders(idx, 1);
                }
            }

            for (const p of toRemove) this.flatManagedFolders.delete(p);
            this.channel.appendLine(`  移除 ${toRemove.length} 个过期 FlatMode 目录`);
        }

        // 加入新的
        const toAdd = roots.filter(r => !currentPaths.has(norm(r.path)) && !this.flatManagedFolders.has(norm(r.path)));

        if (toAdd.length > 0) {
            const insertIndex = workspace.workspaceFolders.length;
            const ok = workspace.updateWorkspaceFolders(
                insertIndex, 0,
                ...toAdd.map(r => ({ uri: Uri.file(r.path), name: r.name })),
            );

            if (ok) {
                for (const r of toAdd) this.flatManagedFolders.add(norm(r.path));
                this.channel.appendLine(`  ✅ 加入 ${toAdd.length} 个 FlatMode 目录到 workspace`);
            } else {
                this.channel.appendLine(`  ❌ 加入 FlatMode 目录失败！`);
            }
        } else {
            this.channel.appendLine(`  FlatMode 目录无需变更（已在 workspace 中）`);
        }
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