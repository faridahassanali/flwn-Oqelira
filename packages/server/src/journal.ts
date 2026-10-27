import type {ServerResponse} from 'node:http'
import type {HostEvent} from '@oqelira/protocol'
import type {Store} from './store.js'

/** Durable event replay; reconnecting never calls the model or repeats a tool. */
export class RunJournal {
  private pending=Promise.resolve()
  private listeners=new Set<(event:HostEvent)=>void>()
  private closers=new Set<()=>void>()
  private responses=new Set<ServerResponse>()
  private finished=false
  constructor(private store:Store,private user:string,private conversation:string,private id:string,private cancel:()=>void){}
  publish(event:HostEvent){
    if(this.finished)return
    this.pending=this.pending.then(async()=>{
      const saved=await this.store.appendRunEvent(this.user,this.conversation,this.id,event)
      for(const listener of this.listeners)listener(saved)
    }).catch(()=>{this.finished=true;this.cancel();for(const close of this.closers)close()})
  }
  async connect(response:ServerResponse,after:number){
    let cursor=after,ready=false,closed=false
    const buffer:HostEvent[]=[]
    const write=(event:HostEvent)=>{if(closed||response.destroyed||response.writableEnded||!event.sequence||event.sequence<=cursor)return;cursor=event.sequence;response.write(JSON.stringify(event)+'\n')}
    const listener=(event:HostEvent)=>{if(ready)write(event);else buffer.push(event)}
    const close=()=>{if(ready&&!response.destroyed)response.end()}
    this.listeners.add(listener);this.closers.add(close)
    this.responses.add(response)
    response.on('close',()=>{closed=true;this.listeners.delete(listener);this.closers.delete(close);this.responses.delete(response)})
    try{
      for(;;){const events=await this.store.runEvents(this.user,this.id,cursor);for(const event of events)write(event);if(events.length<1000||closed)break}
      ready=true
      for(const event of buffer)write(event)
      if(this.finished)close()
    }catch{response.destroy()}
  }
  heartbeat(){for(const response of this.responses)if(!response.destroyed)response.write('\n')}
  async finish(){await this.pending;this.finished=true;for(const close of this.closers)close()}
}
