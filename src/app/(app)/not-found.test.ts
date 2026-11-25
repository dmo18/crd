import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import NotFound from "./not-found";

describe("the app's not found page (review fix 12)", () => {
  it("says it in plain words and leads back to the cards", () => {
    const html = renderToStaticMarkup(createElement(NotFound));
    expect(html).toContain("Not found");
    expect(html).toContain('href="/"');
    expect(html).toContain("Back to your cards");
    expect(html).not.toContain("404");
    expect(html).not.toMatch(/[–—]/);
  });
});
