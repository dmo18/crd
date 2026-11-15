import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

/**
 * Small shared building blocks so every screen looks and behaves the same.
 * All tap targets are at least 44px tall. Use these before writing new markup.
 */

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

const BUTTON_BASE =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-base font-semibold disabled:opacity-50 disabled:pointer-events-none";
const BUTTON_VARIANTS = {
  primary: "bg-accent text-accent-text",
  secondary: "bg-surface-2 text-text border border-border",
  danger: "bg-danger-soft text-danger border border-danger",
  ghost: "text-accent",
} as const;
type Variant = keyof typeof BUTTON_VARIANTS;

export function Button({ variant = "primary", className, ...props }: ComponentProps<"button"> & { variant?: Variant }) {
  return <button {...props} className={cx(BUTTON_BASE, BUTTON_VARIANTS[variant], className)} />;
}

export function LinkButton({ variant = "primary", className, ...props }: ComponentProps<typeof Link> & { variant?: Variant }) {
  return <Link {...props} className={cx(BUTTON_BASE, BUTTON_VARIANTS[variant], className)} />;
}

export function Card({ className, ...props }: ComponentProps<"div">) {
  return <div {...props} className={cx("rounded-2xl border border-border bg-surface p-4", className)} />;
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <header className="flex items-start justify-between gap-3 pb-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold text-balance">{title}</h1>
        {subtitle ? <p className="pt-1 text-sm text-muted">{subtitle}</p> : null}
      </div>
      {action}
    </header>
  );
}

const BADGE_TONES = {
  neutral: "bg-surface-2 text-muted",
  accent: "bg-accent-soft text-accent",
  warn: "bg-warn-soft text-warn",
  danger: "bg-danger-soft text-danger",
  gold: "bg-gold-soft text-gold",
} as const;

export function Badge({ tone = "neutral", children }: { tone?: keyof typeof BADGE_TONES; children: ReactNode }) {
  return (
    <span className={cx("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap", BADGE_TONES[tone])}>
      {children}
    </span>
  );
}

export const INPUT_CLASS =
  "min-h-11 w-full rounded-xl border border-border bg-surface px-3 text-base text-text placeholder:text-muted";

/** A labeled form control. Pass the input, select or textarea as children. */
export function Field({ label, hint, error, htmlFor, children }: {
  label: string; hint?: string; error?: string | null; htmlFor: string; children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-sm font-semibold">{label}</label>
      {children}
      {hint && !error ? <p className="text-xs text-muted">{hint}</p> : null}
      {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
    </div>
  );
}

export function Notice({ tone = "neutral", children }: { tone?: keyof typeof BADGE_TONES; children: ReactNode }) {
  return <div className={cx("rounded-xl px-3 py-2 text-sm", BADGE_TONES[tone])}>{children}</div>;
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <Card className="flex flex-col items-center gap-3 py-10 text-center">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="max-w-xs text-sm text-muted">{body}</p>
      {action}
    </Card>
  );
}
