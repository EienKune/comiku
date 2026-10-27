import { useAccount } from "../account/account-context";
import { SectionHeading } from "../account/forms";
import { SourceFetchHistory } from "./SourceFetchHistory";
import "./system.css";

export function SystemManagementPage() {
  const user = useAccount();
  if (!user.permissions.includes("system:manage"))
    return (
      <SectionHeading title="无权访问">系统管理仅向管理员开放。</SectionHeading>
    );
  return (
    <>
      <SectionHeading title="系统管理" />
      <SourceFetchHistory />
    </>
  );
}
