import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { isPublicPath } from "@/proxy";
import NotFound from "./not-found";

describe("the app's own page for an unknown address", () => {
  it("says it in plain words and leads back to the cards, with nothing from the collection", () => {
    const html = renderToStaticMarkup(createElement(NotFound));
    expect(html).toContain("Not found");
    expect(html).toContain('href="/"');
    expect(html).toContain("Back to your cards");
    expect(html).not.toContain("404");
    expect(html).not.toContain("Recently deleted");
    expect(html).not.toMatch(/[–—]/);
  });

  it("an unknown address is not public: a visitor who is not signed in is sent to sign in first", () => {
    expect(isPublicPath("/nope")).toBe(false);
  });
});
