import type { Environment } from "../config/environment.js";
export const sessionCookieOptions = (environment: Environment) => ({
  httpOnly: true,
  secure: environment.nodeEnv === "production",
  sameSite: "lax" as const,
  path: "/api",
});
