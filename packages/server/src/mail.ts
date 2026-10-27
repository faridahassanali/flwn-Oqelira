import nodemailer from 'nodemailer'
import {randomUUID} from 'node:crypto'
import type {Pool} from 'pg'
export type AccountEmail = {to:string;url:string;kind:'verify'|'reset'|'invite'}
export type EmailDelivery=(email:AccountEmail)=>Promise<void>
export async function enqueueAccountMail(pool:Pool,message:AccountEmail){await pool.query('INSERT INTO oq_account_mail(id,payload) VALUES($1,$2::jsonb)',[randomUUID(),JSON.stringify(message)])}
export async function deliverAccountMail(pool:Pool,send:EmailDelivery){
 await pool.query("DELETE FROM oq_account_mail WHERE created_at<now()-interval '15 minutes'")
 const result=await pool.query("WITH candidate AS (SELECT id FROM oq_account_mail WHERE available_at<=now() AND attempts<5 AND (locked_until IS NULL OR locked_until<now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE oq_account_mail SET locked_until=now()+interval '2 minutes',attempts=attempts+1 WHERE id IN (SELECT id FROM candidate) RETURNING id,payload")
 const row=result.rows[0];if(!row)return
 try{await send(row.payload as AccountEmail);await pool.query('DELETE FROM oq_account_mail WHERE id=$1',[row.id])}
 catch{await pool.query("UPDATE oq_account_mail SET locked_until=NULL,available_at=now()+interval '1 minute' WHERE id=$1",[row.id])}
}
export function startAccountMail(pool:Pool,send:EmailDelivery|undefined){
 if(!send)return ()=>{}
 let busy=false
 const timer=setInterval(()=>{if(busy)return;busy=true;void deliverAccountMail(pool,send).catch(()=>{}).finally(()=>{busy=false})},2000)
 timer.unref();return ()=>clearInterval(timer)
}
export function smtpDelivery(url:string|undefined,from:string|undefined,origin:string):EmailDelivery|undefined{
 if(!url)return undefined
 let smtp:URL
 try{smtp=new URL(url)}catch{throw new Error('Invalid SMTP configuration')}
 if(!['smtp:','smtps:'].includes(smtp.protocol)||!smtp.hostname||smtp.search||smtp.hash||!from||!/^[^<>\s@]+@[^<>\s@]+\.[^\s@]+$/.test(from))throw new Error('Configure a valid SMTP URL and sender address')
 const transport=nodemailer.createTransport({host:smtp.hostname,port:Number(smtp.port||(smtp.protocol==='smtps:'?465:587)),secure:smtp.protocol==='smtps:',requireTLS:smtp.protocol==='smtp:',auth:smtp.username?{user:decodeURIComponent(smtp.username),pass:decodeURIComponent(smtp.password)}:undefined,connectionTimeout:5000,socketTimeout:10000,logger:false,debug:false,tls:{rejectUnauthorized:true}})
 return async message=>{
   if(new URL(message.url).origin!==origin)throw new Error('Account link must use the application origin')
   try{await transport.sendMail({from,to:message.to,subject:message.kind==='verify'?'Verify your Oqelira account':message.kind==='invite'?'Join your Oqelira team':'Reset your Oqelira password',text:(message.kind==='verify'?'Verify your email address using this link:':message.kind==='invite'?'Sign in with this email address and accept your team invitation:':'Reset your password using this link:')+'\n\n'+message.url+'\n\nIf you did not request this, ignore this email.'})}
   catch{throw new Error('Account email delivery failed')}
 }
}
