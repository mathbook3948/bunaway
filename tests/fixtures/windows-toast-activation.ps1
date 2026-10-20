$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
  $class = [Windows.UI.Notifications.ToastActivatedEventArgs, Windows.UI.Notifications, ContentType=WindowsRuntime]
  $result = foreach ($type in $class.GetInterfaces()) {
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
