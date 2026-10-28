// Ritsu UI 组件层 —— 只做可复用的交互原语，不含业务状态。
// 视觉语言沿用 transitions.dev 的动效钩子：文字换字、勾选描边、下拉缩放、Toast 上浮。
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type {
  ButtonHTMLAttributes,
  CSSProperties,
  ReactNode,
} from "react";

export type IconName =
  | "audio"
  | "lyrics"
  | "image"
  | "play"
  | "pause"
  | "chevron"
  | "x"
  | "minus"
  | "plus"
  | "spark"
  | "check"
  | "alert";

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    "aria-hidden": true,
  } as const;

  switch (name) {
    case "audio":
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round">
          <path d="M2 9.2V6.8M4.4 11V5M6.8 13V3M9.2 11.4V4.6M11.6 9.4V6.6M14 8.4V7.6" />
        </svg>
      );
    case "lyrics":
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round">
          <path d="M3 4.2h10M3 7.1h7.4M3 10h10M3 12.9h5.6" />
        </svg>
      );
    case "image":
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round">
          <rect x="2.2" y="2.6" width="11.6" height="10.8" rx="1.2" />
          <circle cx="6" cy="6.2" r="1.1" />
          <path d="m3.2 11.4 3.3-3 2.8 2.4 1.8-1.5 2.7 2.1" />
        </svg>
      );
    case "play":
      return (
        <svg {...common} fill="currentColor" aria-hidden="true">
          <path d="M5 3.1 12.6 8 5 12.9z" />
        </svg>
      );
    case "pause":
      return (
        <svg {...common} fill="currentColor" aria-hidden="true">
          <rect x="4" y="3" width="2.7" height="10" rx="0.8" />
          <rect x="9.3" y="3" width="2.7" height="10" rx="0.8" />
        </svg>
      );
    case "chevron":
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
          <path d="m5.2 3.8 4.2 4.2-4.2 4.2" />
        </svg>
      );
    case "x":
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round">
          <path d="m4.4 4.4 7.2 7.2M11.6 4.4l-7.2 7.2" />
        </svg>
      );
    case "minus":
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
          <path d="M4 8h8" />
        </svg>
      );
    case "plus":
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
          <path d="M8 4v8M4 8h8" />
        </svg>
      );
    case "spark":
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 1.8 9.2 6l4.2 1.2-4.2 1.2L8 12.6 6.8 8.4 2.6 7.2 6.8 6z" />
          <path d="M12.4 11.4v2.2M11.3 12.5h2.2" />
        </svg>
      );
    case "check":
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="m3.1 8.2 3 3.2 6.8-7" />
        </svg>
      );
    case "alert":
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round">
          <path d="M8 3.2v5.4" />
          <circle cx="8" cy="12" r="0.7" fill="currentColor" stroke="none" />
        </svg>
      );
  }
}

export function Button({
  variant = "default",
  size = "md",
  block = false,
  className,
  children,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "quiet";
  size?: "sm" | "md";
  block?: boolean;
}) {
  return (
    <button
      {...rest}
      type={type}
      className={[
        "t-btn",
        `t-btn--${variant}`,
        size === "sm" ? "t-btn--sm" : "",
        block ? "t-btn--block" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </button>
  );
}

/** 文案原地换字：旧字上移模糊退出 → 新字从下方进入。 */
export function SwapText({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!el.textContent || el.textContent === text) {
      el.textContent = text;
      return;
    }
    const cs = getComputedStyle(document.documentElement);
    const dur = parseFloat(cs.getPropertyValue("--text-swap-dur")) || 150;
    el.classList.add("is-exit");
    const timer = window.setTimeout(() => {
      el.textContent = text;
      el.classList.remove("is-exit");
      el.classList.add("is-enter-start");
      void el.offsetHeight;
      el.classList.remove("is-enter-start");
    }, dur);
    return () => {
      window.clearTimeout(timer);
      el.classList.remove("is-exit", "is-enter-start");
    };
  }, [text]);

  return <span ref={ref} className="t-text-swap" />;
}

/** 悬浮提示：纯 CSS 的 hover / focus-within 触发，触发器本身必须带 aria-label。 */
export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="t-tt-group">
      {children}
      <span className="t-tt" role="tooltip">
        {label}
      </span>
    </span>
  );
}

