import { type Database, schema } from "@travelog/db";
import { dateInTimeZone } from "@travelog/domain";
import { and, eq, inArray, lt, ne } from "drizzle-orm";
import type { TripEvent, TripEvents } from "./events.js";

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

/** 送出推播；回傳已失效（應刪除）的權杖。 */
export interface PushSender {
  send(messages: PushMessage[]): Promise<{ invalidTokens: string[] }>;
}

export const noopPush: PushSender = {
  async send() {
    return { invalidTokens: [] };
  },
};

/** Expo Push API（https://docs.expo.dev/push-notifications/sending-notifications/）。 */
export function expoPush(opts: { accessToken?: string; fetch?: typeof fetch } = {}): PushSender {
  const doFetch = opts.fetch ?? fetch;
  return {
    async send(messages) {
      const invalidTokens: string[] = [];
      for (let i = 0; i < messages.length; i += 100) {
        const batch = messages.slice(i, i + 100);
        const res = await doFetch("https://exp.host/--/api/v2/push/send", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            ...(opts.accessToken ? { Authorization: `Bearer ${opts.accessToken}` } : {}),
          },
          body: JSON.stringify(batch.map((m) => ({ ...m, sound: "default" }))),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`Expo push 回應 ${res.status}`);
        const body = (await res.json()) as {
          data?: { status: string; details?: { error?: string } }[];
        };
        body.data?.forEach((r, j) => {
          if (r.status === "error" && r.details?.error === "DeviceNotRegistered") {
            invalidTokens.push(batch[j]?.to as string);
          }
        });
      }
      return { invalidTokens };
    },
  };
}

const ITEM_ACTIONS = /^item\.(created|updated|moved|deleted|confirmed|unconfirmed)$/;
const THROTTLE_MS = 15 * 60 * 1000;

/**
 * 依行程事件發推播給「其他」成員：
 * - 有人加入行程
 * - 行程進行中（行程時區的今天在行程日期內），有人改了行程點：同一趟行程每 15 分鐘最多一則
 */
export function startPushNotifier(deps: {
  db: Database;
  events: TripEvents;
  sender: PushSender;
  now: () => Date;
}) {
  /** 搶到這次送出的權利才回傳 true（多個執行個體只有一個會成功）。 */
  async function claim(key: string, throttled: boolean) {
    const now = deps.now();
    const insert = deps.db.insert(schema.pushDispatches).values({ key, sentAt: now });
    const rows = throttled
      ? await insert
          .onConflictDoUpdate({
            target: schema.pushDispatches.key,
            set: { sentAt: now },
            setWhere: lt(schema.pushDispatches.sentAt, new Date(now.getTime() - THROTTLE_MS)),
          })
          .returning()
      : await insert.onConflictDoNothing().returning();
    return rows.length > 0;
  }

  async function handle(e: TripEvent) {
    const joined = e.action === "member.joined";
    const itemChange = ITEM_ACTIONS.test(e.action);
    if (!joined && !itemChange) return;

    const [trip] = await deps.db.select().from(schema.trips).where(eq(schema.trips.id, e.tripId));
    if (!trip) return;
    if (itemChange) {
      const today = dateInTimeZone(deps.now(), trip.primaryTz);
      if (today < trip.startDate || today > trip.endDate) return;
    }
    if (!(await claim(itemChange ? `trip-items:${e.tripId}` : `activity:${e.id}`, itemChange)))
      return;

    const [actor] = e.actorId
      ? await deps.db
          .select({ name: schema.users.displayName })
          .from(schema.users)
          .where(eq(schema.users.id, e.actorId))
      : [];
    const who = e.via === "mcp" ? `${actor?.name ?? "某人"} 透過 AI` : (actor?.name ?? "某人");
    const recipients = await deps.db
      .select({ token: schema.pushTokens.token })
      .from(schema.tripMembers)
      .innerJoin(schema.pushTokens, eq(schema.pushTokens.userId, schema.tripMembers.userId))
      .where(
        and(
          eq(schema.tripMembers.tripId, e.tripId),
          e.actorId ? ne(schema.tripMembers.userId, e.actorId) : undefined,
        ),
      );
    if (recipients.length === 0) return;
    const body = joined ? `${who} 加入了行程` : `${who} 修改了行程，點開看看最新安排`;
    const { invalidTokens } = await deps.sender.send(
      recipients.map((r) => ({
        to: r.token,
        title: trip.title,
        body,
        data: {
          tripId: trip.id,
          path: itemChange ? `/trips/${trip.id}/today` : `/trips/${trip.id}`,
        },
      })),
    );
    if (invalidTokens.length) {
      await deps.db
        .delete(schema.pushTokens)
        .where(inArray(schema.pushTokens.token, invalidTokens));
    }
  }

  return deps.events.subscribeAll((e) => {
    handle(e).catch((err: unknown) => console.error("[push] 推播失敗", err));
  });
}
