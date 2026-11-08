import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_COLLAPSED, isContractScreen, screenKind, setCollapsed } from "./sidebar";

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("isContractScreen", () => {
  it("matches the proofread and questions screens of a version", () => {
    expect(isContractScreen("/versions/abc-123/proof")).toBe(true);
    expect(isContractScreen("/versions/abc-123/questions")).toBe(true);
    expect(isContractScreen("/versions/abc-123/questions/")).toBe(true);
  });
  it("does not match the list, a study, a bare version or anything nested or unrelated", () => {
    for (const p of ["/", "/studies/s1", "/versions/abc", "/versions//proof", "/versions/a/b/proof", "/versions/a/proof/x", "/activity", "/settings", null, undefined]) {
      expect(isContractScreen(p)).toBe(false);
    }
  });
});

describe("defaults", () => {
  it("contract screens start collapsed and the rest expanded", () => {
    expect(screenKind("/versions/v/proof")).toBe("contract");
    expect(DEFAULT_COLLAPSED.contract).toBe(true);
    expect(DEFAULT_COLLAPSED.other).toBe(false);
  });
});

describe("storage", () => {
  it("writes each kind to its own slot", () => {
    setCollapsed("other", true);
    setCollapsed("contract", false);
    expect(localStorage.getItem("dct.sidebar.other")).toBe("collapsed");
    expect(localStorage.getItem("dct.sidebar.contract")).toBe("expanded");
  });

  it("still toggles for the page's lifetime when storage is blocked", async () => {
    vi.resetModules();
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    vi.stubGlobal("localStorage", blocked);
    const { setCollapsed: set, useSidebarCollapsed } = await import("./sidebar");
    const { renderHook, act } = await import("@testing-library/react");
    const { result } = renderHook(() => useSidebarCollapsed("/activity"));
    expect(result.current.collapsed).toBe(false);
    act(() => set("other", true));
    expect(result.current.collapsed).toBe(true);
  });
});