export function AssetField({
  label,
  hint,
  accept,
  fileName,
  detail,
  disabled = false,
  icon,
  preview,
  onFile,
}: {
  label: string;
  hint: string;
  accept: string;
  fileName?: string | null;
  detail?: string;
  disabled?: boolean;
  icon: IconName;
  preview?: ReactNode;
  onFile: (file: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const filled = Boolean(fileName);

  return (
    <div className="asset" data-filled={filled} data-disabled={disabled}>
      <span className="asset-visual">{preview ?? <Icon name={icon} size={18} />}</span>
      <div className="asset-copy">
        <div className="asset-head">
          <span className="asset-label">{label}</span>
          <span className="asset-state">{filled ? "已载入" : "未选择"}</span>
        </div>
        <div className="asset-foot">
          <span className="asset-name" title={fileName ?? "未选择任何文件"}>
            {fileName ?? "未选择任何文件"}
          </span>
          <Button
            size="sm"
            variant="quiet"
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
          >
            选择
          </Button>
        </div>
        <span className="asset-detail">{filled ? (detail ?? hint) : hint}</span>
      </div>
      <input
        ref={inputRef}
        className="sr-only"
        type="file"
        accept={accept}
        disabled={disabled}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) onFile(file);
        }}
      />
    </div>
  );
}

