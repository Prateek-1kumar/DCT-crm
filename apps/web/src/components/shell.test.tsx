import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
// next/image and next/link need the Next runtime; plain elements are enough for what is asserted here.
vi.mock("next/image", () => ({ default: ({ alt }: { alt: string }) => <span role="img" aria-label={alt} /> }));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: ReactNode }) => <a href={href} {...p}>{children}</a> }));

describe("shell", () => {
  it("sidebar shows the logo, the Contracts link and the name picker", () => {
    render(<Sidebar />);
    expect(screen.getAllByRole("img", { name: "Discovery Clinical Trials" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: "Contracts" })[0]!.getAttribute("href")).toBe("/");
    expect(screen.getByText("Choose your name")).toBeTruthy();
  });
});
