import * as vscode from 'vscode';
import type { MetadataNode } from '../../tree/TreeNode';
import type { CommandServices } from '../_shared';

export function registerShowPropertiesCommand(
  context: vscode.ExtensionContext,
  services: CommandServices
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('onecdev.openPropertiesView', () => services.propertiesViewProvider.reveal()),
    vscode.commands.registerCommand('onecdev.showProperties', (node: MetadataNode | undefined) =>
      services.propertiesViewProvider.reveal(node)
    ),
    vscode.commands.registerCommand('onecdev.openSubsystemEditor', (node: MetadataNode | undefined) => {
      if (node?.nodeKind !== 'Subsystem') {
        return;
      }
      services.subsystemEditorViewProvider.show(node.textLabel, node.xmlPath ?? '');
    })
  );
}
