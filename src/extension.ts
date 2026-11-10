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

    const testKeilRoot = ResourceManager.getInstance(context).getKeilRootDir("MDK");

    stat(testKeilRoot, (err, stat) => {
        if (err || !stat.isDirectory()) {
            channel.show();
            channel.appendLine(`Error: Please set keil root Path, ${err}`);
            window.showErrorMessage(`Error: Please set keil root Path, ${err}`);
        }
    });

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
