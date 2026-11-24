import { describe, expect, it } from "vitest";
import { ForbiddenError } from "../src/errors.js";
import { type AccessContext, assertCan, can, canInviteAs, hasRole } from "../src/roles.js";

const web = (role: AccessContext["role"]): AccessContext => ({ role, via: "web" });

describe("hasRole", () => {
  it("依角色高低判斷", () => {
    expect(hasRole("owner", "editor")).toBe(true);
    expect(hasRole("editor", "editor")).toBe(true);
    expect(hasRole("viewer", "editor")).toBe(false);
    expect(hasRole(null, "viewer")).toBe(false);
  });
});

describe("can：權限矩陣", () => {
  it("非成員什麼都不能做", () => {
    expect(can(web(null), "trip.view")).toBe(false);
  });

  it("檢視者只能看、寫自己的心得", () => {
    expect(can(web("viewer"), "trip.view")).toBe(true);
    expect(can(web("viewer"), "journal.writeOwn")).toBe(true);
    expect(can(web("viewer"), "item.update")).toBe(false);
    expect(can(web("viewer"), "member.invite")).toBe(false);
  });

  it("檢視者寫心得可由行程設定關閉", () => {
    expect(can(web("viewer"), "journal.writeOwn", { viewerCanWriteJournal: false })).toBe(false);
    expect(can(web("editor"), "journal.writeOwn", { viewerCanWriteJournal: false })).toBe(true);
  });

  it("編輯者可編輯、確定、解除確定，但不能管理成員或刪除行程", () => {
    const ctx = web("editor");
    expect(can(ctx, "item.update")).toBe(true);
    expect(can(ctx, "item.confirm")).toBe(true);
    expect(can(ctx, "item.unconfirm")).toBe(true);
    expect(can(ctx, "member.manage")).toBe(false);
    expect(can(ctx, "trip.delete")).toBe(false);
    expect(can(ctx, "trip.publish")).toBe(false);
  });

  it("擁有者可做所有事", () => {
    expect(can(web("owner"), "trip.delete")).toBe(true);
    expect(can(web("owner"), "member.manage")).toBe(true);
  });
});

describe("can：入口限制", () => {
  it("MCP 可以讀寫一般行程點", () => {
    const mcp: AccessContext = { role: "editor", via: "mcp" };
    expect(can(mcp, "trip.view")).toBe(true);
    expect(can(mcp, "item.create")).toBe(true);
    expect(can(mcp, "item.update")).toBe(true);
  });

  it("MCP 不能確定／解除確定、邀請、刪除行程，擁有者也一樣", () => {
    const mcp: AccessContext = { role: "owner", via: "mcp" };
    expect(can(mcp, "item.confirm")).toBe(false);
    expect(can(mcp, "item.unconfirm")).toBe(false);
    expect(can(mcp, "member.invite")).toBe(false);
    expect(can(mcp, "trip.delete")).toBe(false);
  });

  it("復原 MCP 修改：編輯者以上、只限第一方 client", () => {
    expect(can({ role: "editor", via: "web" }, "activity.undo")).toBe(true);
    expect(can({ role: "viewer", via: "web" }, "activity.undo")).toBe(false);
    expect(can({ role: "owner", via: "mcp" }, "activity.undo")).toBe(false);
  });
});

describe("assertCan", () => {
  it("沒有權限時丟出 ForbiddenError（403）", () => {
    expect(() => assertCan(web("viewer"), "item.delete")).toThrow(ForbiddenError);
    try {
      assertCan(web("viewer"), "item.delete");
    } catch (e) {
      expect((e as ForbiddenError).status).toBe(403);
    }
  });
});

describe("canInviteAs", () => {
  it("擁有者與編輯者可邀請編輯者、檢視者，但不能邀請擁有者", () => {
    for (const role of ["owner", "editor"] as const) {
      expect(canInviteAs(web(role), "editor")).toBe(true);
      expect(canInviteAs(web(role), "viewer")).toBe(true);
      expect(canInviteAs(web(role), "owner")).toBe(false);
    }
  });

  it("檢視者不能邀請", () => {
    expect(canInviteAs(web("viewer"), "viewer")).toBe(false);
  });
});
