# Met en place (ou met à jour) le serveur de tâches Studoo sur Azure for Students.
#
# À lancer depuis la racine du projet, après « az login » :
#     powershell -ExecutionPolicy Bypass -File worker\azure\deploy.ps1
#
# Ce que fait le script (tout dans le groupe de ressources « studoo ») :
#   1. un compte de stockage avec une file « studoo-jobs » (les messages de réveil, vides de contenu) ;
#   2. un environnement Container Apps « studoo-env » (profil Consumption : payé seulement quand ça tourne,
#      pas de journal Log Analytics payant) ;
#   3. un « job » « studoo-worker » (4 vCPU / 8 Go) qui démarre tout seul dès qu'un message arrive dans la file,
#      avec l'image publiée gratuitement sur ghcr.io par GitHub Actions ;
#   4. les clés de .env.worker deviennent des « secrets » du job (lues sur TON PC, jamais affichées).
# On peut le relancer sans risque (après une mise à jour du code, par exemple).
param(
    [string]$Location = "francecentral",
    [string]$Image = "ghcr.io/b2tn/studoo-worker:latest",
    [string]$EnvFile = ".env.worker"
)
$ErrorActionPreference = "Stop"
$Group = "studoo"; $Environment = "studoo-env"; $Job = "studoo-worker"; $Queue = "studoo-jobs"

function Invoke-AzCli {
    $out = & az @args
    if ($LASTEXITCODE -ne 0) { throw "La commande « az $($args[0..2] -join ' ') … » a échoué (voir le message ci-dessus)." }
    return $out
}

if (-not (Test-Path $EnvFile)) { throw "Fichier $EnvFile introuvable : lance le script depuis la racine du projet." }
$values = [ordered]@{}
foreach ($line in Get-Content $EnvFile -Encoding UTF8) {
    $t = $line.Trim()
    if (-not $t -or $t.StartsWith("#") -or -not $t.Contains("=")) { continue }
    $key, $value = $t.Split("=", 2)
    $values[$key.Trim()] = $value.Trim().Trim('"').Trim("'")
}
foreach ($needed in "DATABASE_URL", "JOB_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET") {
    if (-not $values[$needed]) { throw "$needed est vide dans $EnvFile : complète-le d'abord." }
}

Write-Host "1/5 Préparation de l'abonnement Azure…"
Invoke-AzCli extension add --name containerapp --upgrade --only-show-errors | Out-Null
Invoke-AzCli provider register --namespace Microsoft.App --wait | Out-Null
Invoke-AzCli provider register --namespace Microsoft.Storage --wait | Out-Null
Invoke-AzCli group create --name $Group --location $Location --only-show-errors | Out-Null

Write-Host "2/5 File de réveil (Azure Storage)…"
$account = Invoke-AzCli storage account list --resource-group $Group --query "[0].name" -o tsv
if (-not $account) {
    $suffix = -join ((48..57) + (97..122) | Get-Random -Count 8 | ForEach-Object { [char]$_ })
    $account = "studoo$suffix"
    Invoke-AzCli storage account create --name $account --resource-group $Group --location $Location `
        --sku Standard_LRS --kind StorageV2 --min-tls-version TLS1_2 --allow-blob-public-access false --only-show-errors | Out-Null
}
$env:AZURE_STORAGE_CONNECTION_STRING = Invoke-AzCli storage account show-connection-string --name $account --resource-group $Group --query connectionString -o tsv
Invoke-AzCli storage queue create --name $Queue --only-show-errors | Out-Null
$expiry = (Get-Date).ToUniversalTime().AddYears(3).ToString("yyyy-MM-ddTHH:mmZ")
$sasAdd = Invoke-AzCli storage queue generate-sas --name $Queue --permissions a --expiry $expiry --https-only -o tsv
$sasProcess = Invoke-AzCli storage queue generate-sas --name $Queue --permissions p --expiry $expiry --https-only -o tsv
$queueUrl = "https://$account.queue.core.windows.net/$Queue"

Write-Host "3/5 Environnement Container Apps…"
$envId = Invoke-AzCli containerapp env list --resource-group $Group --query "[?name=='$Environment'].id | [0]" -o tsv
if (-not $envId) {
    Invoke-AzCli containerapp env create --name $Environment --resource-group $Group --location $Location `
        --enable-workload-profiles --logs-destination none --only-show-errors | Out-Null
    $envId = Invoke-AzCli containerapp env show --name $Environment --resource-group $Group --query id -o tsv
}

