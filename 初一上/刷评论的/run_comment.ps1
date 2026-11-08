# ==========================================
#   CYBERPUNK HACKER TERMINAL - v3.0 (HEAVY)
# ==========================================

$Host.UI.RawUI.WindowTitle = "SYSTEM OVERRIDE - DATA BOMB"
$Host.UI.RawUI.BackgroundColor = "Black"
$Host.UI.RawUI.ForegroundColor = "Green"
Clear-Host

$cyan = "Cyan"; $green = "Green"; $red = "Red"; $yellow = "Yellow"; $white = "White"; $magenta = "Magenta"

Write-Host "================================================================" -ForegroundColor $magenta
Write-Host "    W A R N I N G :   S Y S T E M   O V E R R I D E   A C T I V E   " -ForegroundColor $red
Write-Host "================================================================" -ForegroundColor $magenta
Write-Host ""
Write-Host "[SYSTEM] Initializing kernel exploit..." -ForegroundColor $yellow
Start-Sleep -Milliseconds 400
Write-Host "[SYSTEM] Bypassing CORS firewall..." -ForegroundColor $yellow
Start-Sleep -Milliseconds 400
Write-Host "[SYSTEM] Spoofing device signature..." -ForegroundColor $yellow
Start-Sleep -Milliseconds 600
Write-Host "[SUCCESS] Tunnel established. Data bomb armed." -ForegroundColor $green
Write-Host ""

$url = "https://www.haokebang.net/aicommunity/comment/add"
$body = "content=%E5%88%B7%E5%88%B7%E5%88%B7&resourceId=130687393&resourceType=1&cuid=8a9e1dc920a294fe0a714fdf6a784c4eca358aa6&os=android&abis=0&channel=yingyongbao&appBit=32&vc=630&token=1_XPXQH3c5HRPtFHkSwi3sCCURmT25QfxM&adid=8a9e1dc920a294fe0a714fdf6a784c4eca358aa6&androidVersion=14&pkgName=com.guangsuxie.aiwriting&appId=aiwriting&vcname=6.3.0&sdk=34&device=25060RK16C&operatorid=&did=05047d83f5200002845b8180400000c7&nt=wifi&ZYBUSS=nKSAv-mUXm3UOJ8MvD4scn7wUuGm-LilwbARzzCpUmFSwAtLHOE3zQG56S6grw10&sign=8a157b36172a978f392ec245ff177727&_t_=1793501566&kakorrhaphiophobia=4502670"

$total = 20
Write-Host "[TARGET] Payload: <刷刷刷> x $total" -ForegroundColor $white
Write-Host "================================================================" -ForegroundColor $cyan

for ($i = 1; $i -le $total; $i++) {
    
    # 进度条计算
    $percent = [math]::Round(($i / $total) * 100)
    $barLength = 30
    $filledLength = [math]::Round(($i / $total) * $barLength)
    $bar = ("=" * $filledLength) + ("-" * ($barLength - $filledLength))
    
    # 生成随机十六进制数据流（装逼用）
    $randomHex = -join ((48..57) + (65..70) | Get-Random -Count 8 | ForEach-Object {[char]$_})
    
    # 打印进度
    Write-Host -NoNewline "[PAYLOAD] " -ForegroundColor $cyan
    Write-Host -NoNewline "0x$randomHex " -ForegroundColor $magenta
    Write-Host -NoNewline "|$bar| $percent% " -ForegroundColor $green
    
    try {
        $response = Invoke-RestMethod -Uri $url -Method Post -Body $body -ContentType "application/x-www-form-urlencoded"
        Write-Host -NoNewline "[SUCCESS] ID:$($response.data.commentId)" -ForegroundColor $green
    } 
    catch {
        Write-Host -NoNewline "[FAILED] Request blocked" -ForegroundColor $red
    }
    
    Write-Host ""
    
    # 如果不是最后一条，停顿一下
    if ($i -lt $total) {
        Start-Sleep -Milliseconds 800
    }
}

Write-Host "================================================================" -ForegroundColor $cyan
Write-Host "   [ MISSION ACCOMPLISHED - SYSTEM HAS BEEN OVERLOADED ]      " -ForegroundColor $yellow
Write-Host "================================================================" -ForegroundColor $cyan
Write-Host ""
Write-Host "Closing terminal in 3 seconds..." -ForegroundColor $yellow
Start-Sleep -Seconds 3