"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { confirmedLabel, itemTypeMeta } from "@/lib/items";
import { formatTime } from "@/lib/time";
import type { Item } from "@/lib/types";
import { File, Grip, Pushpin } from "../icons";
import { cx } from "../ui";

export function ItemCard({
  item,
  n,
  canEdit,
  onOpen,
  travelHint,
}: {
  item: Item;
  n: number;
  canEdit: boolean;
  onOpen: () => void;
  travelHint?: string | undefined;
}) {
  const sortable = useSortable({ id: item.id, disabled: !canEdit || item.confirmed });
  const style = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
  };
  const meta = itemTypeMeta(item.type);
  const time = formatTime(item.startAt, item.tz);
  const end = formatTime(item.endAt, item.tz);

  return (
    <li
      ref={sortable.setNodeRef}
      style={style}
      className={cx("flex flex-col", sortable.isDragging && "relative z-10 opacity-80")}
    >
      <div className="flex items-stretch gap-3.5">
        <div className="flex w-13 flex-none flex-col items-end gap-0.5 pt-3.5">
          <span className="text-[15px] font-bold">{time}</span>
          <span className="text-xs text-muted">{end}</span>
        </div>
        <div
          className={cx(
            "flex min-w-0 flex-1 items-start gap-3 rounded-xl border px-3.5 py-3",
            item.confirmed ? "border-pin-line bg-pin-bg" : "border-line bg-white",
          )}
        >
          {canEdit && !item.confirmed ? (
            <button
              type="button"
              aria-label={`拖拉調整「${item.title}」的順序`}
              className="mt-1 w-4 flex-none cursor-grab touch-none text-[#8a94a3] active:cursor-grabbing"
              {...sortable.attributes}
              {...sortable.listeners}
            >
              <Grip className="size-3.5" />
            </button>
          ) : (
            <span className="w-4 flex-none" />
          )}
          <span
            className={cx(
              "flex size-7 flex-none items-center justify-center rounded-full text-[13px] font-bold text-white",
              item.confirmed ? "bg-pin" : "bg-navy",
            )}
          >
            {n}
          </span>
          <button
            type="button"
            onClick={onOpen}
            className="flex min-w-0 flex-1 flex-col items-start gap-1 text-left"
          >
            <span className="flex flex-wrap items-center gap-2">
              <strong className="text-base">{item.title}</strong>
              <span className={cx("rounded-md px-2 py-0.5 text-xs font-semibold", meta.chip)}>
                {meta.label}
              </span>
              {item.confirmed && (
                <span className="rounded-md bg-pin-chip px-2 py-0.5 text-xs font-bold text-pin-ink">
                  {confirmedLabel(item.booking?.kind, item.confirmSource)}
                </span>
              )}
            </span>
            {(item.place || item.notes) && (
              <span className="text-sm leading-relaxed text-muted">
                {item.place?.name && item.place.name !== item.title ? `${item.place.name}・` : ""}
                {item.notes}
              </span>
            )}
            {item.booking?.confirmationCode && (
              <span className="mt-0.5 flex items-center gap-1.5 rounded-md bg-canvas px-2.5 py-1 text-[13px] text-ink-soft">
                <File className="size-3.5" />
                訂位代號 {item.booking.confirmationCode}
              </span>
            )}
          </button>
          {item.confirmed && (
            <span
              title="已釘選，不能更動時間、地點與順序"
              className="flex size-8 flex-none items-center justify-center rounded-md bg-pin-chip text-pin"
            >
              <Pushpin />
              <span className="sr-only">已釘選</span>
            </span>
          )}
        </div>
      </div>
      {travelHint && (
        <div className="flex min-h-9 items-center gap-3.5">
          <div className="w-13 flex-none" />
          <div className="ml-[27px] self-stretch border-l-2 border-dashed border-line-strong" />
          <span className="text-[13px] text-muted">{travelHint}</span>
        </div>
      )}
    </li>
  );
}
