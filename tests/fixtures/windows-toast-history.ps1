param([Parameter(Mandatory=$true)][string]$AppId, [switch]$Expiration)
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
  // ExpirationTime is a DateTimeOffset?: an empty string means the toast has none.
  public static string[] Expirations(object target, MethodInfo method, string id) {
    var history = method.Invoke(target, new object[] { id }) as IEnumerable;
    if (history == null) throw new InvalidOperationException("History is not enumerable");
    var result = new List<string>();
    foreach (object toast in history) {
      object value = toast.GetType().GetProperty("ExpirationTime").GetValue(toast, null);
      result.Add(value == null ? "" : ((DateTimeOffset)value).UtcDateTime.ToString("o"));
    }
    return result.ToArray();
  }
}
'@
  $manager = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]
  $historyType = [Windows.UI.Notifications.ToastNotificationHistory, Windows.UI.Notifications, ContentType=WindowsRuntime]
  $method = $historyType.GetMethod('GetHistory', [Type[]]@([string]))
  if ($null -eq $method) { throw 'History method is missing' }
  $items = if ($Expiration) { [ToastHistoryProbe]::Expirations($manager::History, $method, $AppId) } else { [ToastHistoryProbe]::Xml($manager::History, $method, $AppId) }
  ConvertTo-Json -InputObject @($items) -Compress
} catch {
  [Console]::Error.WriteLine($_.Exception.ToString())
  exit 1
}
