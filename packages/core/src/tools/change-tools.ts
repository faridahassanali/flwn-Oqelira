import type { Tool } from './types.js'
import {str} from './types.js'
import {snapshotFile,applyFileChange,readFileChange} from './changes.mjs'
type FileChangeInput={path:string;expected_sha256:string|null;content:string|null;change_id?:string}
const changeParameters={type:'object',properties:{path:{type:'string'},expected_sha256:{type:['string','null']},content:{type:['string','null']},change_id:{type:'string'}},required:['path','expected_sha256','content']}
export const changeTools:Tool[]=[
  {spec:{name:'file_snapshot',description:'Read a small UTF-8 workspace file and its SHA-256 version before a reviewed, reversible change. A missing file has null hash; internal and credential paths are excluded.',parameters:{type:'object',properties:{path:{type:'string'}},required:['path']}},risk:'read',describe:i=>'snapshot '+str(i,'path'),run:async(i,c)=>JSON.stringify(await snapshotFile(c.cwd,str(i,'path')))},
  {spec:{name:'apply_file_change',description:'Apply the exact reviewed content only when the workspace file still matches the supplied snapshot hash, then record an undo entry. Null content deletes the file. Requires write approval; never replace a stale human edit.',parameters:changeParameters},risk:'write',describe:i=>'apply versioned change to '+str(i,'path'),run:(i,c)=>applyFileChange(c.cwd,i as FileChangeInput,false,c.signal)},
  {spec:{name:'read_file_change',description:'Read the exact reviewed input required to revert one recorded file change. This is read-only and does not grant approval.',parameters:{type:'object',properties:{change_id:{type:'string'}},required:['change_id']}},risk:'read',describe:i=>'read change '+str(i,'change_id'),run:async(i,c)=>JSON.stringify(await readFileChange(c.cwd,str(i,'change_id')))},
  {spec:{name:'revert_file_change',description:'Revert one recorded change only with the exact input from read_file_change. Refuses later human edits and requires a fresh write approval.',parameters:{...changeParameters,required:[...changeParameters.required,'change_id']}},risk:'write',describe:i=>'revert recorded change to '+str(i,'path'),run:(i,c)=>applyFileChange(c.cwd,i as FileChangeInput,true,c.signal)},
]
