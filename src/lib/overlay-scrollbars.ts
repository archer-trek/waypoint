const SCROLL_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
]);

type ScrollTrackedElement = HTMLElement & {
  _scrollFadeTimer?: ReturnType<typeof setTimeout>;
  _scrollCleanTimer?: ReturnType<typeof setTimeout>;
  _lastScrollLeft?: number;
  _lastScrollTop?: number;
  _overlayThumbX?: HTMLDivElement;
  _overlayThumbY?: HTMLDivElement;
};

function isInlineCardScroller(el: HTMLElement): boolean {
  return (
    el.getAttribute("data-streamdown") === "code-block-body" ||
    Boolean(el.parentElement?.getAttribute("data-streamdown") === "table-wrapper")
  );
}

function getVisibleCardRect(el: HTMLElement): {
  left: number;
  top: number;
  right: number;
  bottom: number;
} | null {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }
  let left = rect.left;
  let top = rect.top;
  let right = rect.right;
  let bottom = rect.bottom;

  let ancestor = el.parentElement;
  while (ancestor && ancestor !== el.ownerDocument.body) {
    const style = el.ownerDocument.defaultView?.getComputedStyle(ancestor);
    if (
      style &&
      (style.overflowY === "auto" ||
        style.overflowY === "scroll" ||
        style.overflowY === "hidden" ||
        style.overflowX === "auto" ||
        style.overflowX === "scroll" ||
        style.overflowX === "hidden")
    ) {
      const aRect = ancestor.getBoundingClientRect();
      if (aRect.width > 0 && aRect.height > 0) {
        left = Math.max(left, aRect.left);
        top = Math.max(top, aRect.top);
        right = Math.min(right, aRect.right);
        bottom = Math.min(bottom, aRect.bottom);
      }
    }
    ancestor = ancestor.parentElement;
  }

  if (right <= left || bottom <= top) {
    return null;
  }
  return { left, top, right, bottom };
}

function removeCardThumb(
  el: ScrollTrackedElement,
  axis: "x" | "y",
  activeThumbs: Set<HTMLDivElement>,
) {
  const key = axis === "x" ? "_overlayThumbX" : "_overlayThumbY";
  const thumb = el[key];
  if (thumb) {
    activeThumbs.delete(thumb);
    thumb.remove();
    delete el[key];
  }
}

/**
 * Enable scroll-only overlay scrollbars that stay hidden during programmatic jumps,
 * remain active throughout touch momentum scrolling, and fade out smoothly when settled.
 * Inline Markdown cards (code blocks and tables) use zero-gutter floating overlay thumbs
 * so neither horizontal nor vertical scrolling shifts card dimensions.
 */
