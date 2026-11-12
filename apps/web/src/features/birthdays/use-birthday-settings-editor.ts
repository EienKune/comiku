import type { components } from "@comiku/api-client";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { client, unwrap } from "../account/api";
import { birthdayError, useBirthdayQuery } from "./use-birthday-query";

type Settings = components["schemas"]["BirthdaySettingsDto"];
type Management = components["schemas"]["BirthdayManagementDto"];
type Fields = {
  display: Pick<Settings, "displayEnabled">;
  reminders: Pick<Settings, "remindersEnabled" | "sendTime" | "offsetDays">;
};
const key = ["birthdays", "settings"];
function owned<S extends keyof Fields>(
  scope: S,
  settings: Settings,
): Fields[S] {
  return (
    scope === "display"
      ? { displayEnabled: settings.displayEnabled }
      : {
          remindersEnabled: settings.remindersEnabled,
          sendTime: settings.sendTime,
          offsetDays: settings.offsetDays,
        }
  ) as Fields[S];
}

export function useBirthdaySettingsEditor<S extends keyof Fields>(
  scope: S,
  enabled: boolean,
) {
  const cache = useQueryClient();
  const query = useBirthdayQuery("settings", enabled, async (signal) =>
    unwrap(await client.GET("/api/birthdays/settings", { signal })),
  );
  const [draft, setDraft] = useState<{
    fields: Fields[S];
    baseRevision: number;
  } | null>(null);
  const [comparison, setComparison] = useState<Settings | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const current =
    draft?.fields ??
    (query.data?.settings && owned(scope, query.data.settings));
  function change(patch: Partial<Fields[S]>) {
    if (!current || !query.data?.settings) return;
    setDraft({
      fields: { ...current, ...patch },
      baseRevision: draft?.baseRevision ?? query.data.settings.revision,
    });
    setComparison(null);
    setSuccess("");
  }
  async function save() {
    if (!enabled || !current || busy || conflict) return;
    const snapshot = cache.getQueryData<Management>(key)?.settings;
    if (!snapshot) return;
    const pending = draft ?? {
      fields: owned(scope, snapshot),
      baseRevision: snapshot.revision,
    };
    setDraft(pending);
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      // Only this editor's fields come from its draft. The complete DTO's other
      // fields always come from one server snapshot, with the original fence.
      const fields = { ...snapshot, ...pending.fields };
      const result = await client.PATCH("/api/birthdays/settings", {
        body: {
          expectedRevision: pending.baseRevision,
          displayEnabled: fields.displayEnabled,
          remindersEnabled: fields.remindersEnabled,
          sendTime: fields.sendTime,
          offsetDays: fields.offsetDays.filter(
            (day): day is 0 | 1 | 7 => day === 0 || day === 1 || day === 7,
          ),
        },
      });
      if (result.response.status === 409) {
        setConflict(true);
        throw new Error("设置已变化，草稿已保留。请核对当前版本。");
      }
      const saved = await unwrap(result);
      cache.setQueryData<Management>(key, (previous) =>
        previous ? { ...previous, settings: saved } : previous,
      );
      setDraft(null);
      setComparison(null);
      setConflict(false);
      void cache.invalidateQueries({ queryKey: key });
      if (scope === "display")
        void cache.invalidateQueries({ queryKey: ["birthdays", "summary"] });
      setSuccess(
        scope === "display" ? "工作台展示已保存。" : "生日提醒已保存。",
      );
    } catch (caught) {
      setError(birthdayError(caught));
    } finally {
      setBusy(false);
    }
  }
  async function compare() {
    if (!enabled || busy) return;
    setError("");
    try {
      const latest = await query.refetch();
      if (latest.isError) throw latest.error;
      if (latest.data) setComparison(latest.data.settings);
    } catch (caught) {
      setError(birthdayError(caught));
    }
  }
  function adopt() {
    if (!comparison || !draft) return;
    setDraft({ fields: draft.fields, baseRevision: comparison.revision });
    setComparison(null);
    setConflict(false);
    setError("");
  }
  function discard() {
    setDraft(null);
    setComparison(null);
    setConflict(false);
    setError("");
    setSuccess("");
  }
  return {
    query,
    current,
    draft,
    comparison,
    conflict,
    busy,
    error,
    success,
    change,
    save,
    compare,
    adopt,
    discard,
    dismissError: () => setError(""),
  };
}
