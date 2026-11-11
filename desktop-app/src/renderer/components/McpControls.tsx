import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { McpApprovalPolicy } from '../../main/local-mcp-spec';
import type { McpTool } from '../lib/mcp-service';
import { AnimatedDetails } from './AnimatedDisclosure';
import { Icon } from './Icon';
import s from './SettingsModal.module.scss';
import styles from './McpSettings.module.scss';
import switches from './MemoryPopover.module.scss';

export function McpToggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label?: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className={styles.toggleRow}>
      <div className={styles.toggleText}>
        {label && <span id={id}>{label}</span>}
        {hint && <small id={id + '-hint'}>{hint}</small>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={label ? id : undefined}
        aria-describedby={hint ? id + '-hint' : undefined}
        disabled={disabled}
        className={`${switches.toggle} ${checked ? switches.toggleActive : ''}`}
        onClick={() => onChange(!checked)}
      >
        <span />
      </button>
    </div>
  );
}

export function McpTools({
  tools,
  selected,
  eagerByDefault,
  modeExceptions = [],
  approval,
  disabled,
  saveSelected,
  saveModeExceptions,
  saveApproval,
}: {
  tools: McpTool[];
  selected: string[] | null;
  eagerByDefault: boolean;
  modeExceptions?: string[];
  approval: McpApprovalPolicy;
  disabled: boolean;
  saveSelected: (selected: string[] | null) => void;
  saveModeExceptions: (names: string[]) => void;
  saveApproval: (patch: Partial<McpApprovalPolicy>) => void;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const filtered = tools.filter((tool) =>
    (tool.name + ' ' + (tool.description || ''))
      .toLowerCase()
      .includes(search.toLowerCase().trim()),
  );
  const enabledCount = tools.filter(
    (tool) => selected === null || selected.includes(tool.name),
  ).length;
  return (
    <AnimatedDetails
      className={styles.details}
      summary={
        <>
          <Icon name="terminal" size={14} />
          {t('mcp.tools')}
          <span className={styles.meta}>
            {enabledCount} / {tools.length}
          </span>
        </>
      }
    >
      <div className={styles.detailBody}>
        <div className={styles.toolsToolbar}>
          <input
            className={s.fieldInput}
            aria-label={t('mcp.design.searchTools')}
            placeholder={t('mcp.design.searchTools')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <button className={s.cancelBtn} disabled={disabled} onClick={() => saveSelected(null)}>
            {t('mcp.allTools')}
          </button>
          <button className={s.cancelBtn} disabled={disabled} onClick={() => saveSelected([])}>
            {t('mcp.noTools')}
          </button>
        </div>
        {filtered.map((tool) => {
          const available = selected === null || selected.includes(tool.name);
          return (
            <div className={styles.toolItem} key={tool.name}>
              <div className={styles.toolInfo}>
                <strong>{tool.name}</strong>
                {tool.description && <p>{tool.description}</p>}
              </div>
              <div className={styles.toolSwitches}>
                <McpToggle
                  label={t('mcp.design.available')}
                  checked={available}
                  disabled={disabled}
                  onChange={(checked) => {
                    const next = new Set(selected ?? tools.map((item) => item.name));
                    if (checked) next.add(tool.name);
                    else next.delete(tool.name);
                    saveSelected([...next]);
                  }}
                />
                <McpToggle
                  label={t('mcp.design.alwaysIncludeTool')}
                  checked={available && (eagerByDefault !== modeExceptions.includes(tool.name))}
                  disabled={disabled || !available}
                  onChange={(checked) => {
                    const next = new Set(modeExceptions);
                    if (checked !== eagerByDefault) next.add(tool.name);
                    else next.delete(tool.name);
                    saveModeExceptions([...next]);
                  }}
                />
                <McpToggle
                  label={t('mcp.approvals.withoutConfirmation')}
                  checked={approval.allow_all || approval.tools.includes(tool.name)}
                  disabled={disabled || approval.allow_all}
                  onChange={(checked) =>
                    saveApproval({
                      tools: checked
                        ? [...new Set([...approval.tools, tool.name])]
                        : approval.tools.filter((name) => name !== tool.name),
                    })
                  }
                />
              </div>
            </div>
          );
        })}
        {!filtered.length && <p className={styles.empty}>{t('mcp.design.noToolsFound')}</p>}
      </div>
    </AnimatedDetails>
  );
}
