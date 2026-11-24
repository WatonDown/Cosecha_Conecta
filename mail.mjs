import { createHash } from 'node:crypto';

export const categories = ['publications','orders','reminders','harvest','weather'];
const subjects = {
  welcome:'Te damos la bienvenida', account:'Cambios en tu cuenta',
  publications:'Publicaciones agrícolas', orders:'Actualización de pedido',
  reminders:'Recordatorio de cosecha', harvest:'Novedades de cosecha', weather:'Alerta meteorológica'
};
const escape = value => value.replace(/[&<>"']/g, char =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[char]);

export async function createMailer({one,run}) {
  const address = process.env.GMAIL_USER;
  const password = process.env.GMAIL_APP_PASSWORD?.replace(/\s/g,'');
  if (Boolean(address) !== Boolean(password)) throw new Error('Configura GMAIL_USER y GMAIL_APP_PASSWORD juntos.');
  const transport = address && (await import('nodemailer')).default.createTransport({
    host:'smtp.gmail.com', port:465, secure:true, auth:{user:address,pass:password},
    connectionTimeout:15_000, greetingTimeout:15_000, socketTimeout:30_000
  });

  function enabled(user,category) {
    if (!categories.includes(category)) return true;
    return one('SELECT enabled FROM email_preferences WHERE user_id=? AND category=?',user,category)?.enabled === 1;
  }

  function enqueue(user,category,body,event,target) {
    if (!enabled(user,category)) return;
    run(`INSERT INTO email_queue(recipient,address,category,body,event)
      VALUES(?,?,?,?,?) ON CONFLICT(recipient,event) DO NOTHING`,
    user,target ?? one('SELECT email FROM users WHERE id=?',user).email,category,body,event);
  }

  let processing = false;
  async function flush() {
    if (!transport || processing) return;
    processing = true;
    try {
      for (let i=0; i<20; i++) {
        const now = Date.now();
        const item = one(`UPDATE email_queue SET status='sending',attempts=attempts+1,due=?,updated=CURRENT_TIMESTAMP
          WHERE id=(SELECT id FROM email_queue WHERE status IN ('pending','sending') AND due<=? ORDER BY due,id LIMIT 1)
          RETURNING *`,now+600_000,now);
        if (!item) break;
        const finish = (status,due=0,error=null) => run(`UPDATE email_queue SET
          status=?,due=?,last_error=?,updated=CURRENT_TIMESTAMP WHERE id=? AND attempts=?`,
        status,due,error,item.id,item.attempts);
        if (!enabled(item.recipient,item.category) || (item.category !== 'account' &&
            one('SELECT email FROM users WHERE id=?',item.recipient).email !== item.address)) {
          finish('skipped');
          continue;
        }
        const title = subjects[item.category];
        const identifier = createHash('sha256').update(item.address+'\n'+item.event).digest('hex');
        try {
          await transport.sendMail({
            from:{name:'Cosecha Conecta',address}, to:item.address,
            messageId:`<${identifier}@${address.split('@').at(-1)}>`,
            subject:`Cosecha Conecta · ${title}`,
            text:`Cosecha Conecta\n\n${title}\n\n${item.body}`,
            html:`<div lang="es" style="font-family:Arial,sans-serif;color:#243b28;max-width:560px;margin:auto;border:1px solid #dce5d8">
              <div style="background:#234e35;color:white;padding:20px;font-size:20px">Cosecha Conecta</div>
              <div style="padding:20px"><h1 style="font-size:22px">${title}</h1><p>${escape(item.body)}</p>
              <p style="font-size:13px">Puedes gestionar tus preferencias de correo desde tu perfil.</p></div></div>`
          });
          finish('sent');
        } catch (error) {
          const permanent = error.responseCode >= 500 && error.responseCode !== 535;
          const retry = !permanent && item.attempts < 6;
          const code = typeof error.code === 'string' && /^[A-Z0-9]+$/.test(error.code) ? error.code : 'SMTP';
          finish(retry?'pending':'failed',retry ? Date.now()+60_000*2**(item.attempts-1) : 0,
            [code,error.responseCode].filter(Boolean).join(' '));
        }
      }
    } finally { processing = false; }
  }
  return {enqueue,flush};
}
