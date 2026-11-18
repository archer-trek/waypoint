import {
  type ComponentProps,
  type ReactNode,
  useRef,
  useState,
} from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "@/lib/utils";

/** Root Action Sheet state container using Dialog primitives. */
export function ActionSheet({
  ...props
}: ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="action-sheet" {...props} />;
}

/** Trigger element for opening the Action Sheet. */
export function ActionSheetTrigger({
  ...props
}: ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="action-sheet-trigger" {...props} />;
}

/** Portal container rendering Action Sheet into document body. */
export function ActionSheetPortal({
  ...props
}: ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="action-sheet-portal" {...props} />;
}

/** Translucent backdrop scrim behind the Action Sheet. */
export function ActionSheetOverlay({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="action-sheet-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px] transition-opacity",
        className,
      )}
      {...props}
    />
  );
}

export type ActionSheetContentProps = ComponentProps<
  typeof DialogPrimitive.Content
> & {
  title?: string;
  onDismiss?: () => void;
  overlayClassName?: string;
};

/** Bottom drawer surface adhering to modern iOS Action Sheet & M3 Modal Bottom Sheet ergonomics. */
export function ActionSheetContent({
  className,
  children,
  title,
  onDismiss,
  overlayClassName,
  ...props
}: ActionSheetContentProps) {
  const touchStartRef = useRef<number | null>(null);
  const dragDeltaRef = useRef(0);
  const [dragDelta, setDragDelta] = useState(0);
  const [isDragging, setIsDragging] = useState(false);

  const accessibleTitle = title ?? props["aria-label"] ?? "操作菜单";

  return (
    <ActionSheetPortal>
      <ActionSheetOverlay className={overlayClassName} />
      <DialogPrimitive.Content
        data-slot="action-sheet-content"
        aria-describedby={props["aria-describedby"] ?? undefined}
        onPointerDown={(event) => {
          event.stopPropagation();
          event.nativeEvent?.stopPropagation?.();
        }}
        className={cn(
          "fixed inset-x-0 bottom-0 z-50 flex max-h-[85vh] flex-col gap-2 px-3 pt-0 outline-none sm:mx-auto sm:max-w-md",
          "pb-[max(0.75rem,env(safe-area-inset-bottom,0px))]",
          !isDragging && "transition-transform duration-150 ease-out",
          className,
        )}
        style={{
          transform: dragDelta > 0 ? `translate3d(0, ${dragDelta}px, 0)` : undefined,
        }}
        {...props}
      >
        <DialogPrimitive.Title className="sr-only">
          {accessibleTitle}
        </DialogPrimitive.Title>
        <div
          data-slot="action-sheet-grabber-zone"
          className="flex h-11 w-full cursor-grab touch-none items-center justify-center select-none active:cursor-grabbing"
          onTouchStart={(e) => {
            if (e.touches.length === 1) {
              touchStartRef.current = e.touches[0]!.clientY;
              dragDeltaRef.current = 0;
            }
          }}
          onTouchMove={(e) => {
            if (touchStartRef.current !== null && e.touches.length === 1) {
              const delta = e.touches[0]!.clientY - touchStartRef.current;
              if (delta > 0) {
                dragDeltaRef.current = delta;
                setIsDragging(true);
                setDragDelta(delta);
              }
            }
          }}
          onTouchEnd={() => {
            const shouldDismiss = dragDeltaRef.current > 60;
            dragDeltaRef.current = 0;
            touchStartRef.current = null;
            setIsDragging(false);
            setDragDelta(0);
            if (shouldDismiss) {
              onDismiss?.();
            }
          }}
          onTouchCancel={() => {
            dragDeltaRef.current = 0;
            touchStartRef.current = null;
            setIsDragging(false);
            setDragDelta(0);
          }}
        >
          <span
            data-slot="action-sheet-grabber"
            className="h-1 w-9 rounded-full bg-muted-foreground/35"
            aria-hidden="true"
          />
        </div>
        {children}
      </DialogPrimitive.Content>
    </ActionSheetPortal>
  );
}

/** Rounded container card grouping related actions or cancel button. */
export function ActionSheetCard({
  className,
  children,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      data-slot="action-sheet-card"
      className={cn(
        "overflow-hidden rounded-2xl border border-border/80 bg-card/95 shadow-xl backdrop-blur-md",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export type ActionSheetItemProps = ComponentProps<"button"> & {
  variant?: "default" | "destructive";
  icon?: ReactNode;
};

/** Individual action item row within an ActionSheetCard. */
export function ActionSheetItem({
  className,
  variant = "default",
  icon,
  children,
  ...props
}: ActionSheetItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      data-slot="action-sheet-item"
      data-variant={variant}
      className={cn(
        "flex min-h-13 w-full items-center justify-start gap-3 border-t border-border/50 px-4 text-left text-[15px] font-medium transition-colors first:border-0 hover:bg-accent active:bg-accent/80 disabled:pointer-events-none disabled:opacity-50",
        variant === "destructive"
          ? "font-semibold text-destructive hover:bg-destructive/10 active:bg-destructive/15"
          : "text-foreground",
        className,
      )}
      {...props}
    >
      {icon ? (
        <span className="inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground">
          {icon}
        </span>
      ) : null}
      <span className="truncate">{children}</span>
    </button>
  );
}

/** Separated cancel button pinned to the bottom card. */
export function ActionSheetCancel({
  className,
  children = "取消",
  ...props
}: ComponentProps<"button">) {
  return (
    <button
      type="button"
      data-slot="action-sheet-cancel"
      className={cn(
        "flex min-h-13 w-full items-center justify-center px-4 text-center text-[15px] font-semibold text-foreground transition-colors hover:bg-accent active:bg-accent/80",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
