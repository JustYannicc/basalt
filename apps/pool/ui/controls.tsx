import { type ButtonHTMLAttributes, type ReactNode, useEffect, useRef } from "react";

// The dashboard's button vocabulary: same heights, radius, weights and states.
const base =
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-[background-color,color,box-shadow,opacity] duration-150 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 max-[740px]:min-h-11";
const variants = {
  default: "bg-primary text-primary-foreground hover:bg-primary/90",
  outline: "border border-border bg-background shadow-xs hover:bg-accent dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
  ghost: "hover:bg-accent",
  destructive: "bg-destructive text-white hover:bg-destructive/90 dark:bg-destructive/60",
  link: "text-foreground underline underline-offset-4 decoration-muted-foreground/50 hover:decoration-foreground",
} as const;
const sizes = { default: "h-9 px-4", sm: "h-8 px-3 gap-1.5", xs: "h-6 px-2 text-xs gap-1", inline: "h-auto p-0" } as const;

type Variant = keyof typeof variants;
type Size = keyof typeof sizes;

/** Button classes, for a link that looks like one. */
export function buttonClass(variant: Variant = "default", size: Size = "default"): string {
  return `${base} ${variants[variant]} ${sizes[size]}`;
}

export function Button({
  variant = "default",
  size = "default",
  busy = false,
  className = "",
  children,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      {...props}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={`${buttonClass(variant, size)} ${className}`}
    >
      {busy && <Spinner />}
      {children}
    </button>
  );
}

export function Spinner({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg className={`${className} animate-spin`} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.5" />
      <path d="M14.5 8A6.5 6.5 0 0 0 8 1.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function Badge({ tone = "muted", children }: { tone?: "muted" | "warning" | "destructive"; children: ReactNode }) {
  const tones = {
    muted: "border-border text-muted-foreground",
    warning: "border-warning/30 text-warning",
    destructive: "border-destructive/30 text-destructive",
  };
  return (
    <span className={`inline-flex h-5 items-center rounded-sm border px-1.5 text-xs font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

/** A modal on the native dialog element: focus trap, Escape and backdrop come with it. */
export function Dialog({
  open,
  onClose,
  label,
  children,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-label={label}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className="m-auto w-[min(30rem,calc(100vw-2rem))] max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-lg border border-border bg-background p-0 text-foreground shadow-[0_16px_48px_-12px_rgb(0_0_0/0.25)] open:animate-[pool-dialog-in_180ms_cubic-bezier(0.16,1,0.3,1)]"
    >
      {open && children}
    </dialog>
  );
}

export function ExternalIcon() {
  return (
    <svg className="size-3.5" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M6 3.5H3.5v9h9V10M9 3.5h3.5V7M12.5 3.5 7 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CheckIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m3.5 8.5 3 3 6-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Problem({ children }: { children: string }) {
  return (
    <p role="alert" className="text-sm text-destructive text-pretty">
      {children}
    </p>
  );
}
