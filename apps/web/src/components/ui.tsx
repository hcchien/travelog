"use client";

import { forwardRef, useEffect, useId, useRef } from "react";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

type Variant = "primary" | "secondary" | "ghost" | "danger";
const variants: Record<Variant, string> = {
  primary: "bg-brand text-white hover:bg-brand-dark disabled:bg-line-strong",
  secondary: "border border-line-strong bg-white text-ink hover:bg-canvas",
  ghost: "text-ink-soft hover:bg-canvas",
  danger: "border border-line-strong bg-white text-danger hover:bg-red-50",
};

export const Button = forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" }
>(function Button({ variant = "primary", size = "md", className, type = "button", ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60",
        size === "md" ? "h-11 px-4 text-[15px]" : "h-9 px-3 text-sm",
        variants[variant],
        className,
      )}
      {...rest}
    />
  );
});

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: (id: string) => React.ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cx("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-[13px] font-semibold text-ink-soft">
        {label}
      </label>
      {children(id)}
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </div>
  );
}

const control =
  "h-11 w-full rounded-lg border border-line-strong bg-white px-3 text-[15px] text-ink placeholder:text-muted disabled:bg-canvas disabled:text-muted";

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={cx(control, className)} {...rest} />;
  },
);

export function Select({ className, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cx(control, "pr-8", className)} {...rest} />;
}

export function Textarea({
  className,
  ...rest
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx(control, "h-auto min-h-20 py-2", className)} {...rest} />;
}

/** 原生 <dialog>：內建焦點管理與 Esc 關閉。 */
export function Dialog({
  open,
  onClose,
  title,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-label={title}
      className={cx(
        "m-auto w-[calc(100%-2rem)] rounded-2xl border border-line p-0 text-ink shadow-xl",
        wide ? "max-w-2xl" : "max-w-lg",
      )}
    >
      {open && (
        <div className="flex max-h-[85vh] flex-col">
          <div className="flex items-center justify-between border-b border-line px-6 py-4">
            <h2 className="text-lg font-bold">{title}</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="關閉"
              className="flex size-9 items-center justify-center rounded-lg text-muted hover:bg-canvas"
            >
              ✕
            </button>
          </div>
          <div className="overflow-y-auto px-6 py-5">{children}</div>
        </div>
      )}
    </dialog>
  );
}

const AVATAR_COLORS = ["#1F5FAD", "#E07A2F", "#3E7D5A", "#5B3A8C", "#B04C0B", "#2B6E8C"];

export function Avatar({ name, size = 32, ring }: { name: string; size?: number; ring?: boolean }) {
  const color =
    AVATAR_COLORS[[...name].reduce((a, ch) => a + ch.charCodeAt(0), 0) % AVATAR_COLORS.length];
  return (
    <span
      title={name}
      className={cx(
        "inline-flex flex-none items-center justify-center rounded-full font-bold text-white",
        ring && "border-2 border-white",
      )}
      style={{ width: size, height: size, background: color, fontSize: size * 0.42 }}
    >
      {[...name][0] ?? "?"}
    </span>
  );
}

export function Pill({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "brand" | "pin" | "ok";
  children: React.ReactNode;
}) {
  const tones = {
    neutral: "bg-canvas text-ink-soft",
    brand: "bg-brand-soft text-brand",
    pin: "bg-pin-chip text-pin-ink",
    ok: "bg-ok-soft text-ok",
  };
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-semibold",
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

export function EmptyState({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border-2 border-dashed border-line-strong px-6 py-10 text-center">
      <strong className="text-base">{title}</strong>
      {children && <div className="text-sm text-muted">{children}</div>}
    </div>
  );
}

export { cx };
