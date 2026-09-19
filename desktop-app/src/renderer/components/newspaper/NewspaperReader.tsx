import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Select } from '../Select';
import { ImageViewerModal } from '../ImageViewerModal';
import { saveImageFile } from '../../lib/saveImageFile';
import { TemplateRenderer } from './templates/TemplateRenderer';
import { NewspaperImageViewerProvider } from './NewspaperImageViewerContext';
import { NewspaperStyleSelect, type NewspaperStyleOption } from './NewspaperStyleSelect/NewspaperStyleSelect';
import { BroadsheetCurlTransition } from './BroadsheetCurlTransition';
import { WizardBurnTransition } from './WizardBurnTransition';
import { NewspaperFocusTransition } from './NewspaperFocusTransition';
import { MassEffectPageTransition, type MassEffectPageTransitionState } from './MassEffectPageTransition';
import { NewspaperMaterialProvider, type NewspaperMaterial } from './NewspaperMaterialContext';
import { NewspaperMaterialRenderer } from './NewspaperMaterialRenderer';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { getMessages, getNewspaperChat, sendChatTrigger, subscribeRoomEvents, type NewspaperChatContext } from '../../lib/api';
import type { NewspaperIssue, NewspaperVisualStyle } from './types';
import s from './Newspaper.module.scss';

const ZOOM_MIN = 100;
const ZOOM_MAX = 150;
const ZOOM_STEP = 10;
const ZOOM_DEFAULT = 100;
const SHOW_READER_CHROME = false;

type PageTransition = {
  direction: 'previous' | 'next';
  phase: 'cover' | 'covered' | 'reveal';
  sourcePageNumber: number;
};

type WizardingTransition = {
  direction: PageTransition['direction'];
  phase: 'capturing' | 'holding' | 'waiting' | 'burning';
  sourcePageNumber: number;
  snapshot?: HTMLCanvasElement;
  left?: number;
  top?: number;
  width?: number;
  height?: number;
};

type BroadsheetTransition = {
  direction: PageTransition['direction'];
  phase: 'capturing' | 'holding' | 'waiting' | 'curling';
  sourcePageNumber: number;
  snapshot?: HTMLCanvasElement;
  left?: number;
  top?: number;
  width?: number;
  height?: number;
};

type FocusTransition = {
  kind: 'snapshot';
  direction: 'open' | 'close';
  phase: 'capturing' | 'holding' | 'waiting' | 'animating';
  target: NewspaperMaterial | null;
  snapshot?: HTMLCanvasElement;
  left?: number;
  top?: number;
  width?: number;
  height?: number;
} | {
  kind: 'buffer';
  direction: 'open' | 'close';
  phase: 'cover' | 'covered' | 'reveal';
  target: NewspaperMaterial | null;
};

type ReaderMessage = { id: string; role: 'assistant' | 'user'; text: string };

type Props = {
  issue: NewspaperIssue | null;
  sourceIssueId: number | null;
  style: NewspaperVisualStyle;
  pageNumber: number;
  pageCount: number;
  canGoPrevious: boolean;
  canGoNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
  onStyleChange: (style: NewspaperVisualStyle) => void;
  previousLabel: string;
  nextLabel: string;
  closeLabel: string;
};

const styleOptions: NewspaperStyleOption[] = [
  { value: 'wizarding', label: 'Волшебный таблоид', hint: 'Сенсации, пергамент и огромные заголовки' },
  { value: 'broadsheet', label: 'Большая газета', hint: 'Строгая многоколоночная первая полоса' },
  { value: 'deusEx', label: 'Deus Ex', hint: 'Picus: чёрный интерфейс и золото' },
  { value: 'massEffect', label: 'Mass Effect', hint: 'ANN: циан, оранжевый и HUD' },
];

