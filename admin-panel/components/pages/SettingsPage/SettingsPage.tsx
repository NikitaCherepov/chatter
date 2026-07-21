'use client';

import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { LANGUAGE_LABELS, SUPPORTED_LANGUAGES } from '../../../i18n';
import { Card } from '../../ui/Card/Card';
import { FormField } from '../../ui/FormField/FormField';
import { Select, type SelectOption } from '../../ui/Select/Select';
import grid from '../../ui/PageGrid/PageGrid.module.css';
import styles from './SettingsPage.module.css';

export function SettingsPage() {
  const { t, i18n } = useTranslation();

  const languageOptions = useMemo<SelectOption[]>(() => {
    return SUPPORTED_LANGUAGES.map((code) => ({
      value: code,
      label: LANGUAGE_LABELS[code],
    }));
  }, []);

  const handleLanguageChange = useCallback(
    (code: string) => {
      i18n.changeLanguage(code);
      document.documentElement.lang = code;
    },
    [i18n],
  );

  return (
    <div className={styles.wrap}>
      <Card
        title={t('settings.languageTitle')}
        description={t('settings.languageDescription')}
      >
        <div className={grid.fields}>
          <FormField label={t('settings.languageLabel')}>
            <Select
              options={languageOptions}
              value={i18n.language}
              onChange={handleLanguageChange}
              searchable
              searchPlaceholder={t('ui.search')}
              emptyText={t('ui.nothingFound')}
            />
          </FormField>
        </div>
      </Card>
    </div>
  );
}
