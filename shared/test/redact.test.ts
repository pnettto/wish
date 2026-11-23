import { describe, expect, it } from "vitest";
import { redactUrl } from "../src/redact";

describe("redactUrl", () => {
  it("drops the fragment", () => {
    expect(redactUrl("https://example.com/pricing#plans")).toBe("https://example.com/pricing");
  });

  it("keeps harmless params", () => {
    expect(redactUrl("https://example.com/p?tab=2&lang=en")).toBe("https://example.com/p?tab=2&lang=en");
  });

  it("redacts sensitive params case-insensitively", () => {
    const out = redactUrl(
      "https://example.com/cb?code=abc&state=x&access_TOKEN=t&apiKey=k&SessionId=s&X-Amz-Signature=z&password=p&auth=a&client_secret=c",
    );
    const params = new URL(out).searchParams;
    expect(params.get("state")).toBe("x");
    for (const name of ["code", "access_TOKEN", "apiKey", "SessionId", "X-Amz-Signature", "password", "auth", "client_secret"]) {
      expect(params.get(name)).toBe("REDACTED");
    }
  });

  it("drops credentials in the authority", () => {
    expect(redactUrl("https://user:pw@example.com/")).toBe("https://example.com/");
  });

  it("handles unparseable input", () => {
    expect(redactUrl("not a url#frag")).toBe("not a url");
  });
});
