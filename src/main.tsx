import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

if (typeof document !== "undefined") {
  let userInteracting = false;
  let interactionTimer: ReturnType<typeof setTimeout> | undefined;

  const markUserInteraction = () => {
    userInteracting = true;
    if (interactionTimer) clearTimeout(interactionTimer);
    interactionTimer = setTimeout(() => {
      userInteracting = false;
    }, 250);
  };

  // 捕获真实用户物理交互：触摸拖拽、鼠标滚轮、键盘按键滚动
  window.addEventListener("wheel", markUserInteraction, { capture: true, passive: true });
  window.addEventListener("touchmove", markUserInteraction, { capture: true, passive: true });
  window.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch" || e.buttons > 0) {
      markUserInteraction();
    }
  }, { capture: true, passive: true });
  window.addEventListener("keydown", (e) => {
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", " "].includes(e.key)) {
      markUserInteraction();
    }
  }, { capture: true, passive: true });

  document.addEventListener(
    "scroll",
    (e) => {
      // 过滤程序自动执行的编程式定位滚动（如从列表进入对话页时自动跳到底部），避免滚动条突兀闪现
      if (!userInteracting) {
        return;
      }
      const target = e.target;
      if (target instanceof HTMLElement) {
        target.setAttribute("data-scrolling", "active");
        const el = target as HTMLElement & {
          _scrollFadeTimer?: ReturnType<typeof setTimeout>;
          _scrollCleanTimer?: ReturnType<typeof setTimeout>;
        };
        if (el._scrollFadeTimer) clearTimeout(el._scrollFadeTimer);
        if (el._scrollCleanTimer) clearTimeout(el._scrollCleanTimer);

        // 停止物理滚动 500ms 后平滑触发 fade-out 渐隐
        el._scrollFadeTimer = setTimeout(() => {
          target.setAttribute("data-scrolling", "fade");
          // 450ms 渐隐过渡完成后彻底清除属性
          el._scrollCleanTimer = setTimeout(() => {
            target.removeAttribute("data-scrolling");
            delete el._scrollFadeTimer;
            delete el._scrollCleanTimer;
          }, 450);
        }, 500);
      }
    },
    { capture: true, passive: true },
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
