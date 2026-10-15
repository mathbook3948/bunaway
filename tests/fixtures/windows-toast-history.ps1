param([Parameter(Mandatory=$true)][string]$AppId)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
  if ($AppId -notmatch '^test\.[a-f0-9-]{36}$') { throw 'Only fixture identities are allowed' }
  Add-Type -TypeDefinition @'
using System;
using System.Collections;
using System.Collections.Generic;
using System.Reflection;
public static class ToastHistoryProbe {
  public static string[] Xml(object target, MethodInfo method, string id) {
    var history = method.Invoke(target, new object[] { id }) as IEnumerable;
    if (history == null) throw new InvalidOperationException("History is not enumerable");
    var result = new List<string>();
    foreach (object toast in history) {
      object content = toast.GetType().GetProperty("Content").GetValue(toast, null);
      result.Add((string)content.GetType().GetMethod("GetXml").Invoke(content, null));
    }
    return result.ToArray();
  }
}
'@
  $manager = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]
  $historyType = [Windows.UI.Notifications.ToastNotificationHistory, Windows.UI.Notifications, ContentType=WindowsRuntime]
  $method = $historyType.GetMethod('GetHistory', [Type[]]@([string]))
  if ($null -eq $method) { throw 'History method is missing' }
  $xml = [ToastHistoryProbe]::Xml($manager::History, $method, $AppId)
  ConvertTo-Json -InputObject @($xml) -Compress
} catch {
  [Console]::Error.WriteLine($_.Exception.ToString())
  exit 1
}
