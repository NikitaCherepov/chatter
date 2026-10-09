import type { ContextMenuParams } from 'electron';

export type TextMenuAction = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll';
export type TextMenuItem = { action: TextMenuAction; enabled: boolean; separator?: boolean };

export function getTextMenuItems(params: Pick<ContextMenuParams, 'isEditable' | 'selectionText' | 'editFlags'>): TextMenuItem[] {
  const flags = params.editFlags;
  if (!params.isEditable) {
    return params.selectionText.length > 0 ? [{ action: 'copy', enabled: flags.canCopy }] : [];
  }
  return [
    { action: 'undo', enabled: flags.canUndo },
    { action: 'redo', enabled: flags.canRedo },
    { action: 'cut', enabled: flags.canCut, separator: true },
    { action: 'copy', enabled: flags.canCopy },
    { action: 'paste', enabled: flags.canPaste },
    { action: 'selectAll', enabled: flags.canSelectAll, separator: true },
  ];
}
