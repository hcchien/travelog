"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Attachments } from "@/components/attachments";
import { ApiError, api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { BOOKING_KINDS, BOOKING_STATUSES, confirmedLabel, ITEM_TYPES } from "@/lib/items";
import { keys, useSavedForTrip } from "@/lib/queries";
import { isoToZoned, offsetFromTaipei, zonedToIso } from "@/lib/time";
import type {
  BookingKind,
  BookingStatus,
  Item,
  ItemType,
  Place,
  TripDetail,
  Warning,
} from "@/lib/types";
import { Pushpin } from "../icons";
import { PlaceSearch } from "../place-search";
import { useToast } from "../toast";
import { Button, Dialog, Field, Input, Select, Textarea } from "../ui";

interface Props {
  trip: TripDetail;
  /** 編輯既有行程點；省略時為新增。 */
  item?: Item | null;
  dayId: string | null;
  open: boolean;
  onClose: () => void;
  onSaved: (warnings?: Warning[]) => void;
  canEdit: boolean;
}

const typeFromCategory = (c: Place["category"]): ItemType =>
  c === "food" || c === "cafe"
    ? "food"
    : c === "stay"
      ? "stay"
      : c === "shopping"
        ? "activity"
        : "sight";

function addDays(date: string, n: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function ItemDialog(props: Props) {
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={props.item ? "行程點" : "新增行程點"}
      wide
    >
      {props.open && <ItemForm key={props.item?.id ?? "new"} {...props} />}
    </Dialog>
  );
}

function ItemForm({ trip, item, dayId, onClose, onSaved, canEdit }: Props) {
  const toast = useToast();
  const qc = useQueryClient();
  const { me } = useAuth();
  const savedPlaces = useSavedForTrip(trip.id);
  const day = trip.days.find((d) => d.id === (item?.dayId ?? dayId));
  const date = day?.date ?? trip.startDate;
  const locked = !!item?.confirmed;
  const readOnly = !canEdit;

  const [type, setType] = useState<ItemType>(item?.type ?? "sight");
  const [typeTouched, setTypeTouched] = useState(!!item);
  const [title, setTitle] = useState(item?.title ?? "");
  const [notes, setNotes] = useState(item?.notes ?? "");
  const [place, setPlace] = useState<Place | null>(item?.place ?? null);
  const tz = item?.tz ?? place?.tz ?? trip.primaryTz;
  const [start, setStart] = useState(item?.startAt ? isoToZoned(item.startAt, tz).time : "");
  const [end, setEnd] = useState(item?.endAt ? isoToZoned(item.endAt, tz).time : "");
  const [withBooking, setWithBooking] = useState(!!item?.booking);
  const [kind, setKind] = useState<BookingKind>(item?.booking?.kind ?? "other");
  const [status, setStatus] = useState<BookingStatus>(item?.booking?.status ?? "planned");
  const [code, setCode] = useState(item?.booking?.confirmationCode ?? "");
  const [unconfirmReason, setUnconfirmReason] = useState<"reschedule" | "cancel" | "other" | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const base = `/v1/trips/${trip.id}/items`;

  function times() {
    const startAt = start ? zonedToIso(date, start, tz) : null;
    let endAt = end ? zonedToIso(date, end, tz) : null;
    // 結束時間比開始早，視為隔天（例如夜間航班）
    if (startAt && endAt && endAt < startAt) endAt = zonedToIso(addDays(date, 1), end, tz);
    return { startAt, endAt };
  }

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      if (e instanceof ApiError && e.status === 412)
        setError("這個行程點剛被其他人修改，請關閉後重新開啟");
      else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const save = () =>
    run(async () => {
      if (!item) {
        const res = await api<{ item: Item; warnings: Warning[] }>("POST", base, {
          body: {
            dayId,
            type,
            title: title.trim() || place?.name || "",
            notes: notes || null,
            ...times(),
            ...(place ? { googlePlaceId: place.googlePlaceId } : {}),
            ...(withBooking ? { booking: { kind, status, confirmationCode: code || null } } : {}),
          },
        });
        onSaved(res.warnings);
        return;
      }
      const patch: Record<string, unknown> = {};
      if (title !== item.title) patch.title = title;
      if ((notes || null) !== item.notes) patch.notes = notes || null;
      if (!locked) {
        const t = times();
        if (type !== item.type) patch.type = type;
        if (t.startAt !== item.startAt) patch.startAt = t.startAt;
        if (t.endAt !== item.endAt) patch.endAt = t.endAt;
        if ((place?.googlePlaceId ?? null) !== (item.place?.googlePlaceId ?? null)) {
          patch.googlePlaceId = place?.googlePlaceId ?? null;
        }
      }
      let warnings: Warning[] = [];
      if (Object.keys(patch).length > 0) {
        const res = await api<{ warnings: Warning[] }>("PATCH", `${base}/${item.id}`, {
          body: patch,
          ifMatch: item.version,
        });
        warnings = res.warnings;
      }
      if (withBooking && !item.booking) {
        await api("POST", `${base}/${item.id}/booking`, {
          body: { kind, status, confirmationCode: code || null },
        });
      } else if (item.booking) {
        const b: Record<string, unknown> = {};
        if (status !== item.booking.status) b.status = status;
        if ((code || null) !== item.booking.confirmationCode) b.confirmationCode = code || null;
        if (Object.keys(b).length > 0)
          await api("PATCH", `${base}/${item.id}/booking`, { body: b });
      }
      onSaved(warnings);
    });

  const confirm = () =>
    run(async () => {
      await api("POST", `${base}/${item?.id}/confirm`);
      toast("已釘選這個行程點");
      onSaved();
    });

  const unconfirm = () =>
    run(async () => {
      await api("POST", `${base}/${item?.id}/unconfirm`, { body: { reason: unconfirmReason } });
      toast("已解除確定");
      onSaved();
    });

  const remove = () =>
    run(async () => {
      if (!window.confirm(`確定要刪除「${item?.title}」？`)) return;
      await api("DELETE", `${base}/${item?.id}`);
      onSaved();
    });

  const savedEntry = place
    ? savedPlaces.data?.find((s) => s.place.googlePlaceId === place.googlePlaceId)
    : undefined;

  const saveToLibrary = (rating?: number | null) =>
    run(async () => {
      if (!place) return;
      try {
        await api("POST", "/v1/me/saved-places", {
          body: {
            googlePlaceId: place.googlePlaceId,
            ...(rating !== undefined ? { rating } : {}),
          },
        });
        void qc.invalidateQueries({ queryKey: keys.saved });
        void qc.invalidateQueries({ queryKey: keys.savedForTrip(trip.id) });
        toast(
          rating != null
            ? `已把「${place.name}」存到我的地點並評為 ${rating}★`
            : `已把「${place.name}」存到我的地點`,
        );
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          const existingId = (e.body as { savedPlaceId?: string }).savedPlaceId ?? savedEntry?.id;
          if (existingId && rating !== undefined) {
            await api("PATCH", `/v1/me/saved-places/${existingId}`, { body: { rating } });
            void qc.invalidateQueries({ queryKey: keys.saved });
            void qc.invalidateQueries({ queryKey: keys.savedForTrip(trip.id) });
            toast(
              rating === null
                ? `已清除「${place.name}」的評分`
                : `已將「${place.name}」評為 ${rating}★`,
            );
            return;
          }
          toast("這個地點已經在你的地點庫裡");
        } else throw e;
      }
    });

  const disabled = readOnly || busy;
  return (
    <div className="flex flex-col gap-4">
      {locked && (
        <div className="flex items-start gap-3 rounded-xl border border-pin-line bg-pin-bg px-4 py-3 text-sm text-pin-ink">
          <Pushpin className="mt-0.5 size-4 flex-none text-pin" />
          <span>
            <strong>{confirmedLabel(item?.booking?.kind, item?.confirmSource ?? null)}</strong>
            ：日期、時間、地點與順序都不能更動。需要改期或取消時，請先解除確定。
          </span>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
        <Field label="名稱">
          {(id) => (
            <Input
              id={id}
              value={title}
              disabled={disabled}
              maxLength={200}
              placeholder={place?.name ?? "例如：清水寺"}
              onChange={(e) => setTitle(e.target.value)}
            />
          )}
        </Field>
        <Field label="類型">
          {(id) => (
            <Select
              id={id}
              value={type}
              disabled={disabled || locked}
              onChange={(e) => {
                setType(e.target.value as ItemType);
                setTypeTouched(true);
              }}
            >
              {ITEM_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-semibold text-ink-soft">地點</span>
        {place ? (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-canvas px-3 py-2.5">
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex items-center gap-2">
                <strong className="text-[15px]">{place.name}</strong>
                {savedEntry?.rating != null && (
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-xs font-semibold ${
                      savedEntry.rating <= 2
                        ? "bg-red-100 text-danger"
                        : "bg-amber-100 text-amber-800"
                    }`}
                  >
                    {savedEntry.rating <= 2
                      ? `⚠️ ${savedEntry.rating}★ 避雷`
                      : `${savedEntry.rating}★`}
                  </span>
                )}
              </div>
              <span className="truncate text-xs text-muted">{place.address}</span>
            </div>
            <fieldset className="flex items-center gap-1" aria-label="地點評分">
              {[1, 2, 3, 4, 5].map((n) => {
                const cur = savedEntry?.rating ?? null;
                const active = cur !== null && n <= cur;
                return (
                  <button
                    key={n}
                    type="button"
                    disabled={busy}
                    aria-label={`評為 ${n} 顆星`}
                    onClick={() => saveToLibrary(cur === n ? null : n)}
                    className={`text-base leading-none ${
                      active
                        ? cur !== null && cur <= 2
                          ? "text-danger"
                          : "text-amber-500"
                        : "text-line-strong hover:text-amber-400"
                    }`}
                  >
                    ★
                  </button>
                );
              })}
            </fieldset>
            {place.googleMapsUri && (
              <a
                href={place.googleMapsUri}
                target="_blank"
                rel="noreferrer"
                className="text-sm font-semibold text-brand"
              >
                地圖
              </a>
            )}
            <button
              type="button"
              onClick={() => saveToLibrary()}
              disabled={busy}
              className="text-sm font-semibold text-brand"
            >
              {savedEntry ? "已收藏" : "存到我的地點"}
            </button>
            {!locked && !readOnly && (
              <button type="button" onClick={() => setPlace(null)} className="text-sm text-muted">
                移除
              </button>
            )}
          </div>
        ) : (
          !readOnly && (
            <PlaceSearch
              placeholder="搜尋地點（選填）"
              onPick={(p) => {
                setPlace(p);
                if (!title) setTitle(p.name);
                if (!typeTouched) setType(typeFromCategory(p.category));
              }}
            />
          )
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="開始時間" hint={`${tz}，${offsetFromTaipei(tz)}`}>
          {(id) => (
            <Input
              id={id}
              type="time"
              value={start}
              disabled={disabled || locked}
              onChange={(e) => setStart(e.target.value)}
            />
          )}
        </Field>
        <Field label="結束時間">
          {(id) => (
            <Input
              id={id}
              type="time"
              value={end}
              disabled={disabled || locked}
              onChange={(e) => setEnd(e.target.value)}
            />
          )}
        </Field>
      </div>

      <Field label="備註">
        {(id) => (
          <Textarea
            id={id}
            value={notes}
            disabled={disabled}
            maxLength={5000}
            onChange={(e) => setNotes(e.target.value)}
          />
        )}
      </Field>

      <fieldset className="flex flex-col gap-3 rounded-xl border border-line px-4 py-3">
        <legend className="px-1 text-[13px] font-semibold text-ink-soft">訂位</legend>
        {!withBooking ? (
          !readOnly && (
            <button
              type="button"
              onClick={() => setWithBooking(true)}
              className="self-start text-sm font-semibold text-brand"
            >
              ＋ 加上訂位資訊（機票、住宿、餐廳…）
            </button>
          )
        ) : (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="種類">
              {(id) => (
                <Select
                  id={id}
                  value={kind}
                  disabled={disabled || !!item?.booking}
                  onChange={(e) => setKind(e.target.value as BookingKind)}
                >
                  {BOOKING_KINDS.map((k) => (
                    <option key={k.value} value={k.value}>
                      {k.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="狀態" hint={status === "booked" ? "已訂位會自動釘選" : undefined}>
              {(id) => (
                <Select
                  id={id}
                  value={status}
                  disabled={disabled || (locked && item?.confirmSource === "booking")}
                  onChange={(e) => setStatus(e.target.value as BookingStatus)}
                >
                  {BOOKING_STATUSES.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="訂位代號">
              {(id) => (
                <Input
                  id={id}
                  value={code}
                  disabled={disabled}
                  maxLength={80}
                  onChange={(e) => setCode(e.target.value)}
                />
              )}
            </Field>
          </div>
        )}
      </fieldset>

      {item && (
        <Attachments
          tripId={trip.id}
          itemId={item.id}
          canEdit={canEdit}
          myUserId={me?.id}
          isOwner={trip.myRole === "owner"}
        />
      )}

      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      {!readOnly && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
          {item && !locked && (
            <>
              <Button variant="danger" size="sm" onClick={remove} disabled={busy}>
                刪除
              </Button>
              <Button variant="secondary" size="sm" onClick={confirm} disabled={busy}>
                <Pushpin className="size-3.5" />
                設為確定
              </Button>
            </>
          )}
          {item && locked && (
            <div className="flex flex-wrap items-center gap-2">
              <Select
                aria-label="解除確定的原因"
                className="h-9 w-auto text-sm"
                value={unconfirmReason ?? ""}
                onChange={(e) =>
                  setUnconfirmReason((e.target.value || null) as typeof unconfirmReason)
                }
              >
                <option value="">解除確定…</option>
                <option value="reschedule">改期</option>
                <option value="cancel">取消</option>
                <option value="other">其他原因</option>
              </Select>
              {unconfirmReason && (
                <Button variant="danger" size="sm" onClick={unconfirm} disabled={busy}>
                  確認解除
                </Button>
              )}
            </div>
          )}
          <span className="flex-1" />
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button onClick={save} disabled={busy || (!title.trim() && !place)}>
            {item ? "儲存" : "新增"}
          </Button>
        </div>
      )}
    </div>
  );
}
