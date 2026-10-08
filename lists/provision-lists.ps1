<#
.SYNOPSIS
  Creates the four roadmap lists in a SharePoint site and (optionally) loads the sample data.

.EXAMPLE
  ./provision-lists.ps1 -SiteUrl https://samtek.sharepoint.com/sites/EnterpriseRoadmap -ClientId <pnp-app-id> -WithSampleData

.NOTES
  Requires PnP.PowerShell 2.x (PowerShell 7):  Install-Module PnP.PowerShell -Scope CurrentUser
  -ClientId is an Entra app registered for PnP interactive login (Register-PnPEntraIDAppForInteractiveLogin).
  Safe to re-run: existing lists and columns are skipped.
#>
param(
  [Parameter(Mandatory)] [string] $SiteUrl,
  [Parameter(Mandatory)] [string] $ClientId,
  [switch] $WithSampleData
)
$ErrorActionPreference = 'Stop'
Connect-PnPOnline -Url $SiteUrl -Interactive -ClientId $ClientId

function Ensure-List($title) {
  $l = Get-PnPList -Identity $title -ErrorAction SilentlyContinue
  if (-not $l) { $l = New-PnPList -Title $title -Template GenericList -OnQuickLaunch; Write-Host "Created list $title" }
  return Get-PnPList -Identity $title
}

