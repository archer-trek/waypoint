const TOUCH_SLOP_PX = 4;

/**
 * Reset any root/visual viewport panning back to (0, 0) without disturbing inner
 * scroll containers (such as the message timeline or multiline composer).
 */
export function resetRootViewportOffset(
  win: Window | undefined = typeof window !== "undefined" ? window : undefined,
  doc: Document | undefined = typeof document !== "undefined" ? document : undefined,
): boolean {
  if (!win || !doc) {
    return false;
  }
  let changed = false;

  const docEl = doc.documentElement;
  const body = doc.body;

  if (
    win.scrollX !== 0 ||
    win.scrollY !== 0 ||
    (docEl && (docEl.scrollTop !== 0 || docEl.scrollLeft !== 0)) ||
    (body && (body.scrollTop !== 0 || body.scrollLeft !== 0))
  ) {
    changed = true;
    try {
      win.scrollTo(0, 0);
    } catch {
      /* ignore */
    }
    if (docEl) {
      docEl.scrollTop = 0;
      docEl.scrollLeft = 0;
    }
    if (body) {
      body.scrollTop = 0;
      body.scrollLeft = 0;
    }
  }

  const vv = win.visualViewport;
  if (vv && (Math.abs(vv.offsetTop) > 0.5 || Math.abs(vv.offsetLeft) > 0.5)) {
    changed = true;
    // Blink ignores window.scrollTo(0, 0) when layout scrollY is already 0,
    // so align the root document element back to the visual viewport origin.
    if (docEl && typeof docEl.scrollIntoView === "function") {
      try {
        docEl.scrollIntoView({ block: "start", inline: "start" });
      } catch {
        try {
          docEl.scrollIntoView(true);
        } catch {
          /* ignore */
        }
      }
    }
  }

  return changed;
}

/**
 * Returns true when the soft keyboard constrains the visible height below the layout viewport.
 */
export function isViewportKeyboardConstrained(
  safeInset: number,
  win: Window | undefined = typeof window !== "undefined" ? window : undefined,
): boolean {
  if (Number.isFinite(safeInset) && safeInset > 0) {
    return true;
  }
  const vv = win?.visualViewport;
  if (!win || !vv) {
    return false;
  }
  return win.innerHeight > 0 && vv.height > 0 && vv.height < win.innerHeight - 1;
}

function isVerticalScrollContainer(el: HTMLElement, boundaryRoot: HTMLElement): boolean {
  if (el.scrollHeight <= el.clientHeight + 1) {
    return false;
  }
  if (
    el === boundaryRoot ||
    el.tagName === "TEXTAREA" ||
    el.classList.contains("overflow-y-auto") ||
    el.classList.contains("overflow-auto")
  ) {
    return true;
  }
  const win = el.ownerDocument?.defaultView;
  if (win && typeof win.getComputedStyle === "function") {
    const overflowY = win.getComputedStyle(el).overflowY;
    return overflowY === "auto" || overflowY === "scroll";
  }
  return false;
}

/**
 * Checks whether `target` or any ancestor up to `boundaryRoot` can still scroll vertically
 * in the direction of a finger drag (`deltaY > 0` drags down / scrolls up; `deltaY < 0` drags up / scrolls down).
 */
export function canScrollVerticallyInDirection(
  target: EventTarget | null,
  boundaryRoot: HTMLElement,
  deltaY: number,
): boolean {
  if (deltaY === 0) {
    return false;
  }
  let node: HTMLElement | null =
    target instanceof HTMLElement
      ? target
      : target instanceof Node
        ? target.parentElement
        : null;

  while (node) {
    if (isVerticalScrollContainer(node, boundaryRoot)) {
      if (deltaY > 0 && node.scrollTop > 0.5) {
        return true;
      }
      if (deltaY < 0 && node.scrollTop + node.clientHeight < node.scrollHeight - 1) {
        return true;
      }
    }
    if (node === boundaryRoot) {
      break;
    }
    node = node.parentElement;
  }
  return false;
}

export type TouchScrollBoundaryLockOptions = {
  isLocked: () => boolean;
  allowVerticalScroll?: (target: EventTarget | null, deltaY: number) => boolean;
  onlyVertical?: boolean;
  shouldIgnoreHorizontalEdge?: (startX: number, deltaX: number, deltaY: number) => boolean;
};

