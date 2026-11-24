import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { randomBytes, randomUUID, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { categories, createMailer } from './mail.mjs';
import { openDatabase } from './database.mjs';

const derive = promisify(scrypt);
const folder = resolve(process.env.DATA_DIR || 'data');
mkdirSync(folder, { recursive: true });
const db = openDatabase(resolve(folder, 'cosecha.sqlite'));
db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
const one = (sql, ...args) => db.prepare(sql).get(...args);
const all = (sql, ...args) => db.prepare(sql).all(...args);
const run = (sql, ...args) => db.prepare(sql).run(...args);
const mail = await createMailer({one,run});
const hashToken = token => createHash('sha256').update(token).digest('hex');
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Santiago' }).format(new Date());
const day = 86_400_000;
const publicUser = 'id, name, role, comuna, bio, photo, created';
const catalog = `SELECT l.id, l.product, l.category, l.description, l.available, l.price,
  l.comuna, l.kind, l.quality, l.harvest, l.deadline, l.photo, l.producer, u.name,
  ROUND(l.lat,2) AS lat, ROUND(l.lon,2) AS lon,
  EXISTS(SELECT 1 FROM withdrawn_lots w WHERE w.lot=l.id) AS withdrawn,
  (SELECT AVG(r.stars) FROM reviews r JOIN orders o ON o.id=r.order_id
   JOIN lots reviewed ON reviewed.id=o.lot WHERE reviewed.producer=l.producer) AS rating
  FROM lots l JOIN users u ON u.id=l.producer`;
const meetingBase = process.env.MEETING_BASE_URL ? new URL(process.env.MEETING_BASE_URL) : null;
if (meetingBase && (meetingBase.protocol !== 'https:' || meetingBase.username || meetingBase.password)) {
  throw new Error('MEETING_BASE_URL debe ser una URL HTTPS sin credenciales.');
}
db.function('distance_km',(lat,lon,targetLat,targetLon) => {
  if (lat === null || lon === null) return null;
  const rad = Math.PI/180;
  const a = Math.sin((targetLat-lat)*rad/2)**2 +
    Math.cos(lat*rad)*Math.cos(targetLat*rad)*Math.sin((targetLon-lon)*rad/2)**2;
  return 12742*Math.asin(Math.min(1,Math.sqrt(a)));
});

function requireThat(condition, message, status = 400) {
  if (!condition) throw Object.assign(new Error(message), { status });
}
function field(value, label, limit = 120, optional = false) {
  requireThat(typeof value === 'string' && value.trim().length <= limit && (optional || value.trim()), label + ' inválido.');
  return value.trim();
}
function integer(value, label, min = 0, max = 1_000_000) {
  const number = Number(value);
  requireThat((typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) &&
    Number.isSafeInteger(number) && number >= min && number <= max, label + ' fuera de rango.');
  return number;
}
function date(value) {
  requireThat(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), 'Fecha inválida.');
  const parsed = new Date(value);
  requireThat(!isNaN(parsed) && parsed.toISOString().slice(0,10) === value, 'Fecha inválida.');
  return value;
}
function photo(value = '') {
  if (!value) return '';
  requireThat(typeof value === 'string' && value.length <= 950_000, 'La fotografía supera el tamaño permitido.');
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  requireThat(match, 'Usa una imagen JPEG, PNG o WebP.');
  const bytes = Buffer.from(match[2], 'base64');
  const valid = {
    jpeg: bytes.subarray(0,3).equals(Buffer.from([255,216,255])),
    png: bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),
    webp: bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP'
  };
  requireThat(valid[match[1]], 'El contenido de la imagen no coincide con su formato.');
  return value;
}
function coordinates(lat, lon) {
  if ((lat ?? '') === '' && (lon ?? '') === '') return [null, null];
  requireThat([lat,lon].every(value => typeof value === 'number' || (typeof value === 'string' && value.trim())) &&
    Math.abs(Number(lat)) <= 90 && Math.abs(Number(lon)) <= 180, 'Coordenadas inválidas.');
  return [Number(lat), Number(lon)];
}
function transaction(action) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
const audit = (actor, subject, action, note = '') =>
  run('INSERT INTO audit(actor,subject,action,note) VALUES(?,?,?,?)', actor, String(subject), action, note);
function notify(recipient, body, key = null, category) {
  const result = run('INSERT OR IGNORE INTO notices(recipient,body,dedupe) VALUES(?,?,?)', recipient, body, key);
  if (result.changes && category) mail.enqueue(recipient,category,body,key ?? `notice:${result.lastInsertRowid}`);
}

function deadlines() {
  const current = today();
  const limit = new Date(Date.parse(current) + 2 * day).toISOString().slice(0,10);
  const upcoming = all(`SELECT l.id,l.product,l.deadline,u.id AS recipient FROM lots l JOIN users u
    ON u.comuna=l.comuna COLLATE NOCASE AND u.role IN ('comprador','organizacion')
    WHERE l.available>0 AND l.deadline BETWEEN ? AND ?
    AND (u.role='comprador' OR l.kind='donation')`, current, limit);
  for (const lot of upcoming) {
    const hours = Date.parse(lot.deadline) - Date.parse(current) <= day ? 24 : 48;
    if (one('SELECT id FROM notices WHERE recipient=? AND dedupe=?',lot.recipient,`deadline:${lot.id}:${hours}`)) continue;
    notify(lot.recipient, `${lot.product} vence el ${lot.deadline}.`,
      `deadline:${lot.id}:${lot.deadline}:${hours}`, 'reminders');
  }
  for (const lot of all(`SELECT id,product,producer,harvest FROM lots
    WHERE kind='future' AND harvest BETWEEN ? AND ?
    AND NOT EXISTS(SELECT 1 FROM withdrawn_lots w WHERE w.lot=lots.id)`,current,limit)) {
    const hours = Date.parse(lot.harvest)-Date.parse(current) <= day ? 24 : 48;
    mail.enqueue(lot.producer,'reminders',`La cosecha de ${lot.product} está programada para el ${lot.harvest}.`,
      `harvest-date:${lot.id}:${lot.harvest}:${hours}`);
  }
}
function releaseExpiredGroups() {
  for (const group of all(`SELECT id,offer FROM collaborative WHERE deadline<? AND (
    status='open' OR (status='offered' AND NOT EXISTS (
      SELECT 1 FROM orders o WHERE o.lot=collaborative.offer AND o.status<>'cancelled'
    )))`,today())) {
    releaseGroup(group);
    audit(null,group.id,'group.expire');
  }
}
function expireUnpaidOrders() {
  for (const order of all(`SELECT o.id,o.lot,o.kg,o.buyer,l.product,l.producer FROM orders o
    JOIN lots l ON l.id=o.lot WHERE o.status='pending' AND o.created<=datetime('now','-30 minutes')`)) {
    run("UPDATE orders SET status='cancelled' WHERE id=?",order.id);
    run('UPDATE lots SET available=available+? WHERE id=?',order.kg,order.lot);
    audit(null,order.id,'order.expired','Se liberó el inventario después de 30 minutos sin pago o depósito.');
    for (const id of [order.buyer,order.producer]) notify(id,`Venció el plazo de pago para ${order.product}.`,null,'orders');
  }
}

