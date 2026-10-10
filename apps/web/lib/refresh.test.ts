import { afterEach, describe, expect, it, vi } from "vitest";
import { REFRESH_DATA_EVENT, refreshClientData } from "./refresh";

afterEach(() => { vi.unstubAllGlobals(); });

describe("refreshClientData", () => {
  it("notifies client data subscribers once per click", () => {
    const target = new EventTarget();
    const listener = vi.fn();
    target.addEventListener(REFRESH_DATA_EVENT, listener);
    vi.stubGlobal("window", target);
    refreshClientData();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not throw in server-side rendering", () => {
    vi.stubGlobal("window", undefined);
    expect(() => refreshClientData()).not.toThrow();
  });
});
