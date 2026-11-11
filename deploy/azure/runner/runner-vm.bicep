// Oqelira sandbox runner VM. Cheapest sound setup: one VM, public 443 (token + TLS), no VNet extras.
// Validated against the live Sweden Central runner VM. Run `what-if` again before each new deployment.
targetScope = 'resourceGroup'

param location string = resourceGroup().location
param adminUsername string = 'oqadmin'
@description('SSH public key (ssh-ed25519 / ssh-rsa line). Password auth is disabled.')
param sshPublicKey string
@description('Single IPv4 address allowed to SSH, e.g. 203.0.113.1 (no CIDR).')
param adminIp string
@description('DNS label -> <label>.<region>.cloudapp.azure.com. Must be unique in the region.')
param dnsLabel string = 'oqelira-runner'
param vmName string = 'oqelira-runner'
param vmSize string = 'Standard_B2ls_v2'
param dataDiskSizeGB int = 64
@description('Per-project XFS quota in GiB.')
param projectQuotaGiB int = 2
// Hard inode limit per project volume. 1,000,000 covers a large node_modules tree (typically 50k-300k files) several times over;
// the validation run showed 300k empty files cost 157 MiB of real metadata disk, so 1M bounds that at roughly 0.5 GiB per project.
param projectInodeLimit int = 1000000
@description('Off by default: the API needs the runner reachable.')
param enableAutoShutdown bool = false
param autoShutdownTime string = '2100'
param autoShutdownTimeZone string = 'UTC'
param storageAccountName string = 'oqrun${uniqueString(resourceGroup().id)}'
param backupRetentionDays int = 30

var cloudInit = replace(replace(replace(replace(loadTextContent('cloud-init.yaml'), '__FQDN__', '${dnsLabel}.${location}.cloudapp.azure.com'), '__QUOTA_GIB__', string(projectQuotaGiB)), '__INODE_LIMIT__', string(projectInodeLimit)), '__STORAGE_ACCOUNT__', storageAccountName)
var blobContributorRole = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe' // Storage Blob Data Contributor

resource ip 'Microsoft.Network/publicIPAddresses@2024-05-01' = {
  name: '${vmName}-ip'
  location: location
  sku: { name: 'Standard' }
  properties: {
    publicIPAllocationMethod: 'Static'
    dnsSettings: { domainNameLabel: dnsLabel }
  }
}

// 443 is open to the internet because Container Apps (consumption) has no fixed outbound IP.
// The bearer token (>=32 bytes, constant-time check) and TLS are the control.
resource nsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: '${vmName}-nsg'
  location: location
  properties: {
    securityRules: [
      { name: 'allow-https', properties: { priority: 100, direction: 'Inbound', access: 'Allow', protocol: 'Tcp', sourceAddressPrefix: 'Internet', sourcePortRange: '*', destinationAddressPrefix: '*', destinationPortRange: '443' } }
      { name: 'allow-ssh-admin', properties: { priority: 110, direction: 'Inbound', access: 'Allow', protocol: 'Tcp', sourceAddressPrefix: adminIp, sourcePortRange: '*', destinationAddressPrefix: '*', destinationPortRange: '22' } }
      { name: 'deny-all-inbound', properties: { priority: 4000, direction: 'Inbound', access: 'Deny', protocol: '*', sourceAddressPrefix: '*', sourcePortRange: '*', destinationAddressPrefix: '*', destinationPortRange: '*' } }
    ]
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: '${vmName}-vnet'
  location: location
  properties: {
    addressSpace: { addressPrefixes: ['10.60.0.0/24'] }
    subnets: [ { name: 'default', properties: { addressPrefix: '10.60.0.0/24' } } ]
  }
}

resource nic 'Microsoft.Network/networkInterfaces@2024-05-01' = {
  name: '${vmName}-nic'
  location: location
  properties: {
    networkSecurityGroup: { id: nsg.id }
    ipConfigurations: [ {
      name: 'ipconfig1'
      properties: {
        privateIPAllocationMethod: 'Dynamic'
        subnet: { id: vnet.properties.subnets[0].id }
        publicIPAddress: { id: ip.id }
      }
    } ]
  }
}

resource vm 'Microsoft.Compute/virtualMachines@2024-07-01' = {
  name: vmName
  location: location
  identity: { type: 'SystemAssigned' }
  properties: {
    hardwareProfile: { vmSize: vmSize }
    osProfile: {
      computerName: vmName
      adminUsername: adminUsername
      customData: base64(cloudInit)
      linuxConfiguration: {
        disablePasswordAuthentication: true
        ssh: { publicKeys: [ { path: '/home/${adminUsername}/.ssh/authorized_keys', keyData: sshPublicKey } ] }
        provisionVMAgent: true
      }
    }
    storageProfile: {
      imageReference: { publisher: 'Canonical', offer: 'ubuntu-24_04-lts', sku: 'server', version: 'latest' }
      osDisk: { createOption: 'FromImage', managedDisk: { storageAccountType: 'StandardSSD_LRS' }, deleteOption: 'Delete' }
      dataDisks: [ { lun: 0, name: '${vmName}-data', createOption: 'Empty', diskSizeGB: dataDiskSizeGB, managedDisk: { storageAccountType: 'StandardSSD_LRS' }, deleteOption: 'Detach' } ]
    }
    networkProfile: { networkInterfaces: [ { id: nic.id } ] }
  }
}

resource shutdown 'Microsoft.DevTestLab/schedules@2018-09-15' = if (enableAutoShutdown) {
  name: 'shutdown-computevm-${vmName}'
  location: location
  properties: {
    status: 'Enabled'
    taskType: 'ComputeVmShutdownTask'
    dailyRecurrence: { time: autoShutdownTime }
    timeZoneId: autoShutdownTimeZone
    notificationSettings: { status: 'Disabled' }
    targetResourceId: vm.id
  }
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    accessTier: 'Cool'
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource backups 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'backups'
  properties: { publicAccess: 'None' }
}

resource lifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    policy: {
      rules: [ {
        name: 'expire-backups'
        enabled: true
        type: 'Lifecycle'
        definition: {
          filters: { blobTypes: ['blockBlob'], prefixMatch: ['backups/'] }
          actions: { baseBlob: { delete: { daysAfterModificationGreaterThan: backupRetentionDays } } }
        }
      } ]
    }
  }
}

resource backupRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: backups
  name: guid(backups.id, vm.id, blobContributorRole)
  properties: {
    principalId: vm.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobContributorRole)
  }
}

output fqdn string = ip.properties.dnsSettings.fqdn
output runnerUrl string = 'https://${ip.properties.dnsSettings.fqdn}'
output storageAccount string = storage.name