const roles = ['productor','comprador','organizacion'];
const routes = [];
function route(method, path, access, handler) {
  routes.push({ method, path: new RegExp('^/api' + path + '$'), access, handler });
}
function session(response, id) {
  const token = randomBytes(32).toString('hex');
  run('INSERT INTO sessions VALUES(?,?,?)', hashToken(token), id, Date.now() + 7 * day);
  const secure = process.env.SECURE_COOKIES === '1' ? '; Secure' : '';
  response.setHeader('Set-Cookie', `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secure}`);
  return privateProfile(id);
}
function emailAddress(value) {
  const email = field(value, 'Correo', 254).toLowerCase();
  requireThat(/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(email), 'Correo inválido.');
  return email;
}
function validPassword(password) {
  requireThat(typeof password === 'string' && password.length >= 12 && password.length <= 128, 'Usa de 12 a 128 caracteres para la contraseña.');
  return password;
}
function authInput(body) {
  return {email:emailAddress(body.email),password:validPassword(body.password)};
}
function privateProfile(id) {
  return {...one(`SELECT ${publicUser},email FROM users WHERE id=?`,id),
    ...(one('SELECT phone,lat,lon FROM account_settings WHERE user_id=?',id) ?? {phone:'',lat:null,lon:null}),
    emailPreferences:Object.fromEntries(all('SELECT category,enabled FROM email_preferences WHERE user_id=?',id)
      .map(row => [row.category,Boolean(row.enabled)]))};
}
const attempts = new Map();
function throttle(req) {
  const ip = req.socket.remoteAddress;
  const now = Date.now();
  for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
  const entry = attempts.get(ip) || { count: 0, until: now + 60_000 };
  attempts.set(ip, entry);
  requireThat(++entry.count <= 20, 'Demasiados intentos. Espera un minuto.', 429);
}

route('POST','/register',null,async ({body,res,req}) => {
  throttle(req);
  const {email,password} = authInput(body);
  requireThat(roles.includes(body.role), 'Tipo de cuenta inválido.');
  const name = field(body.name,'Nombre');
  const comuna = field(body.comuna,'Comuna');
  const picture = photo(body.photo);
  const salt = randomBytes(16).toString('hex');
  const digest = (await derive(password,salt,64)).toString('hex');
  return transaction(() => {
    requireThat(!one('SELECT id FROM users WHERE email=?',email), 'El correo ya está registrado.',409);
    const id = run('INSERT INTO users(email,password,role,name,comuna,photo) VALUES(?,?,?,?,?,?)',
      email, salt + ':' + digest, body.role,name,comuna,picture).lastInsertRowid;
    mail.enqueue(id,'welcome',`Hola, ${name}. Tu cuenta está lista.`,'welcome');
    return session(res,id);
  });
});
route('POST','/login',null,async ({body,res,req}) => {
  throttle(req);
  const email = field(body.email,'Correo',254).toLowerCase();
  const password = validPassword(body.password);
  const user = one('SELECT id,password FROM users WHERE email=?',email);
  const [salt,digest] = (user?.password || 'missing:' + '0'.repeat(128)).split(':');
  const derived = await derive(password,salt,64);
  requireThat(timingSafeEqual(derived,Buffer.from(digest,'hex')) && user,'Credenciales incorrectas.',401);
  return transaction(() => {
    requireThat(one('SELECT id FROM users WHERE id=? AND email=? AND password=?',user.id,email,user.password),
      'Credenciales incorrectas.',401);
    return session(res,user.id);
  });
});
route('POST','/logout',true,({res,token}) => {
  run('DELETE FROM sessions WHERE token=?',hashToken(token));
  res.setHeader('Set-Cookie','session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'+
    (process.env.SECURE_COOKIES === '1' ? '; Secure' : ''));
  return {};
});
route('GET','/me',null,({user}) => user ? privateProfile(user.id) : null);
route('POST','/profile',true,({user,body}) => transaction(() => {
  run('UPDATE users SET name=?,comuna=?,bio=?,photo=? WHERE id=?',
    field(body.name,'Nombre'),field(body.comuna,'Comuna'),field(body.bio ?? '','Descripción',1000,true),
    body.photo === undefined ? user.photo : photo(body.photo),user.id);
  const previous = privateProfile(user.id);
  const phone = field(body.phone ?? previous.phone,'Teléfono',30,true);
  requireThat(!phone || /^\+?[\d ().-]+$/.test(phone) && /\d/.test(phone),'Teléfono inválido.');
  requireThat(user.role === 'productor' || (!Object.hasOwn(body,'lat') && !Object.hasOwn(body,'lon')),
    'Solo los productores pueden registrar un predio.',403);
  const point = Object.hasOwn(body,'lat') || Object.hasOwn(body,'lon')
    ? coordinates(body.lat,body.lon) : [previous.lat,previous.lon];
  run(`INSERT INTO account_settings(user_id,phone,lat,lon) VALUES(?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET phone=excluded.phone,lat=excluded.lat,lon=excluded.lon`,user.id,phone,...point);
  if (body.emailPreferences !== undefined) {
    requireThat(body.emailPreferences && typeof body.emailPreferences === 'object' && !Array.isArray(body.emailPreferences),
      'Preferencias inválidas.');
    for (const [category,enabled] of Object.entries(body.emailPreferences)) {
      requireThat(categories.includes(category) && typeof enabled === 'boolean','Preferencias inválidas.');
      run(`INSERT INTO email_preferences VALUES(?,?,?)
        ON CONFLICT(user_id,category) DO UPDATE SET enabled=excluded.enabled`,user.id,category,Number(enabled));
    }
  }
  return privateProfile(user.id);
}));
route('POST','/account/security',true,async ({user,body,req,res,token}) => {
  throttle(req);
  const current = one('SELECT email,password FROM users WHERE id=?',user.id);
  const [salt,digest] = current.password.split(':');
  requireThat(timingSafeEqual(await derive(validPassword(body.currentPassword),salt,64),Buffer.from(digest,'hex')),
    'La contraseña actual es incorrecta.',401);
  const email = body.email === undefined ? current.email : emailAddress(body.email);
  let password = current.password;
  if (body.newPassword !== undefined && body.newPassword !== '') {
    const newSalt = randomBytes(16).toString('hex');
    password = newSalt + ':' + (await derive(validPassword(body.newPassword),newSalt,64)).toString('hex');
  }
  if (email === current.email && password === current.password) return privateProfile(user.id);
  return transaction(() => {
    const updated = run('UPDATE users SET email=?,password=? WHERE id=? AND email=? AND password=? AND NOT EXISTS(SELECT 1 FROM users WHERE email=? AND id<>?) AND EXISTS(SELECT 1 FROM sessions WHERE token=? AND expires>?)',
      email,password,user.id,current.email,current.password,email,user.id,hashToken(token),Date.now());
    requireThat(updated.changes,'La cuenta cambió o el correo ya está registrado.',409);
    run('DELETE FROM sessions WHERE user_id=?',user.id);
    const event = 'account:'+randomUUID();
    const message = 'Se actualizó el correo o la contraseña de tu cuenta. Si no reconoces el cambio, contacta con soporte.';
    mail.enqueue(user.id,'account',message,event);
    if (email !== current.email) mail.enqueue(user.id,'account',message,event+':previous',current.email);
    audit(user.id,user.id,'account.security');
    return session(res,user.id);
  });
});
route('GET','/profiles/(\\d+)',null,({match}) => {
  const profile = one(`SELECT ${publicUser} FROM users WHERE id=?`,Number(match[1]));
  requireThat(profile,'Perfil inexistente.',404);
  return { ...profile, reviews: all(`SELECT r.stars,r.comment,o.created FROM reviews r JOIN orders o ON o.id=r.order_id
    JOIN lots l ON l.id=o.lot WHERE l.producer=? ORDER BY o.created DESC LIMIT 100`,profile.id) };
});

