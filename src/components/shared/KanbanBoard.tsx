import { useState } from 'react';

/**
 * Stage-column board shared by the Opportunities and Projects pipelines.
 *
 * Both pages had the same board: a horizontally scrolling row of w-80 columns,
 * a cyan drop-target ring, and the same dragStart/dragOver/dragLeave/drop quartet
 * persisting the move asynchronously. They differed only in mechanism -- the
 * opportunities board kept the whole dragged object in React state while the
 * projects board round-tripped an id through dataTransfer -- and in column chrome.
 *
 * The drag state lives here, so neither page needs its own `draggedX` /
 * `dragOverStage` pair. dataTransfer is still populated because some browsers
 * refuse to start a drag without it.
 *
 * Column chrome stays a prop rather than being standardised: the two boards
 * legitimately look different (projects columns are bare, opportunities columns
 * are a filled card with a footer), and forcing them identical would be a visual
 * change smuggled in under a refactor.
 *
 * Scrolling contract: the board is `h-full`, each column fills it, and only the card list
 * (`listClassName`, `flex-1 overflow-y-auto`) scrolls, so the stage header stays pinned above
 * it. That needs a definite height all the way down: the caller wraps the board in
 * `flex-1 min-h-0 overflow-x-auto` (the horizontal scroller for the columns row) inside a
 * flex column whose height is fixed -- ProjectsLayout / OpportunitiesLayout use
 * FILL_MAIN_HEIGHT_MD from layouts/appShell.ts. Without that, `h-full` resolves to auto and the
 * whole page scrolls instead. Native HTML5 drag and drop needs no scroll-container setup;
 * Chromium and Firefox auto-scroll an overflow container while a drag hovers near its edge.
 */
export function KanbanBoard<TStage, TItem>({
  stages,
  getStageId,
  getItems,
  getItemId,
  renderStageHeader,
  renderCard,
  renderStageFooter,
  onMove,
  canDragItem,
  columnClassName = '',
  dropRingClassName = 'ring-2 ring-hud-gold-soft',
  emptyLabel,
  listClassName = 'flex-1 overflow-y-auto p-2 space-y-2 min-h-[200px]',
}: {
  stages: TStage[];
  getStageId: (stage: TStage) => string;
  getItems: (stage: TStage) => TItem[];
  getItemId: (item: TItem) => string;
  renderStageHeader: (stage: TStage) => React.ReactNode;
  renderCard: (item: TItem, isDragging: boolean, stage: TStage) => React.ReactNode;
  renderStageFooter?: (stage: TStage) => React.ReactNode;
  /** Persist the move. Errors are the caller's to surface. */
  onMove: (itemId: string, toStageId: string, item: TItem) => void | Promise<void>;
  /** Items that fail this stay undraggable — e.g. an opportunity that is not open. */
  canDragItem: (item: TItem) => boolean;
  columnClassName?: string;
  dropRingClassName?: string;
  emptyLabel?: string;
  listClassName?: string;
}) {
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverStageId, setDragOverStageId] = useState<string | null>(null);

  function handleDragStart(e: React.DragEvent, item: TItem) {
    if (!canDragItem(item)) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', getItemId(item));
    setDraggedId(getItemId(item));
  }

  async function handleDrop(e: React.DragEvent, stage: TStage) {
    e.preventDefault();
    setDragOverStageId(null);
    const id = draggedId || e.dataTransfer.getData('text/plain');
    setDraggedId(null);
    if (!id) return;

    const item = stages.flatMap(getItems).find((i) => getItemId(i) === id);
    if (!item || !canDragItem(item)) return;
    await onMove(id, getStageId(stage), item);
  }

  return (
    <div className="flex gap-4 h-full min-w-max">
      {stages.map((stage) => {
        const stageId = getStageId(stage);
        const items = getItems(stage);

        return (
          <div
            key={stageId}
            className={`w-80 flex-shrink-0 flex flex-col transition-colors ${columnClassName} ${
              dragOverStageId === stageId ? dropRingClassName : ''
            }`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOverStageId(stageId);
            }}
            onDragLeave={() => setDragOverStageId(null)}
            onDrop={(e) => handleDrop(e, stage)}
          >
            {renderStageHeader(stage)}

            <div className={listClassName}>
              {items.map((item) => {
                const id = getItemId(item);
                const draggable = canDragItem(item);
                return (
                  <div
                    key={id}
                    draggable={draggable}
                    onDragStart={(e) => handleDragStart(e, item)}
                    onDragEnd={() => setDraggedId(null)}
                    className={draggable ? '' : 'cursor-not-allowed'}
                  >
                    {renderCard(item, draggedId === id, stage)}
                  </div>
                );
              })}
              {items.length === 0 && emptyLabel && (
                <div className="py-8 text-center">
                  <p className="text-xs text-hud-cream-mute">{emptyLabel}</p>
                </div>
              )}
            </div>

            {renderStageFooter?.(stage)}
          </div>
        );
      })}
    </div>
  );
}
