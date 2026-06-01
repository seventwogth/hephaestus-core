import { describe, expect, it } from "vitest";
import { apiBaseUrl } from "./config";

describe("apiBaseUrl", () => {
  it("has a default API URL", () => {
    expect(apiBaseUrl).toContain("http");
  });
});
