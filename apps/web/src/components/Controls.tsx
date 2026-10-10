import type { ReactNode } from "react";

/** Small square chip, used by the route builders (click to add / remove). */
export function Chip({
  selected,
  onClick,
  children,
  title,
  onRemove,
}: {
  selected?: boolean;
  onClick?: () => void;
  children: ReactNode;
  title?: string;
  onRemove?: () => void;
}) {
  if (!onClick && !onRemove)
    return (
      <span className="chip chip--static" title={title}>
        {children}
      </span>
    );
  return (
    <button type="button" className="chip" aria-pressed={selected ?? undefined} title={title} onClick={onRemove ?? onClick}>
      {children}
      {onRemove && (
        <span className="chip__x" aria-hidden>
          ×
        </span>
      )}
    </button>
  );
}
