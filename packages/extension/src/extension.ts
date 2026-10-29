import * as vscode from 'vscode'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { builtinTools, webTools, createFoundry, runAgent, DEFAULT_SYSTEM, snapshotFile, readFileChange, applyFileChange } from '@oqelira/core'
import type { Message, ModelConfig, ApprovalRequest } from '@oqelira/core'
import { foundryEndpoint, secretName } from './policy.js'

interface Setup { endpoint:string; model:ModelConfig }
let active:AbortController|undefined
let history:Message[]=[]
let workspaceKey=''
export function activate(context:vscode.ExtensionContext) {
  const output=vscode.window.createOutputChannel('Oqelira by Flwn')
  const previews=new Map<string,string>()
  const recentChanges:{label:string;id:string;cwd:string}[]=[]
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('oqelira-preview',{provideTextDocumentContent:uri=>previews.get(uri.toString())??''}))
  const review=async(request:ApprovalRequest,cwd:string,signal:AbortSignal)=>{
    if(signal.aborted)return false
    const detail=JSON.stringify(request.input,null,2)
    if(detail.length>30000){output.appendLine('Denied: change is too large to review.');return false}
    if(['apply_file_change','revert_file_change'].includes(request.tool)){
      const input=request.input as {path:string;content:string|null;expected_sha256:string|null}
      const before=await snapshotFile(cwd,input.path)
      if(before.sha256!==input.expected_sha256){output.appendLine('Denied: file changed since preview.');return false}
      const id=randomUUID(),name=path.basename(input.path)
      const left=vscode.Uri.from({scheme:'oqelira-preview',path:`/${id}/before/${name}`}),right=vscode.Uri.from({scheme:'oqelira-preview',path:`/${id}/after/${name}`})
      while(previews.size>30)previews.delete(previews.keys().next().value!)
      previews.set(left.toString(),before.content??'');previews.set(right.toString(),input.content??'')
      await vscode.commands.executeCommand('vscode.diff',left,right,`Oqelira: ${input.path}`,{preview:true})
    }
    const answer=await vscode.window.showWarningMessage(request.summary,{modal:true,detail:(request.risk==='network'?'This sends the query to an external service.\n\n':request.risk==='exec'?'This local shell command can access your computer.\n\n':'Review the proposed change.\n\n')+detail},'Allow once','Deny')
    return !signal.aborted&&answer==='Allow once'
  }
  context.subscriptions.push(output,{dispose:()=>active?.abort()})
  const register=(name:string,action:()=>unknown)=>context.subscriptions.push(vscode.commands.registerCommand(name,action))
  register('oqelira.stop',()=>active?.abort())
  register('oqelira.clear',()=>{if(active){void vscode.window.showWarningMessage('Stop the current run first.');return};history=[];output.clear()})
  register('oqelira.revert',async()=>{
    if(active||!vscode.workspace.isTrusted)return
    const available=recentChanges.filter(change=>vscode.workspace.workspaceFolders?.some(folder=>folder.uri.scheme==='file'&&folder.uri.fsPath===change.cwd))
    const change=await vscode.window.showQuickPick(available,{title:'Revert a reviewed file change'})
    if(!change)return
    const controller=new AbortController();active=controller
    try{const input=await readFileChange(change.cwd,change.id);if(await review({tool:'revert_file_change',risk:'write',summary:'Revert '+input.path,input},change.cwd,controller.signal)){output.appendLine(await applyFileChange(change.cwd,input,true,controller.signal));history=[]}}
    catch{void vscode.window.showErrorMessage('The file changed or the revert could not be verified. Inspect it before retrying.')}
    finally{active=undefined}
  })
  register('oqelira.configure',async()=>{
    if(active){void vscode.window.showWarningMessage('Stop the current run before changing credentials.');return}
    const endpointInput=await vscode.window.showInputBox({title:'Azure Foundry endpoint',prompt:'HTTPS endpoint for your existing Foundry resource. Saved in your user profile only.',ignoreFocusOut:true})
    if(!endpointInput)return
    let endpoint:string
    try{endpoint=foundryEndpoint(endpointInput)}catch{void vscode.window.showErrorMessage('Use a valid HTTPS Azure Foundry endpoint.');return}
    const deployment=await vscode.window.showInputBox({title:'Foundry deployment name',prompt:'The deployment name from your Azure configuration.',ignoreFocusOut:true,validateInput:value=>value.trim()?undefined:'Enter a deployment name'})
    if(!deployment)return
    const api=await vscode.window.showQuickPick(['responses','chat'],{title:'API supported by this deployment'})
    if(api !== 'responses' && api !== 'chat')return
    const key=await vscode.window.showInputBox({title:'Foundry API key',prompt:'Stored in VS Code SecretStorage, never in workspace settings.',password:true,ignoreFocusOut:true})
    if(!key)return
    await context.secrets.store(secretName(endpoint),key.trim())
    await context.globalState.update('oqelira.setup',{endpoint,model:{id:deployment.trim(),deployment:deployment.trim(),api,speed:'fast'}} satisfies Setup)
    history=[];void vscode.window.showInformationMessage('Oqelira Foundry configuration saved.')
  })
  register('oqelira.ask',async()=>{
    if(!vscode.workspace.isTrusted){void vscode.window.showWarningMessage('Trust this workspace before running Oqelira.');return}
    if(active){void vscode.window.showWarningMessage('Oqelira is already running. Use Oqelira: Stop first.');return}
    const folders=vscode.workspace.workspaceFolders
    if(!folders?.length){void vscode.window.showWarningMessage('Open a local project folder first.');return}
    const folder=folders.length===1?folders[0]:await vscode.window.showWorkspaceFolderPick({placeHolder:'Choose the project Oqelira may access'})
    if(!folder || folder.uri.scheme!=='file')return
    const setup=context.globalState.get<Setup>('oqelira.setup')
    if(!setup){void vscode.window.showInformationMessage('Run Oqelira: Configure Foundry first.');return}
    let endpoint:string
    try{endpoint=foundryEndpoint(setup.endpoint)}catch{void vscode.window.showErrorMessage('Reconfigure the Foundry endpoint.');return}
    const key=await context.secrets.get(secretName(endpoint))
    if(!key){void vscode.window.showInformationMessage('Run Oqelira: Configure Foundry to save your key.');return}
    const prompt=await vscode.window.showInputBox({title:'Ask Oqelira',prompt:'Read tools run automatically. Changes and shell commands need your approval.',ignoreFocusOut:true})
    if(!prompt?.trim())return
    const identity=folder.uri.toString()+JSON.stringify(setup)
    if(identity!==workspaceKey){history=[];workspaceKey=identity}
    const controller=new AbortController();active=controller
    output.show(true);output.appendLine('\nYou: '+prompt);output.appendLine('Oqelira:')
    try{
      let rules=''
      for(const name of ['OQELIRA.md','AGENTS.md']){try{rules='\n\nProject instructions:\n'+(await fs.readFile(path.join(folder.uri.fsPath,name),'utf8')).slice(0,20000);break}catch{}}
      const result=await runAgent({cwd:folder.uri.fsPath,prompt,history,provider:createFoundry({baseURL:endpoint,apiKey:key})(setup.model),system:DEFAULT_SYSTEM+rules,tools:[...builtinTools,...webTools()],signal:controller.signal,
        permissions:{autoAllow:['read'],approve:request=>review(request,folder.uri.fsPath,controller.signal)},onText:delta=>output.append(delta),onToolCall:call=>output.appendLine('\nTool: '+call.name),onToolResult:result=>{
          output.appendLine((result.isError?'Failed: ':'Result: ')+result.output)
          if(!result.isError&&['apply_file_change','revert_file_change'].includes(result.name)){try{const change=JSON.parse(result.output) as {change_id:string;path:string};recentChanges.unshift({label:change.path,id:change.change_id,cwd:folder.uri.fsPath});recentChanges.splice(100)}catch{}}
        },onContextCompacted:()=>output.appendLine('\nOlder context compacted; full session history retained.')})
      history=result.messages;output.appendLine('\nStatus: '+result.finishReason)
    }catch{history=[];output.appendLine(controller.signal.aborted?'\nStopped. Already approved changes remain.':'\nRun failed. Check your configuration and service availability.');void vscode.window.showErrorMessage('Oqelira stopped. See its output channel for status.')}
    finally{active=undefined}
  })
}
export function deactivate(){active?.abort()}
