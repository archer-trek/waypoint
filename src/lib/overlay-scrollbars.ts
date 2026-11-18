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
};

/**
 * Enable scroll-only overlay scrollbars that stay hidden during programmatic jumps,
 * remain active throughout touch momentum scrolling, and fade out smoothly when settled.
 */
export function installOverlayScrollbars(
  win: Window,
  doc: Document,
): () => void {
  let userInteracting = false;
  let interactionTimer: ReturnType<typeof setTimeout> | undefined;

  const markUserInteraction = (durationMs = 350) => {
    userInteracting = true;
    if (interactionTimer) clearTimeout(interactionTimer);
    interactionTimer = setTimeout(() => {
      userInteracting = false;
      interactionTimer = undefined;
    }, durationMs);
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
    const currentState = target.getAttribute("data-scrolling");
    const isMomentumContinuation = currentState === "active";
    if (!userInteracting && !isMomentumContinuation) {
      return;
    }

    const el = target as ScrollTrackedElement;
    target.setAttribute("data-scrolling", "active");
    if (el._scrollFadeTimer) clearTimeout(el._scrollFadeTimer);
    if (el._scrollCleanTimer) clearTimeout(el._scrollCleanTimer);

    // Trigger fade-out 500ms after scroll events stop settling
    el._scrollFadeTimer = setTimeout(() => {
      target.setAttribute("data-scrolling", "fade");
      el._scrollCleanTimer = setTimeout(() => {
        target.removeAttribute("data-scrolling");
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
    win.removeEventListener("wheel", onWheel, { capture: true });
    win.removeEventListener("touchmove", onTouchMove, { capture: true });
    win.removeEventListener("touchend", onTouchEnd, { capture: true });
    win.removeEventListener("touchcancel", onTouchEnd, { capture: true });
    win.removeEventListener("pointermove", onPointerMove, { capture: true });
    win.removeEventListener("keydown", onKeyDown, { capture: true });
    doc.removeEventListener("scroll", onScroll, { capture: true });
  };
}
