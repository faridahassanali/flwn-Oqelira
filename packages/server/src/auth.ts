import { betterAuth } from 'better-auth'
import {organization} from 'better-auth/plugins'
import {defaultAc,defaultRoles} from 'better-auth/plugins/organization/access'
import type { Pool } from 'pg'
import type { serverConfig } from './config.js'
import type {EmailDelivery} from './mail.js'

export function createAuth(pool: Pool, config: ReturnType<typeof serverConfig>, delivery?:EmailDelivery) {
  const send=delivery
  if(config.requireEmailVerification&&!send)throw new Error('Verified email requires configured account email delivery')
  return betterAuth({
    database: pool, secret: config.secret, baseURL: config.baseURL,
    trustedOrigins: [config.baseURL],
    emailAndPassword: { enabled: true, disableSignUp: !config.signup, minPasswordLength: 12, maxPasswordLength: 128, requireEmailVerification:config.requireEmailVerification, revokeSessionsOnPasswordReset:true,resetPasswordTokenExpiresIn:900,...(send?{sendResetPassword:async({user,url}:{user:{email:string};url:string})=>send({to:user.email,url,kind:'reset'})}:{}) },
    ...(send?{emailVerification:{sendOnSignUp:true,sendOnSignIn:true,autoSignInAfterVerification:false,expiresIn:900,sendVerificationEmail:async({user,url}:{user:{email:string};url:string})=>send({to:user.email,url,kind:'verify'})}}:{}),
    account:{accountLinking:{enabled:true,disableImplicitLinking:true,allowDifferentEmails:false,allowUnlinkingAll:false}},
    socialProviders:{...(config.google?{google:{...config.google,disableSignUp:!config.signup,scope:['openid','email','profile']}}:{}),...(config.github?{github:{...config.github,disableSignUp:!config.signup,scope:['read:user','user:email']}}:{})},
    plugins:[organization({organizationLimit:10,membershipLimit:50,invitationLimit:50,allowUserToCreateOrganization:user=>user.emailVerified,requireEmailVerificationOnInvitation:true,roles:{...defaultRoles,viewer:defaultAc.newRole({ac:['read']})},sendInvitationEmail:async invitation=>{
      if(!send)throw new Error('Configure account email delivery before sending invitations')
      await send({to:invitation.email,url:config.baseURL+'/?invitation='+encodeURIComponent(invitation.id),kind:'invite'})
    }})],
    session: { expiresIn: 60 * 60 * 24, updateAge: 60 * 60, cookieCache: { enabled: false } },
    rateLimit: { enabled: true, storage: 'database', window: 60, max: 30, customRules: { '/sign-in/email': { window: 60, max: 5 }, '/sign-up/email': { window: 60, max: 3 },'/request-password-reset':{window:60,max:3},'/send-verification-email':{window:60,max:3},'/reset-password':{window:60,max:5} } },
    advanced: { useSecureCookies: config.production, defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' }, disableCSRFCheck: false, disableOriginCheck: false },
    logger: { disabled: true },
  })
}
export type Auth = ReturnType<typeof createAuth>
