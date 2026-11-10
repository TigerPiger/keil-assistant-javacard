import type {
    ExtensionContext, OutputChannel, StatusBarItem} from 'vscode';
import {
    StatusBarAlignment,
    commands, env, l10n, window
} from 'vscode';

import { ResourceManager } from './ResourceManager';

import { stat } from 'fs';
import { ProjectExplorer } from './ui/ProjectExplorer';
import type { IView } from './core/IView';

let myStatusBarItem: StatusBarItem;
let channel: OutputChannel;

export function activate(context: ExtensionContext) {
    console.info('---- keil-assistant actived >>>  ----');
    channel ??= window.createOutputChannel('keil-vscode');
    myStatusBarItem = window.createStatusBarItem(StatusBarAlignment.Left, 200);
    myStatusBarItem.command = 'statusbar.project';

    // 检查 Keil 根目录是否存在。
    // 注意：这个检查是"尽力而为"——如果用户没配好 Keil.HOME 或路径无效，我们只记日志，
    // 不去弹 errorMessage 打断用户流程（不影响 workspace sync 这类不依赖 Keil 路径的功能）。
    try {
        const testKeilRoot = ResourceManager.getInstance(context).getKeilRootDir("MDK");

        stat(testKeilRoot, (err, stat) => {
            if (err || !stat.isDirectory()) {
                // 路径可能带了引号/空格等脏字符，先 trim 一下再提示
                const cleaned = testKeilRoot?.replace(/^["']|["']$/g, '') ?? '';

                channel.appendLine(
                    `[keil-assistant] Keil.HOME 路径无效: ${testKeilRoot}（尝试清理后: ${cleaned}）。` +
                    `Keil 构建/下载功能不可用，但 workspace sync 不受影响。`
                );
            }
        });
    } catch (err) {
        channel.appendLine(`[keil-assistant] getKeilRootDir 调用异常: ${err}`);
    }

    const prjExplorer = new ProjectExplorer(context, channel, myStatusBarItem);
    const subscriber = context.subscriptions;

    subscriber.push(commands.registerCommand('explorer.open', async () => {
        const uri = await window.showOpenDialog({
            openLabel: l10n.t('Open keil uVision project'),
            canSelectFolders: false,
            canSelectMany: false,
            filters: {
                'keilProjectXml': ['uvproj', 'uvprojx', 'uvmpw']
            }
        });

        try {
            if (uri && uri.length > 0) {
                // openProject 内部会自动把 uvprojx 所在目录加入工作区（非破坏性），
                // 然后加载工程；工作区变更会触发 onDidChangeWorkspaceFolders 监听 → syncWorkspaceFolders
                const uvPrjPath = uri[0].fsPath;

                await prjExplorer.openProject(uvPrjPath, false);
            }
        } catch (error) {
            const errMsg = l10n.t('Open project failed! msg');

            window.showErrorMessage(`${errMsg}: ${(error as Error).message}`);
        }
    }));

    subscriber.push(commands.registerCommand('project.close', (item: IView) => prjExplorer.closeProject(item.prjID)));

    subscriber.push(commands.registerCommand('project.build', (item: IView) => prjExplorer.getTarget(item)?.build()));

    subscriber.push(commands.registerCommand('project.rebuild', (item: IView) => prjExplorer.getTarget(item)?.rebuild()));

    subscriber.push(commands.registerCommand('project.download', (item: IView) => prjExplorer.getTarget(item)?.download()));

    subscriber.push(commands.registerCommand('item.copyValue', (item: IView) => env.clipboard.writeText(item.tooltip ?? '')));

    subscriber.push(commands.registerCommand('project.switch', (item: IView) => prjExplorer.switchTargetByProject(item)));

    subscriber.push(commands.registerCommand('project.active', (item: IView) => prjExplorer.activeProject(item)));

    subscriber.push(commands.registerCommand('statusbar.project', async () => {
        void prjExplorer.statusBarSwitchTargetByProject();
    }));

    // 手动触发工作区同步，方便排障：命令面板里输入 "Keil: Sync Workspace Folders"
    subscriber.push(commands.registerCommand('workspace.sync', () => {
        void prjExplorer.syncNow();
    }));

    subscriber.push(commands.registerCommand('project.generateCompileCommandsJson',
        (item: IView) => prjExplorer.getTarget(item)?.updateCompileCommands()
    ));

    subscriber.push(myStatusBarItem);

    void prjExplorer.loadWorkspace();
    console.info('---- keil-assistant actived <<<< ----');
}

export function deactivate() {
    // console.log('---- keil-assistant closed ----');
    channel.dispose();
}
