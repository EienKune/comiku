import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { useAccount } from "./account-context";
import { AccountsPage, MembersPage } from "./AccountsPage";
import { ProfilePage, PasswordPage } from "./ProfilePage";
import { LoadingState, SectionHeading } from "./forms";
import { isPersonalSettings, useSettingsNavigation } from "./settings-routing";

const DashboardPage = lazy(async () => ({
  default: (await import("../workspace/BusinessPages")).DashboardPage,
}));
const AuthorsPage = lazy(async () => ({
  default: (await import("../workspace/BusinessPages")).AuthorsPage,
}));
const AuthorDetailPage = lazy(async () => ({
  default: (await import("../workspace/BusinessPages")).AuthorDetailPage,
}));
const CandidatesPage = lazy(async () => ({
  default: (await import("../workspace/BusinessPages")).CandidatesPage,
}));
const WorksPage = lazy(async () => ({
  default: (await import("../workspace/BusinessPages")).WorksPage,
}));
const WorkDetailPage = lazy(async () => ({
  default: (await import("../workspace/BusinessPages")).WorkDetailPage,
}));
const TranslationEditorPage = lazy(async () => ({
  default: (await import("../editor/TranslationEditorPage"))
    .TranslationEditorPage,
}));
const ReviewsPage = lazy(async () => ({
  default: (await import("../workspace/BusinessPages")).ReviewsPage,
}));
const ReviewDetailPage = lazy(async () => ({
  default: (await import("../workspace/BusinessPages")).ReviewDetailPage,
}));
const BusinessAuditPage = lazy(async () => ({
  default: (await import("../workspace/BusinessPages")).BusinessAuditPage,
}));
const SystemManagementPage = lazy(async () => ({
  default: (await import("../system/SystemManagementPage"))
    .SystemManagementPage,
}));

export function WorkspaceRoutes() {
  const location = useLocation();
  const user = useAccount();
  const { background } = useSettingsNavigation();
  if (user.mustChangePassword) return <PasswordPage />;
  const settings = isPersonalSettings(location.pathname);
  return (
    <>
      <Suspense fallback={<LoadingState />}>
        <Routes location={settings ? (background ?? "/") : location}>
          <Route
            path="/"
            element={
              user.permissions.includes("dashboard:read") ? (
                <DashboardPage />
              ) : (
                <SectionHeading title="尚未分配职务">
                  请联系管理员开通团队访问权限；仍可维护个人资料和密码。
                </SectionHeading>
              )
            }
          />
          <Route path="/authors" element={<AuthorsPage />} />
          <Route path="/authors/:id" element={<AuthorDetailPage />} />
          <Route path="/candidates" element={<CandidatesPage />} />
          <Route path="/works" element={<WorksPage />} />
          <Route path="/works/:id" element={<WorkDetailPage />} />
          <Route path="/works/:id/editor" element={<TranslationEditorPage />} />
          <Route path="/reviews" element={<ReviewsPage />} />
          <Route path="/reviews/:id" element={<ReviewDetailPage />} />
          <Route path="/audit" element={<BusinessAuditPage />} />
          <Route path="/settings/users" element={<AccountsPage />} />
          <Route path="/settings/system" element={<SystemManagementPage />} />
          <Route path="/members" element={<MembersPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
      {settings && (
        <Routes location={location}>
          <Route path="/settings" element={<ProfilePage />} />
          <Route path="/settings/password" element={<PasswordPage />} />
        </Routes>
      )}
    </>
  );
}
