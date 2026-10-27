import type { HostConfig, HostEvent } from '@oqelira/protocol'
async function checked(response: Response): Promise<Response> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error ?? `Host returned ${response.status}`)
  }
  return response
}
export const getConfig = async (): Promise<HostConfig> => (await checked(await fetch('/api/config'))).json()
const headers = { 'Content-Type': 'application/json', 'X-Oqelira-Client': 'workspace' }
export async function approve(runId: string, approvalId: string, allowed: boolean): Promise<void> {
  await checked(await fetch('/api/approval', { method: 'POST', headers, body: JSON.stringify({ runId, approvalId, allowed }) }))
}
export async function run(request: { prompt: string; model: string; sessionId?: string; projectId?: string }, signal: AbortSignal, onEvent: (event: HostEvent) => void): Promise<void> {
  const reconnectable=!!request.projectId
  let runId='',cursor=0,finished=false
  const stop=()=>{if(reconnectable&&runId)void fetch('/api/run/stop',{method:'POST',headers,body:JSON.stringify({runId}),signal:AbortSignal.timeout(5000)}).catch(()=>{})}
  signal.addEventListener('abort',stop,{once:true})
  const consume=async(response:Response)=>{
    await checked(response)
    if(!response.body)throw new Error('The host did not return a stream')
    const reader=response.body.getReader(),decoder=new TextDecoder();let buffer=''
    try{
      for(;;){const chunk=await reader.read();if(chunk.done)break;buffer+=decoder.decode(chunk.value,{stream:true});let newline:number
        while((newline=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,newline).trim();buffer=buffer.slice(newline+1);if(!line)continue
          const event=JSON.parse(line) as HostEvent
          if(event.sequence){if(event.sequence<=cursor)continue;cursor=event.sequence}
          if(event.type==='started')runId=event.runId
          if(event.type==='done'||event.type==='error')finished=true
          onEvent(event)
        }
      }
      if(!finished)throw new Error('The host connection ended before the run completed')
    }finally{await reader.cancel().catch(()=>{});reader.releaseLock()}
  }
  try{
    let failure:unknown
    try{await consume(await fetch('/api/run',{method:'POST',headers,body:JSON.stringify({...request,reconnectable}),signal}));return}catch(error){failure=error}
    for(let attempt=0;reconnectable&&runId&&!finished&&!signal.aborted&&attempt<3;attempt++){
      onEvent({type:'connection',state:'reconnecting'})
      await new Promise<void>(resolve=>{const abort=()=>{clearTimeout(timer);resolve()};const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve()},500*(attempt+1));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort()})
      signal.throwIfAborted()
      try{const response=await fetch('/api/run/events?runId='+encodeURIComponent(runId)+'&after='+cursor,{signal});await checked(response);onEvent({type:'connection',state:'connected'});await consume(response);return}catch(error){failure=error}
    }
    if(finished)return
    throw failure
  }finally{signal.removeEventListener('abort',stop)}
}
