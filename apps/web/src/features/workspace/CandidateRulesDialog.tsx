import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import type { components } from "@comiku/api-client";
import { Badge, Button, SelectField, TextField } from "../../components/ui";
import { client, unwrap } from "../account/api";
import { useAction } from "../account/use-action";
import "./candidates.css";

type Group = components["schemas"]["CandidateTagGroupDto"];
const groupLabels: Record<Group["kind"], string> = {
  valid: "优先标签",
  blocked: "降级标签",
  gray: "历史灰名单",
};
const sectionLabels = {
  priority: "优先审核",
  uncertain: "待判断",
  low_priority: "低优先级",
};

export function CandidateRulesDialog({
  canManage,
  onClose,
}: {
  canManage: boolean;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const action = useAction();
  const { success, setSuccess } = action;
  const [editing, setEditing] = useState<Group | "new" | null>(null);
  const [name, setName] = useState("");
  const [aliases, setAliases] = useState("");
  const [kind, setKind] = useState<Group["kind"]>("valid");
  const policy = useQuery({
    queryKey: ["candidate-review-policy"],
    queryFn: async ({ signal }) =>
      unwrap(await client.GET("/api/candidates/review-policy", { signal })),
    staleTime: 0,
  });
  const groups = useQuery({
    queryKey: ["candidate-tag-groups"],
    queryFn: async ({ signal }) =>
      unwrap(await client.GET("/api/candidates/tag-groups", { signal })),
    enabled: canManage,
    staleTime: 0,
  });
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    element?.showModal();
    return () => {
      element?.close();
      previous?.focus();
    };
  }, []);
  useEffect(() => {
    if (!success) return;
    const timer = setTimeout(() => setSuccess(""), 6000);
    return () => clearTimeout(timer);
  }, [success, setSuccess]);
  function edit(group: Group | "new") {
    setEditing(group);
    setName(group === "new" ? "" : group.name);
    setAliases(group === "new" ? "" : group.aliases.join("，"));
    setKind(group === "new" ? "valid" : group.kind);
  }
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void action.run(async () => {
      const values = aliases
        .split(/[,，\s]+/)
        .map((value) => value.trim())
        .filter(Boolean);
      if (editing && editing !== "new") {
        await unwrap(
          await client.PATCH("/api/candidates/tag-groups/{id}", {
            params: { path: { id: editing.id } },
            body: {
              name,
              kind,
              aliases: values,
              enabled: editing.enabled,
              expectedRevision: editing.revision,
            },
          }),
        );
      } else {
        await unwrap(
          await client.POST("/api/candidates/tag-groups", {
            body: { name, kind, aliases: values, enabled: true },
          }),
        );
      }
      setEditing(null);
      await groups.refetch();
      action.setSuccess("规则已保存，刷新列表后应用新分区。");
    });
  }
  function toggle(group: Group) {
    void action.run(async () => {
      await unwrap(
        await client.PATCH("/api/candidates/tag-groups/{id}", {
          params: { path: { id: group.id } },
          body: {
            name: group.name,
            kind: group.kind,
            aliases: group.aliases,
            enabled: !group.enabled,
            expectedRevision: group.revision,
          },
        }),
      );
      await groups.refetch();
      action.setSuccess("规则已保存，刷新列表后应用新分区。");
    });
  }
  return (
    <dialog
      ref={dialog}
      className="workspace-business-dialog candidate-rules-dialog"
      aria-labelledby={heading}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const rect = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom
          )
            onClose();
        }
      }}
    >
      <header>
        <h2 id={heading}>审核规则</h2>
        <Button
          size="sm"
          variant="ghost"
          aria-label="关闭审核规则"
          onClick={onClose}
        >
          关闭
        </Button>
      </header>
      <div className="candidate-rules-dialog__body">
        <section aria-labelledby={`${heading}-policy`}>
          <h3 id={`${heading}-policy`}>分区说明</h3>
          <p>所有区域均可人工入库。分区只决定审核顺序。</p>
          {policy.isPending ? (
            <p role="status">正在读取分区规则…</p>
          ) : policy.error ? (
            <p role="alert">{policy.error.message}</p>
          ) : policy.data?.classes.length ? (
            <ul className="candidate-rules-mapping">
              {policy.data.classes.map((category) => (
                <li key={category.label}>
                  <Badge tone={category.tone}>{category.text}</Badge>
                  <span>→ {sectionLabels[category.triageGroup]}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p>当前未启用模型分类映射；证据不足时进入待判断。</p>
          )}
          <p>
            优先标签或任一图片的优先类别提供正向线索；同时命中降级标签时进入待判断。识别失败不作为负面证据。
          </p>
          <p>
            修改标签规则只重算命中与分区，不重新下载或调用模型；当前列表在主动刷新后应用。
          </p>
        </section>
        {canManage && (
          <section aria-labelledby={`${heading}-tags`}>
            <div className="candidate-rules-heading">
              <h3 id={`${heading}-tags`}>标签规则</h3>
              <Button
                size="sm"
                variant="secondary"
                disabled={action.busy}
                onClick={() => edit("new")}
              >
                新增标签组
              </Button>
            </div>
            {groups.isPending ? (
              <p role="status">正在读取标签规则…</p>
            ) : groups.error ? (
              <p role="alert">{groups.error.message}</p>
            ) : groups.data?.length ? (
              <div className="candidate-rules-table-scroll">
                <table className="candidate-rules-table">
                  <thead>
                    <tr>
                      <th>名称</th>
                      <th>作用 / 别名</th>
                      <th>状态</th>
                      <th>
                        <span className="sr-only">操作</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {groups.data.map((group) => (
                      <tr key={group.id}>
                        <th scope="row">{group.name}</th>
                        <td>
                          {groupLabels[group.kind]}
                          <small>{group.aliases.length} 个别名</small>
                          <small className="candidate-rules-aliases">
                            {group.aliases.slice(0, 2).join("、")}
                            {group.aliases.length > 2 ? "…" : ""}
                          </small>
                        </td>
                        <td>{group.enabled ? "已启用" : "已停用"}</td>
                        <td>
                          <div className="candidate-rules-row-actions">
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-label={`编辑 ${group.name}`}
                              disabled={action.busy}
                              onClick={() => edit(group)}
                            >
                              编辑
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-label={`${group.enabled ? "停用" : "启用"} ${group.name}`}
                              disabled={action.busy}
                              onClick={() => toggle(group)}
                            >
                              {group.enabled ? "停用" : "启用"}
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p>尚未设置标签规则。</p>
            )}
            {editing && (
              <form
                key={editing === "new" ? "new" : editing.id}
                className="candidate-rules-form"
                onSubmit={save}
              >
                <h4>
                  {editing === "new" ? "新增标签组" : `编辑 ${editing.name}`}
                </h4>
                <TextField
                  label="标签组名称"
                  autoFocus
                  required
                  maxLength={100}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
                <SelectField
                  label="规则类型"
                  value={kind}
                  onValueChange={(value) => setKind(value as Group["kind"])}
                >
                  <option value="valid">优先标签</option>
                  <option value="blocked">降级标签</option>
                  {editing !== "new" && editing.kind === "gray" && (
                    <option value="gray">历史灰名单</option>
                  )}
                </SelectField>
                <TextField
                  label="标签别名"
                  required
                  value={aliases}
                  onChange={(event) => setAliases(event.target.value)}
                />
                <div className="workspace-inline-actions">
                  <Button type="submit" size="sm" loading={action.busy}>
                    {editing === "new" ? "新增规则" : "保存修改"}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label="取消编辑"
                    disabled={action.busy}
                    onClick={() => setEditing(null)}
                  >
                    取消
                  </Button>
                </div>
              </form>
            )}
          </section>
        )}
        {action.error && (
          <p role="alert" className="account-error">
            {action.error}
          </p>
        )}
        {action.success && (
          <p role="status" className="candidate-rules-notice">
            {action.success}
          </p>
        )}
      </div>
    </dialog>
  );
}
