import createClient from "openapi-fetch";
import type { paths, components } from "./schema.js";

export type { paths, components } from "./schema.js";
export type CurrentUser = components["schemas"]["UserDto"];
export type Role = components["schemas"]["Role"];
export function createComikuClient(baseUrl = "") {
  return createClient<paths>({
    baseUrl,
    credentials: "include",
    headers: { "X-Comiku-Request": "1" },
  });
}
