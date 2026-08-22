'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../lib/api';
import type { ModelPrices } from '../../../lib/presetModels';
import { Select, type SelectOption } from '../Select/Select';
import {
  formatModelHint,
  pricingToModelPrices,
  type OpenRouterPricing,
} from './ModelInput.utils';

type Props = {
  value: string;
  onSelect: (
    modelId: string,
    prices: ModelPrices | null,
    supportsTools?: boolean,
  ) => void;
};

/**
 * Autocomplete input that searches OpenRouter models via the manager proxy
 * (/api/openrouter/models?q=...) and lets the user pick one. Shows modality
 * and context length hints under each option.
 */
export function OpenRouterModelInput({ value, onSelect }: Props) {
  const { t } = useTranslation();
  const [options, setOptions] = useState<SelectOption[]>([]);
  // Cache full pricing objects by model id so we don't refetch on every select.
  const pricingCacheRef = useRef<Map<string, ModelPrices | null>>(new Map());
  const toolSupportCacheRef = useRef<Map<string, boolean>>(new Map());
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSearch = useCallback((q: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const trimmed = q.trim();
    if (trimmed.length < 2) {
      setOptions([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      try {
        type ApiModel = {
          id?: string;
          name?: string;
          pricing?: OpenRouterPricing;
          architecture?: { modality?: string | null } | null;
          context_length?: number | null;
          supported_parameters?: string[];
        };
        const data = await api<{ data?: ApiModel[] }>(
          `/api/openrouter/models?q=${encodeURIComponent(trimmed)}`
        );
        const list = (data?.data || [])
          .map((m) => {
            // Stash pricing for instant use on select.
            if (m.id && m.pricing) {
              pricingCacheRef.current.set(m.id, pricingToModelPrices(m.pricing));
            }
            if (m.id && Array.isArray(m.supported_parameters)) {
              toolSupportCacheRef.current.set(
                m.id,
                m.supported_parameters.includes('tools'),
              );
            }
            return {
              value: m.id || '',
              label: m.name || m.id || '',
              hint: formatModelHint(m),
              badge:
                Array.isArray(m.supported_parameters) &&
                !m.supported_parameters.includes('tools')
                  ? {
                      text: t('models.manual.noTools'),
                      color: 'warning' as const,
                    }
                  : undefined,
            };
          })
          .filter((m) => m.value);
        setOptions(list);
      } catch {
        setOptions([]);
      }
    }, 400);
  }, [t]);

  const optionsWithCurrent = useMemo(() => {
    if (!value) return options;
    if (options.some((o) => o.value === value)) return options;
    return [{ value, label: value, hint: value }, ...options];
  }, [options, value]);

  const handleChange = (v: string) => {
    onSelect(
      v,
      pricingCacheRef.current.get(v) ?? null,
      toolSupportCacheRef.current.get(v),
    );
  };

  return (
    <Select
      options={optionsWithCurrent}
      value={value}
      onChange={handleChange}
      searchable
      onSearchChange={handleSearch}
      placeholder={t('models.billing.searchModelPlaceholder') || 'Search model…'}
      searchPlaceholder={t('models.billing.searchModelHint') || 'Type 2+ chars (e.g. deepseek)'}
      emptyText={t('models.billing.noModelsFound') || 'No models found'}
      maxVisibleItems={8}
      valueFallbackLabel={value || undefined}
    />
  );
}
