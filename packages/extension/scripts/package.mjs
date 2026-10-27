import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const root=fileURLToPath(new URL('../',import.meta.url))
const manifest=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'))
const stage=await fs.mkdtemp(path.join(os.tmpdir(),'oqelira-vsix-'))
await fs.mkdir(path.join(stage,'extension','dist'),{recursive:true})
for(const file of ['package.json','README.md','dist/extension.cjs'])await fs.copyFile(path.join(root,file),path.join(stage,'extension',file))
const xml=value=>String(value).replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]))
await fs.writeFile(path.join(stage,'extension.vsixmanifest'),`<?xml version="1.0" encoding="utf-8"?><PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011"><Metadata><Identity Language="en-US" Id="${xml(manifest.name)}" Version="${xml(manifest.version)}" Publisher="${xml(manifest.publisher)}"/><DisplayName>${xml(manifest.displayName)}</DisplayName><Description xml:space="preserve">${xml(manifest.description)}</Description><Tags>AI,coding</Tags><Categories>Other</Categories><GalleryFlags>Public</GalleryFlags><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="${xml(manifest.engines.vscode)}"/><Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace"/></Properties></Metadata><Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/><Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/><Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/></Assets></PackageManifest>`)
await fs.writeFile(path.join(stage,'[Content_Types].xml'),'<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="cjs" ContentType="application/javascript"/><Default Extension="md" ContentType="text/markdown"/><Default Extension="vsixmanifest" ContentType="text/xml"/></Types>')
const destination=path.resolve(root,'../../outputs');await fs.mkdir(destination,{recursive:true})
const zip=path.join(destination,`${manifest.name}-${manifest.version}.zip`)
const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(root,'scripts/package.ps1'),'-Stage',stage,'-Archive',zip],{stdio:'inherit',windowsHide:true})
if(result.status!==0)throw new Error('VSIX archive creation failed')
const target=zip.replace(/\.zip$/,'.vsix');await fs.rename(zip,target);console.log(target)
