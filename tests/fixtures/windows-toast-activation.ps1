$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
  $types = @(
    [Windows.UI.Notifications.IToastActivatedEventArgs, Windows.UI.Notifications, ContentType=WindowsRuntime],
    [Windows.UI.Notifications.IToastActivatedEventArgs2, Windows.UI.Notifications, ContentType=WindowsRuntime],
    [Windows.Foundation.IPropertyValue, Windows.Foundation, ContentType=WindowsRuntime]
  )
  $result = foreach ($type in $types) {
    [pscustomobject]@{
      name = $type.Name
      guid = $type.GUID.ToString()
      methods = @($type.GetMethods() | ForEach-Object { $_.Name })
    }
  }
  ConvertTo-Json -InputObject @($result) -Compress
} catch {
  [Console]::Error.WriteLine($_.Exception.ToString())
  exit 1
}
