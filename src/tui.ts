import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { getCopilotUsageDialogMessage } from "./usage.js";

const id = "@gnahz77/opencode-copilot-multi-auth";

function showErrorToast(api: Parameters<TuiPlugin>[0], error: unknown) {
  api.ui.toast({
    title: "Copilot Usage",
    message: error instanceof Error ? error.message : String(error),
    variant: "error",
    duration: 7000,
  });
}

async function showCopilotUsageDialog(api: Parameters<TuiPlugin>[0]) {
  try {
    const message = await getCopilotUsageDialogMessage();
    api.ui.dialog.setSize("xlarge");
    api.ui.dialog.replace(() => api.ui.DialogAlert({
      title: "Copilot Usage",
      message,
    }));
  } catch (error) {
    showErrorToast(api, error);
  }
}

const tui: TuiPlugin = async (api) => {
  api.command.register(() => [
    {
      title: "Copilot Usage",
      value: "copilot-usage",
      description: "Show Copilot usage for all accounts in the local account pool.",
      category: "GitHub Copilot",
      slash: {
        name: "copilot-usage",
      },
      onSelect() {
        void showCopilotUsageDialog(api);
      },
    },
  ]);
};

const pluginModule: TuiPluginModule & { id: string } = {
  id,
  tui,
};

export default pluginModule;