# Creates a column with a fixed internal name, then sets the friendly display name.
function Ensure-Field($list, $name, $display, $type, $extra = '', $inner = '') {
  if (Get-PnPField -List $list -Identity $name -ErrorAction SilentlyContinue) { return }
  $xml = "<Field Type=`"$type`" Name=`"$name`" StaticName=`"$name`" DisplayName=`"$name`" $extra>$inner</Field>"
  Add-PnPFieldFromXml -List $list -FieldXml $xml | Out-Null
  Set-PnPField -List $list -Identity $name -Values @{ Title = $display } | Out-Null
}
function Choices($values, $default) {
  "<Default>$default</Default><CHOICES>" + (($values | ForEach-Object { "<CHOICE>$_</CHOICE>" }) -join '') + '</CHOICES>'
}

# ---------- Strategic Themes ----------
$themes = Ensure-List 'Strategic Themes'
Ensure-Field $themes 'Code' 'Code' 'Text' 'Required="TRUE" EnforceUniqueValues="TRUE" Indexed="TRUE" MaxLength="10"'
Ensure-Field $themes 'Description' 'Description' 'Note' 'NumLines="4" RichText="FALSE"'
Ensure-Field $themes 'KpiName' 'KPI' 'Text'
Ensure-Field $themes 'KpiUnit' 'KPI unit' 'Text'
Ensure-Field $themes 'KpiBaseline' 'KPI baseline' 'Number'
Ensure-Field $themes 'KpiCurrent' 'KPI current' 'Number'
Ensure-Field $themes 'KpiTarget' 'KPI target' 'Number'
Ensure-Field $themes 'SortOrder' 'Sort order' 'Number'

# ---------- Product Areas ----------
$areas = Ensure-List 'Product Areas'
Ensure-Field $areas 'Code' 'Code' 'Text' 'Required="TRUE" EnforceUniqueValues="TRUE" Indexed="TRUE" MaxLength="10"'
Ensure-Field $areas 'ProductOwner' 'Product owner' 'Text'
Ensure-Field $areas 'DeliveryManager' 'Delivery manager' 'Text'
Ensure-Field $areas 'Description' 'Description' 'Note' 'NumLines="4" RichText="FALSE"'
Ensure-Field $areas 'SortOrder' 'Sort order' 'Number'
Ensure-Field $areas 'Active' 'Active' 'Boolean' '' '<Default>1</Default>'

# ---------- Initiatives ----------
$init = Ensure-List 'Initiatives'
Ensure-Field $init 'InitiativeKey' 'Initiative ID' 'Text' 'Required="TRUE" EnforceUniqueValues="TRUE" Indexed="TRUE" MaxLength="20"'
Ensure-Field $init 'ProductArea' 'Product area' 'Lookup' "Required=`"TRUE`" Indexed=`"TRUE`" List=`"{$($areas.Id)}`" ShowField=`"Title`""
Ensure-Field $init 'Theme' 'Strategic theme' 'Lookup' "Required=`"TRUE`" Indexed=`"TRUE`" List=`"{$($themes.Id)}`" ShowField=`"Title`""
Ensure-Field $init 'Horizon' 'Horizon' 'Choice' 'Format="Dropdown"' (Choices @('Commit','Plan','Explore') 'Plan')
Ensure-Field $init 'Status' 'Status' 'Choice' 'Format="Dropdown"' (Choices @('Not started','On track','At risk','Off track','Done') 'Not started')
Ensure-Field $init 'StartDate' 'Start date' 'DateTime' 'Format="DateOnly"'
Ensure-Field $init 'EndDate' 'End date' 'DateTime' 'Format="DateOnly"'
Ensure-Field $init 'Owner' 'Owner' 'Text'
Ensure-Field $init 'Summary' 'Summary' 'Note' 'NumLines="6" RichText="FALSE"'
Ensure-Field $init 'JiraEpic' 'Jira epic' 'Text' 'MaxLength="40"'
Ensure-Field $init 'DependsOn' 'Depends on (IDs)' 'Text'
Ensure-Field $init 'RiskNote' 'Risk note' 'Note' 'NumLines="3" RichText="FALSE"'
Ensure-Field $init 'LastReviewed' 'Last reviewed' 'DateTime' 'Format="DateOnly"'

# Colored status pills in the Lists UI
$statusFormat = Get-Content (Join-Path $PSScriptRoot 'status-format.json') -Raw
Set-PnPField -List $init -Identity 'Status' -Values @{ CustomFormatter = $statusFormat } | Out-Null

# ---------- Milestones ----------
$ms = Ensure-List 'Milestones'
Ensure-Field $ms 'Initiative' 'Initiative' 'Lookup' "Required=`"TRUE`" Indexed=`"TRUE`" List=`"{$($init.Id)}`" ShowField=`"InitiativeKey`""
Ensure-Field $ms 'MilestoneDate' 'Date' 'DateTime' 'Required="TRUE" Format="DateOnly"'
Ensure-Field $ms 'MilestoneType' 'Type' 'Choice' 'Format="Dropdown"' (Choices @('Release','Pilot','Review gate','Decision') 'Release')
Ensure-Field $ms 'Done' 'Done' 'Boolean' '' '<Default>0</Default>'
Ensure-Field $ms 'JiraEpic' 'Jira epic' 'Text' 'MaxLength="40"'

# ---------- Views ----------
Set-PnPView -List $init -Identity 'All Items' -Fields 'InitiativeKey','LinkTitle','ProductArea','Theme','Horizon','Status','StartDate','EndDate','Owner','JiraEpic','LastReviewed' | Out-Null
if (-not (Get-PnPView -List $init -Identity 'By product area' -ErrorAction SilentlyContinue)) {
  Add-PnPView -List $init -Title 'By product area' -Fields 'InitiativeKey','LinkTitle','Theme','Horizon','Status','StartDate','EndDate','Owner','LastReviewed' `
    -Query "<GroupBy Collapse='FALSE'><FieldRef Name='ProductArea'/></GroupBy><OrderBy><FieldRef Name='StartDate'/></OrderBy>" | Out-Null
}
Set-PnPView -List $ms -Identity 'All Items' -Fields 'Initiative','LinkTitle','MilestoneDate','MilestoneType','Done','JiraEpic' | Out-Null
Set-PnPView -List $areas -Identity 'All Items' -Fields 'Code','LinkTitle','ProductOwner','DeliveryManager','SortOrder','Active' | Out-Null
Set-PnPView -List $themes -Identity 'All Items' -Fields 'Code','LinkTitle','KpiName','KpiBaseline','KpiCurrent','KpiTarget','KpiUnit','SortOrder' | Out-Null

Write-Host 'Lists ready.' -ForegroundColor Green

# ---------- Sample data ----------
if ($WithSampleData) {
  $data = Get-Content (Join-Path $PSScriptRoot '..' 'site' 'data' 'roadmap.sample.json') -Raw | ConvertFrom-Json
  $tId = @{}; $aId = @{}; $iId = @{}; $n = 0
  foreach ($t in $data.themes) {
    $n++
    $item = Add-PnPListItem -List $themes -Values @{ Title = $t.name; Code = $t.id; Description = $t.description; KpiName = $t.kpi.name; KpiUnit = $t.kpi.unit;
      KpiBaseline = $t.kpi.baseline; KpiCurrent = $t.kpi.current; KpiTarget = $t.kpi.target; SortOrder = $n }
    $tId[$t.id] = $item.Id
  }
  $n = 0
  foreach ($a in $data.productAreas) {
    $n++
    $item = Add-PnPListItem -List $areas -Values @{ Title = $a.name; Code = $a.id; ProductOwner = $a.owner; DeliveryManager = $a.deliveryManager; Description = $a.description; SortOrder = $n }
    $aId[$a.id] = $item.Id
  }
  foreach ($i in $data.initiatives) {
    $item = Add-PnPListItem -List $init -Values @{ Title = $i.title; InitiativeKey = $i.id; ProductArea = $aId[$i.productArea]; Theme = $tId[$i.theme];
      Horizon = $i.horizon; Status = $i.status; StartDate = $i.start; EndDate = $i.end; Owner = $i.owner; Summary = $i.summary;
      JiraEpic = $i.jiraEpic; DependsOn = ($i.dependsOn -join '; '); RiskNote = $i.riskNote; LastReviewed = $i.lastReviewed }
    $iId[$i.id] = $item.Id
  }
  foreach ($m in $data.milestones) {
    Add-PnPListItem -List $ms -Values @{ Title = $m.title; Initiative = $iId[$m.initiative]; MilestoneDate = $m.date; MilestoneType = $m.type; Done = [bool]$m.done } | Out-Null
  }
  Write-Host "Loaded sample data: $($data.initiatives.Count) initiatives, $($data.milestones.Count) milestones." -ForegroundColor Green
}
