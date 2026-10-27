targetScope = 'resourceGroup'

@description('Azure region selected for the deployment. Existing Foundry resources are not modified.')
param location string
@minLength(3)
@maxLength(10)
param prefix string = 'oqelira'
@description('Review region availability and cost before choosing a PostgreSQL GeneralPurpose SKU.')
param databaseSku string
@secure()
param databaseAdminPassword string

var suffix = uniqueString(resourceGroup().id, prefix)

resource runnerNsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: '${prefix}-runner-security'
  location: location
  properties: {
    securityRules: [
      {
        name: 'api-to-private-tls'
        properties: { priority: 100, direction: 'Inbound', access: 'Allow', protocol: 'Tcp', sourcePortRange: '*', destinationPortRange: '443', sourceAddressPrefix: '10.40.0.0/23', destinationAddressPrefix: '*' }
      }
      {
        name: 'deny-other-inbound'
        properties: { priority: 200, direction: 'Inbound', access: 'Deny', protocol: '*', sourcePortRange: '*', destinationPortRange: '*', sourceAddressPrefix: '*', destinationAddressPrefix: '*' }
      }
      {
        name: 'deny-runner-to-vnet-services'
        properties: { priority: 300, direction: 'Outbound', access: 'Deny', protocol: '*', sourcePortRange: '*', destinationPortRange: '*', sourceAddressPrefix: '*', destinationAddressPrefix: 'VirtualNetwork' }
      }
    ]
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: '${prefix}-network'
  location: location
  properties: {
    addressSpace: { addressPrefixes: ['10.40.0.0/16'] }
    subnets: [
      {
        name: 'apps'
        properties: {
          addressPrefix: '10.40.0.0/23'
          delegations: [{ name: 'container-apps', properties: { serviceName: 'Microsoft.App/environments' } }]
        }
      }
      {
        name: 'postgres'
        properties: {
          addressPrefix: '10.40.2.0/24'
          delegations: [{ name: 'postgres', properties: { serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers' } }]
        }
      }
      { name: 'private-endpoints', properties: { addressPrefix: '10.40.3.0/24', privateEndpointNetworkPolicies: 'Disabled' } }
      { name: 'runner', properties: { addressPrefix: '10.40.4.0/24', networkSecurityGroup: { id: runnerNsg.id } } }
    ]
  }
}
resource databaseDns 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: '${prefix}.private.postgres.database.azure.com'
  location: 'global'
}
resource databaseLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: databaseDns
  name: '${prefix}-link'
  location: 'global'
  properties: { registrationEnabled: false, virtualNetwork: { id: vnet.id } }
}
resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: '${prefix}-pg-${suffix}'
  location: location
  sku: { name: databaseSku, tier: 'GeneralPurpose' }
  properties: {
    version: '16'
    administratorLogin: 'oqeliraadmin'
    administratorLoginPassword: databaseAdminPassword
    storage: { storageSizeGB: 32, autoGrow: 'Enabled' }
    backup: { backupRetentionDays: 7, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'Disabled' }
    network: {
      publicNetworkAccess: 'Disabled'
      delegatedSubnetResourceId: resourceId('Microsoft.Network/virtualNetworks/subnets', vnet.name, 'postgres')
      privateDnsZoneArmResourceId: databaseDns.id
    }
  }
  dependsOn: [databaseLink]
}
resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgres
  name: 'oqelira'
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
}
resource postgresTls 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: postgres
  name: 'require_secure_transport'
  properties: { source: 'user-override', value: 'on' }
}
resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: '${prefix}${suffix}'
  location: location
  sku: { name: 'Basic' }
  properties: { adminUserEnabled: false }
}
resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: '${prefix}-${suffix}'
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: { name: 'standard', family: 'A' }
    enableRbacAuthorization: true
    enablePurgeProtection: true
    softDeleteRetentionInDays: 90
    publicNetworkAccess: 'Disabled'
    networkAcls: { defaultAction: 'Deny', bypass: 'None' }
    accessPolicies: []
  }
}
resource vaultDns 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: 'privatelink.vaultcore.azure.net'
  location: 'global'
}
resource vaultLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: vaultDns
  name: '${prefix}-link'
  location: 'global'
  properties: { registrationEnabled: false, virtualNetwork: { id: vnet.id } }
}
resource vaultEndpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: '${prefix}-vault-private'
  location: location
  properties: {
    subnet: { id: resourceId('Microsoft.Network/virtualNetworks/subnets', vnet.name, 'private-endpoints') }
    privateLinkServiceConnections: [{
      name: 'vault'
      properties: { privateLinkServiceId: vault.id, groupIds: ['vault'] }
    }]
  }
}
resource vaultDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: vaultEndpoint
  name: 'vault'
  properties: { privateDnsZoneConfigs: [{ name: 'vault', properties: { privateDnsZoneId: vaultDns.id } }] }
}

output virtualNetworkId string = vnet.id
output appsSubnetId string = resourceId('Microsoft.Network/virtualNetworks/subnets', vnet.name, 'apps')
output runnerSubnetId string = resourceId('Microsoft.Network/virtualNetworks/subnets', vnet.name, 'runner')
output databaseHost string = postgres.properties.fullyQualifiedDomainName
output registryServer string = registry.properties.loginServer
output vaultUri string = vault.properties.vaultUri
