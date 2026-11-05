import { describe, expect, it } from "vitest";
import { loadConfig, publicBase } from "../../src/config.js";

const base = (env: Record<string, string>) => publicBase(loadConfig(env as NodeJS.ProcessEnv));

describe("publicBase", () => {
  it("prefers PUBLIC_URL, without a trailing slash", () => {
    expect(base({ PUBLIC_URL: "https://ordo.example/", VERCEL_ENV: "preview", VERCEL_URL: "x.vercel.app" })).toBe("https://ordo.example");
  });
  it("uses Render's external URL", () => {
    expect(base({ RENDER_EXTERNAL_URL: "https://ordo.onrender.com" })).toBe("https://ordo.onrender.com");
  });
  it("on a Vercel preview, points at the preview, not production", () => {
    expect(base({ VERCEL_ENV: "preview", VERCEL_PROJECT_PRODUCTION_URL: "ordo.app", VERCEL_BRANCH_URL: "ordo-git-x.vercel.app", VERCEL_URL: "ordo-abc.vercel.app" })).toBe("https://ordo-git-x.vercel.app");
    expect(base({ VERCEL_ENV: "preview", VERCEL_PROJECT_PRODUCTION_URL: "ordo.app", VERCEL_URL: "ordo-abc.vercel.app" })).toBe("https://ordo-abc.vercel.app");
  });
  it("in production, the production domain; locally, none", () => {
    expect(base({ VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "ordo.app", VERCEL_URL: "ordo-abc.vercel.app" })).toBe("https://ordo.app");
    expect(base({})).toBeNull();
  });
});
