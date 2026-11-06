import type { components } from "@comiku/api-client";

export const sourceLanguageLabels: Record<
  components["schemas"]["SourceLanguage"],
  string
> = {
  ja: "日语",
  ko: "韩语",
  en: "英语",
};

export const authorizationLabels: Record<
  components["schemas"]["AuthorizationStatus"],
  string
> = {
  pending: "待确认",
  authorized: "已授权",
  expired: "已过期",
  revoked: "已撤销",
};
