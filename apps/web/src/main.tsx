import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./features/account/api";
import { AccountLayout } from "./features/account/AccountApp";
import { LoginPage } from "./features/account/LoginPage";
import { SettingsRoutingProvider } from "./features/account/SettingsRoutingProvider";
import { WorkspaceRoutes } from "./features/account/WorkspaceRoutes";
import { DesignSystemPlayground } from "./playground/DesignSystemPlayground";
import "./styles/tokens.css";
import "./styles/global.css";
import "./features/workspace/workspace.css";

const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  {
    element: (
      <SettingsRoutingProvider>
        <AccountLayout />
      </SettingsRoutingProvider>
    ),
    children: [{ path: "*", element: <WorkspaceRoutes /> }],
  },
  {
    path: "/playground",
    element: <DesignSystemPlayground />,
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
