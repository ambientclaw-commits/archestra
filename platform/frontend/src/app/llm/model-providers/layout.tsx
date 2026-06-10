"use client";

import { usePathname } from "next/navigation";
import { createContext, useContext, useMemo, useState } from "react";
import { PageLayout } from "@/components/page-layout";
import { useFeature } from "@/lib/config/config.query";

const TABS = [
  {
    label: "API Keys",
    href: "/llm/model-providers/api-keys",
  },
  {
    label: "Models",
    href: "/llm/model-providers/models",
  },
];

const SMART_ROUTER_TAB = {
  label: "Smart Router",
  href: "/llm/model-providers/smart-router",
};

const PAGE_CONFIG: Record<string, { title: string; description: string }> = {
  "/llm/model-providers/api-keys": {
    title: "API Keys",
    description:
      "Manage API keys for model providers used in Chat and LLM Proxy",
  },
  "/llm/model-providers/models": {
    title: "Models",
    description:
      'Models available from your configured API keys. Use "Refresh Models" to re-fetch models and capabilities from providers.',
  },
  "/llm/model-providers/smart-router": {
    title: "Smart Router",
    description:
      "Route each request between an everyday and a premium model by difficulty, with a Cost / Balanced / Quality mode.",
  },
};

type ModelProvidersLayoutContextType = {
  setActionButton: (button: React.ReactNode) => void;
};

const ModelProvidersLayoutContext =
  createContext<ModelProvidersLayoutContextType>({
    setActionButton: () => {},
  });

export function useSetModelProvidersAction() {
  return useContext(ModelProvidersLayoutContext).setActionButton;
}

export default function ModelProvidersLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const smartRouterEnabled = useFeature("smartRouterEnabled");
  const tabs = smartRouterEnabled ? [...TABS, SMART_ROUTER_TAB] : TABS;
  const [actionButton, setActionButton] = useState<React.ReactNode>(null);

  const config = PAGE_CONFIG[pathname] ?? {
    title: "Model Providers",
    description: "",
  };

  const contextValue = useMemo(() => ({ setActionButton }), []);

  return (
    <ModelProvidersLayoutContext.Provider value={contextValue}>
      <PageLayout
        title={config.title}
        description={config.description}
        tabs={tabs}
        actionButton={actionButton}
      >
        {children}
      </PageLayout>
    </ModelProvidersLayoutContext.Provider>
  );
}
