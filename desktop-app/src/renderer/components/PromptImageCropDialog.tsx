import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import s from './PromptImageCropDialog.module.scss';

const CROP_SIZE = 320;
const OUTPUT_SIZE = 512;
const MIN_ZOOM = 1;
const MAX_ZOOM = 3;

type Point = { x: number; y: number };
type ImageSize = { width: number; height: number };

type Props = {
  sourceUrl: string;
  onCancel: () => void;
  onConfirm: (image: { base64: string; mimeType: string; previewUrl: string }) => void;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function PromptImageCropDialog({ sourceUrl, onCancel, onConfirm }: Props) {
  const { t } = useTranslation();
  const imageRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{ pointerId: number; start: Point; origin: Point } | null>(null);
  const [imageSize, setImageSize] = useState<ImageSize | null>(null);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 });
  const [saving, setSaving] = useState(false);

  const baseScale = imageSize
    ? Math.max(CROP_SIZE / imageSize.width, CROP_SIZE / imageSize.height)
    : 1;

  const clampOffset = useCallback((point: Point, nextZoom = zoom): Point => {
    if (!imageSize) return { x: 0, y: 0 };
    const renderedWidth = imageSize.width * baseScale * nextZoom;
    const renderedHeight = imageSize.height * baseScale * nextZoom;
    const maxX = Math.max(0, (renderedWidth - CROP_SIZE) / 2);
    const maxY = Math.max(0, (renderedHeight - CROP_SIZE) / 2);
    return {
      x: clamp(point.x, -maxX, maxX),
      y: clamp(point.y, -maxY, maxY),
    };
  }, [baseScale, imageSize, zoom]);

  const changeZoom = useCallback((nextZoom: number) => {
    const clampedZoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
    setZoom(clampedZoom);
    setOffset(current => clampOffset(current, clampedZoom));
  }, [clampOffset]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onCancel]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!imageSize) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      origin: offset,
    };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setOffset(clampOffset({
      x: drag.origin.x + event.clientX - drag.start.x,
      y: drag.origin.y + event.clientY - drag.start.y,
    }));
  };

  const stopDragging = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  };

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    changeZoom(zoom - event.deltaY * 0.0015);
  };

  const handleConfirm = () => {
    const image = imageRef.current;
    if (!image || !imageSize || saving) return;
    setSaving(true);
    try {
      const effectiveScale = baseScale * zoom;
      const renderedWidth = imageSize.width * effectiveScale;
      const renderedHeight = imageSize.height * effectiveScale;
      const renderedLeft = (CROP_SIZE - renderedWidth) / 2 + offset.x;
      const renderedTop = (CROP_SIZE - renderedHeight) / 2 + offset.y;
      const sourceX = -renderedLeft / effectiveScale;
      const sourceY = -renderedTop / effectiveScale;
      const sourceSize = CROP_SIZE / effectiveScale;

      const canvas = document.createElement('canvas');
      canvas.width = OUTPUT_SIZE;
      canvas.height = OUTPUT_SIZE;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('canvas_unavailable');
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(
        image,
        sourceX,
        sourceY,
        sourceSize,
        sourceSize,
        0,
        0,
        OUTPUT_SIZE,
        OUTPUT_SIZE,
      );
      const previewUrl = canvas.toDataURL('image/png');
      onConfirm({
        base64: previewUrl.split(',')[1] || '',
        mimeType: 'image/png',
        previewUrl,
      });
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div className={s.overlay} onMouseDown={onCancel}>
      <div className={s.dialog} role="dialog" aria-modal="true" onMouseDown={event => event.stopPropagation()}>
        <div className={s.title}>{t('settings.prompt.imageCropTitle')}</div>
        <div className={s.help}>{t('settings.prompt.imageCropHelp')}</div>
        <div
          className={s.cropViewport}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={stopDragging}
          onPointerCancel={stopDragging}
          onWheel={handleWheel}
        >
          <img
            ref={imageRef}
            className={s.cropImage}
            src={sourceUrl}
            alt=""
            draggable={false}
            onLoad={event => {
              setImageSize({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              });
              setZoom(MIN_ZOOM);
              setOffset({ x: 0, y: 0 });
            }}
            style={imageSize ? {
              width: imageSize.width * baseScale * zoom,
              height: imageSize.height * baseScale * zoom,
              transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px))`,
            } : undefined}
          />
          <div className={s.cropFrame} />
        </div>
        <label className={s.zoomRow}>
          <span>{t('settings.prompt.imageCropZoom')}</span>
          <input
            type="range"
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            step={0.01}
            value={zoom}
            onChange={event => changeZoom(Number(event.target.value))}
          />
        </label>
        <div className={s.actions}>
          <button className={s.cancelButton} type="button" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button className={s.confirmButton} type="button" onClick={handleConfirm} disabled={!imageSize || saving}>
            {t('settings.prompt.imageCropApply')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