/**
 * Prevents touch-drag gestures from chaining out of non-scrollable chrome or boundary-clamped
 * scroll containers into Chromium's VisualViewport when the soft keyboard is open.
 */
export function installTouchScrollBoundaryLock(
  element: HTMLElement,
  options: TouchScrollBoundaryLockOptions,
): () => void {
  let tracking = false;
  let decided = false;
  let blockNative = false;
  let startX = 0;
  let startY = 0;

  const onTouchStart = (event: TouchEvent) => {
    if (event.touches.length !== 1) {
      tracking = false;
      decided = false;
      blockNative = false;
      return;
    }
    const touch = event.touches[0]!;
    tracking = true;
    decided = false;
    blockNative = false;
    startX = touch.clientX;
    startY = touch.clientY;
  };

  const onTouchMove = (event: TouchEvent) => {
    if (!tracking || event.touches.length !== 1 || !options.isLocked()) {
      return;
    }
    const touch = event.touches[0]!;
    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;

    if (!decided) {
      if (Math.abs(dx) <= TOUCH_SLOP_PX && Math.abs(dy) <= TOUCH_SLOP_PX) {
        return;
      }
      decided = true;
      if (options.shouldIgnoreHorizontalEdge?.(startX, dx, dy)) {
        blockNative = false;
        return;
      }
      const isVertical = Math.abs(dy) >= Math.abs(dx);
      if (options.onlyVertical && !isVertical) {
        blockNative = false;
        return;
      }
      blockNative = !(options.allowVerticalScroll?.(event.target, dy) ?? false);
    }

    if (blockNative && event.cancelable) {
      event.preventDefault();
    }
  };

  const onTouchEnd = () => {
    tracking = false;
    decided = false;
    blockNative = false;
  };

  element.addEventListener("touchstart", onTouchStart, { passive: true });
  element.addEventListener("touchmove", onTouchMove, { passive: false });
  element.addEventListener("touchend", onTouchEnd, { passive: true });
  element.addEventListener("touchcancel", onTouchEnd, { passive: true });

  return () => {
    element.removeEventListener("touchstart", onTouchStart);
    element.removeEventListener("touchmove", onTouchMove);
    element.removeEventListener("touchend", onTouchEnd);
    element.removeEventListener("touchcancel", onTouchEnd);
  };
}

/**
 * Subscribes to visualViewport and window scroll/resize events and immediately snaps any
 * unintended root or visual-viewport scroll offset back to (0, 0).
 */
export function installViewportScrollLock(
  win: Window | undefined = typeof window !== "undefined" ? window : undefined,
  doc: Document | undefined = typeof document !== "undefined" ? document : undefined,
): () => void {
  if (!win || !doc) {
    return () => undefined;
  }
  let rafId: number | undefined;
  let resetting = false;

  const runReset = (scheduleFollowUp: boolean) => {
    if (resetting) {
      return;
    }
    resetting = true;
    let changed: boolean;
    try {
      changed = resetRootViewportOffset(win, doc);
    } finally {
      resetting = false;
    }
    if (
      changed &&
      scheduleFollowUp &&
      rafId === undefined &&
      typeof win.requestAnimationFrame === "function"
    ) {
      rafId = win.requestAnimationFrame(() => {
        rafId = undefined;
        runReset(false);
      });
    }
  };

  const onViewportEvent = () => {
    runReset(true);
  };

  const vv = win.visualViewport;
  vv?.addEventListener?.("scroll", onViewportEvent);
  vv?.addEventListener?.("resize", onViewportEvent);
  win.addEventListener("scroll", onViewportEvent, { passive: true });

  runReset(false);

  return () => {
    if (rafId !== undefined && typeof win.cancelAnimationFrame === "function") {
      win.cancelAnimationFrame(rafId);
      rafId = undefined;
    }
    vv?.removeEventListener?.("scroll", onViewportEvent);
    vv?.removeEventListener?.("resize", onViewportEvent);
    win.removeEventListener("scroll", onViewportEvent);
  };
}
