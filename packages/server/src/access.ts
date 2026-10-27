export const mayWrite=(role:string|undefined)=>!!role?.split(',').some(value=>['owner','admin','member'].includes(value))
export const mayAdmin=(role:string|undefined)=>!!role?.split(',').some(value=>['owner','admin'].includes(value))
