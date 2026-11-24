/**
 * 領域錯誤。API 層依 `status` 與 `problemType` 轉成 RFC 9457 Problem Details。
 */
export abstract class DomainError extends Error {
  abstract readonly status: number;
  abstract readonly problemType: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ForbiddenError extends DomainError {
  readonly status = 403;
  readonly problemType = "/problems/forbidden";
}

export class ItemConfirmedError extends DomainError {
  readonly status = 423;
  readonly problemType = "/problems/item-confirmed";

  constructor(
    readonly itemId: string,
    readonly confirmedAt: Date,
    readonly confirmedBy: string | null,
    readonly lockedFields: readonly string[] = [],
  ) {
    super(
      lockedFields.length > 0
        ? `行程點已確定（已訂位／已購票），不能修改：${lockedFields.join(", ")}。請先解除確定。`
        : "行程點已確定（已訂位／已購票），不能移動或刪除。請先解除確定。",
    );
  }
}

export class InvalidTransitionError extends DomainError {
  readonly status = 409;
  readonly problemType = "/problems/invalid-transition";
}
