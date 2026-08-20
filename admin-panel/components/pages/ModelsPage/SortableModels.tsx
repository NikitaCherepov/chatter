import { useCallback, useState, type HTMLAttributes, type ReactNode } from 'react';
import {
  DndContext,
  DragOverlay,
  closestCenter,
  useDraggable,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import styles from './ModelsPage.module.css';

type WithId = { id: string };
type DragHandleProps = HTMLAttributes<HTMLButtonElement> & Record<string, unknown>;

/**
 * Single row that is both draggable and droppable on the same node
 * (same pattern as room participants in the desktop app).
 */
export function SortableModelRow({
  id,
  children,
}: {
  id: string;
  children: (dragHandleProps: DragHandleProps) => ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef: setDraggableRef,
    isDragging,
  } = useDraggable({
    id: `model-drag-${id}`,
    data: { id },
  });
  const { setNodeRef: setDroppableRef, isOver } = useDroppable({
    id: `model-drop-${id}`,
    data: { id },
  });

  return (
    <div
      ref={(node) => {
        setDraggableRef(node);
        setDroppableRef(node);
      }}
      className={[
        styles.sortableRow,
        isDragging ? styles.sortableRowDragging : '',
        isOver && !isDragging ? styles.sortableRowOver : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children({ ...attributes, ...listeners } as DragHandleProps)}
    </div>
  );
}

/** Compact clone of a card summary shown under the cursor while dragging. */
export function ModelOverlaySummary({
  order,
  title,
  subtitle,
}: {
  order: number;
  title: string;
  subtitle: string;
}) {
  return (
    <div className={styles.overlaySummary}>
      <span className={styles.order}>{order}</span>
      <span className={styles.modelTitle}>
        <strong>{title}</strong>
        <span>{subtitle}</span>
      </span>
    </div>
  );
}

/** Six-dot grip handle; listeners are attached here, not to the whole row. */
export function DragGrip({
  dragHandleProps,
  title,
}: {
  dragHandleProps: DragHandleProps;
  title: string;
}) {
  return (
    <button
      type="button"
      className={styles.dragHandle}
      title={title}
      {...dragHandleProps}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true">
        <circle cx="2.5" cy="3" r="1.4" />
        <circle cx="7.5" cy="3" r="1.4" />
        <circle cx="2.5" cy="8" r="1.4" />
        <circle cx="7.5" cy="8" r="1.4" />
        <circle cx="2.5" cy="13" r="1.4" />
        <circle cx="7.5" cy="13" r="1.4" />
      </svg>
    </button>
  );
}

/**
 * Drag-and-drop reorder for a list of models (PRO / LITE / Manual queues).
 * Owns one DndContext per list; reordering is a local splice — persistence
 * happens through the shared form save, same as the old up/down buttons.
 */
export function SortableModelsDnd<T extends WithId>({
  items,
  onReorder,
  renderOverlay,
  keyOf,
  children,
}: {
  items: T[];
  onReorder: (next: T[]) => void;
  renderOverlay: (activeItem: T, order: number) => ReactNode;
  /** Stable identity for keys/dnd ids (defaults to `item.id`). Use uniqueId when the server regenerates ids. */
  keyOf?: (item: T) => string;
  children: (item: T, index: number, dragHandleProps: DragHandleProps) => ReactNode;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeSize, setActiveSize] = useState<{ width: number; height: number } | null>(null);
  const getKey = keyOf ?? ((item: T) => item.id);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const id = (event.active.data.current as { id?: string } | undefined)?.id ?? null;
    const rect = event.active.rect.current.initial;
    setActiveId(id);
    setActiveSize(rect ? { width: rect.width, height: rect.height } : null);
  }, []);

  const handleDragCancel = useCallback(() => {
    setActiveId(null);
    setActiveSize(null);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveId(null);
      setActiveSize(null);
      const activeModelId = (event.active.data.current as { id?: string } | undefined)?.id;
      const overModelId = (event.over?.data.current as { id?: string } | undefined)?.id;
      if (!activeModelId || !overModelId || activeModelId === overModelId) return;
      const from = items.findIndex((item) => getKey(item) === activeModelId);
      const to = items.findIndex((item) => getKey(item) === overModelId);
      if (from < 0 || to < 0) return;
      const next = [...items];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      onReorder(next);
    },
    [items, onReorder, getKey],
  );

  const activeIndex = activeId ? items.findIndex((item) => getKey(item) === activeId) : -1;
  const activeItem = activeIndex >= 0 ? items[activeIndex] : null;

  return (
    <DndContext
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragCancel={handleDragCancel}
      onDragEnd={handleDragEnd}
    >
      {items.map((item, index) => {
        const key = getKey(item);
        return (
          <SortableModelRow key={key} id={key}>
            {(dragHandleProps) => children(item, index, dragHandleProps)}
          </SortableModelRow>
        );
      })}
      <DragOverlay zIndex={1000} dropAnimation={{ duration: 150, easing: 'ease-out' }}>
        {activeItem && (
          <div className={styles.sortableOverlay} style={activeSize ?? undefined}>
            {renderOverlay(activeItem, activeIndex + 1)}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
