const assert=require('node:assert/strict')
const fs=require('node:fs')
const path=require('node:path')
exports.run=async function(){
 const vscode=require('vscode')
 const extension=vscode.extensions.getExtension('flwn.oqelira-vscode')
 assert.ok(extension,'extension registered')
 await extension.activate()
 const commands=await vscode.commands.getCommands(true)
 for(const command of ['oqelira.ask','oqelira.stop','oqelira.configure','oqelira.clear','oqelira.revert'])assert.ok(commands.includes(command),command)
 await vscode.commands.executeCommand('oqelira.stop')
 await vscode.commands.executeCommand('oqelira.clear')
 fs.writeFileSync(path.resolve(__dirname,'../../../work/vscode-smoke-result.json'),JSON.stringify({activated:true,commands:5,stop:true,clear:true}))
}
