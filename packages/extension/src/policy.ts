export function foundryEndpoint(value: string): string {
  const url=new URL(value.trim())
  if(url.protocol!=='https:' || url.username || url.password || url.search || url.hash || !/\.(openai\.azure\.com|services\.ai\.azure\.com)$/.test(url.hostname) || (url.pathname!=='/' && url.pathname!=='/openai/v1' && url.pathname!=='/openai/v1/')) throw new Error('Use your HTTPS Azure Foundry endpoint or /openai/v1 base URL')
  return url.origin+'/openai/v1'
}
export function secretName(endpoint:string):string {return 'oqelira.foundry:'+new URL(endpoint).origin}