Write-Host "4/5 Serveur de tâches (job)…"
$secrets = @(
    @{ name = "queue-connection"; value = $env:AZURE_STORAGE_CONNECTION_STRING },
    @{ name = "worker-queue-url"; value = "${queueUrl}?$sasProcess" }
)
$containerEnv = @(
    @{ name = "WORKER_QUEUE_URL"; secretRef = "worker-queue-url" },
    @{ name = "THREADS"; value = "4" },
    @{ name = "MODELS_DIR"; value = "/tmp/models" }
)
foreach ($key in $values.Keys) {
    if (-not $values[$key] -or $key -eq "WORKER_QUEUE_URL") { continue }
    $name = ($key.ToLower() -replace "[^a-z0-9]", "-")
    $secrets += @{ name = $name; value = $values[$key] }
    $containerEnv += @{ name = $key; secretRef = $name }
}
$spec = @{
    location   = $Location
    properties = @{
        environmentId       = $envId
        workloadProfileName = "Consumption"
        configuration       = @{
            triggerType        = "Event"
            replicaTimeout     = 21600   # 6 h au maximum par exécution
            replicaRetryLimit  = 1       # une relance si Azure interrompt la machine (maintenance)
            secrets            = $secrets
            eventTriggerConfig = @{
                parallelism            = 1
                replicaCompletionCount = 1
                scale                  = @{
                    minExecutions   = 0
                    maxExecutions   = 2     # au plus deux machines en même temps
                    pollingInterval = 30
                    rules           = @(@{
                        name     = "reveil"
                        type     = "azure-queue"
                        metadata = @{ accountName = $account; queueName = $Queue; queueLength = "1" }
                        auth     = @(@{ secretRef = "queue-connection"; triggerParameter = "connection" })
                    })
                }
            }
        }
        template            = @{
            containers = @(@{
                name      = "worker"
                image     = $Image
                resources = @{ cpu = 4.0; memory = "8Gi" }
                env       = $containerEnv
            })
        }
    }
}
$specFile = Join-Path ([System.IO.Path]::GetTempPath()) "studoo-job-$([guid]::NewGuid()).yaml"
try {
    # JSON = YAML valide ; écrit sans BOM, effacé juste après (il contient les secrets)
    [System.IO.File]::WriteAllText($specFile, ($spec | ConvertTo-Json -Depth 20), (New-Object System.Text.UTF8Encoding $false))
    $exists = Invoke-AzCli containerapp job list --resource-group $Group --query "[?name=='$Job'].name | [0]" -o tsv
    $verb = if ($exists) { "update" } else { "create" }
    Invoke-AzCli containerapp job $verb --name $Job --resource-group $Group --yaml $specFile --only-show-errors | Out-Null
} finally {
    Remove-Item $specFile -Force -ErrorAction SilentlyContinue
}

Write-Host "5/5 Terminé."
Write-Host ""
Write-Host "Dans Vercel (studoo → Settings → Environment Variables), ajoute :"
Write-Host "  WORKER_QUEUE_URL = ${queueUrl}?$sasAdd"
Write-Host "  JOB_SECRET       = (la valeur de JOB_SECRET dans $EnvFile)"
Write-Host "  VAPID_PUBLIC_KEY = (la valeur de VAPID_PUBLIC_KEY dans $EnvFile)"
Write-Host "puis fais « Redeploy »."
