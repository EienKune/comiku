import { SetMetadata } from "@nestjs/common";
import type { Request } from "express";
import { Role } from "../generated/prisma/client.js";

export const roleLabels: Record<Role, string> = {
  admin: "管理员",
  source: "图源",
  translator: "翻译",
  proofreader: "校对",
  typesetter: "嵌字",
  operator: "运营",
  reviewer: "审核",
};
export type Permission =
  | "self"
  | "members:read"
  | "accounts:manage"
  | "system:manage"
  | "audit:read"
  | "authors:read"
  | "authors:sensitive"
  | "authors:manage"
  | "authors:admin"
  | "candidates:read"
  | "candidates:manage"
  | "works:read"
  | "works:metadata"
  | "works:translate"
  | "works:proofread"
  | "works:typeset"
  | "works:publish"
  | "works:review:raise"
  | "reviews:resolve"
  | "works:admin"
  | "dashboard:read";
export function permissionsFor(
  roles: Role[],
  mustChangePassword: boolean,
): Permission[] {
  if (mustChangePassword || !roles.length) return ["self"];
  const permissions: Permission[] = [
    "self",
    "members:read",
    "authors:read",
    "works:read",
    "works:review:raise",
    "dashboard:read",
  ];
  if (roles.includes(Role.source)) {
    permissions.push(
      "authors:sensitive",
      "authors:manage",
      "candidates:read",
      "candidates:manage",
      "works:metadata",
    );
  }
  if (roles.includes(Role.translator)) permissions.push("works:translate");
  if (roles.includes(Role.proofreader)) permissions.push("works:proofread");
  if (roles.includes(Role.typesetter)) permissions.push("works:typeset");
  if (roles.includes(Role.operator))
    permissions.push("works:publish", "works:metadata");
  if (roles.includes(Role.reviewer)) {
    permissions.push("candidates:read");
  }
  if (roles.includes(Role.admin)) {
    permissions.push(
      "accounts:manage",
      "system:manage",
      "audit:read",
      "authors:sensitive",
      "authors:manage",
      "authors:admin",
      "candidates:read",
      "candidates:manage",
      "works:metadata",
      "works:translate",
      "works:proofread",
      "works:typeset",
      "works:publish",
      "reviews:resolve",
      "works:admin",
    );
  }
  return [...new Set(permissions)];
}
export interface AccessPolicy {
  permission?: Permission;
  public?: boolean;
  allowPasswordChange?: boolean;
  contentType?:
    | "application/json"
    | "multipart/form-data"
    | "application/octet-stream"
    | null;
}
export const ACCESS = Symbol("ACCESS");
export const Access = (policy: AccessPolicy) => SetMetadata(ACCESS, policy);
export interface Actor {
  userId: string;
  sessionId: string;
}
export interface AuthRequest extends Request {
  actor: Actor;
}
