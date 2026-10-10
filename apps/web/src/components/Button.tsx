import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> {
  variant?: ButtonVariant;
  size?: "sm" | "lg";
  /** Click twice to confirm: the first click arms the button for 3 s. */
  confirm?: boolean | string;
  active?: boolean;
  onClick?: () => void;
  children: ReactNode;
}

export function Button({ variant = "secondary", size = "sm", confirm, active, onClick, children, className, type = "button", ...rest }: Props) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => void (timer.current && window.clearTimeout(timer.current)), []);

  const handle = () => {
    if (!confirm) return onClick?.();
    if (armed) {
      setArmed(false);
      if (timer.current) window.clearTimeout(timer.current);
      onClick?.();
      return;
    }
    setArmed(true);
    timer.current = window.setTimeout(() => setArmed(false), 3000);
  };

  const cls = ["btn", variant !== "secondary" ? `btn--${variant}` : "", size === "lg" ? "btn--lg" : "", armed ? "btn--armed" : "", active ? "btn--active" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  return (
    <button type={type} className={cls} aria-pressed={active} onClick={type === "submit" ? undefined : handle} {...rest}>
      {armed ? (typeof confirm === "string" ? confirm : "Click again to confirm") : children}
    </button>
  );
}
