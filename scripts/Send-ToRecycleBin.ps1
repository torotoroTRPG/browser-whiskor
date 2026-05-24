# 関数として定義
function Send-ToRecycleBin {
    param(
        [Parameter(Mandatory=$true, ValueFromPipeline=$true)]
        [string[]]$Path
    )
    
    process {
        foreach ($p in $Path) {
            try {
                $fullPath = Resolve-Path $p -ErrorAction Stop
                $shell = New-Object -ComObject Shell.Application
                # 0x0はデスクトップ(ルート)を示す定数
                $item = $shell.Namespace(0).ParseName($fullPath.Path)
                if ($item) {
                    $item.InvokeVerb("delete")
                    Write-Host "ごみ箱に移動しました: $($fullPath.Path)" -ForegroundColor Green
                } else {
                    Write-Warning "アイテムが見つかりません: $p"
                }
            } catch {
                Write-Error "処理に失敗しました ($p): $_"
            }
        }
    }
}

# 使い方:
# . .\scripts\Send-ToRecycleBin.ps1
# Send-ToRecycleBin .\file.txt
# またはパイプラインから: Get-ChildItem *.tmp | Select-Object -ExpandProperty FullName | Send-ToRecycleBin
