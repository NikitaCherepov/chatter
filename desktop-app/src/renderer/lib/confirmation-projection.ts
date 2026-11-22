import React, { type ReactNode } from 'react';
import type { AppearanceConfirmationNode, AppearanceConfirmationField, AppearanceConfirmationAction } from '../../main/appearance-shell-types';

type FieldValue = string | boolean;
export type ConfirmationProjection = {
  content: AppearanceConfirmationNode[];
  fields: AppearanceConfirmationField[];
  actions: AppearanceConfirmationAction[];
  customizable: boolean;
  commands: Map<string, (comment?: string) => void | Promise<void>>;
  changes: Map<string, (value: FieldValue) => void>;
};

/** Project the same React props/callbacks used by the native card; no DOM scraping or second approval implementation. */
export function projectConfirmation(
  body: ReactNode,
  groups: { primary: ReactNode; permissions?: ReactNode; review?: ReactNode },
  labels: { reject: string; rejectWithComment: string },
  busy: boolean,
): ConfirmationProjection {
  const result: ConfirmationProjection = { content: [], fields: [], actions: [], customizable: true, commands: new Map(), changes: new Map() };
  const text = (node: ReactNode): string => React.Children.toArray(node).map(child => {
    if (typeof child === 'string' || typeof child === 'number') return String(child);
    if (!React.isValidElement<any>(child)) return '';
    return child.props['aria-label'] ?? child.props.label ?? text(child.props.children);
  }).join(' ').trim();
  const addAction = (id: string, label: string, disabled: boolean, group: AppearanceConfirmationAction['group'], command: (comment?: string) => void | Promise<void>, comment = false) => {
    result.actions.push({ id, label, disabled: busy || disabled, group, comment });
    result.commands.set(id, command);
    return { type: 'action' as const, actionId: id };
  };
  const walk = (nodes: ReactNode, path: string, group: AppearanceConfirmationAction['group'] = 'content', fieldLabel = ''): AppearanceConfirmationNode[] =>
    React.Children.toArray(nodes).flatMap((node, index): AppearanceConfirmationNode[] => {
      const id = path + '-' + index;
      if (typeof node === 'string' || typeof node === 'number') return [{ type: 'text', text: String(node) }];
      if (!React.isValidElement<any>(node)) return [];
      const props = node.props;
      if (node.type === 'svg' || props['aria-hidden'] === true) return [];
      if (['img', 'iframe', 'video', 'audio', 'canvas', 'object', 'embed'].includes(node.type as string)) {
        result.customizable = false;
        return [];
      }
      if (typeof props.onReject === 'function') return [
        addAction(id + '-reject', labels.reject, Boolean(props.disabled), group, () => props.onReject('')),
        addAction(id + '-comment', labels.rejectWithComment, Boolean(props.disabled), group, comment => props.onReject(comment?.trim() ?? ''), true),
      ];
      if (typeof props.submit === 'function' && typeof props.label === 'string')
        return [addAction(id, props.label, Boolean(props.disabled), group, () => props.submit(true, props.remember))];
      if (node.type === 'button' && typeof props.onClick === 'function')
        return [addAction(id, text(node) || String(props.title ?? ''), Boolean(props.disabled), group,
          () => props.onClick({ preventDefault() {}, stopPropagation() {} }))];
      if (node.type === 'a' && typeof props.href === 'string') {
        if (!/^https?:\/\//i.test(props.href)) { result.customizable = false; return []; }
        return [addAction(id, text(node) || props.href, false, group, () => { window.open(props.href, '_blank', 'noopener,noreferrer'); })];
      }
      if (node.type === 'input' || node.type === 'textarea' || node.type === 'select'
          || (typeof props.onChange === 'function' && Array.isArray(props.options))) {
        const kind = node.type === 'textarea' ? 'textarea' : node.type === 'select' || props.options ? 'select' : props.type ?? 'text';
        if (!['text', 'password', 'checkbox', 'textarea', 'select', 'number', 'url', 'email'].includes(kind)) { result.customizable = false; return []; }
        const options = props.options?.map((item: any) => ({ value: String(item.value ?? item), label: String(item.label ?? item.value ?? item) }))
          ?? (node.type === 'select' ? React.Children.toArray(props.children).filter(React.isValidElement).map((item: any) => ({ value: String(item.props.value), label: text(item) })) : undefined);
        result.fields.push({ id, label: props['aria-label'] ?? props.placeholder ?? fieldLabel, type: kind,
          value: kind === 'checkbox' ? Boolean(props.checked) : String(props.value ?? props.defaultValue ?? ''),
          disabled: busy || Boolean(props.disabled || props.readOnly || typeof props.onChange !== 'function'), ...(options ? { options } : {}) });
        if (typeof props.onChange === 'function') result.changes.set(id, value => {
          if (kind === 'checkbox' ? typeof value !== 'boolean' : typeof value !== 'string') throw new Error('confirmation_invalid_field');
          if (options && !options.some((item: any) => item.value === value)) throw new Error('confirmation_invalid_field');
          const target = { value, checked: value, name: props.name, type: kind };
          props.onChange(node.type === 'input' || node.type === 'textarea' || node.type === 'select' ? { target, currentTarget: target } : value);
        });
        return [{ type: 'field', fieldId: id }];
      }
      if (typeof props.oldContent === 'string' && typeof props.newContent === 'string')
        return [{ type: 'diff', before: props.oldContent, after: props.newContent }];
      if (typeof props.content === 'string') return [{ type: 'markdown', text: props.content }];
      if (typeof props.body === 'string') return [{ type: 'email', text: props.body }];
      if (props.assessment) return [{ type: 'json', text: JSON.stringify(props.assessment, null, 2) }];
      if (props.profile && typeof props.profile.name === 'string') return [{ type: 'json', text: JSON.stringify({
        name: props.profile.name, light: props.profile.light, dark: props.profile.dark, typography: props.profile.typography,
        geometry: props.profile.geometry, materials: props.profile.materials,
      }, null, 2) }];
      if (props.children !== undefined) {
        if (node.type === 'pre' || node.type === 'code') return [{ type: 'code', text: text(props.children) }];
        return [{ type: 'group', ...(props.summary ? { label: text(props.summary) } : {}),
          children: walk(props.children, id, group, node.type === 'label' ? text(props.children) : fieldLabel) }];
      }
      // Decorative components do not carry decision information.
      if (typeof props.name === 'string' && (props.size !== undefined || props.width !== undefined)) return [];
      if (node.type === 'br' || node.type === 'hr') return [{ type: 'text', text: '\n' }];
      if (typeof node.type !== 'string') result.customizable = false;
      return [];
    });
  result.content = walk(body, 'body');
  const withoutActions = (nodes: AppearanceConfirmationNode[]): AppearanceConfirmationNode[] => nodes.flatMap((node): AppearanceConfirmationNode[] => {
    if (node.type === 'action') return [];
    if (node.type !== 'group') return [node];
    const children = withoutActions(node.children);
    return children.length ? [{ ...node, children }] : [];
  });
  for (const group of ['primary', 'review', 'permissions'] as const)
    result.content.push(...withoutActions(walk(groups[group], group, group)));
  return result;
}
