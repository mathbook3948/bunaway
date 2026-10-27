import type { PackagingConfig } from "./config.ts";
import type { ChannelConfig, ChannelId } from "./contract.ts";

/** A Windows tool the configured channels invoke, and why. */
export interface RequiredWindowsTool {
  tool: "ISCC.exe" | "signtool.exe";
  /** Channels and settings that need the tool, for diagnostics. */
  needs: string[];
}

/** Channels whose adapter compiles an Inno Setup installer. */
const INNO_CHANNELS = [
  "win-direct",
  "win-store-unpackaged",
] as const satisfies readonly ChannelId[];

function usesOfflineWebView2(channel: ChannelConfig): boolean {
  return typeof channel.webView2 === "object";
}

/**
 * Lists the Windows tools `bunaway package` will invoke for the declared Windows channels.
 *
 * Only the Inno channels run external tools: they compile with ISCC.exe, and use signtool.exe
 * when the effective signing (channel over top-level) is set or when the offline WebView2 installer
 * signature is verified. The MSIX channel is assembled in-process and invokes none. An app that
 * declares no Inno channel gets an empty list.
 */
export function requiredWindowsTools(
  config: PackagingConfig,
): RequiredWindowsTool[] {
  const iscc: string[] = [];
  const signtool: string[] = [];
  for (const id of INNO_CHANNELS) {
    const channel = config.channels?.[id];
    if (!channel) {
      continue;
    }
    iscc.push(id);
    if (channel.signing ?? config.signing) {
      signtool.push(`${id} signing`);
    }
    if (usesOfflineWebView2(channel)) {
      signtool.push(`${id} webView2 offline`);
    }
  }
  const tools: RequiredWindowsTool[] = [];
  if (iscc.length > 0) {
    tools.push({
      tool: "ISCC.exe",
      needs: iscc,
    });
  }
  if (signtool.length > 0) {
    tools.push({
      tool: "signtool.exe",
      needs: signtool,
    });
  }
  return tools;
}
