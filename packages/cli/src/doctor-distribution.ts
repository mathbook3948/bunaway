import {
  findIscc,
  findWindowsKitTool,
  type PackagingConfig,
  requiredWindowsTools,
} from "@bunaway/packaging";

/** Looks up an installed tool and returns its path, or undefined when it is missing. */
export interface DistributionToolFinders {
  iscc: () => Promise<string | undefined>;
  signtool: () => Promise<string | undefined>;
}

export const installedToolFinders: DistributionToolFinders = {
  iscc: findIscc,
  signtool: () => findWindowsKitTool("signtool.exe"),
};

export interface DistributionCheck {
  name: string;
  passed: boolean;
  detail: string;
}

/**
 * Checks that the tools `bunaway package` needs for the declared Windows channels are installed.
 *
 * Uses the same lookups as packaging so doctor and package agree. It only tests that a tool
 * exists: nothing is run, and signing certificates and password variables are never opened. An
 * app without Inno channels yields no checks, so development-only apps see no new lines.
 */
export async function checkDistributionTools(
  bundle: PackagingConfig | undefined,
  finders: DistributionToolFinders = installedToolFinders,
): Promise<DistributionCheck[]> {
  if (!bundle) {
    return [];
  }
  const checks: DistributionCheck[] = [];
  for (const { tool, needs } of requiredWindowsTools(bundle)) {
    const path = await (tool === "ISCC.exe"
      ? finders.iscc()
      : finders.signtool());
    const reason = `needed by ${needs.join(", ")}`;
    checks.push({
      name: `distribution/${tool}`,
      passed: path !== undefined,
      detail: path
        ? `${path}; ${reason}`
        : `not found; ${reason}; ${installHint(tool)}`,
    });
  }
  return checks;
}

function installHint(tool: "ISCC.exe" | "signtool.exe"): string {
  return tool === "ISCC.exe"
    ? "install Inno Setup 6.3 or newer"
    : "install the Windows 10/11 SDK signing tools";
}
