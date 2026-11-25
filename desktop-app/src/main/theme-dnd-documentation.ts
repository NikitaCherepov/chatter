export const THEME_DND_GUIDE = `# Drag and drop

React themes may import @dnd-kit/core, @dnd-kit/sortable, @dnd-kit/modifiers and
@dnd-kit/utilities. These are the same core/modifier/utility packages used by the native app,
plus the sortable helper package. Exact installed versions are in libraries.json. One optional
local bundle shares React and dnd-kit contexts across all four packages. No installation is
needed in a theme. Only these package roots are supported, not internal package subpaths.

Use DndContext/useDraggable/useDroppable/DragOverlay from core for free placement or drop zones.
Use SortableContext/useSortable/arrayMove from sortable for lists and grids. Utilities supplies
CSS.Transform.toString; modifiers supplies constraints such as restrictToWindowEdges or
restrictToVerticalAxis. These are data/hooks, not required cards or layouts. The theme owns all
markup, styles, drag handles, overlays, animation choices and state updates.

## Interaction rules

- Use stable IDs, not array positions. Put listeners/attributes on a dedicated, labelled drag
  handle and setActivatorNodeRef on it. Keep row buttons, inputs, links and text selection usable.
- Give pointer activation a small distance threshold; limit touch-action:none to drag handles
  so the rest of a long list remains scrollable.
- Supply a KeyboardSensor with sortableKeyboardCoordinates for sortable lists. Space starts
  and finishes a keyboard drag, arrows move it and Escape cancels. Localize handle labels and
  announcements/instructions when needed; core accepts accessibility configuration.
- In a sortable list pass items in the same order you render them. Apply arrayMove after a valid
  drop. On cancellation or a missing/removed destination keep the previous order. Use the
  appropriate sorting strategy for list/grid and DragOverlay for complex scrolling containers.
- Respect useThemeEffects().active when adding decorative drop transitions. Functional dragging
  must continue to work when visual effects are disabled.

## Actions and persistence

dnd-kit changes the theme's local UI state only. It does not persist chat order, move a chat to
a folder or save app configuration by itself. To move a chat into a folder call the existing
chat/folder SDK operation after a valid drop and handle its busy/error result. Use real chat and
folder IDs, permissions and available actions from the app; do not invent new bridge commands.
For theme-local sorting decide whether transient order is enough; persistent app actions require
an existing supported API. A drag inside the isolated theme cannot cross into the native UI or
serve as an OS file import. See media.md for attachment selection/paste.

examples/dnd/SortableList.tsx is a small reusable example with pointer/keyboard support and a
separate handle. It emits the reordered list to its parent and has no forced styling or storage.
`;

export const THEME_DND_EXAMPLES: Record<string, string> = {
  'SortableList.tsx': `import React from 'react';
import {DndContext,closestCenter,PointerSensor,KeyboardSensor,useSensor,useSensors,type DragEndEvent} from '@dnd-kit/core';
import {SortableContext,useSortable,arrayMove,verticalListSortingStrategy,sortableKeyboardCoordinates} from '@dnd-kit/sortable';
import {restrictToVerticalAxis} from '@dnd-kit/modifiers';
import {CSS} from '@dnd-kit/utilities';
import {useThemeEffects} from '@chatter/ui';

type Item={id:string;label:string};
function Row({item,handleLabel}:{item:Item;handleLabel:string}){
  const effects=useThemeEffects();
  const {setNodeRef,setActivatorNodeRef,attributes,listeners,transform,transition,isDragging}=useSortable({id:item.id,transition:effects.active?undefined:null});
  return <li ref={setNodeRef} data-item={item.id} style={{transform:CSS.Transform.toString(transform),transition,position:'relative',zIndex:isDragging?1:undefined}}>
    <button type="button" ref={setActivatorNodeRef} {...attributes} {...listeners} data-drag-handle={item.id}
      aria-label={handleLabel} style={{touchAction:'none'}}>↕</button>
    <span>{item.label}</span>
  </li>;
}
export function SortableList({items,onReorder,handleLabel}:{items:Item[];onReorder:(items:Item[])=>void;handleLabel:(item:Item)=>string}){
  const sensors=useSensors(useSensor(PointerSensor,{activationConstraint:{distance:6}}),useSensor(KeyboardSensor,{coordinateGetter:sortableKeyboardCoordinates}));
  const end=({active,over}:DragEndEvent)=>{
    if(!over||active.id===over.id)return;
    const from=items.findIndex(item=>item.id===active.id),to=items.findIndex(item=>item.id===over.id);
    if(from>=0&&to>=0)onReorder(arrayMove(items,from,to));
  };
  return <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[restrictToVerticalAxis]} onDragEnd={end}>
    <SortableContext items={items.map(item=>item.id)} strategy={verticalListSortingStrategy}>
      <ul>{items.map(item=><Row key={item.id} item={item} handleLabel={handleLabel(item)}/>)}</ul>
    </SortableContext>
  </DndContext>;
}
`,
};
