import type { Tool } from './types.js'
import {str} from './types.js'
import {snapshotFile,applyFileChange,readFileChange} from './changes.mjs'
type FileChangeInput={path:string;expected_sha256:string|null;content:string|null;change_id?:string}
const changeParameters={type:'object',properties:{path:{type:'string'},expected_sha256:{type:['string','null']},content:{type:['string','null']},change_id:{type:'string'}},required:['path','expected_sha256','content']}
export const changeTools:Tool[]=[
  {spec:{name:'file_snapshot',description:'Read a small UTF-8 file and its SHA-256 version for a reviewed, reversible change. A missing file has null hash. Internal and credential paths are excluded.',parameters:{type:'object',properties:{path:{type:'string'}},required:['path']}},risk:'read',describe:i=>'snapshot '+str(i,'path'),run:async(i,c)=>JSON.stringify(await snapshotFile(c.cwd,str(i,'path')))},
  {spec:{name:'apply_file_change',description:'Apply the exact content only if the file still matches the snapshot hash; record a durable undo entry. Null content deletes the file. Requires write approval.',parameters:changeParameters},risk:'write',describe:i=>'apply versioned change to '+str(i,'path'),run:(i,c)=>applyFileChange(c.cwd,i as FileChangeInput,false,c.signal)},
  {spec:{name:'read_file_change',description:'Read the exact revert input for an applied change ID. This does not change files or grant approval.',parameters:{type:'object',properties:{change_id:{type:'string'}},required:['change_id']}},risk:'read',describe:i=>'read change '+str(i,'change_id'),run:async(i,c)=>JSON.stringify(await readFileChange(c.cwd,str(i,'change_id')))},
  {spec:{name:'revert_file_change',description:'Revert a recorded change using the exact input returned by read_file_change, including full replacement content for review. Refuses subsequent human edits. Requires fresh write approval.',parameters:{...changeParameters,required:[...changeParameters.required,'change_id']}},risk:'write',describe:i=>'revert recorded change to '+str(i,'path'),run:(i,c)=>applyFileChange(c.cwd,i as FileChangeInput,true,c.signal)},
]
