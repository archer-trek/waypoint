import "fake-indexeddb/auto";
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});

if (typeof HTMLFormElement !== "undefined") {
  HTMLFormElement.prototype.requestSubmit = function (submitter?: HTMLElement) {
    const event = new SubmitEvent("submit", {
      bubbles: true,
      cancelable: true,
      submitter,
    });
    this.dispatchEvent(event);
  };
}
