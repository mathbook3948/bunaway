import { currentTarget } from "./build.ts";
import { validateProject } from "./config.ts";

export async function doctor(directory: string): Promise<boolean> {
  let ok = true;
  const check = (name: string, passed: boolean, detail: string) => {
    console.log(`${passed ? "OK" : "FAIL"} ${name}: ${detail}`);
    if (!passed) ok = false;
  };
  check("Bun", Bun.version === "1.4.2", `${Bun.version}; required 1.4.2 for development/build`);
  try {
    check("target", true, currentTarget());
  } catch (error) {
    check("target", false, String(error));
  }
  try {
    await validateProject(directory);
    check("configuration/policy", true, "valid");
  } catch (error) {
    check("configuration/policy", false, String(error));
  }
  for (const name of process.platform === "win32" ? ["pwsh"] : ["zsh", "clang++", "codesign"]) {
    check(name, Bun.which(name) !== null, Bun.which(name) ?? "not on PATH");
  }
  if (process.platform === "win32") {
    const webview = Bun.spawn(
      [
        "powershell.exe",
        "-NoProfile",
        "-Command",
        "$keys = @('HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\*', 'HKLM:\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\*', 'HKCU:\\Software\\Microsoft\\EdgeUpdate\\Clients\\*'); Get-ItemProperty $keys -ErrorAction SilentlyContinue | Where-Object { $_.name -like '*WebView2*' -and $_.pv -ne '0.0.0.0' } | Select-Object -ExpandProperty pv",
      ],
      { stdout: "pipe", stderr: "ignore" },
    );
    const version = (await new Response(webview.stdout).text()).trim();
    await webview.exited;
    check("WebView2 Evergreen", !!version, version || "not detected; install Evergreen runtime");
  }
  console.log(
    process.platform === "win32"
      ? "Windows uses bundled Bun FFI; execution requires WebView2 Evergreen. The prepare script verifies Bun and Loader pins."
      : "Native build requires Xcode CLT; macOS 14+ arm64. Local ad-hoc signing only, no notarization.",
  );
  return ok;
}