export function TextField({
  label,
  value,
  placeholder,
  disabled = false,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const ghostRef = useRef<HTMLSpanElement | null>(null);
  const glowRef = useRef<HTMLSpanElement | null>(null);

  const clear = useCallback(() => {
    if (disabled || !value) return;
    const input = inputRef.current;
    const ghost = ghostRef.current;
    const glow = glowRef.current;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (ghost && glow && !reduced) {
      ghost.textContent = value;
      ghost.classList.add("is-clearing");
      const ghostAnim = ghost.animate(
        [
          { opacity: 1, filter: "blur(0)", transform: "translateY(0)" },
          { opacity: 0, filter: "blur(7px)", transform: "translateY(-2px)" },
        ],
        { duration: 380, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
      );
      ghostAnim.onfinish = () => {
        ghost.textContent = "";
        ghost.classList.remove("is-clearing");
      };
      glow.animate(
        [
          { opacity: 0, transform: "scale(0.985)" },
          { opacity: 1, transform: "scale(1)" },
          { opacity: 0, transform: "scale(1.01)" },
        ],
        { duration: 420, easing: "ease-out" },
      );
    }

    onChange("");
    input?.focus();
  }, [disabled, onChange, value]);

  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <span className="t-text-field">
        <input
          ref={inputRef}
          id={id}
          className="t-text-input"
          type="text"
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
        <span ref={ghostRef} className="t-input-ghost" aria-hidden="true" />
        <span ref={glowRef} className="t-input-glow" aria-hidden="true" />
        {value ? (
          <button
            type="button"
            className="t-input-clear"
            aria-label={`清空${label}`}
            disabled={disabled}
            onClick={clear}
          >
            <Icon name="x" size={12} />
          </button>
        ) : null}
      </span>
    </div>
  );
}

type Option = { value: string; label: string; disabled?: boolean };

export function SelectField({
  label,
  value,
  options,
  disabled = false,
  onChange,
}: {
  label: string;
  value: string;
  options: Option[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(false);
  const [closing, setClosing] = useState(false);
  const [placement, setPlacement] = useState<"down" | "up">("down");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const selected = options.find((option) => option.value === value);

  const openMenu = () => {
    if (disabled) return;
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    setPlacement(rect && window.innerHeight - rect.bottom < 240 ? "up" : "down");
    setClosing(false);
    setOpen(true);
    window.requestAnimationFrame(() => setShown(true));
  };

  const closeMenu = useCallback((focusTrigger = false) => {
    setShown(false);
    setClosing(true);
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(() => {
      setOpen(false);
      setClosing(false);
      closeTimerRef.current = null;
      if (focusTrigger) triggerRef.current?.focus();
    }, 140);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) closeMenu();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [closeMenu, open]);

  useEffect(() => {
    if (!open) return;
    const id = window.requestAnimationFrame(() => {
      const target = listRef.current?.querySelector<HTMLElement>(
        '[role="option"][aria-selected="true"]',
      );
      target?.focus();
    });
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  const moveFocus = (direction: 1 | -1) => {
    const items = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ?? [],
    );
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = (current + direction + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div ref={rootRef} className="t-select" data-open={open && shown}>
        <button
          ref={triggerRef}
          type="button"
          className="t-select-trigger"
          aria-haspopup="listbox"
          aria-expanded={open && shown}
          disabled={disabled}
          onClick={() => (open && shown ? closeMenu() : openMenu())}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              if (!open) openMenu();
            } else if (event.key === "Escape") {
              closeMenu(true);
            }
          }}
        >
          <span>{selected?.label ?? "请选择"}</span>
          <span className="t-select-chevron" aria-hidden="true">
            <Icon name="chevron" size={13} />
          </span>
        </button>
        {open ? (
          <div
            ref={listRef}
            className={[
              "t-select-menu",
              shown ? "is-open" : "",
              closing ? "is-closing" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            data-origin={placement === "down" ? "top-left" : "bottom-left"}
            role="listbox"
            aria-label={label}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                moveFocus(1);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                moveFocus(-1);
              } else if (event.key === "Home") {
                event.preventDefault();
                listRef.current?.querySelector<HTMLButtonElement>('[role="option"]')?.focus();
              } else if (event.key === "End") {
                event.preventDefault();
                const items = listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]');
                items?.[items.length - 1]?.focus();
              } else if (event.key === "Escape") {
                event.preventDefault();
                closeMenu(true);
              } else if (event.key === "Tab") {
                closeMenu();
              }
            }}
          >
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                className="t-select-option"
                role="option"
                aria-selected={option.value === value}
                disabled={option.disabled}
                onClick={() => {
                  onChange(option.value);
                  closeMenu(true);
                }}
              >
                <span>{option.label}</span>
                {option.value === value ? <Icon name="check" size={13} /> : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function Segmented({
  label,
  value,
  options,
  disabled = false,
  onChange,
}: {
  label?: string;
  value: string;
  options: Option[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const barRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    const index = options.findIndex((option) => option.value === value);
    const bar = barRef.current;
    const item = itemRefs.current[index];
    if (!bar || !item) return;
    bar.style.setProperty("--tabs-pill-x", `${item.offsetLeft}px`);
    bar.style.setProperty("--tabs-pill-w", `${item.offsetWidth}px`);
    const id = window.requestAnimationFrame(() => setReady(true));
    return () => window.cancelAnimationFrame(id);
  }, [options, value]);

  useEffect(() => {
    const bar = barRef.current;
    if (!bar || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const index = options.findIndex((option) => option.value === value);
      const item = itemRefs.current[index];
      if (!item) return;
      bar.style.setProperty("--tabs-pill-x", `${item.offsetLeft}px`);
      bar.style.setProperty("--tabs-pill-w", `${item.offsetWidth}px`);
    });
    ro.observe(bar);
    return () => ro.disconnect();
  }, [options, value]);

  return (
    <div className="field">
      {label ? <span className="field-label">{label}</span> : null}
      <div className="t-tabs" data-disabled={disabled}>
        <div ref={barRef} className="t-tabs-bar" role="tablist" aria-label={label}>
          <span className={ready ? "t-tabs-pill is-ready" : "t-tabs-pill"} aria-hidden="true" />
          {options.map((option, index) => {
            const active = option.value === value;
            return (
              <button
                key={option.value}
                ref={(element) => {
                  itemRefs.current[index] = element;
                }}
                type="button"
                className="t-tab"
                role="tab"
                aria-selected={active}
                disabled={disabled || option.disabled}
                onClick={() => onChange(option.value)}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
                  event.preventDefault();
                  const enabled = options.filter((candidate) => !candidate.disabled);
                  if (enabled.length === 0) return;
                  const current = enabled.findIndex((candidate) => candidate.value === value);
                  const step = event.key === "ArrowRight" ? 1 : -1;
                  const next = enabled[(current + step + enabled.length) % enabled.length];
                  if (next) onChange(next.value);
                }}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function NumberField({
  label,
  value,
  min,
  max,
  step,
  unit,
  disabled = false,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  const clamp = (input: number) => Math.min(max, Math.max(min, input));
  const commit = (input: number) => {
    if (Number.isFinite(input)) onChange(clamp(input));
  };

  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="t-number" data-disabled={disabled}>
        <button
          type="button"
          className="t-step"
          aria-label={`${label}减少`}
          disabled={disabled || value <= min}
          onClick={() => commit(value - step)}
        >
          <Icon name="minus" size={12} />
        </button>
        <input
          className="t-number-input"
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          aria-label={label}
          onChange={(event) => commit(event.target.valueAsNumber)}
          onBlur={(event) => {
            const next = event.target.valueAsNumber;
            if (Number.isFinite(next)) commit(next);
            else onChange(value);
          }}
        />
        {unit ? <span className="t-number-unit">{unit}</span> : null}
        <button
          type="button"
          className="t-step"
          aria-label={`${label}增加`}
          disabled={disabled || value >= max}
          onClick={() => commit(value + step)}
        >
          <Icon name="plus" size={12} />
        </button>
      </div>
    </div>
  );
}

export function CheckRow({
  label,
  description,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      className="t-check-row"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={onChange}
    >
      <span className="t-check" aria-hidden="true">
        <svg viewBox="0 0 10.1668 10.1668">
          <path d="M1 5.52L3.92 9.17L9.17 1" />
        </svg>
      </span>
      <span className="t-check-copy">
        <span className="t-check-label">{label}</span>
        {description ? <span className="t-check-desc">{description}</span> : null}
      </span>
    </button>
  );
}

export function Section({
  index,
  title,
  meta,
  defaultOpen = true,
  children,
}: {
  index: string;
  title: string;
  meta?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    if (open) panel.removeAttribute("inert");
    else panel.setAttribute("inert", "");
  }, [open]);

  return (
    <section className="panel-block" data-open={open}>
      <button
        type="button"
        className="section-head"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="section-index">{index}</span>
        <span className="section-title">{title}</span>
        <span className="section-meta">{meta}</span>
        <span className="section-chevron" aria-hidden="true">
          <Icon name="chevron" size={13} />
        </span>
      </button>
      <div ref={panelRef} className="t-acc-panel">
        <div className="t-acc-panel-inner">
          <div className="section-body">{children}</div>
        </div>
      </div>
    </section>
  );
}

export function Reveal({ children, className }: { children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const id = window.requestAnimationFrame(() => setOpen(true));
    return () => window.cancelAnimationFrame(id);
  }, []);

  return (
    <div className={className ? `t-acc ${className}` : "t-acc"} data-open={open}>
      <div className="t-acc-panel">
        <div className="t-acc-panel-inner">{children}</div>
      </div>
    </div>
  );
}

export function ProgressBar({ value, label }: { value: number; label?: string }) {
  const pct = Math.min(100, Math.max(0, value));
  return (
    <div className="t-progress-wrap">
      {label ? (
        <div className="t-progress-meta">
          <span>{label}</span>
          <span>{Math.round(pct)}%</span>
        </div>
      ) : null}
      <div
        className="t-progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
      >
        <span
          className="t-progress-fill"
          style={{ transform: `scaleX(${(pct / 100).toFixed(4)})` } as CSSProperties}
        />
      </div>
    </div>
  );
}

export function Toast({
  message,
  tone = "info",
  onClose,
}: {
  message: string;
  tone?: "info" | "success" | "error";
  onClose: () => void;
}) {
  const [open, setOpen] = useState(false);
  const closingRef = useRef(false);

  const close = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setOpen(false);
    window.setTimeout(onClose, 220);
  }, [onClose]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setOpen(true));
    const timer =
      tone === "error" ? 0 : window.setTimeout(close, tone === "success" ? 4600 : 5600);
    return () => {
      window.cancelAnimationFrame(frame);
      if (timer) window.clearTimeout(timer);
    };
  }, [close, tone]);

  return (
    <div className="t-toast" data-open={open} data-tone={tone} role={tone === "error" ? "alert" : "status"}>
      <span className="t-toast-icon" aria-hidden="true">
        <Icon name={tone === "success" ? "check" : tone === "error" ? "alert" : "spark"} size={15} />
      </span>
      <p className="t-toast-copy">{message}</p>
      <button type="button" className="t-toast-close" aria-label="关闭提示" onClick={close}>
        <Icon name="x" size={12} />
      </button>
    </div>
  );
}