export function NewspaperReader({ issue, sourceIssueId, style, pageNumber, pageCount, canGoPrevious, canGoNext, onPrevious, onNext, onClose, onStyleChange, previousLabel, nextLabel, closeLabel }: Props) {
  const { t } = useTranslation();
  const viewportRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; scrollLeft: number; scrollTop: number } | null>(null);
  const transitionLockRef = useRef(false);
  const materialIssueViewRef = useRef({ scrollLeft: 0, scrollTop: 0, zoom: ZOOM_DEFAULT });
  const [zoom, setZoom] = useState(ZOOM_DEFAULT);
  const [dragging, setDragging] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [viewerImage, setViewerImage] = useState<{ src: string; title?: string } | null>(null);
  const [pageTransition, setPageTransition] = useState<PageTransition | null>(null);
  const [massEffectTransition, setMassEffectTransition] = useState<MassEffectPageTransitionState | null>(null);
  const [wizardingTransition, setWizardingTransition] = useState<WizardingTransition | null>(null);
  const [broadsheetTransition, setBroadsheetTransition] = useState<BroadsheetTransition | null>(null);
  const [material, setMaterial] = useState<NewspaperMaterial | null>(null);
  const [focusTransition, setFocusTransition] = useState<FocusTransition | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatDraft, setChatDraft] = useState('');
  const [chatMessages, setChatMessages] = useState<ReaderMessage[]>([]);
  const [readerChatId, setReaderChatId] = useState<number | null>(null);
  const [chatBusy, setChatBusy] = useState(false);
  const [chatStreaming, setChatStreaming] = useState('');
  const chatRunSeenRef = useRef(false);
  const chatWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resetPageViewport = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollLeft = 0;
    viewport.scrollTop = 0;
  }, []);

  const navigatePage = useCallback(async (direction: PageTransition['direction']) => {
    if (!issue || material || transitionLockRef.current || pageTransition || massEffectTransition || wizardingTransition || broadsheetTransition || focusTransition) return;
    if (direction === 'previous' ? !canGoPrevious : !canGoNext) return;
    if (style === 'broadsheet') {
      const page = pageRef.current?.querySelector<HTMLElement>(':scope > article');
      const viewport = viewportRef.current;
      const dialog = dialogRef.current;
      if (!page || !viewport || !dialog) return;
      transitionLockRef.current = true;
      setBroadsheetTransition({ direction, phase: 'capturing', sourcePageNumber: pageNumber });
      try {
        const pageBounds = page.getBoundingClientRect();
        const viewportBounds = viewport.getBoundingClientRect();
        const dialogBounds = dialog.getBoundingClientRect();
        const left = Math.max(pageBounds.left, viewportBounds.left);
        const top = Math.max(pageBounds.top, viewportBounds.top);
        const right = Math.min(pageBounds.right, viewportBounds.right);
        const bottom = Math.min(pageBounds.bottom, viewportBounds.bottom);
        if (right <= left || bottom <= top) throw new Error('Broadsheet page is outside the viewport');
        const pixelRatio = window.devicePixelRatio || 1;
        const captureBounds = {
          x: Math.floor(left * pixelRatio),
          y: Math.floor(top * pixelRatio),
          width: Math.ceil(right * pixelRatio) - Math.floor(left * pixelRatio),
          height: Math.ceil(bottom * pixelRatio) - Math.floor(top * pixelRatio),
        };
        const capture = await window.electronAPI.capturePageRegion(captureBounds);
        const image = new Image();
        image.src = capture.dataUrl;
        await image.decode();
        const snapshot = document.createElement('canvas');
        snapshot.width = image.naturalWidth;
        snapshot.height = image.naturalHeight;
        const context = snapshot.getContext('2d');
        if (!context) throw new Error('Unable to create broadsheet snapshot canvas');
        context.drawImage(image, 0, 0);
        setBroadsheetTransition({
          direction,
          phase: 'holding',
          sourcePageNumber: pageNumber,
          snapshot,
          left: captureBounds.x / pixelRatio - dialogBounds.left,
          top: captureBounds.y / pixelRatio - dialogBounds.top,
          width: captureBounds.width / pixelRatio,
          height: captureBounds.height / pixelRatio,
        });
      } catch (error) {
        console.error('Failed to capture broadsheet newspaper page:', error);
        setBroadsheetTransition(null);
        transitionLockRef.current = false;
        resetPageViewport();
        if (direction === 'previous') onPrevious();
        else onNext();
      }
      return;
    }
    if (style === 'wizarding') {
      const page = pageRef.current;
      const viewport = viewportRef.current;
      const dialog = dialogRef.current;
      if (!page || !viewport || !dialog) return;
      transitionLockRef.current = true;
      setWizardingTransition({ direction, phase: 'capturing', sourcePageNumber: pageNumber });
      try {
        const bounds = viewport.getBoundingClientRect();
        const dialogBounds = dialog.getBoundingClientRect();
        const pixelRatio = window.devicePixelRatio || 1;
        const captureBounds = {
          x: Math.floor(bounds.left * pixelRatio),
          y: Math.floor(bounds.top * pixelRatio),
          width: Math.ceil(bounds.right * pixelRatio) - Math.floor(bounds.left * pixelRatio),
          height: Math.ceil(bounds.bottom * pixelRatio) - Math.floor(bounds.top * pixelRatio),
        };
        const capture = await window.electronAPI.capturePageRegion(captureBounds);
        const image = new Image();
        image.src = capture.dataUrl;
        await image.decode();
        const snapshot = document.createElement('canvas');
        snapshot.width = image.naturalWidth;
        snapshot.height = image.naturalHeight;
        const context = snapshot.getContext('2d');
        if (!context) throw new Error('Unable to create newspaper snapshot canvas');
        context.drawImage(image, 0, 0);
        setWizardingTransition({
          direction,
          phase: 'holding',
          sourcePageNumber: pageNumber,
          snapshot,
          left: captureBounds.x / pixelRatio - dialogBounds.left,
          top: captureBounds.y / pixelRatio - dialogBounds.top,
          width: captureBounds.width / pixelRatio,
          height: captureBounds.height / pixelRatio,
        });
      } catch (error) {
        console.error('Failed to capture wizarding newspaper page:', error);
        setWizardingTransition(null);
        transitionLockRef.current = false;
        resetPageViewport();
        if (direction === 'previous') onPrevious();
        else onNext();
      }
      return;
    }
    if (style === 'massEffect') {
      const viewport = viewportRef.current;
      setMassEffectTransition({
        direction,
        phase: 'waiting',
        sourcePageNumber: pageNumber,
        outgoingIssue: issue,
        scrollLeft: viewport?.scrollLeft ?? 0,
        scrollTop: viewport?.scrollTop ?? 0,
      });
      if (viewport) {
        viewport.scrollLeft = 0;
        viewport.scrollTop = 0;
      }
      if (direction === 'previous') onPrevious();
      else onNext();
      return;
    }
    if (style !== 'deusEx') {
      resetPageViewport();
      if (direction === 'previous') onPrevious();
      else onNext();
      return;
    }
    setPageTransition({ direction, phase: 'cover', sourcePageNumber: pageNumber });
  }, [broadsheetTransition, canGoNext, canGoPrevious, focusTransition, issue, massEffectTransition, material, onNext, onPrevious, pageNumber, pageTransition, resetPageViewport, style, wizardingTransition]);

  const focusMaterial = useCallback(async (target: NewspaperMaterial | null) => {
    if (!issue || pageTransition || massEffectTransition || wizardingTransition || broadsheetTransition || focusTransition) return;
    const viewport = viewportRef.current;
    const dialog = dialogRef.current;
    if (!viewport || !dialog) return;
    if (target && !material) {
      materialIssueViewRef.current = { scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop, zoom };
    }
    const direction = target ? 'open' : 'close';
    transitionLockRef.current = true;
    if (style === 'deusEx') {
      setFocusTransition({ kind: 'buffer', direction, phase: 'cover', target });
      return;
    }
    setFocusTransition({ kind: 'snapshot', direction, phase: 'capturing', target });
    try {
      const bounds = viewport.getBoundingClientRect();
      const dialogBounds = dialog.getBoundingClientRect();
      const pixelRatio = window.devicePixelRatio || 1;
      const captureBounds = {
        x: Math.floor(bounds.left * pixelRatio),
        y: Math.floor(bounds.top * pixelRatio),
        width: Math.ceil(bounds.right * pixelRatio) - Math.floor(bounds.left * pixelRatio),
        height: Math.ceil(bounds.bottom * pixelRatio) - Math.floor(bounds.top * pixelRatio),
      };
      const capture = await window.electronAPI.capturePageRegion(captureBounds);
      const image = new Image();
      image.src = capture.dataUrl;
      await image.decode();
      const snapshot = document.createElement('canvas');
      snapshot.width = image.naturalWidth;
      snapshot.height = image.naturalHeight;
      const context = snapshot.getContext('2d');
      if (!context) throw new Error('Unable to create material transition snapshot');
      context.drawImage(image, 0, 0);
      setFocusTransition({
        kind: 'snapshot',
        direction,
        phase: 'holding',
        target,
        snapshot,
        left: captureBounds.x / pixelRatio - dialogBounds.left,
        top: captureBounds.y / pixelRatio - dialogBounds.top,
        width: captureBounds.width / pixelRatio,
        height: captureBounds.height / pixelRatio,
      });
    } catch (error) {
      console.error('Failed to capture material transition:', error);
      setMaterial(target);
      setFocusTransition(null);
      transitionLockRef.current = false;
      requestAnimationFrame(() => {
        if (!viewportRef.current) return;
        viewportRef.current.scrollLeft = target ? 0 : materialIssueViewRef.current.scrollLeft;
        viewportRef.current.scrollTop = target ? 0 : materialIssueViewRef.current.scrollTop;
      });
    }
  }, [broadsheetTransition, focusTransition, issue, massEffectTransition, material, pageTransition, style, wizardingTransition, zoom]);

  useEffect(() => {
    if (!issue) {
      setViewerImage(null);
      setChatOpen(false);
      setChatMessages([]);
      setChatDraft('');
    }
    setMaterial(null);
    setFocusTransition(null);
    transitionLockRef.current = false;
  }, [issue?.id]);
  useEffect(() => {
    if (!issue) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (viewerImage) setViewerImage(null);
        else if (controlsOpen) setControlsOpen(false);
        else if (chatOpen) setChatOpen(false);
        else if (material) void focusMaterial(null);
        else onClose();
        return;
      }
      if (!material && event.key === 'ArrowLeft' && canGoPrevious) navigatePage('previous');
      if (!material && event.key === 'ArrowRight' && canGoNext) navigatePage('next');
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [canGoNext, canGoPrevious, chatOpen, controlsOpen, focusMaterial, issue, material, navigatePage, onClose, viewerImage]);
  useEffect(() => {
    if (!focusTransition || focusTransition.kind !== 'snapshot' || focusTransition.phase !== 'holding') return;
    let switchFrame = 0;
    const presentationFrame = requestAnimationFrame(() => {
      switchFrame = requestAnimationFrame(() => {
        setFocusTransition(current => current?.phase === 'holding' ? { ...current, phase: 'waiting' } : current);
        setMaterial(focusTransition.target);
      });
    });
    return () => {
      cancelAnimationFrame(presentationFrame);
      cancelAnimationFrame(switchFrame);
    };
  }, [focusTransition]);
  useLayoutEffect(() => {
    if (!focusTransition || focusTransition.kind !== 'snapshot' || focusTransition.phase !== 'waiting') return;
    const targetMatches = focusTransition.target
      ? material?.id === focusTransition.target.id && material.kind === focusTransition.target.kind
      : material === null;
    const viewport = viewportRef.current;
    if (!targetMatches || !viewport) return;
    viewport.scrollLeft = focusTransition.target ? 0 : materialIssueViewRef.current.scrollLeft;
    viewport.scrollTop = focusTransition.target ? 0 : materialIssueViewRef.current.scrollTop;
  }, [focusTransition, material]);
  useEffect(() => {
    if (!focusTransition || focusTransition.kind !== 'snapshot' || focusTransition.phase !== 'waiting') return;
    const targetMatches = focusTransition.target
      ? material?.id === focusTransition.target.id && material.kind === focusTransition.target.kind
      : material === null;
    if (!targetMatches) return;
    let restoreFrame = 0;
    const animationFrame = requestAnimationFrame(() => {
      restoreFrame = requestAnimationFrame(() => {
        setFocusTransition(current => current?.phase === 'waiting' ? { ...current, phase: 'animating' } : current);
      });
    });
    return () => {
      cancelAnimationFrame(animationFrame);
      cancelAnimationFrame(restoreFrame);
    };
  }, [focusTransition, material]);
  useEffect(() => {
    if (!focusTransition || focusTransition.kind !== 'snapshot' || focusTransition.phase !== 'animating') return;
    const failsafe = window.setTimeout(() => {
      transitionLockRef.current = false;
      setFocusTransition(null);
    }, 1250);
    return () => window.clearTimeout(failsafe);
  }, [focusTransition]);
  useEffect(() => {
    if (!focusTransition || focusTransition.kind !== 'buffer' || focusTransition.phase !== 'covered') return;
    const targetMatches = focusTransition.target
      ? material?.id === focusTransition.target.id && material.kind === focusTransition.target.kind
      : material === null;
    if (!targetMatches) return;
    const frame = requestAnimationFrame(() => {
      setFocusTransition(current => current?.kind === 'buffer' && current.phase === 'covered' ? { ...current, phase: 'reveal' } : current);
    });
    return () => cancelAnimationFrame(frame);
  }, [focusTransition, material]);
  useEffect(() => {
    if (!issue || style !== 'deusEx') setPageTransition(null);
  }, [issue, style]);
  useEffect(() => {
    if (!issue || style !== 'massEffect') setMassEffectTransition(null);
  }, [issue, style]);
  useEffect(() => {
    if (!issue || style !== 'wizarding') {
      setWizardingTransition(null);
      transitionLockRef.current = false;
    }
  }, [issue, style]);
  useEffect(() => {
    if (!issue || style !== 'broadsheet') {
      setBroadsheetTransition(null);
      transitionLockRef.current = false;
    }
  }, [issue, style]);
  useEffect(() => {
    if (!pageTransition || pageTransition.phase !== 'covered' || pageNumber === pageTransition.sourcePageNumber) return;
    const frame = requestAnimationFrame(() => {
      setPageTransition(current => current?.phase === 'covered' ? { ...current, phase: 'reveal' } : current);
    });
    return () => cancelAnimationFrame(frame);
  }, [pageNumber, pageTransition]);
  useEffect(() => {
    if (!massEffectTransition || massEffectTransition.phase !== 'waiting' || pageNumber === massEffectTransition.sourcePageNumber) return;
    const frame = requestAnimationFrame(() => {
      setMassEffectTransition(current => current?.phase === 'waiting' ? { ...current, phase: 'reveal' } : current);
    });
    return () => cancelAnimationFrame(frame);
  }, [massEffectTransition, pageNumber]);
  useEffect(() => {
    if (!wizardingTransition || wizardingTransition.phase !== 'holding') return;
    let navigationFrame = 0;
    const presentationFrame = requestAnimationFrame(() => {
      navigationFrame = requestAnimationFrame(() => {
        setWizardingTransition(current => current?.phase === 'holding' ? { ...current, phase: 'waiting' } : current);
        resetPageViewport();
        if (wizardingTransition.direction === 'previous') onPrevious();
        else onNext();
      });
    });
    return () => {
      cancelAnimationFrame(presentationFrame);
      cancelAnimationFrame(navigationFrame);
    };
  }, [onNext, onPrevious, resetPageViewport, wizardingTransition]);
  useEffect(() => {
    if (!broadsheetTransition || broadsheetTransition.phase !== 'holding') return;
    let navigationFrame = 0;
    const presentationFrame = requestAnimationFrame(() => {
      navigationFrame = requestAnimationFrame(() => {
        setBroadsheetTransition(current => current?.phase === 'holding' ? { ...current, phase: 'waiting' } : current);
        resetPageViewport();
        if (broadsheetTransition.direction === 'previous') onPrevious();
        else onNext();
      });
    });
    return () => {
      cancelAnimationFrame(presentationFrame);
      cancelAnimationFrame(navigationFrame);
    };
  }, [broadsheetTransition, onNext, onPrevious, resetPageViewport]);
  useEffect(() => {
    if (!wizardingTransition || wizardingTransition.phase !== 'waiting' || pageNumber === wizardingTransition.sourcePageNumber) return;
    const frame = requestAnimationFrame(() => {
      setWizardingTransition(current => current?.phase === 'waiting' ? { ...current, phase: 'burning' } : current);
    });
    return () => cancelAnimationFrame(frame);
  }, [pageNumber, wizardingTransition]);
  useEffect(() => {
    if (!broadsheetTransition || broadsheetTransition.phase !== 'waiting' || pageNumber === broadsheetTransition.sourcePageNumber) return;
    const frame = requestAnimationFrame(() => {
      setBroadsheetTransition(current => current?.phase === 'waiting' ? { ...current, phase: 'curling' } : current);
    });
    return () => cancelAnimationFrame(frame);
  }, [broadsheetTransition, pageNumber]);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!issue || !viewport) return;
    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      setZoom(current => {
        const direction = event.deltaY < 0 ? 1 : -1;
        const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, current + direction * ZOOM_STEP));
        if (next === current) return current;
        const rect = viewport.getBoundingClientRect();
        const pointerX = event.clientX - rect.left;
        const pointerY = event.clientY - rect.top;
        const scale = next / current;
        const nextLeft = (viewport.scrollLeft + pointerX) * scale - pointerX;
        const nextTop = (viewport.scrollTop + pointerY) * scale - pointerY;
        requestAnimationFrame(() => {
          viewport.scrollLeft = nextLeft;
          viewport.scrollTop = nextTop;
        });
        return next;
      });
    };
    viewport.addEventListener('wheel', handleWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', handleWheel);
  }, [issue]);

  const downloadViewerImage = useCallback(async () => {
    if (!viewerImage) return;
    try {
      if (await saveImageFile(viewerImage.src)) toast.success(t('chat.toasts.imageSaved'));
    } catch (error) {
      console.error('Failed to download newspaper image:', error);
      toast.error(t('chat.toasts.imageSaveFailed'));
    }
  }, [t, viewerImage]);

  const finishFocusTransition = useCallback(() => {
    transitionLockRef.current = false;
    setFocusTransition(null);
  }, []);

  // ── Reader chat (temporary newspaper chat) ────────────────────────────────
  // Context rows are model payload, not reader conversation — filtered out.
  const isAutomatedReaderContext = (text: string) =>
    text.startsWith('[ACTIVE_VIEW]') || text.startsWith('[NEWSPAPER CONTEXT');

  const loadReaderChat = useCallback(async (reloadHistory: boolean) => {
    try {
      const { chat_id } = await getNewspaperChat();
      setReaderChatId(current => current === chat_id ? current : chat_id);
      if (!reloadHistory) return;
      const { messages } = await getMessages(chat_id, 100);
      setChatMessages(messages
        .filter(message => !isAutomatedReaderContext(message.content))
        .map(message => ({ id: `msg-${message.id}`, role: message.role, text: message.content })));
    } catch (error) {
      console.error('Failed to load the newspaper chat:', error);
    }
  }, []);

  // Keep-alive: the periodic open refreshes the idle-TTL activity marker.
  useEffect(() => {
    if (!chatOpen) return;
    setChatBusy(false);
    setChatStreaming('');
    void loadReaderChat(true);
    const keepAlive = setInterval(() => { void loadReaderChat(false); }, 4 * 60 * 1000);
    return () => clearInterval(keepAlive);
  }, [chatOpen, loadReaderChat]);

  // Chat events for the reader chat; ChatPage ignores it via api.isNewspaperChat.
  useEffect(() => {
    return subscribeRoomEvents(event => {
      if (readerChatId === null || event.chat_id !== readerChatId) return;
      if (event.type === 'chat_agent_start') {
        chatRunSeenRef.current = true;
        setChatBusy(true);
        setChatStreaming('');
      } else if (event.type === 'chat_agent_token') {
        chatRunSeenRef.current = true;
        setChatBusy(true);
        setChatStreaming(current => current + event.text);
      } else if (event.type === 'chat_agent_done') {
        chatRunSeenRef.current = true;
        setChatBusy(false);
        setChatStreaming('');
        const text = `${event.result?.reply_text || ''}`.trim();
        if (text) setChatMessages(current => [...current, { id: `assistant-${Date.now()}`, role: 'assistant', text }]);
      } else if (event.type === 'chat_agent_error') {
        chatRunSeenRef.current = true;
        setChatBusy(false);
        setChatStreaming('');
        toast.error(event.message || 'Ответ не получен');
      }
    });
  }, [readerChatId]);

  useEffect(() => () => {
    if (chatWatchdogRef.current) clearTimeout(chatWatchdogRef.current);
  }, []);

  const sendReaderMessage = async () => {
    const text = chatDraft.trim();
    if (!text || !issue || sourceIssueId === null || chatBusy || readerChatId === null) return;
    // Send-time reading context: opened material, or current page.
    const page = issue as NewspaperIssue & { page_id?: string };
    const visibleBlocks = issue.document.blocks.map(block => ({
      block,
      sourceId: (block as typeof block & { source_id?: string }).source_id || block.id,
    }));
    const blockItemIds = Object.fromEntries(visibleBlocks
      .filter(({ block }) => block.type === 'notes_list')
      .map(({ block, sourceId }) => [
        sourceId,
        block.type === 'notes_list'
          ? block.items.map((item, index) =>
              (item as typeof item & { source_id?: string }).source_id || item.id || `${sourceId}-${index}`)
          : [],
      ]));
    const newspaperContext: NewspaperChatContext = material
      ? { issue_id: sourceIssueId, page: pageNumber, page_count: pageCount, page_id: page.page_id, block_id: material.id, block_kind: material.kind }
      : {
          issue_id: sourceIssueId,
          page: pageNumber,
          page_count: pageCount,
          page_id: page.page_id,
          block_ids: visibleBlocks.map(({ sourceId }) => sourceId),
          block_item_ids: blockItemIds,
        };
    setChatMessages(current => [...current, { id: `user-${Date.now()}`, role: 'user', text }]);
    setChatDraft('');
    setChatBusy(true);
    // Watchdog: unlock the composer if no run event arrives in time.
    chatRunSeenRef.current = false;
    if (chatWatchdogRef.current) clearTimeout(chatWatchdogRef.current);
    chatWatchdogRef.current = setTimeout(() => {
      if (chatRunSeenRef.current) return;
      setChatBusy(false);
      toast.error('Ответ не получен — попробуйте ещё раз');
    }, 45_000);
    try {
      const sent = await sendChatTrigger({ text, chatId: readerChatId, newspaperContext });
      if (!sent) {
        chatRunSeenRef.current = true;
        setChatBusy(false);
        toast.error('Не удалось отправить сообщение');
      }
    } catch (error) {
      chatRunSeenRef.current = true;
      setChatBusy(false);
      console.error('Failed to send the newspaper chat message:', error);
    }
  };

  const applyZoom = (value: number) => {
    const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(value / ZOOM_STEP) * ZOOM_STEP));
    setZoom(next);
  };
  const fitToWindow = () => {
    const viewport = viewportRef.current;
    const page = pageRef.current;
    if (!viewport || !page) return;
    const currentScale = zoom / 100;
    const rect = page.getBoundingClientRect();
    const naturalWidth = rect.width / currentScale;
    const naturalHeight = rect.height / currentScale;
    if (!naturalWidth || !naturalHeight) return;
    const scale = Math.min((viewport.clientWidth - 24) / naturalWidth, (viewport.clientHeight - 18) / naturalHeight);
    applyZoom(Math.floor(scale * 100 / ZOOM_STEP) * ZOOM_STEP);
  };
  const startDragging = (event: React.PointerEvent<HTMLDivElement>) => {
    if (massEffectTransition || wizardingTransition || broadsheetTransition || focusTransition) return;
    if (event.button !== 0 || (event.target as HTMLElement).closest('a, button, input, textarea, select, [role="button"], [role="link"], [data-clickable="true"]')) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
    };
    viewport.setPointerCapture(event.pointerId);
    setDragging(true);
  };
  const moveDragging = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const viewport = viewportRef.current;
    if (!drag || !viewport || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    viewport.scrollLeft = drag.scrollLeft - (event.clientX - drag.x);
    viewport.scrollTop = drag.scrollTop - (event.clientY - drag.y);
  };
  const stopDragging = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const viewport = viewportRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (viewport?.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    dragRef.current = null;
    setDragging(false);
  };
  const completePageTransitionStep = () => {
    if (!pageTransition) return;
    if (pageTransition.phase === 'cover') {
      setPageTransition({ ...pageTransition, phase: 'covered' });
      resetPageViewport();
      if (pageTransition.direction === 'previous') onPrevious();
      else onNext();
      return;
    }
    if (pageTransition.phase === 'reveal') setPageTransition(null);
  };
  const completeFocusBufferStep = () => {
    if (!focusTransition || focusTransition.kind !== 'buffer') return;
    if (focusTransition.phase === 'cover') {
      setFocusTransition({ ...focusTransition, phase: 'covered' });
      setMaterial(focusTransition.target);
      requestAnimationFrame(() => {
        if (!viewportRef.current) return;
        viewportRef.current.scrollLeft = focusTransition.target ? 0 : materialIssueViewRef.current.scrollLeft;
        viewportRef.current.scrollTop = focusTransition.target ? 0 : materialIssueViewRef.current.scrollTop;
      });
      return;
    }
    if (focusTransition.phase === 'reveal') {
      transitionLockRef.current = false;
      setFocusTransition(null);
    }
  };

  return createPortal(<AnimatePresence>{issue && <motion.div key="newspaper-reader" className={s.backdrop} initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} onMouseDown={() => controlsOpen ? setControlsOpen(false) : onClose()}><motion.div ref={dialogRef} className={s.dialog} initial={{opacity:0,y:20,scale:.985}} animate={{opacity:1,y:0,scale:1}} exit={{opacity:0,y:14,scale:.99}} onMouseDown={event=>{ event.stopPropagation(); if (controlsOpen && !(event.target as HTMLElement).closest('[data-reader-controls]')) setControlsOpen(false); }} role="dialog" aria-modal="true">
    <AnimatePresence initial={false} mode="wait">{!controlsOpen ? <motion.button
      key="reader-handle"
      type="button"
      className={s.readerHandle}
      data-style={style}
      data-reader-controls
      aria-label="Настройки выпуска"
      aria-expanded="false"
      aria-controls="newspaper-reader-controls"
      initial={{ opacity: 0, x: 44 }}
      animate={{ opacity: 1, x: 0 }}
      whileHover={{ x: -8 }}
      exit={{ opacity: 0, x: 52 }}
      transition={{ duration: .18, ease: 'easeOut' }}
      onClick={() => setControlsOpen(true)}
    ><span className={s.readerHandleGlyph}>{style === 'deusEx' ? 'SYS' : style === 'massEffect' ? 'MENU' : style === 'wizarding' ? 'МЕНЮ' : 'EDIT'}</span></motion.button> : <motion.aside
      key="reader-panel"
      id="newspaper-reader-controls"
      className={s.readerPanel}
      data-style={style}
      data-reader-controls
      initial={{ opacity: 0, x: 280 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 280 }}
      transition={{ duration: .24, ease: [0.22, 1, 0.36, 1] }}
    >
      <header className={s.readerPanelHeader}><div><span>ISSUE CONTROL</span><strong>Выпуск №{issue.issue_number}</strong></div><small>{pageNumber} / {pageCount}</small></header>
      <div className={s.readerControlGroup}><span>Стиль</span><NewspaperStyleSelect options={styleOptions} value={style} onChange={onStyleChange}/></div>
      <div className={s.readerControlGroup}><span>Масштаб</span><div className={s.readerZoomRow}><button type="button" onClick={()=>applyZoom(zoom-ZOOM_STEP)} disabled={zoom<=ZOOM_MIN}>−</button><strong>{zoom}%</strong><button type="button" onClick={()=>applyZoom(zoom+ZOOM_STEP)} disabled={zoom>=ZOOM_MAX}>+</button></div></div>
      <div className={s.readerPanelActions}><button type="button" className={s.readerClose} onClick={() => setControlsOpen(false)}>{closeLabel}</button></div>
    </motion.aside>}</AnimatePresence>
    <AnimatePresence initial={false}>
      {(material || canGoPrevious) && <motion.button
        key="reader-previous"
        type="button"
        className={`${s.readerPageTab} ${s.readerPageTabPrevious}${material ? ` ${s.readerMaterialBack}` : ''}`}
        data-style={style}
        data-reader-controls
        aria-label={material ? t('tools.newspapers.backToIssue') : previousLabel}
        initial={{ opacity: 0, x: 46 }}
        animate={{ opacity: 1, x: 0 }}
        whileHover={{ x: -8 }}
        whileTap={{ scale: .96 }}
        exit={{ opacity: 0, x: 46 }}
        transition={{ duration: .18, ease: 'easeOut' }}
        onClick={() => { if (material) void focusMaterial(null); else navigatePage('previous'); }}
      ><span className={s.readerPageTabContent}><b>‹</b><small>{material ? (style === 'deusEx' ? 'ISSUE' : style === 'massEffect' ? 'FEED' : 'В выпуск') : (style === 'deusEx' ? 'PREV' : style === 'massEffect' ? 'BACK' : 'Назад')}</small></span></motion.button>}
      {!material && canGoNext && <motion.button
        key="reader-next"
        type="button"
        className={`${s.readerPageTab} ${s.readerPageTabNext}`}
        data-style={style}
        data-reader-controls
        aria-label={nextLabel}
        initial={{ opacity: 0, x: -46 }}
        animate={{ opacity: 1, x: 0 }}
        whileHover={{ x: 8 }}
        whileTap={{ scale: .96 }}
        exit={{ opacity: 0, x: -46 }}
        transition={{ duration: .18, ease: 'easeOut' }}
        onClick={() => navigatePage('next')}
      ><span className={s.readerPageTabContent}><b>›</b><small>{style === 'deusEx' ? 'NEXT' : style === 'massEffect' ? 'FWD' : 'Вперёд'}</small></span></motion.button>}
    </AnimatePresence>
    <AnimatePresence initial={false} mode="wait">{!chatOpen ? <motion.button
      key="reader-chat-handle"
      type="button"
      className={s.readerChatHandle}
      data-style={style}
      aria-label="Открыть разговор с аналитиком"
      aria-expanded="false"
      initial={{ opacity: 0, x: 44 }}
      animate={{ opacity: 1, x: 0 }}
      whileHover={{ x: -8 }}
      exit={{ opacity: 0, x: 52 }}
      transition={{ duration: .18, ease: 'easeOut' }}
      onClick={() => setChatOpen(true)}
    ><span>{style === 'deusEx' ? 'ANALYST' : style === 'massEffect' ? 'ASK EDI' : 'ОБСУДИТЬ'}</span></motion.button> : <motion.aside
      key="reader-chat-panel"
      className={s.readerChatPanel}
      data-style={style}
      initial={{ opacity: 0, x: 350 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 350 }}
      transition={{ duration: .24, ease: [0.22, 1, 0.36, 1] }}
    >
      <header><div><span>{style === 'deusEx' ? 'PICUS // ANALYST' : style === 'massEffect' ? 'ANN // ASSIST' : 'Разговор с редакцией'}</span><strong>{material?.title || issue.document.title}</strong></div><button type="button" className={s.readerChatClose} onClick={() => setChatOpen(false)}>Закрыть</button></header>
      <div className={s.readerChatMessages}>{chatMessages.map(message => <div key={message.id} data-role={message.role}>{message.role === 'assistant' ? <MarkdownRenderer content={message.text} className={s.readerMarkdown}/> : message.text}</div>)}{chatBusy && <div data-role="assistant" data-streaming={chatStreaming ? undefined : 'pending'}><MarkdownRenderer content={chatStreaming || '…'} className={s.readerMarkdown}/></div>}</div>
      <form onSubmit={event => { event.preventDefault(); void sendReaderMessage(); }}><textarea value={chatDraft} onChange={event => setChatDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendReaderMessage(); } }} placeholder={material ? 'Спросить об этом материале…' : 'Спросить об этом выпуске…'} rows={3} disabled={readerChatId === null}/><button type="submit" disabled={!chatDraft.trim() || chatBusy || readerChatId === null}>Отправить</button></form>
    </motion.aside>}</AnimatePresence>
    {SHOW_READER_CHROME && <header className={s.toolbar}><div className={s.issueMeta}><strong>Выпуск №{issue.issue_number}</strong><span>{pageNumber} / {pageCount}</span></div><div className={s.styleSelect}><Select options={styleOptions} value={style} onChange={value=>onStyleChange(value as NewspaperVisualStyle)} maxVisibleItems={4}/></div><div className={s.toolbarActions}><div className={s.zoomControls}><button type="button" onClick={()=>applyZoom(zoom-ZOOM_STEP)} disabled={zoom<=ZOOM_MIN} aria-label="Уменьшить масштаб">−</button><button type="button" className={s.zoomValue} onClick={fitToWindow} title="Вписать газету в окно">{zoom}%</button><button type="button" onClick={()=>applyZoom(zoom+ZOOM_STEP)} disabled={zoom>=ZOOM_MAX} aria-label="Увеличить масштаб">+</button></div><nav className={s.navigation}><button type="button" onClick={onPrevious} disabled={!canGoPrevious} aria-label={previousLabel}>‹</button><button type="button" onClick={onNext} disabled={!canGoNext} aria-label={nextLabel}>›</button><button type="button" onClick={onClose} aria-label={closeLabel}>×</button></nav></div></header>}
    <div className={`${s.viewport} ${dragging ? s.viewportDragging : ''}`} data-style={style} ref={viewportRef} onPointerDown={startDragging} onPointerMove={moveDragging} onPointerUp={stopDragging} onPointerCancel={stopDragging} onDragStart={event=>event.preventDefault()}>
      <motion.div ref={pageRef} className={s.zoomLayer} style={{zoom:zoom/100} as React.CSSProperties} key={`${issue.id}-${style}-${material ? `${material.kind}-${material.id}` : 'issue'}`} initial={false}><NewspaperImageViewerProvider onOpen={(src, title) => setViewerImage({ src, title })}><NewspaperMaterialProvider onOpen={nextMaterial => focusMaterial(nextMaterial)}>{material ? <NewspaperMaterialRenderer material={material} issue={issue} style={style}/> : <TemplateRenderer issue={issue} style={style}/>}</NewspaperMaterialProvider></NewspaperImageViewerProvider></motion.div>
      <MassEffectPageTransition transition={massEffectTransition} zoom={zoom} onComplete={() => setMassEffectTransition(null)}/>
    </div>
    {wizardingTransition?.snapshot && <WizardBurnTransition
      snapshot={wizardingTransition.snapshot}
      left={wizardingTransition.left ?? 0}
      top={wizardingTransition.top ?? 0}
      width={wizardingTransition.width ?? wizardingTransition.snapshot.width}
      height={wizardingTransition.height ?? wizardingTransition.snapshot.height}
      running={wizardingTransition.phase === 'burning'}
      onComplete={() => {
        transitionLockRef.current = false;
        setWizardingTransition(null);
      }}
    />}
    {broadsheetTransition?.snapshot && <BroadsheetCurlTransition
      snapshot={broadsheetTransition.snapshot}
      direction={broadsheetTransition.direction}
      left={broadsheetTransition.left ?? 0}
      top={broadsheetTransition.top ?? 0}
      width={broadsheetTransition.width ?? broadsheetTransition.snapshot.width}
      height={broadsheetTransition.height ?? broadsheetTransition.snapshot.height}
      running={broadsheetTransition.phase === 'curling'}
      onComplete={() => {
        transitionLockRef.current = false;
        setBroadsheetTransition(null);
      }}
    />}
    {focusTransition?.kind === 'snapshot' && focusTransition.snapshot && style === 'wizarding' && <WizardBurnTransition
      snapshot={focusTransition.snapshot}
      left={focusTransition.left ?? 0}
      top={focusTransition.top ?? 0}
      width={focusTransition.width ?? focusTransition.snapshot.width}
      height={focusTransition.height ?? focusTransition.snapshot.height}
      running={focusTransition.phase === 'animating'}
      onComplete={finishFocusTransition}
    />}
    {focusTransition?.kind === 'snapshot' && focusTransition.snapshot && style === 'broadsheet' && <BroadsheetCurlTransition
      snapshot={focusTransition.snapshot}
      direction={focusTransition.direction === 'open' ? 'next' : 'previous'}
      left={focusTransition.left ?? 0}
      top={focusTransition.top ?? 0}
      width={focusTransition.width ?? focusTransition.snapshot.width}
      height={focusTransition.height ?? focusTransition.snapshot.height}
      running={focusTransition.phase === 'animating'}
      onComplete={finishFocusTransition}
    />}
    {focusTransition?.kind === 'snapshot' && focusTransition.snapshot && style !== 'wizarding' && style !== 'broadsheet' && <NewspaperFocusTransition
      snapshot={focusTransition.snapshot}
      style={style}
      direction={focusTransition.direction}
      left={focusTransition.left ?? 0}
      top={focusTransition.top ?? 0}
      width={focusTransition.width ?? focusTransition.snapshot.width}
      height={focusTransition.height ?? focusTransition.snapshot.height}
      running={focusTransition.phase === 'animating'}
      onComplete={finishFocusTransition}
    />}
    <AnimatePresence>{focusTransition?.kind === 'buffer' && <motion.div
      key="deus-material-transition"
      className={s.deusPageTransition}
      data-direction={focusTransition.direction === 'open' ? 'next' : 'previous'}
      data-phase={focusTransition.phase}
      initial={{ scaleX: 0 }}
      animate={{ scaleX: focusTransition.phase === 'reveal' ? 0 : 1 }}
      exit={{ opacity: 0 }}
      style={{ transformOrigin: focusTransition.phase === 'reveal'
        ? (focusTransition.direction === 'open' ? 'left center' : 'right center')
        : (focusTransition.direction === 'open' ? 'right center' : 'left center') }}
      transition={{ duration: focusTransition.phase === 'covered' ? 0 : .34, ease: [0.76, 0, 0.24, 1] }}
      onAnimationComplete={completeFocusBufferStep}
    ><span>{focusTransition.direction === 'open' ? 'DISPLAY BUFFER // OPENING FILE' : 'DISPLAY BUFFER // RESTORING ISSUE'}</span></motion.div>}</AnimatePresence>
    <AnimatePresence>{pageTransition && <motion.div
      key="deus-page-transition"
      className={s.deusPageTransition}
      data-direction={pageTransition.direction}
      data-phase={pageTransition.phase}
      initial={{ scaleX: 0 }}
      animate={{ scaleX: pageTransition.phase === 'reveal' ? 0 : 1 }}
      exit={{ opacity: 0 }}
      style={{ transformOrigin: pageTransition.phase === 'reveal'
        ? (pageTransition.direction === 'next' ? 'left center' : 'right center')
        : (pageTransition.direction === 'next' ? 'right center' : 'left center') }}
      transition={{ duration: pageTransition.phase === 'covered' ? 0 : .34, ease: [0.76, 0, 0.24, 1] }}
      onAnimationComplete={completePageTransitionStep}
    ><span>DISPLAY BUFFER // REFRESHING</span></motion.div>}</AnimatePresence>
  </motion.div></motion.div>}
  {viewerImage && <ImageViewerModal key="newspaper-image-viewer" src={viewerImage.src} alt={viewerImage.title} downloadLabel={t('common.download')} closeLabel={t('common.close')} onClose={() => setViewerImage(null)} onDownload={() => void downloadViewerImage()} aboveNewspaper/>}</AnimatePresence>, document.body);
}
