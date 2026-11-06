import { useQuery } from "@tanstack/react-query";
import { Badge, Button, Surface } from "../../components/ui";
import { client, unwrap } from "../account/api";
import { sourceAdapterLabels } from "../workspace/source-labels";

export function SourceConnections() {
  const sources = useQuery({
    queryKey: ["source-capabilities"],
    queryFn: async () => unwrap(await client.GET("/api/authors/sources")),
  });
  return (
    <Surface className="workspace-panel">
      <h2>图源接入</h2>
      {sources.isPending ? (
        <p role="status">正在读取接入状态…</p>
      ) : sources.isError ? (
        <p role="alert">
          接入状态读取失败。
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void sources.refetch()}
          >
            重试
          </Button>
        </p>
      ) : (
        <dl className="workspace-detail-list">
          {(["x", "pixiv"] as const).map((platform) => {
            const source =
              sources.data.find(
                (item) => item.platform === platform && item.available,
              ) ?? sources.data.find((item) => item.platform === platform);
            return (
              <div key={platform}>
                <dt>{platform === "x" ? "X" : "Pixiv"}</dt>
                <dd>
                  {source ? (
                    <>
                      {sourceAdapterLabels[source.adapterKey] ??
                        source.adapterKey}{" "}
                      <Badge tone={source.available ? "success" : "neutral"}>
                        {source.available ? "可用" : "暂不可用"}
                      </Badge>
                    </>
                  ) : (
                    <Badge tone="neutral">未配置</Badge>
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      )}
    </Surface>
  );
}