route('GET','/lots',null,({query,user}) => {
  const where = [], args = [];
  const filter = (sql,value) => { where.push(sql); args.push(value); };
  if (query.get('mine') === '1') {
    requireThat(user?.role === 'productor','Acceso restringido.',403);
    filter('l.producer=?',user.id);
  } else if (query.get('favorites') === '1') {
    requireThat(user,'Inicia sesión.',401);
    filter('EXISTS(SELECT 1 FROM favorites f WHERE f.lot=l.id AND f.user_id=?)',user.id);
  } else {
    filter('l.deadline>=?',today());
    where.push('l.available>0');
  }
  if (query.get('q')) {
    const term = '%' + field(query.get('q'),'Búsqueda') + '%';
    where.push('(l.product LIKE ? OR l.description LIKE ?)');
    args.push(term,term);
  }
  for (const [key,column] of [['category','category'],['comuna','comuna'],['kind','kind']]) {
    if (query.get(key)) filter(`l.${column}=? COLLATE NOCASE`,field(query.get(key),key));
  }
  if (query.get('price')) filter('l.price<=?',integer(query.get('price'),'Precio'));
  if (query.get('kg')) filter('l.available>=?',integer(query.get('kg'),'Cantidad',1));
  if (query.get('deadline')) filter('l.deadline<=?',date(query.get('deadline')));
  const sort = { price:'l.price ASC', kg:'l.available DESC', deadline:'l.deadline ASC' };
  let order = Object.hasOwn(sort,query.get('sort')) ? sort[query.get('sort')] : 'l.id DESC';
  if (query.get('sort') === 'nearby') {
    const [lat,lon] = coordinates(query.get('lat'),query.get('lon'));
    requireThat(lat!==null && lon!==null,'Comparte tu ubicación para ordenar por distancia.');
    where.push('l.lat IS NOT NULL AND l.lon IS NOT NULL');
    order = 'distance_km(ROUND(l.lat,2),ROUND(l.lon,2),?,?) ASC';
    args.push(lat,lon);
  }
  const page = query.has('page') ? integer(query.get('page'),'Página',1,10000) : 1;
  return all(catalog + ' WHERE ' + where.join(' AND ') + ' ORDER BY ' + order + ',l.id DESC LIMIT 12 OFFSET ?',...args,(page-1)*12);
});
route('GET','/harvest-map',null,({query}) => {
  const after = query.has('after') ? integer(query.get('after'),'Cursor',0,Number.MAX_SAFE_INTEGER) : 0;
  return all(`SELECT l.id,l.product,l.comuna,l.kind,l.producer,u.name,
    ROUND(l.lat,2) AS lat,ROUND(l.lon,2) AS lon FROM lots l JOIN users u ON u.id=l.producer
    WHERE l.id>? AND l.deadline>=? AND l.available>0 AND l.lat BETWEEN -90 AND 90 AND l.lon BETWEEN -180 AND 180
    AND NOT EXISTS(SELECT 1 FROM withdrawn_lots w WHERE w.lot=l.id)
    ORDER BY l.id LIMIT 250`,after,today());
});
route('GET','/lots/(\\d+)',null,({match}) => {
  const lot = one(catalog + ' WHERE l.id=?',Number(match[1]));
  requireThat(lot,'Lote inexistente.',404);
  const rules = {
    small: integer(process.env.SMALL_LOT_KG || 300,'Umbral de agrupación',1),
    industrial: integer(process.env.INDUSTRIAL_LOT_KG || 1000,'Umbral industrial',1)
  };
  const days = (Date.parse(lot.deadline)-Date.parse(today()))/day;
  const destinations = days < 0 || !lot.available ? [] : lot.kind === 'donation' ? ['Donación'] : ['Venta directa'];
  if (destinations.length && lot.kind !== 'donation') {
    if (lot.kind === 'fresh' && lot.available <= rules.small && days >= 1) destinations.push('Lote Colaborativo');
    if (lot.available >= rules.industrial && days >= 1) destinations.push('Evaluar transformación agroindustrial');
    if (days <= 2) destinations.push('Evaluar donación si el producto es apto para consumo');
    if (/descarte|dañad|sobremadur/i.test(lot.quality)) destinations.push('Evaluar compostaje o alimentación animal según aptitud');
  }
  return {...lot,destinations,collaborative:!!one('SELECT id FROM collaborative WHERE offer=?',lot.id)};
});
route('POST','/lots',['productor'],({body,user}) => {
  const {kind} = body;
  requireThat(['fresh','future','donation'].includes(kind),'Tipo de publicación inválido.');
  const harvest = date(body.harvest);
  const deadline = date(body.deadline);
  requireThat(deadline >= today() && deadline >= harvest &&
    (kind === 'future' ? harvest > today() : harvest <= today()),'Revisa las fechas de cosecha y aprovechamiento.');
  const kg = integer(body.kg,'Cantidad',1);
  return transaction(() => {
    const id = run(`INSERT INTO lots(producer,product,category,description,kg,available,price,comuna,
      kind,quality,harvest,deadline,photo,lat,lon) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    user.id,field(body.product,'Producto'),field(body.category,'Categoría'),field(body.description,'Descripción',1500),
    kg,kg,kind === 'donation' ? 0 : integer(body.price,'Precio',1),field(body.comuna,'Comuna'),
    kind,field(body.quality,'Condición'),harvest,deadline,photo(body.photo),...coordinates(body.lat,body.lon)).lastInsertRowid;
    audit(user.id,id,'lot.publish');
    const lot = one('SELECT product,comuna FROM lots WHERE id=?',id);
    mail.enqueue(user.id,'publications',`Publicaste ${lot.product} en ${lot.comuna}.`,`publish:${id}`);
    deadlines();
    return { id };
  });
});
route('POST','/lots/(\\d+)/favorite',true,({user,match}) => {
  const id = Number(match[1]);
  requireThat(one('SELECT id FROM lots WHERE id=?',id),'Lote inexistente.',404);
  if (run('DELETE FROM favorites WHERE user_id=? AND lot=?',user.id,id).changes) return { saved:false };
  run('INSERT INTO favorites VALUES(?,?)',user.id,id);
  return {saved:true};
});
route('POST','/lots/(\\d+)/order',['comprador','organizacion'],({body,user,match}) => transaction(() => {
  const lot = one('SELECT * FROM lots WHERE id=?',Number(match[1]));
  requireThat(lot && lot.deadline >= today(),'Lote no disponible.',409);
  requireThat(lot.kind === 'donation' ? user.role === 'organizacion' : user.role === 'comprador','Tu rol no permite esta operación.',403);
  const kg = integer(body.kg,'Cantidad',1);
  if (one('SELECT id FROM collaborative WHERE offer=?',lot.id)) {
    requireThat(kg === lot.kg,'La oferta colaborativa se adquiere completa.');
  }
  requireThat(run('UPDATE lots SET available=available-? WHERE id=? AND available>=?',kg,lot.id,kg).changes,
    'La cantidad solicitada supera las existencias.',409);
  const id = randomUUID();
  const total = kg * lot.price;
  requireThat(lot.kind !== 'future' || total >= 10,'El monto mínimo de reserva es $10 CLP.');
  const deposit = lot.kind === 'future' ? Math.round(total * 0.25) : 0;
  const status = lot.kind === 'donation' ? 'requested' : 'pending';
  run('INSERT INTO orders(id,lot,buyer,kg,total,deposit,status) VALUES(?,?,?,?,?,?,?)',id,lot.id,user.id,kg,total,deposit,status);
  audit(user.id,id,'order.create');
  notify(lot.producer,`${user.name} solicitó ${kg} kg de ${lot.product}.`,null,'orders');
  return { id,total,deposit,status };
}));
route('GET','/orders',true,({user}) => all(`SELECT o.*,l.product,l.kind,l.harvest,l.producer,
  buyer.name AS buyer_name, seller.name AS seller_name,r.stars,a.kg AS proposed_kg,a.reason AS adjustment_reason,
  d.status AS dispatch_status,d.cost AS dispatch_cost,
  EXISTS(SELECT 1 FROM collaborative c WHERE c.offer=l.id) AS collaborative
  FROM orders o JOIN lots l ON l.id=o.lot JOIN users buyer ON buyer.id=o.buyer
  JOIN users seller ON seller.id=l.producer LEFT JOIN reviews r ON r.order_id=o.id
  LEFT JOIN adjustments a ON a.order_id=o.id LEFT JOIN dispatches d ON d.order_id=o.id
  WHERE o.buyer=? OR l.producer=? ORDER BY o.created DESC LIMIT 100`,user.id,user.id));
route('GET','/summary',['productor','comprador','organizacion'],({user}) => {
  const scope = user.role==='productor' ? 'l.producer=?' : 'o.buyer=?';
  const orders = one(`SELECT COUNT(*) AS orders,
    COUNT(CASE WHEN o.status='completed' THEN 1 END) AS completed,
    COUNT(CASE WHEN o.status='reserved' THEN 1 END) AS reserved,
    COUNT(CASE WHEN o.status IN ('pending','requested','accepted','paid') THEN 1 END) AS pending,
    COALESCE(SUM(CASE WHEN o.status='completed' AND NOT EXISTS
      (SELECT 1 FROM collaborative c WHERE c.offer=l.id) THEN o.total-o.commission ELSE 0 END),0) AS direct
    FROM orders o JOIN lots l ON l.id=o.lot WHERE `+scope,user.id);
  if (user.role!=='productor') return orders;
  const lots = one(`SELECT COUNT(*) AS lots,COUNT(CASE WHEN available>0 AND deadline>=? THEN 1 END) AS active,
    (SELECT COUNT(*) FROM losses WHERE producer=?) AS losses,
    (SELECT COUNT(DISTINCT c.id) FROM collaborative c JOIN contributions p ON p.group_id=c.id
      JOIN lots source ON source.id=p.lot WHERE source.producer=? AND p.status='accepted' AND c.status<>'cancelled') AS groups,
    (SELECT COALESCE(SUM(a.gross-a.commission),0) FROM allocations a JOIN lots source ON source.id=a.lot WHERE source.producer=?) AS group_income
    FROM lots WHERE producer=?`,today(),user.id,user.id,user.id,user.id);
  return {...orders,...lots};
});
route('POST','/orders/([a-f0-9-]+)/action',true,({body,user,match}) => transaction(() => {
  const order = one(`SELECT o.*,l.producer,l.kind,l.product,l.harvest FROM orders o JOIN lots l ON l.id=o.lot
    WHERE o.id=? AND (o.buyer=? OR l.producer=?)`,match[1],user.id,user.id);
  requireThat(order,'Operación inexistente.',404);
  const buyer = user.id === order.buyer;
  const pay = (kind,amount) => run('INSERT INTO payments(order_id,amount,kind) VALUES(?,?,?)',order.id,amount,kind);
  let next, note = '';
  switch (body.action) {
    case 'pay':
      requireThat(buyer && ['pending','reserved'].includes(order.status),'Pago no disponible.',409);
      requireThat(order.status !== 'pending' || Date.parse(order.created.replace(' ','T')+'Z')+30*60_000>Date.now(),
        'Venció el plazo de pago para este pedido.',409);
      requireThat(body.test === true,'Confirma que es un pago de prueba.');
      requireThat(!one('SELECT kg FROM adjustments WHERE order_id=?',order.id),'Resuelve el ajuste de volumen antes de pagar.',409);
      if (order.kind === 'future' && order.status === 'pending') {
        pay('deposit',order.deposit);
        next = 'reserved';
      } else {
        requireThat(order.kind !== 'future' || order.harvest <= today(),'El saldo se habilita en la fecha de cosecha.',409);
        pay('payment',order.total - order.deposit);
        next = 'paid';
      }
      break;
    case 'accept':
      requireThat(!buyer && order.status === 'requested','La solicitud no puede aprobarse.',409);
      next = 'accepted';
      break;
    case 'deliver':
      requireThat(!buyer && ['paid','accepted'].includes(order.status),'La entrega no puede registrarse.',409);
      next = 'completed';
      settleGroup(order);
      break;
    case 'cancel': {
      requireThat(['pending','requested','accepted','reserved','paid'].includes(order.status),'La operación ya está cerrada.',409);
      note = field(body.reason,'Motivo',500);
      refundOrder(order.id);
      run('UPDATE lots SET available=available+? WHERE id=?',order.kg,order.lot);
      run("UPDATE dispatches SET status='cancelled' WHERE order_id=? AND status<>'delivered'",order.id);
      next = 'cancelled';
      break;
    }
    case 'partial': {
      requireThat(!buyer && order.kind === 'future' && order.status === 'reserved','La reserva no admite ajustes.',409);
      const kg = integer(body.kg,'Cantidad',1,order.kg-1);
      note = field(body.reason,'Motivo',500);
      run('INSERT INTO adjustments(order_id,kg,reason) VALUES(?,?,?) ON CONFLICT(order_id) DO UPDATE SET kg=excluded.kg,reason=excluded.reason',order.id,kg,note);
      notify(order.buyer,`Se propuso entregar ${kg} kg de ${order.product}.`,null,'orders');
      audit(user.id,order.id,'order.partial.propose',note);
      return {status:order.status};
    }
    case 'accept-partial': {
      const adjustment = one('SELECT kg FROM adjustments WHERE order_id=?',order.id);
      requireThat(buyer && order.status === 'reserved' && adjustment,'El ajuste no está disponible.',409);
      const total = Math.round(order.total*adjustment.kg/order.kg);
      const refund = Math.max(0,order.deposit-total);
      if (refund) pay('refund',-refund);
      run('UPDATE orders SET kg=?,total=?,deposit=? WHERE id=?',adjustment.kg,total,order.deposit-refund,order.id);
      run('UPDATE lots SET kg=kg-? WHERE id=?',order.kg-adjustment.kg,order.lot);
      run('DELETE FROM adjustments WHERE order_id=?',order.id);
      notify(order.producer,`El comprador aceptó recibir ${adjustment.kg} kg de ${order.product}.`,null,'orders');
      audit(user.id,order.id,'order.partial.accept');
      return {status:order.status};
    }
    default: requireThat(false,'Acción inválida.');
  }
  run('UPDATE orders SET status=?,commission=? WHERE id=?',next,next === 'completed' ? Math.round(order.total*0.05) : 0,order.id);
  if (next === 'cancelled') run('DELETE FROM adjustments WHERE order_id=?',order.id);
  audit(user.id,order.id,'order.'+next,note);
  notify(buyer ? order.producer : order.buyer,`La operación de ${order.product} cambió a ${orderLabels[next]}.`,null,'orders');
  return {status:next};
}));
const orderLabels = {reserved:'reserva confirmada',paid:'pago de prueba registrado',accepted:'donación aprobada',completed:'entrega completada',cancelled:'operación cancelada'};
function refundOrder(id) {
  const paid = one('SELECT COALESCE(SUM(amount),0) AS amount FROM payments WHERE order_id=?',id).amount;
  if (paid>0) run("INSERT INTO payments(order_id,amount,kind) VALUES(?,?,'refund')",id,-paid);
}
route('GET','/orders/([a-f0-9-]+)/history',true,({user,match}) => {
  const order = one(`SELECT o.id FROM orders o JOIN lots l ON l.id=o.lot
    WHERE o.id=? AND (?='admin' OR o.buyer=? OR l.producer=?)`,match[1],user.role,user.id,user.id);
  requireThat(order,'Operación inexistente.',404);
  return {
    events:all('SELECT action,note,created FROM audit WHERE subject=? ORDER BY id DESC',order.id),
    payments:all('SELECT amount,kind,mode,created FROM payments WHERE order_id=? ORDER BY id DESC',order.id)
  };
});
route('POST','/lots/(\\d+)/force-majeure',['productor'],({body,user,match}) => transaction(() => {
  const id = Number(match[1]);
  const lot = one("SELECT product FROM lots WHERE id=? AND producer=? AND kind='future'",id,user.id);
  requireThat(lot,'Cosecha anticipada inexistente.',404);
  const reason = field(body.reason,'Motivo',500);
  requireThat(run('INSERT OR IGNORE INTO withdrawn_lots(lot,reason) VALUES(?,?)',id,reason).changes,
    'La cosecha ya fue retirada.',409);
  run('UPDATE lots SET available=0 WHERE id=?',id);
  for (const order of all("SELECT id,buyer FROM orders WHERE lot=? AND status IN ('pending','reserved','paid')",id)) {
    refundOrder(order.id);
    run("UPDATE orders SET status='cancelled' WHERE id=?",order.id);
    run('DELETE FROM adjustments WHERE order_id=?',order.id);
    run("UPDATE dispatches SET status='cancelled' WHERE order_id=? AND status<>'delivered'",order.id);
    audit(user.id,order.id,'order.force-majeure',reason);
    notify(order.buyer,`Se canceló tu reserva de ${lot.product} por fuerza mayor. Motivo: ${reason}.`,null,'orders');
  }
  audit(user.id,id,'lot.force-majeure',reason);
  return {};
}));
route('POST','/lots/(\\d+)/reschedule',['productor'],({body,user,match}) => transaction(() => {
  const lot = one("SELECT * FROM lots WHERE id=? AND producer=? AND kind='future'",Number(match[1]),user.id);
  requireThat(lot,'Cosecha anticipada inexistente.',404);
  requireThat(!one('SELECT lot FROM withdrawn_lots WHERE lot=?',lot.id),'La cosecha fue retirada.',409);
  const harvest = date(body.harvest), deadline = date(body.deadline);
  const reason = field(body.reason,'Motivo',500);
  requireThat(harvest>=today() && deadline>=harvest,'Revisa las fechas.');
  run('UPDATE lots SET harvest=?,deadline=? WHERE id=?',harvest,deadline,lot.id);
  run('UPDATE notices SET dedupe=NULL WHERE dedupe IN (?,?)','deadline:'+lot.id+':24','deadline:'+lot.id+':48');
  for (const row of all("SELECT DISTINCT buyer FROM orders WHERE lot=? AND status IN ('pending','reserved','paid')",lot.id)) {
    notify(row.buyer,`Se actualizó la cosecha de ${lot.product} al ${harvest}. Motivo: ${reason}.`,null,'harvest');
  }
  audit(user.id,lot.id,'lot.reschedule',reason);
  return {};
}));

const groupQuery = `SELECT c.*,l.product,l.comuna,l.quality,l.category,l.price,u.name,
  COALESCE((SELECT sum(p.kg) FROM contributions p WHERE p.group_id=c.id AND p.status='accepted'),0) AS total
  FROM collaborative c JOIN lots l ON l.id=c.base_lot JOIN users u ON u.id=c.owner`;
function groupLot(id,user) {
  const lot = one(`SELECT * FROM lots l WHERE l.id=? AND l.producer=? AND l.available>0 AND l.kind='fresh'
    AND l.deadline>=? AND NOT EXISTS(SELECT 1 FROM collaborative c WHERE c.offer=l.id)`,id,user,today());
  requireThat(lot,'Selecciona una cosecha propia con existencias.',409);
  return lot;
}
function releaseGroup(group) {
  for (const entry of all("SELECT lot,kg FROM contributions WHERE group_id=? AND status='accepted'",group.id)) {
    run('UPDATE lots SET available=available+? WHERE id=?',entry.kg,entry.lot);
  }
  if (group.offer) run('UPDATE lots SET available=0 WHERE id=?',group.offer);
  run("UPDATE collaborative SET status='cancelled' WHERE id=?",group.id);
}
route('GET','/groups',['productor'],({user}) => {
  const groups = all(groupQuery+" WHERE c.owner=? OR (c.status<>'cancelled' AND c.deadline>=?) ORDER BY c.id DESC LIMIT 100",user.id,today());
  return groups.map(item => ({...item,participants:all(`SELECT p.*,l.producer,l.comuna,u.name
    FROM contributions p JOIN lots l ON l.id=p.lot JOIN users u ON u.id=l.producer
    WHERE p.group_id=? AND (p.status='accepted' OR ?=? OR l.producer=?)`,item.id,item.owner,user.id,user.id)}));
});
route('POST','/groups',['productor'],({user,body}) => transaction(() => {
  const lot = groupLot(integer(body.lot,'Lote',1,Number.MAX_SAFE_INTEGER),user.id);
  const deadline = date(body.deadline);
  requireThat(deadline>=today() && deadline<=lot.deadline,'La fecha debe respetar el vencimiento del lote.');
  const target = integer(body.target,'Cantidad objetivo',1);
  const kg = integer(body.kg,'Aporte',1,lot.available);
  const id = run("INSERT INTO collaborative(owner,base_lot,target,deadline,status) VALUES(?,?,?,?,'open')",user.id,lot.id,target,deadline).lastInsertRowid;
  run('UPDATE lots SET available=available-? WHERE id=?',kg,lot.id);
  run("INSERT INTO contributions VALUES(?,?,?,'accepted')",id,lot.id,kg);
  audit(user.id,id,'group.create');
  return {id};
}));
route('POST','/groups/(\\d+)/action',['productor'],({body,user,match}) => transaction(() => {
  const item = one(groupQuery+' WHERE c.id=?',Number(match[1]));
  requireThat(item && item.status==='open','Agrupación cerrada o inexistente.',409);
  const manages = item.owner===user.id;
  requireThat(manages || body.action==='join','No puedes administrar esta agrupación.',403);
  requireThat(item.deadline>=today() || body.action==='cancel','La agrupación venció.',409);
  switch (body.action) {
    case 'join': {
      const lot = groupLot(integer(body.lot,'Lote',1,Number.MAX_SAFE_INTEGER),user.id);
      const normalize = value => value.trim().toLocaleLowerCase('es-CL');
      requireThat(!manages && ['product','quality','category','comuna'].every(key=> normalize(item[key]) === normalize(lot[key]))
        && lot.deadline>=item.deadline,'El lote debe coincidir en producto, categoría, condición y comuna, y cubrir la fecha límite.',409);
      const kg = integer(body.kg,'Aporte',1,lot.available);
      requireThat(run("INSERT OR IGNORE INTO contributions VALUES(?,?,?,'pending')",item.id,lot.id,kg).changes,'Ya existe una solicitud para este lote.',409);
      notify(item.owner,`${user.name} solicitó aportar ${kg} kg de ${lot.product}.`);
      break;
    }
    case 'accept':
    case 'reject': {
      const entry = one(`SELECT p.*,l.producer FROM contributions p JOIN lots l ON l.id=p.lot
        WHERE p.group_id=? AND p.lot=? AND p.status='pending'`,item.id,integer(body.lot,'Lote',1,Number.MAX_SAFE_INTEGER));
      requireThat(entry,'Solicitud inexistente.',404);
      if (body.action === 'accept') requireThat(run('UPDATE lots SET available=available-? WHERE id=? AND available>=?',entry.kg,entry.lot,entry.kg).changes,'El lote ya no tiene stock suficiente.',409);
      run('UPDATE contributions SET status=? WHERE group_id=? AND lot=?',body.action==='accept'?'accepted':'rejected',item.id,entry.lot);
      notify(entry.producer,`Tu solicitud de agrupación para ${item.product} se procesó: ${body.action==='accept'?'aprobada':'rechazada'}.`);
      break;
    }
    case 'offer': {
      const count = one("SELECT count(DISTINCT l.producer) AS count FROM contributions p JOIN lots l ON l.id=p.lot WHERE p.group_id=? AND p.status='accepted'",item.id).count;
      requireThat(count>=2 && item.total>=item.target && item.total<=1_000_000,'Se requieren dos productores y alcanzar el objetivo dentro del máximo de 1.000.000 kg.',409);
      const base = one('SELECT * FROM lots WHERE id=?',item.base_lot);
      const offer = run(`INSERT INTO lots(producer,product,category,description,kg,available,price,comuna,kind,quality,harvest,deadline,lat,lon)
        VALUES(?,?,?,?,?,?,?,?,'fresh',?,?,?,?,?)`,item.owner,item.product,item.category,'Oferta de Lote Colaborativo.',item.total,item.total,
      integer(body.price,'Precio',1),item.comuna,item.quality,base.harvest,item.deadline,base.lat,base.lon).lastInsertRowid;
      run("UPDATE collaborative SET offer=?,status='offered' WHERE id=?",offer,item.id);
      break;
    }
    case 'cancel':
      releaseGroup(item);
      break;
    default: requireThat(false,'Acción inválida.');
  }
  audit(user.id,item.id,'group.'+body.action);
  return {};
}));
function settleGroup(order) {
  const group = one('SELECT id FROM collaborative WHERE offer=?',order.lot);
  if (!group) return;
  const entries = all("SELECT lot,kg FROM contributions WHERE group_id=? AND status='accepted' ORDER BY lot",group.id);
  let cumulative = 0;
  const fee = Math.round(order.total*0.05);
  for (const entry of entries) {
    const commission = Math.round(fee*(cumulative+entry.kg)/order.kg)-Math.round(fee*cumulative/order.kg);
    cumulative += entry.kg;
    run('INSERT INTO allocations VALUES(?,?,?,?,?)',order.id,entry.lot,entry.kg,entry.kg*(order.total/order.kg),commission);
  }
}
route('GET','/allocations',['productor'],({user}) => all(`SELECT a.*,l.product FROM allocations a
  JOIN lots l ON l.id=a.lot WHERE l.producer=? ORDER BY a.rowid DESC LIMIT 100`,user.id));
route('POST','/orders/([a-f0-9-]+)/dispatch',true,({body,user,match}) => transaction(() => {
  const order = one(`SELECT o.*,l.producer FROM orders o JOIN lots l ON l.id=o.lot WHERE o.id=?`,match[1]);
  requireThat(order && (user.role==='admin' || [order.buyer,order.producer].includes(user.id)),'Operación inaccesible.',404);
  const dispatch = one('SELECT * FROM dispatches WHERE order_id=?',order.id);
  if (body.action === 'request') {
    requireThat(user.role!=='admin' && !dispatch && ['reserved','paid','accepted'].includes(order.status),'No puedes solicitar el despacho.',409);
    run("INSERT INTO dispatches(order_id,requester,status,note) VALUES(?,?,'requested',?)",order.id,user.id,field(body.note,'Instrucciones',500));
    notify(user.id===order.buyer?order.producer:order.buyer,'Se solicitó un despacho para la operación '+order.id+'.');
  } else {
    requireThat(user.role==='admin' && dispatch && dispatch.status!=='cancelled','Despacho inaccesible.',403);
    requireThat((body.action==='quote' && dispatch.status==='requested') ||
      (body.action==='deliver' && dispatch.status==='quoted'),'Transición de despacho inválida.',409);
    const cost = body.action==='quote' ? integer(body.cost,'Costo',0) : dispatch.cost;
    const commission = body.action==='deliver' ? Math.round(cost*0.05) : 0;
    run('UPDATE dispatches SET cost=?,commission=?,status=? WHERE order_id=?',cost,commission,body.action==='quote'?'quoted':'delivered',order.id);
    for (const id of [order.buyer,order.producer]) notify(id,'Se actualizó el despacho de la operación '+order.id+'.');
  }
  audit(user.id,order.id,'dispatch.'+body.action);
  return {};
}));
route('POST','/orders/([a-f0-9-]+)/review',['comprador'],({body,user,match}) => {
  const order = one('SELECT id FROM orders WHERE id=? AND buyer=? AND status=?',match[1],user.id,'completed');
  requireThat(order,'Solo puedes evaluar tus compras completadas.',403);
  requireThat(run('INSERT OR IGNORE INTO reviews VALUES(?,?,?)',order.id,integer(body.stars,'Estrellas',1,5),
    field(body.comment ?? '','Comentario',500,true)).changes,'Ya evaluaste esta operación.',409);
  return {};
});

route('GET','/losses',['productor','admin'],({user}) => user.role === 'admin'
  ? all('SELECT * FROM losses ORDER BY incident DESC LIMIT 100')
  : all('SELECT * FROM losses WHERE producer=? ORDER BY incident DESC LIMIT 100',user.id));
route('POST','/losses',['productor'],({body,user}) => transaction(() => {
  const crop = field(body.crop,'Cultivo');
  const comuna = field(body.comuna,'Comuna');
  const cause = field(body.cause,'Causa');
  const incident = date(body.incident);
  requireThat(incident <= today(),'El incidente no puede tener una fecha futura.');
  const id = run(`INSERT INTO losses(producer,crop,cause,kg,value,incident,comuna,lat,lon,description,photo)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`,user.id,crop,cause,integer(body.kg,'Cantidad',1),
    integer(body.value,'Valor',0,1_000_000_000),incident,comuna,...coordinates(body.lat,body.lon),
    field(body.description,'Descripción',1500),photo(body.photo)).lastInsertRowid;
  for (const neighbor of all("SELECT id FROM users WHERE role='productor' AND comuna=? COLLATE NOCASE AND id<>?",comuna,user.id)) {
    notify(neighbor.id,`Aviso informativo. Un productor de ${comuna} registró pérdidas de ${crop} por ${cause}.`,null,'harvest');
  }
  audit(user.id,id,'loss.register');
  return {id};
}));
route('GET','/notices',true,({user}) => {
  deadlines();
  return all('SELECT id,body,seen FROM notices WHERE recipient=? ORDER BY id DESC LIMIT 100',user.id);
});
route('POST','/notices/read',true,({user}) => {
  run('UPDATE notices SET seen=1 WHERE recipient=?',user.id);
  return {};
});
route('GET','/threads',true,({user}) => all(`SELECT l.id AS lot,l.product,u.id AS peer,u.name,
  MAX(m.id) AS last, SUM(CASE WHEN m.recipient=? AND m.seen=0 THEN 1 ELSE 0 END) AS unread
  FROM messages m JOIN lots l ON l.id=m.lot JOIN users u
  ON u.id=CASE WHEN m.sender=? THEN m.recipient ELSE m.sender END
  WHERE m.sender=? OR m.recipient=? GROUP BY l.id,u.id ORDER BY last DESC LIMIT 100`,user.id,user.id,user.id,user.id));
function thread({user,match}) {
  const lot = one('SELECT id,producer,product FROM lots WHERE id=?',Number(match[1]));
  const peer = one('SELECT id,name,role FROM users WHERE id=?',Number(match[2]));
  requireThat(lot && peer && peer.id !== user.id &&
    ((lot.producer === user.id && ['comprador','organizacion'].includes(peer.role)) ||
     (lot.producer === peer.id && ['comprador','organizacion'].includes(user.role))),
  'Conversación inaccesible.',403);
  return {lot,peer};
}
route('GET','/threads/(\\d+)/(\\d+)',true,({user,match}) => {
  const {lot,peer} = thread({user,match});
  const messages = all(`SELECT * FROM messages WHERE lot=? AND
    ((sender=? AND recipient=?) OR (sender=? AND recipient=?)) ORDER BY id DESC LIMIT 100`,
  lot.id,user.id,peer.id,peer.id,user.id).reverse();
  const meeting = meetingBase && one('SELECT room FROM meetings WHERE lot=? AND participant=?',
    lot.id,lot.producer===user.id?peer.id:user.id);
  return {lot,peer,messages,meetingEnabled:!!meetingBase,meetingUrl:meeting ? meetingUrl(meeting.room) : null};
});
function meetingUrl(room) {
  const url = new URL(meetingBase);
  url.pathname = url.pathname.replace(/\/$/,'')+'/'+room;
  return url.href;
}
route('POST','/threads/(\\d+)/(\\d+)/meeting',true,({user,match}) => transaction(() => {
  requireThat(meetingBase,'El proveedor de llamadas no está configurado.',503);
  const {lot,peer} = thread({user,match});
  const result = run('INSERT OR IGNORE INTO meetings VALUES(?,?,?)',lot.id,
    lot.producer===user.id?peer.id:user.id,randomBytes(24).toString('hex'));
  if (result.changes) notify(peer.id,`${user.name} abrió una sala de llamada para ${lot.product}.`);
  return {};
}));
route('POST','/threads/(\\d+)/(\\d+)/read',true,({user,match}) => {
  const {lot,peer} = thread({user,match});
  run('UPDATE messages SET seen=1 WHERE lot=? AND sender=? AND recipient=?',lot.id,peer.id,user.id);
  return {};
});
route('POST','/threads/(\\d+)/(\\d+)',true,({user,match,body}) => transaction(() => {
  const {lot,peer} = thread({user,match});
  const message = field(body.body ?? '','Mensaje',2000,true);
  const picture = photo(body.photo);
  requireThat(message || picture,'Escribe un mensaje o adjunta una fotografía.');
  run('INSERT INTO messages(sender,recipient,lot,body,photo) VALUES(?,?,?,?,?)',user.id,peer.id,lot.id,message,picture);
  notify(peer.id,`${user.name} te escribió sobre ${lot.product}.`);
  return {};
}));
route('GET','/admin',['admin'],() => ({
  users:all('SELECT id,name,email,role,comuna FROM users ORDER BY id DESC LIMIT 100'),
  stats:one(`SELECT (SELECT count(*) FROM users) AS users,(SELECT count(*) FROM lots) AS lots,
    (SELECT count(*) FROM users WHERE role='productor') AS producers,
    (SELECT count(*) FROM users WHERE role='comprador') AS buyers,
    (SELECT count(*) FROM orders WHERE status='completed') AS deliveries,
    (SELECT count(*) FROM orders o JOIN lots l ON l.id=o.lot WHERE o.status='completed' AND l.kind='donation') AS donations,
    (SELECT COALESCE(sum(kg),0) FROM orders WHERE status='completed') AS rescued,
    (SELECT COALESCE(sum(kg),0) FROM losses) AS lost,
    (SELECT COALESCE(sum(commission),0) FROM orders) AS commission`),
  activity:all('SELECT * FROM audit ORDER BY id DESC LIMIT 100'),
  dispatches:all('SELECT * FROM dispatches ORDER BY rowid DESC LIMIT 100'),
  plans:all('SELECT * FROM plans ORDER BY id')
}));
route('POST','/admin/plans',['admin'],({user,body}) => transaction(() => {
  const name = field(body.name,'Nombre');
  run(`INSERT INTO plans(name,monthly_clp,benefits) VALUES(?,?,?)
    ON CONFLICT(name) DO UPDATE SET monthly_clp=excluded.monthly_clp,benefits=excluded.benefits`,
  name,integer(body.monthly_clp,'Precio mensual',0),field(body.benefits,'Beneficios',1000));
  audit(user.id,name,'plan.save');
  return {};
}));

if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
  const {email,password} = authInput({email:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD});
  const existing = one('SELECT role FROM users WHERE email=?',email);
  requireThat(!existing || existing.role === 'admin','El correo administrativo pertenece a otro rol.');
  if (!existing) {
    const salt = randomBytes(16).toString('hex');
    const digest = (await derive(password,salt,64)).toString('hex');
    run("INSERT INTO users(email,password,role,name,comuna) VALUES(?,?,'admin','Administración','Santiago')",email,salt+':'+digest);
  }
}

const assets = new Map([
  ['/plataforma/', ['index.html','text/html; charset=utf-8']],
  ['/app.js', ['app.js','text/javascript; charset=utf-8']],
  ['/prototipo.css', ['prototipo.css','text/css; charset=utf-8']],
  ['/identidad.css', ['identidad.css','text/css; charset=utf-8']],
  ['/styles.css', ['styles.css','text/css; charset=utf-8']]
]);
const prototype = readFileSync(new URL('./public/prototipo.html',import.meta.url),'utf8');
const prototypeScript = /<script>([\s\S]*?)<\/script>/.exec(prototype)[1].replace(/\r\n?/g,'\n');
const scriptHash = createHash('sha256').update(prototypeScript).digest('base64');
const prototypePolicy = [
  "default-src 'none'",
  `script-src 'sha256-${scriptHash}' https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.js`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://tile.openstreetmap.org https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/images/",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ');
const server = createServer(async (req,res) => {
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' data:; frame-src https://www.openstreetmap.org; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    const url = new URL(req.url,'http://localhost');
    if (req.method === 'GET' && url.pathname === '/') {
      res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
      res.setHeader('Content-Security-Policy',prototypePolicy);
      res.setHeader('Content-Type','text/html; charset=utf-8');
      return res.end(prototype);
    }
    if (req.method === 'GET' && url.pathname === '/plataforma') {
      res.writeHead(308,{Location:'/plataforma/'});
      return res.end();
    }
    if (req.method === 'GET' && /^\/img\/(?:favicon\.png|logo-(?:cosecha-conecta|horizontal)\.webp|frutas\/[a-z]+\.webp)$/.test(url.pathname)) {
      let contents;
      try {
        contents = readFileSync(new URL('./public'+url.pathname,import.meta.url));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        requireThat(false,'Imagen no incluida en la exportación.',404);
      }
      res.setHeader('Content-Type',url.pathname.endsWith('.png')?'image/png':'image/webp');
      return res.end(contents);
    }
    if (req.method === 'GET' && assets.has(url.pathname)) {
      if (url.pathname === '/plataforma/') {
        const leaflet = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/';
        res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
        res.setHeader('Content-Security-Policy',[
          "default-src 'self'",`script-src 'self' ${leaflet}leaflet.js`,
          `style-src 'self' ${leaflet}leaflet.css`,
          `img-src 'self' data: https://tile.openstreetmap.org ${leaflet}images/`,
          "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'"
        ].join('; '));
      }
      const [file,type] = assets.get(url.pathname);
      res.setHeader('Content-Type',type);
      return res.end(readFileSync(new URL('./public/'+file,import.meta.url)));
    }
    const endpoint = routes.find(item => item.method === req.method && item.path.test(url.pathname));
    requireThat(endpoint,'Ruta inexistente.',404);
    const token = /(?:^|;\s*)session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
    const identity = token && one('SELECT user_id FROM sessions WHERE token=? AND expires>?',hashToken(token),Date.now());
    const user = identity ? one(`SELECT ${publicUser} FROM users WHERE id=?`,identity.user_id) : null;
    if (endpoint.access) requireThat(user,'Inicia sesión para continuar.',401);
    if (Array.isArray(endpoint.access)) requireThat(endpoint.access.includes(user.role),'Permisos insuficientes.',403);
    let body;
    if (req.method === 'POST') {
      requireThat(!req.headers.origin || ['http://','https://'].some(prefix => req.headers.origin === prefix + req.headers.host),
        'Origen inválido.',403);
      requireThat(req.headers['content-type']?.split(';')[0] === 'application/json','Se requiere JSON.',415);
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        requireThat(size <= 1_000_000,'La solicitud supera el tamaño permitido.',413);
        chunks.push(chunk);
      }
      try { body = JSON.parse(Buffer.concat(chunks)); } catch { requireThat(false,'JSON inválido.'); }
      requireThat(body && typeof body === 'object' && !Array.isArray(body),'Datos inválidos.');
    }
    const value = await endpoint.handler({req,res,user,token,body,query:url.searchParams,match:url.pathname.match(endpoint.path)});
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Type','application/json; charset=utf-8');
    res.end(JSON.stringify(value));
  } catch (error) {
    if (!error.status) console.error(error);
    res.statusCode = error.status || 500;
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Type','application/json; charset=utf-8');
    res.end(JSON.stringify({error:error.status ? error.message : 'Ocurrió un error interno.'}));
  }
});
const timer = setInterval(() => {
  try {
    transaction(() => {
      deadlines();
      expireUnpaidOrders();
      releaseExpiredGroups();
    });
    run('DELETE FROM sessions WHERE expires<=?',Date.now());
  } catch (error) { console.error(error); }
},60_000);
timer.unref();
const mailTimer = setInterval(() => void mail.flush().catch(console.error),15_000);
mailTimer.unref();
void mail.flush().catch(console.error);
transaction(() => {
  expireUnpaidOrders();
  releaseExpiredGroups();
});
server.listen(Number(process.env.PORT ?? 3000),process.env.HOST || '127.0.0.1',() => {
  console.log('Cosecha Conecta disponible en http://' + server.address().address + ':' + server.address().port);
});