export function installOverlayScrollbars(
  win: Window,
  doc: Document,
): () => void {
  let userInteracting = false;
  let interactionTimer: ReturnType<typeof setTimeout> | undefined;
  const activeThumbs = new Set<HTMLDivElement>();
  const activeCards = new Set<ScrollTrackedElement>();

  const markUserInteraction = (durationMs = 350) => {
    userInteracting = true;
    if (interactionTimer) clearTimeout(interactionTimer);
    interactionTimer = setTimeout(() => {
      userInteracting = false;
      interactionTimer = undefined;
    }, durationMs);
  };

  const clearCardThumbs = (el: ScrollTrackedElement) => {
    removeCardThumb(el, "x", activeThumbs);
    removeCardThumb(el, "y", activeThumbs);
    activeCards.delete(el);
  };

  const syncInlineCardThumbs = (el: ScrollTrackedElement) => {
    const visible = getVisibleCardRect(el);
    if (!visible) {
      clearCardThumbs(el);
      return;
    }

    const canScrollX = el.scrollWidth > el.clientWidth + 1;
    const canScrollY = el.scrollHeight > el.clientHeight + 1;
    const prevLeft = el._lastScrollLeft;
    const prevTop = el._lastScrollTop;
    const dx = prevLeft !== undefined ? Math.abs(el.scrollLeft - prevLeft) : el.scrollLeft;
    const dy = prevTop !== undefined ? Math.abs(el.scrollTop - prevTop) : el.scrollTop;
    el._lastScrollLeft = el.scrollLeft;
    el._lastScrollTop = el.scrollTop;

    const showX = canScrollX && (dx > 0 || !canScrollY || Boolean(el._overlayThumbX));
    const showY = canScrollY && (dy > 0 || !canScrollX || Boolean(el._overlayThumbY));

    if (showX) {
      const trackInset = 4;
      const trackWidth = Math.max(0, visible.right - visible.left - trackInset * 2);
      const maxScrollX = Math.max(1, el.scrollWidth - el.clientWidth);
      const thumbWidth = Math.min(
        trackWidth,
        Math.max(24, Math.round((el.clientWidth / el.scrollWidth) * trackWidth)),
      );
      const thumbLeft =
        visible.left +
        trackInset +
        (el.scrollLeft / maxScrollX) * Math.max(0, trackWidth - thumbWidth);

      let thumbX = el._overlayThumbX;
      if (!thumbX || !thumbX.isConnected) {
        thumbX = doc.createElement("div");
        thumbX.setAttribute("data-overlay-scrollbar", "x");
        thumbX.setAttribute("aria-hidden", "true");
        doc.body.appendChild(thumbX);
        el._overlayThumbX = thumbX;
        activeThumbs.add(thumbX);
      }
      thumbX.style.left = `${Math.round(thumbLeft)}px`;
      thumbX.style.top = `${Math.round(visible.bottom - 7)}px`;
      thumbX.style.width = `${Math.round(thumbWidth)}px`;
      thumbX.style.height = "4px";
      thumbX.setAttribute("data-state", "active");
    } else {
      removeCardThumb(el, "x", activeThumbs);
    }

    if (showY) {
      const trackInset = 4;
      const trackHeight = Math.max(0, visible.bottom - visible.top - trackInset * 2);
      const maxScrollY = Math.max(1, el.scrollHeight - el.clientHeight);
      const thumbHeight = Math.min(
        trackHeight,
        Math.max(24, Math.round((el.clientHeight / el.scrollHeight) * trackHeight)),
      );
      const thumbTop =
        visible.top +
        trackInset +
        (el.scrollTop / maxScrollY) * Math.max(0, trackHeight - thumbHeight);

      let thumbY = el._overlayThumbY;
      if (!thumbY || !thumbY.isConnected) {
        thumbY = doc.createElement("div");
        thumbY.setAttribute("data-overlay-scrollbar", "y");
        thumbY.setAttribute("aria-hidden", "true");
        doc.body.appendChild(thumbY);
        el._overlayThumbY = thumbY;
        activeThumbs.add(thumbY);
      }
      thumbY.style.left = `${Math.round(visible.right - 7)}px`;
      thumbY.style.top = `${Math.round(thumbTop)}px`;
      thumbY.style.width = "4px";
      thumbY.style.height = `${Math.round(thumbHeight)}px`;
      thumbY.setAttribute("data-state", "active");
    } else {
      removeCardThumb(el, "y", activeThumbs);
    }

    if (showX || showY) {
      activeCards.add(el);
    }
  };

  const onWheel = () => markUserInteraction(350);
  const onTouchMove = () => markUserInteraction(450);
  const onTouchEnd = () => {
    if (userInteracting) {
      markUserInteraction(450);
    }
  };
  const onPointerMove = (e: PointerEvent) => {
    if (e.pointerType === "touch" || e.buttons > 0) {
      markUserInteraction(350);
    }
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (SCROLL_KEYS.has(e.key)) {
      markUserInteraction(350);
    }
  };

  const onScroll = (e: Event) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    // If an outer container scrolls, dismiss floating inline card thumbs so they never lag behind
    if (!isInlineCardScroller(target) && activeCards.size > 0) {
      for (const card of Array.from(activeCards)) {
        if (target.contains(card)) {
          clearCardThumbs(card);
        }
      }
    }

    const currentState = target.getAttribute("data-scrolling");
    const isMomentumContinuation = currentState === "active";
    if (!userInteracting && !isMomentumContinuation) {
      return;
    }

    const el = target as ScrollTrackedElement;
    const inlineCard = isInlineCardScroller(el);
    target.setAttribute("data-scrolling", "active");
    if (inlineCard) {
      syncInlineCardThumbs(el);
    }

    if (el._scrollFadeTimer) clearTimeout(el._scrollFadeTimer);
    if (el._scrollCleanTimer) clearTimeout(el._scrollCleanTimer);

    // Trigger fade-out 500ms after scroll events stop settling
    el._scrollFadeTimer = setTimeout(() => {
      target.setAttribute("data-scrolling", "fade");
      el._overlayThumbX?.setAttribute("data-state", "fade");
      el._overlayThumbY?.setAttribute("data-state", "fade");
      el._scrollCleanTimer = setTimeout(() => {
        target.removeAttribute("data-scrolling");
        clearCardThumbs(el);
        delete el._scrollFadeTimer;
        delete el._scrollCleanTimer;
      }, 450);
    }, 500);
  };

  win.addEventListener("wheel", onWheel, { capture: true, passive: true });
  win.addEventListener("touchmove", onTouchMove, { capture: true, passive: true });
  win.addEventListener("touchend", onTouchEnd, { capture: true, passive: true });
  win.addEventListener("touchcancel", onTouchEnd, { capture: true, passive: true });
  win.addEventListener("pointermove", onPointerMove, { capture: true, passive: true });
  win.addEventListener("keydown", onKeyDown, { capture: true, passive: true });
  doc.addEventListener("scroll", onScroll, { capture: true, passive: true });

  return () => {
    if (interactionTimer) clearTimeout(interactionTimer);
    for (const card of Array.from(activeCards)) {
      if (card._scrollFadeTimer) clearTimeout(card._scrollFadeTimer);
      if (card._scrollCleanTimer) clearTimeout(card._scrollCleanTimer);
      clearCardThumbs(card);
    }
    for (const thumb of activeThumbs) {
      thumb.remove();
    }
    activeThumbs.clear();
    win.removeEventListener("wheel", onWheel, { capture: true });
    win.removeEventListener("touchmove", onTouchMove, { capture: true });
    win.removeEventListener("touchend", onTouchEnd, { capture: true });
    win.removeEventListener("touchcancel", onTouchEnd, { capture: true });
    win.removeEventListener("pointermove", onPointerMove, { capture: true });
    win.removeEventListener("keydown", onKeyDown, { capture: true });
    doc.removeEventListener("scroll", onScroll, { capture: true });
  };
}
