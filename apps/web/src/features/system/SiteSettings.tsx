import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { components } from "@comiku/api-client";
import { Button, SelectField, Surface, TextField } from "../../components/ui";
import { ImagePicker } from "../../components/ImagePicker";
import { Avatar } from "../../components/Avatar";
import { themePresets } from "../../styles/theme";
import { authenticatedFetch, client, unwrap } from "../account/api";
import { Feedback } from "../account/forms";
import { useAction } from "../account/use-action";
import {
  defaultSite,
  siteIconUrl,
  siteQueryKey,
  type SiteSettings as Settings,
} from "../site/site-config";

type Draft = Pick<Settings, "name" | "themePresetId"> & {
  iconAction: "keep" | "remove" | "adopt";
};
const managementKey = ["site-settings"];
export function SiteSettings({ enabled }: { enabled: boolean }) {
  const cache = useQueryClient();
  const settings = useQuery({
    queryKey: managementKey,
    enabled,
    queryFn: ({ signal }) =>
      client.GET("/api/site/settings", { signal }).then(unwrap),
  });
  const action = useAction();
  const [draft, setDraft] = useState<Draft>();
  const [revision, setRevision] = useState<number>();
  const [file, setFile] = useState<File>();
  const [prepared, setPrepared] = useState<{
    file: File;
    assetId: string;
    expiresAt: string;
  }>();
  const [conflict, setConflict] = useState(false);
  const [current, setCurrent] = useState<Settings>();
  const [validation, setValidation] = useState("");
  const value: Draft = draft ?? {
    ...(settings.data ?? defaultSite),
    iconAction: "keep",
  };
  const disabled =
    !enabled || !settings.data || settings.isError || action.busy;
  function edit(change: Partial<Draft>) {
    setRevision((old) => old ?? settings.data?.revision);
    setDraft({ ...value, ...change });
    action.clearError();
    action.setSuccess("");
  }
  function reset() {
    setDraft(undefined);
    setRevision(undefined);
    setFile(undefined);
    setPrepared(undefined);
    setConflict(false);
    setCurrent(undefined);
    setValidation("");
    action.clearError();
    action.setSuccess("");
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (disabled || !draft || conflict) return;
    if (!value.name.trim() || [...value.name.trim()].length > 64) {
      setValidation("请输入 1–64 个字符的站点名称");
      return;
    }
    setValidation("");
    await action.run(async () => {
      let asset = prepared;
      if (
        file &&
        value.iconAction === "adopt" &&
        (!asset ||
          asset.file !== file ||
          new Date(asset.expiresAt) <= new Date())
      ) {
        const body = new FormData();
        body.append("file", file);
        const response = await authenticatedFetch("/api/site/icon-uploads", {
          method: "POST",
          headers: { "X-Comiku-Request": "1" },
          body,
        });
        const data = await response.json();
        if (!response.ok)
          throw new Error(
            typeof data.message === "string"
              ? data.message
              : "图标上传失败，请重试",
          );
        const uploaded = data as components["schemas"]["SiteIconUploadDto"];
        asset = { ...uploaded, file };
        setPrepared(asset);
      }
      const result = await client.PATCH("/api/site/settings", {
        body: {
          name: value.name.trim(),
          themePresetId: value.themePresetId,
          expectedRevision: revision ?? settings.data!.revision,
          iconAction: value.iconAction,
          ...(value.iconAction === "adopt" ? { assetId: asset?.assetId } : {}),
        },
      });
      if (result.response.status === 409) {
        setConflict(true);
        setCurrent(undefined);
      }
      const updated = await unwrap(result);
      await cache.cancelQueries({ queryKey: managementKey });
      await cache.cancelQueries({ queryKey: siteQueryKey });
      cache.setQueryData(managementKey, updated);
      cache.setQueryData(siteQueryKey, updated);
      reset();
      action.setSuccess("站点设置已保存");
    });
  }
  return (
    <Surface className="account-card account-content-boundary">
      <h2>站点设置</h2>
      <form
        className="account-form"
        aria-label="站点设置"
        onSubmit={(event) => void save(event)}
      >
        {settings.isPending && <p role="status">正在读取站点设置…</p>}
        {settings.isError && (
          <div>
            <p role="alert">暂时无法读取站点设置。</p>
            <Button
              type="button"
              variant="secondary"
              disabled={!enabled}
              onClick={() => void settings.refetch()}
            >
              重新读取
            </Button>
          </div>
        )}
        <TextField
          label="站点名称"
          value={value.name}
          maxLength={128}
          disabled={disabled}
          onChange={(event) => edit({ name: event.target.value })}
        />
        <ImagePicker
          label="站点图标"
          variant="avatar"
          formats="images"
          files={file ? [file] : []}
          maxFileSize={5 * 1024 * 1024}
          disabled={disabled}
          selectionStatus="图标未保存"
          currentAvatar={
            settings.data?.iconVersion && value.iconAction !== "remove" ? (
              <img
                src={siteIconUrl(settings.data.iconVersion)}
                alt=""
                width={56}
                height={56}
                style={{ objectFit: "contain" }}
              />
            ) : (
              <Avatar name={value.name} size="lg" />
            )
          }
          avatarFallback={<Avatar name={value.name} size="lg" />}
          onChange={(files) => {
            const next = files[0];
            if (next && !next.size) {
              setValidation("请选择非空图片");
              return;
            }
            setFile(next);
            setPrepared(undefined);
            edit({ iconAction: next ? "adopt" : "keep" });
            setValidation("");
          }}
        />
        {(settings.data?.iconVersion || file) && (
          <Button
            type="button"
            variant="secondary"
            disabled={disabled}
            onClick={() => {
              setFile(undefined);
              setPrepared(undefined);
              edit({ iconAction: "remove" });
            }}
          >
            移除图标
          </Button>
        )}
        <SelectField
          label="默认外观"
          value={value.themePresetId}
          disabled={disabled}
          onValueChange={(themePresetId) =>
            edit({ themePresetId: themePresetId as Settings["themePresetId"] })
          }
        >
          {themePresets.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.name}
            </option>
          ))}
        </SelectField>
        <p>用于登录页及跟随站点外观的成员，保留成员的个人选择。</p>
        <Feedback error={validation || action.error} success={action.success} />
        {conflict && (
          <Button
            type="button"
            variant="secondary"
            disabled={!enabled || action.busy}
            onClick={() =>
              void action.run(async () => {
                const latest = await unwrap(
                  await client.GET("/api/site/settings"),
                );
                cache.setQueryData(managementKey, latest);
                setCurrent(latest);
                setRevision(latest.revision);
                setConflict(false);
              })
            }
          >
            读取当前设置
          </Button>
        )}
        {current && (
          <p>
            当前站点：{current.name}，默认外观：
            {themePresets.find((p) => p.id === current.themePresetId)?.name}
            。草稿已保留，确认后再次保存。
          </p>
        )}
        <div className="account-actions">
          <Button
            type="submit"
            loading={action.busy}
            disabled={disabled || !draft || conflict}
          >
            保存更改
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={!enabled || action.busy || !draft}
            onClick={reset}
          >
            取消更改
          </Button>
        </div>
      </form>
    </Surface>
  );
}
