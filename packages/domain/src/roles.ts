import { ForbiddenError } from "./errors.js";

/** 行程成員角色，由低到高。 */
export const TRIP_ROLES = ["viewer", "editor", "owner"] as const;
export type TripRole = (typeof TRIP_ROLES)[number];

/**
 * 請求來源。
 * - web / app：第一方 client
 * - mcp：外部 AI client（透過 MCP）
 * - ai_assistant：App 內 AI 助理（只會產生提案，不直接寫入）
 */
export const ACCESS_CHANNELS = ["web", "app", "mcp", "ai_assistant"] as const;
export type AccessChannel = (typeof ACCESS_CHANNELS)[number];

export const FIRST_PARTY_CHANNELS: ReadonlySet<AccessChannel> = new Set(["web", "app"]);

const ROLE_RANK: Record<TripRole, number> = { viewer: 0, editor: 1, owner: 2 };

export function hasRole(actual: TripRole | null | undefined, min: TripRole): boolean {
  return actual != null && ROLE_RANK[actual] >= ROLE_RANK[min];
}

/** 權限矩陣（PRD §3.3）。 */
export const TRIP_ACTIONS = {
  "trip.view": { minRole: "viewer", firstPartyOnly: false },
  "trip.update": { minRole: "editor", firstPartyOnly: false },
  "trip.delete": { minRole: "owner", firstPartyOnly: true },
  "trip.transferOwnership": { minRole: "owner", firstPartyOnly: true },
  "trip.publish": { minRole: "owner", firstPartyOnly: true },
  "item.create": { minRole: "editor", firstPartyOnly: false },
  "item.update": { minRole: "editor", firstPartyOnly: false },
  "item.move": { minRole: "editor", firstPartyOnly: false },
  "item.delete": { minRole: "editor", firstPartyOnly: false },
  "item.confirm": { minRole: "editor", firstPartyOnly: true },
  "item.unconfirm": { minRole: "editor", firstPartyOnly: true },
  "wishlist.edit": { minRole: "editor", firstPartyOnly: false },
  "attachment.upload": { minRole: "editor", firstPartyOnly: false },
  "journal.writeOwn": { minRole: "viewer", firstPartyOnly: false },
  "member.invite": { minRole: "editor", firstPartyOnly: true },
  "member.manage": { minRole: "owner", firstPartyOnly: true },
  "ai.chat": { minRole: "viewer", firstPartyOnly: true },
  "ai.applyProposal": { minRole: "editor", firstPartyOnly: true },
} as const satisfies Record<string, { minRole: TripRole; firstPartyOnly: boolean }>;

export type TripAction = keyof typeof TRIP_ACTIONS;

export interface AccessContext {
  /** 使用者在此行程的角色；不是成員時為 null。 */
  role: TripRole | null;
  via: AccessChannel;
}

export interface TripSettings {
  /** 檢視者是否可以寫自己的心得（PRD §3.3「可設定」）。預設 true。 */
  viewerCanWriteJournal?: boolean;
}

export function can(ctx: AccessContext, action: TripAction, settings: TripSettings = {}): boolean {
  const rule = TRIP_ACTIONS[action];
  if (rule.firstPartyOnly && !FIRST_PARTY_CHANNELS.has(ctx.via)) return false;
  // App 內 AI 只產生提案，任何寫入都不能以 ai_assistant 身分直接執行。
  if (ctx.via === "ai_assistant" && action !== "trip.view") return false;
  if (action === "journal.writeOwn" && ctx.role === "viewer") {
    return settings.viewerCanWriteJournal ?? true;
  }
  return hasRole(ctx.role, rule.minRole);
}

export function assertCan(ctx: AccessContext, action: TripAction, settings?: TripSettings): void {
  if (!can(ctx, action, settings)) {
    throw new ForbiddenError(`沒有權限執行 ${action}`);
  }
}

/** Owner 與 Editor 可邀請 editor / viewer；Viewer 不能邀請；owner 只能透過轉移擁有權產生。 */
export function canInviteAs(inviter: AccessContext, inviteeRole: TripRole): boolean {
  if (!can(inviter, "member.invite")) return false;
  if (inviteeRole === "owner") return false; // 擁有者只能透過轉移，不能邀請
  return true;
}
