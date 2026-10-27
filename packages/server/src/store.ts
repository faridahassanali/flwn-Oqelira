import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { Message } from '@oqelira/core'
import type { HostEvent } from '@oqelira/protocol'

export interface Conversation { id: string; project_id: string; title: string; model: string; messages: Message[]; status: string; active_run: string | null; updated_at: string }
export class Store {
  constructor(readonly pool: Pool) {}
  async appendRunEvent(user:string,conversation:string,run:string,event:HostEvent):Promise<HostEvent> {
    const result=await this.pool.query('INSERT INTO oq_run_events(user_id,conversation_id,run_id,event) VALUES($1,$2,$3,$4::jsonb) RETURNING sequence',[user,conversation,run,JSON.stringify(event)])
    return {...event,sequence:Number(result.rows[0].sequence)}
  }
  async runEvents(user:string,run:string,after:number):Promise<HostEvent[]> {
    return (await this.pool.query('SELECT sequence,event FROM oq_run_events WHERE user_id=$1 AND run_id=$2 AND sequence>$3 ORDER BY sequence LIMIT 1000',[user,run,after])).rows.map(row=>({...row.event,sequence:Number(row.sequence)}))
  }
  async runState(user:string,run:string) {
    return (await this.pool.query('SELECT event FROM oq_run_events WHERE user_id=$1 AND run_id=$2 ORDER BY sequence DESC LIMIT 1',[user,run])).rows[0]?.event as HostEvent|undefined
  }
  async createApproval(user:string,session:string,conversation:string,run:string,id:string,tool:string) {
    await this.pool.query("INSERT INTO oq_run_approvals(id,user_id,session_id,conversation_id,run_id,tool,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '2 minutes')",[id,user,session,conversation,run,tool])
  }
  async pendingApproval(user:string,session:string,run:string,id:string) {
    return (await this.pool.query("SELECT c.project_id FROM oq_run_approvals a JOIN oq_conversations c ON c.id=a.conversation_id WHERE a.id=$4 AND a.user_id=$1 AND a.session_id=$2 AND a.run_id=$3 AND a.allowed IS NULL AND a.expires_at>now()",[user,session,run,id])).rows[0] as {project_id:string}|undefined
  }
  async decideApproval(user:string,session:string,run:string,id:string,actor:string,allowed:boolean) {
    return (await this.pool.query("UPDATE oq_run_approvals SET allowed=$6,decided_by=$5,decided_at=now() WHERE id=$4 AND user_id=$1 AND session_id=$2 AND run_id=$3 AND allowed IS NULL AND expires_at>now() RETURNING conversation_id,tool",[user,session,run,id,actor,allowed])).rows[0] as {conversation_id:string;tool:string}|undefined
  }
  async approvalDecision(user:string,run:string,id:string) {
    return (await this.pool.query('SELECT allowed FROM oq_run_approvals WHERE id=$3 AND user_id=$1 AND run_id=$2',[user,run,id])).rows[0]?.allowed as boolean|undefined
  }
  async takeQuota(user: string, bucket: string, limit: number, windowSeconds: number) {
    const window = Math.floor(Date.now() / (windowSeconds * 1000))
    const result = await this.pool.query('INSERT INTO oq_quota(user_id,bucket,window_id,used) VALUES($1,$2,$3,1) ON CONFLICT(user_id,bucket) DO UPDATE SET window_id=$3,used=CASE WHEN oq_quota.window_id=$3 THEN oq_quota.used+1 ELSE 1 END WHERE oq_quota.window_id<>$3 OR oq_quota.used<$4 RETURNING used', [user, bucket, window, limit])
    return result.rowCount === 1
  }
  async organizations(user:string){return(await this.pool.query('SELECT o.id,o.name,m.role FROM organization o JOIN member m ON m."organizationId"=o.id WHERE m."userId"=$1 ORDER BY o.name',[user])).rows as {id:string;name:string;role:string}[]}
  async projects(user: string) { return (await this.pool.query("SELECT DISTINCT p.id,p.name,p.created_at,p.organization_id,CASE WHEN p.organization_id IS NULL THEN 'owner' ELSE m.role END AS role FROM oq_projects p LEFT JOIN member m ON m.\"organizationId\"=p.organization_id AND m.\"userId\"=$1 WHERE (p.organization_id IS NULL AND p.user_id=$1) OR m.id IS NOT NULL ORDER BY p.created_at DESC", [user])).rows as { id: string; name: string;role:string }[] }
  async project(user: string, id: string) { return (await this.pool.query("SELECT p.id,p.name,p.user_id AS owner_id,p.organization_id,CASE WHEN p.organization_id IS NULL THEN 'owner' ELSE m.role END AS role FROM oq_projects p LEFT JOIN member m ON m.\"organizationId\"=p.organization_id AND m.\"userId\"=$1 WHERE p.id=$2 AND ((p.organization_id IS NULL AND p.user_id=$1) OR m.id IS NOT NULL)", [user, id])).rows[0] as { id: string; name: string;owner_id:string;organization_id:string|null;role:string } | undefined }
  async visibleConversation(user:string,id:string){return(await this.pool.query('SELECT c.* FROM oq_conversations c JOIN oq_projects p ON p.id=c.project_id LEFT JOIN member m ON m."organizationId"=p.organization_id AND m."userId"=$1 WHERE c.id=$2 AND ((p.organization_id IS NULL AND p.user_id=$1) OR m.id IS NOT NULL)',[user,id])).rows[0] as Conversation|undefined}
  async runOwner(user:string,run:string){return(await this.pool.query('SELECT e.user_id FROM oq_run_events e JOIN oq_conversations c ON c.id=e.conversation_id JOIN oq_projects p ON p.id=c.project_id LEFT JOIN member m ON m."organizationId"=p.organization_id AND m."userId"=$1 WHERE e.run_id=$2 AND ((p.organization_id IS NULL AND p.user_id=$1) OR m.id IS NOT NULL) LIMIT 1',[user,run])).rows[0]?.user_id as string|undefined}
  async claimProject(user: string, id: string, run: string) { return (await this.pool.query("UPDATE oq_projects SET active_run=$3,lease_until=now()+interval '2 minutes' WHERE user_id=$1 AND id=$2 AND (active_run IS NULL OR lease_until<now()) RETURNING id", [user,id,run])).rowCount === 1 }
  async releaseProject(user: string, id: string, run: string) { await this.pool.query('UPDATE oq_projects SET active_run=NULL,lease_until=NULL WHERE user_id=$1 AND id=$2 AND active_run=$3', [user,id,run]) }
  async createProject(user: string, name: string,organization:string|null=null) {
    const id = randomUUID()
    await this.pool.query('INSERT INTO oq_projects(id,user_id,name,organization_id) VALUES($1,$2,$3,$4)', [id, user, name,organization])
    return { id, name }
  }
  async conversations(user: string, project: string) { return (await this.pool.query('SELECT id,project_id,title,model,status,updated_at FROM oq_conversations WHERE user_id=$1 AND project_id=$2 ORDER BY updated_at DESC LIMIT 100', [user, project])).rows as Conversation[] }
  async conversation(user: string, id: string) { return (await this.pool.query('SELECT * FROM oq_conversations WHERE user_id=$1 AND id=$2', [user, id])).rows[0] as Conversation | undefined }
  async createConversation(user: string, project: string, title: string, model: string) {
    const id = randomUUID()
    await this.pool.query('INSERT INTO oq_conversations(id,user_id,project_id,title,model) VALUES($1,$2,$3,$4,$5)', [id, user, project, title, model])
    return id
  }
  async claim(user: string, id: string, run: string) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const project = await client.query("UPDATE oq_projects SET active_run=$3,lease_until=now()+interval '2 minutes' WHERE user_id=$1 AND id=(SELECT project_id FROM oq_conversations WHERE user_id=$1 AND id=$2) AND (active_run IS NULL OR lease_until<now()) RETURNING id", [user, id, run])
      if (project.rowCount !== 1) { await client.query('ROLLBACK'); return false }
      const result = await client.query("UPDATE oq_conversations SET active_run=$3,lease_until=now()+interval '2 minutes',status='running',updated_at=now() WHERE user_id=$1 AND id=$2 AND (active_run IS NULL OR lease_until<now()) RETURNING id", [user, id, run])
      await client.query(result.rowCount === 1 ? 'COMMIT' : 'ROLLBACK')
      return result.rowCount === 1
    } catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
  }
  async checkpoint(user: string, id: string, run: string, messages: Message[]) {
    const result = await this.pool.query("UPDATE oq_conversations SET messages=$4::jsonb,updated_at=now() WHERE user_id=$1 AND id=$2 AND active_run=$3 AND lease_until>now()", [user, id, run, JSON.stringify(messages)])
    if (result.rowCount !== 1) throw new Error('Run lease lost')
  }
  async renew(user: string, id: string, run: string) {
    return (await this.pool.query("WITH p AS (UPDATE oq_projects SET lease_until=now()+interval '2 minutes' WHERE user_id=$1 AND active_run=$3 AND lease_until>now() RETURNING id) UPDATE oq_conversations SET lease_until=now()+interval '2 minutes' WHERE user_id=$1 AND id=$2 AND active_run=$3 AND lease_until>now() AND project_id IN (SELECT id FROM p)", [user, id, run])).rowCount === 1
  }
  async release(user: string, id: string, run: string, status: string) { await this.pool.query('WITH c AS (UPDATE oq_conversations SET active_run=NULL,lease_until=NULL,status=$4,updated_at=now() WHERE user_id=$1 AND id=$2 AND active_run=$3 RETURNING project_id) UPDATE oq_projects SET active_run=NULL,lease_until=NULL WHERE user_id=$1 AND active_run=$3 AND id IN (SELECT project_id FROM c)', [user, id, run, status]) }
  async memory(user: string, project: string) { return (await this.pool.query('SELECT id,content,created_at FROM oq_memory WHERE user_id=$1 AND project_id=$2 ORDER BY created_at DESC LIMIT 100', [user, project])).rows as { id: string; content: string }[] }
  async remember(user: string, project: string, content: string) {
    const id = randomUUID()
    await this.pool.query('INSERT INTO oq_memory(id,user_id,project_id,content) VALUES($1,$2,$3,$4)', [id, user, project, content])
    return id
  }
  async forget(user: string, project: string, id: string) { return (await this.pool.query('DELETE FROM oq_memory WHERE user_id=$1 AND project_id=$2 AND id=$3', [user, project, id])).rowCount === 1 }
  async audit(user: string, conversation: string, run: string, action: string, tool: string | null = null, decision: boolean | null = null,actor:string=user) { await this.pool.query('INSERT INTO oq_audit(user_id,conversation_id,run_id,action,tool,decision,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7)', [user, conversation, run, action, tool, decision,actor]) }
}

/** Recover unfinished calls as unknown outcomes; never rerun an approved operation automatically. */
export function recoverHistory(history: Message[]): Message[] {
  const messages: Message[] = []
  for (let i = 0; i < history.length; i++) {
    const message = history[i]!
    messages.push(message)
    if (message.role !== 'assistant' || !message.toolCalls.length) continue
    const next = history[i + 1]
    const results = next?.role === 'tool' ? [...next.results] : []
    if (next?.role === 'tool') i++
    for (const call of message.toolCalls) if (!results.some(r => r.id === call.id)) results.push({ id: call.id, name: call.name, output: 'Run interrupted. The operation outcome is unknown. Inspect the workspace before proposing any retry.', isError: true })
    messages.push({ role: 'tool', results })
  }
  return messages
}
