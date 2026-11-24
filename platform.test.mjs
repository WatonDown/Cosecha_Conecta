import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Script } from 'node:vm';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { openDatabase, snapshot } from './database.mjs';

const photo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0iYAAAAASUVORK5CYII=';
const password = 'clave-de-prueba-2026';
const dates = offset => {
  const local = new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Santiago'}).format(new Date());
  return new Date(Date.parse(local)+offset*86_400_000).toISOString().slice(0,10);
};

test('mercado persistente y permisos por rol', { timeout: 20000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(),'cosecha-test-'));
  let server;
  async function start() {
    server = spawn(process.execPath,['server.mjs'],{
      env:{...process.env,PORT:'0',HOST:'127.0.0.1',DATA_DIR:dir,ADMIN_EMAIL:'admin@test.cl',ADMIN_PASSWORD:password,
        MEETING_BASE_URL:'https://meeting.example.test',GMAIL_USER:'',GMAIL_APP_PASSWORD:''},
      stdio:['ignore','pipe','inherit']
    });
    const url = await Promise.race([
      once(server.stdout,'data').then(([chunk])=>chunk.toString().match(/http:\/\/[^\s]+/)[0]),
      once(server,'exit').then(([code])=>{throw new Error('Servidor finalizó con código '+code);})
    ]);
    return url;
  }
  async function stop() {
    if (!server || server.exitCode!==null || server.signalCode!==null) return;
    const done = once(server,'exit');
    server.kill();
    await done;
  }
  t.after(async()=>{await stop(); rmSync(dir,{recursive:true,force:true});});
  let origin = await start();
  const request = async (path,{cookie,body,status=200}={}) => {
    const response = await fetch(origin+'/api'+path,{
      method:body===undefined?'GET':'POST',
      headers:{...(cookie?{cookie}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{})},
      body:body===undefined?undefined:JSON.stringify(body)
    });
    const result = await response.json();
    assert.equal(response.status,status,JSON.stringify(result));
    return {result,cookie:response.headers.get('set-cookie')?.split(';')[0]};
  };
  const call = async (path,cookie,body,status) => (await request(path,{cookie,body,status})).result;
  const create = (name,role) => request('/register',{body:{email:name+'@test.cl',name,password,role,comuna:'Chimbarongo',photo}});
  const seller = await create('patricia','productor');
  const neighbor = await create('jose','productor');
  const buyer = await create('ana','comprador');
  const org = await create('fundacion','organizacion');
  const admin = await request('/login',{body:{email:'admin@test.cl',password}});
  assert.equal((await call('/admin',admin.cookie)).stats.users,5);
  await call('/admin',buyer.cookie,undefined,403);
  await call('/register',undefined,{role:'admin',email:'fake@test.cl',password},400);
  const profile = {name:'Patricia',comuna:'Chimbarongo',phone:'+56 9 1234 5678',lat:-34.70973,lon:-71.04751,
    emailPreferences:{publications:true,orders:true}};
  assert.equal((await call('/profile',seller.cookie,profile)).phone,profile.phone);
  await call('/profile',seller.cookie,{...profile,lat:true},400);
  await call('/profile',buyer.cookie,profile,403);
  const sellerPublic = await call('/profiles/'+seller.result.id);
  for (const key of ['email','phone','lat','lon','emailPreferences']) assert.ok(!(key in sellerPublic));
  const base = {product:'Tomate',category:'Hortalizas',description:'Variedad local',kg:60,
    price:1000,comuna:'Chimbarongo',kind:'fresh',quality:'Maduro primera',harvest:dates(0),deadline:dates(2),
    lat:-34.70973,lon:-71.04751,photo};
  const {id:lot} = await call('/lots',seller.cookie,base);
  await call('/lots',buyer.cookie,base,403);
  const [listing] = await call('/lots?price=1200&q=Tomate');
  assert.equal(listing.id,lot);
  assert.equal(listing.lat,-34.71);
  assert.deepEqual((await call('/harvest-map')).map(({id,lat,lon}) => ({id,lat,lon})),[{id:lot,lat:-34.71,lon:-71.05}]);
  assert.equal((await call('/lots?sort=nearby&lat=-34.71&lon=-71.05'))[0].id,lot);
  assert.equal((await call('/notices',buyer.cookie)).length,1);
  await call('/lots/'+lot+'/favorite',buyer.cookie,{});
  assert.equal((await call('/lots?favorites=1',buyer.cookie))[0].id,lot);
  const order = await call('/lots/'+lot+'/order',buyer.cookie,{kg:30});
  await call('/lots/'+lot+'/order',buyer.cookie,{kg:31},409);
  const orderPath = '/orders/'+order.id+'/action';
  await call(orderPath,buyer.cookie,{action:'pay',test:true});
  await call(orderPath,buyer.cookie,{action:'pay',test:true},409);
  await call('/orders/'+order.id+'/dispatch',buyer.cookie,{action:'request',note:'Retiro por la mañana'});
  await call('/orders/'+order.id+'/dispatch',admin.cookie,{action:'quote',cost:2000});
  await call(orderPath,seller.cookie,{action:'deliver'});
  await call('/orders/'+order.id+'/dispatch',admin.cookie,{action:'deliver'});
  assert.equal((await call('/orders',buyer.cookie))[0].commission,1500);
  await call('/orders/'+order.id+'/review',buyer.cookie,{stars:5});
  await call('/orders/'+order.id+'/review',buyer.cookie,{stars:4},409);
  assert.equal((await call('/lots/'+lot)).rating,5);

  const chat = '/threads/'+lot+'/'+seller.result.id;
  await call(chat,buyer.cookie,{body:'¿Dónde retiro?'});
  const reply = '/threads/'+lot+'/'+buyer.result.id;
  assert.equal((await call(reply,seller.cookie)).messages.length,1);
  assert.equal((await call(chat,org.cookie)).messages.length,0);
  await call(chat+'/meeting',buyer.cookie,{});
  const meeting = (await call(chat,buyer.cookie)).meetingUrl;
  assert.match(meeting,/^https:\/\/meeting\.example\.test\/[a-f0-9]{48}$/);
  assert.equal((await call(reply,seller.cookie)).meetingUrl,meeting);
  assert.equal((await call(chat,org.cookie)).meetingUrl,null);
  await call(reply+'/read',seller.cookie,{});
  assert.equal((await call('/threads',seller.cookie))[0].unread,0);
  await call('/losses',seller.cookie,{crop:'Tomate',cause:'Heladas',kg:12,value:12000,
    incident:dates(0),comuna:'Chimbarongo',description:'Zona baja',photo});
  assert.equal((await call('/losses',seller.cookie))[0].kg,12);
  assert.deepEqual(await call('/losses',neighbor.cookie),[]);
  assert.ok((await call('/notices',neighbor.cookie)).some(notice=>notice.body.includes('Aviso informativo')));

  const {id:future} = await call('/lots',seller.cookie,{...base,kind:'future',harvest:dates(3),deadline:dates(5)});
  const reservation = await call('/lots/'+future+'/order',buyer.cookie,{kg:10});
  assert.equal(reservation.deposit,2500);
  const reservationPath = '/orders/'+reservation.id+'/action';
  await call(reservationPath,buyer.cookie,{action:'pay',test:true});
  await call('/lots/'+future+'/reschedule',seller.cookie,{harvest:dates(4),deadline:dates(6),reason:'Lluvia'});
  await call(reservationPath,seller.cookie,{action:'partial',kg:2,reason:'Helada'});
  await call(reservationPath,buyer.cookie,{action:'accept-partial'});
  const revised = (await call('/orders',buyer.cookie)).find(item=>item.id===reservation.id);
  assert.equal(revised.total,2000);
  assert.equal(revised.deposit,2000);
  await call(reservationPath,seller.cookie,{action:'cancel',reason:'Fuerza mayor'});
  assert.equal((await call('/lots/'+future)).available,52);
  const lostReservation = await call('/lots/'+future+'/order',buyer.cookie,{kg:5});
  await call('/orders/'+lostReservation.id+'/action',buyer.cookie,{action:'pay',test:true});
  await call('/lots/'+future+'/force-majeure',seller.cookie,{reason:'Pérdida total después de una helada'});
  const lostHistory = await call('/orders/'+lostReservation.id+'/history',buyer.cookie);
  assert.equal(lostHistory.events[0].action,'order.force-majeure');
  assert.deepEqual(lostHistory.payments.map(payment=>payment.amount),[-1250,1250]);
  assert.equal((await call('/lots/'+future)).available,0);

  const {id:donation} = await call('/lots',seller.cookie,{...base,kind:'donation'});
  await call('/lots/'+donation+'/order',buyer.cookie,{kg:1},403);
  const gift = await call('/lots/'+donation+'/order',org.cookie,{kg:2});
  await call('/orders/'+gift.id+'/action',seller.cookie,{action:'accept'});
  await call('/orders/'+gift.id+'/action',seller.cookie,{action:'deliver'});
  assert.equal((await call('/orders',org.cookie))[0].commission,0);

  const {id:other} = await call('/lots',neighbor.cookie,base);
  const {id:group} = await call('/groups',seller.cookie,{lot,kg:10,target:22,deadline:dates(2)});
  const groupPath = '/groups/'+group+'/action';
  await call(groupPath,neighbor.cookie,{action:'join',lot:other,kg:12});
  await call(groupPath,seller.cookie,{action:'accept',lot:other});
  await call(groupPath,seller.cookie,{action:'offer',price:950});
  const [{offer,total}] = await call('/groups',seller.cookie);
  assert.equal(total,22);
  await call('/lots/'+offer+'/order',buyer.cookie,{kg:21},400);
  const joint = await call('/lots/'+offer+'/order',buyer.cookie,{kg:22});
  await call('/orders/'+joint.id+'/action',buyer.cookie,{action:'pay',test:true});
  await call('/orders/'+joint.id+'/action',seller.cookie,{action:'deliver'});
  assert.equal((await call('/allocations',neighbor.cookie))[0].gross,11400);
  assert.equal((await call('/summary',neighbor.cookie)).group_income,10830);
  assert.equal((await call('/summary',seller.cookie)).direct,28500);
  await call('/admin/plans',admin.cookie,{name:'Premium',monthly_clp:9900,benefits:'Analítica'});
  assert.equal((await call('/admin',admin.cookie)).plans[0].monthly_clp,9900);

  const credentials = {email:'jose.actualizado@test.cl',currentPassword:password,newPassword:'una-clave-nueva-2026'};
  const anotherSession = await request('/login',{body:{email:neighbor.result.email,password}});
  await call('/account/security',neighbor.cookie,{...credentials,currentPassword:'una-clave-incorrecta'},401);
  const changed = await request('/account/security',{cookie:neighbor.cookie,body:credentials});
  assert.equal(changed.result.email,credentials.email);
  for (const cookie of [neighbor.cookie,anotherSession.cookie]) assert.equal(await call('/me',cookie),null);
  assert.equal((await call('/me',changed.cookie)).email,credentials.email);
  await call('/login',undefined,{email:credentials.email,password},401);
  await call('/login',undefined,{email:credentials.email,password:credentials.newPassword});
  await call('/logout',changed.cookie,{});
  assert.equal(await call('/me',changed.cookie),null);

  const database = join(dir,'cosecha.sqlite');
  const saved = join(dir,'backup.sqlite');
  const restored = join(dir,'restored.sqlite');
  await snapshot(database,saved);
  await snapshot(saved,restored,true);
  const recovery = openDatabase(restored);
  try {
    assert.equal(recovery.prepare('SELECT COUNT(*) AS total FROM sessions').get().total,0);
    assert.equal(recovery.prepare('SELECT COUNT(*) AS total FROM users').get().total,5);
    assert.equal(recovery.prepare('SELECT lat FROM account_settings WHERE user_id=?').get(seller.result.id).lat,profile.lat);
    assert.equal(recovery.prepare("SELECT COUNT(*) AS total FROM email_queue WHERE category='account'").get().total,2);
    assert.equal(recovery.prepare("SELECT COUNT(*) AS total FROM email_queue WHERE status='pending'").get().total,0);
    assert.equal(recovery.prepare("SELECT COUNT(*) AS total FROM email_queue WHERE category='publications' AND event=?")
      .get('publish:'+lot).total,1);
    assert.ok(recovery.prepare("SELECT id FROM email_queue WHERE category='orders' AND recipient=?").get(seller.result.id));
    assert.ok(!recovery.prepare("SELECT id FROM email_queue WHERE category='orders' AND recipient=?").get(buyer.result.id));
  } finally { recovery.close(); }

  const prototype = await fetch(origin+'/');
  assert.equal(prototype.status,200);
  assert.equal(prototype.headers.get('referrer-policy'),'strict-origin-when-cross-origin');
  assert.match(prototype.headers.get('content-security-policy'), /https:\/\/tile\.openstreetmap\.org /);
  const markup = await prototype.text();
  assert.match(markup,/href="#cuenta" aria-label="Mi cuenta"/);
  assert.match(markup,/class="hero harvest-hero"/);
  assert.match(markup,/href="\/identidad\.css"/);
  assert.ok(markup.indexOf('home-market') < markup.indexOf('home-tools'));
  const inline = /<script>([\s\S]*?)<\/script>/.exec(markup)[1].replace(/\r\n?/g,'\n');
  const prototypeScript = new Script(inline);
  const nodes = new Map();
  const element = selector => {
    if (!nodes.has(selector)) nodes.set(selector,{
      innerHTML:'',addEventListener(){},setAttribute(){},removeAttribute(){}
    });
    return nodes.get(selector);
  };
  const browser = {scrollTo(){},addEventListener(){}};
  const sandbox = {
    window:browser,location:{hash:'#inicio'},
    document:{querySelector:element,querySelectorAll:()=>[],getElementById:()=>null,addEventListener(){}},
    console:{error:error=>{throw error;}}
  };
  prototypeScript.runInNewContext(sandbox);
  assert.match(element('#main').innerHTML,/El campo tiene/);
  for (const [view,title] of [
    ['mercado','Cosechas, compradores y negociaciones'],
    ['lotes','Sumar kilos para pedidos grandes'],
    ['reservas','Vende antes de cosechar'],
    ['traslados','Del predio al comprador'],
    ['predio','Mi Predio Inteligente'],
    ['mapa','Dónde y por qué se pierde producción'],
    ['reportes','Reportes'],
    ['cuenta','Mi Cuenta']
  ]) {
    sandbox.location.hash = '#'+view;
    sandbox.route();
    assert.ok(element('#main').innerHTML.includes(title),view);
  }
  const mapClasses = new Set();
  const failedTile = {classList:{add:name=>assert.equal(name,'leaflet-tile-failed')}};
  let note, unavailable = false;
  const mapNode = {
    appendChild:child=>{note=child;},
    classList:{toggle:(name,on)=>on ? mapClasses.add(name) : mapClasses.delete(name)}
  };
  const map = {setView(){return this;},invalidateSize(){}};
  const listeners = {};
  const leaflet = {
    map:()=>map,
    tileLayer:(url,options)=>{
      assert.equal(url,'https://tile.openstreetmap.org/{z}/{x}/{y}.png');
      assert.equal(options.referrerPolicy,'strict-origin-when-cross-origin');
      assert.match(options.attribution,/openstreetmap\.org\/copyright/);
      return {
        on(names,listener) { for (const name of names.split(' ')) listeners[name]=listener; },
        addTo(){},
        getContainer:()=>({querySelector:()=>unavailable?failedTile:null})
      };
    },
    layerGroup:()=>({addTo(){}}),marker:()=>({addTo(){}}),divIcon:options=>options
  };
  sandbox.window.L = sandbox.L = leaflet;
  sandbox.setTimeout = callback=>callback();
  sandbox.document.getElementById = ()=>mapNode;
  sandbox.document.createElement = ()=>({setAttribute(){}});
  assert.equal(sandbox.baseMap('mapPredio',[-34.45,-71.1],14),map);
  unavailable = true;
  listeners.tileerror({tile:failedTile});
  assert.ok(mapClasses.has('no-tiles'));
  assert.match(note.textContent,/Los marcadores y límites siguen activos/);
  unavailable = false;
  listeners.tileunload();
  assert.equal(note.textContent,'');
  assert.ok(!mapClasses.has('no-tiles'));
  const hash = createHash('sha256').update(inline).digest('base64');
  assert.ok(prototype.headers.get('content-security-policy').includes("'sha256-"+hash+"'"));
  for (const path of ['/plataforma/','/app.js','/styles.css','/prototipo.css','/identidad.css']) {
    const response = await fetch(origin+path);
    assert.equal(response.status,200);
    assert.ok(response.headers.has('content-security-policy'));
    assert.ok((await response.text()).length>100);
  }
  for (const [path,type] of [
    ['/img/favicon.png','image/png'],
    ['/img/logo-cosecha-conecta.webp','image/webp'],
    ['/img/logo-horizontal.webp','image/webp'],
    ['/img/frutas/tomate.webp','image/webp']
  ]) {
    const response = await fetch(origin+path);
    assert.equal(response.status,200);
    assert.equal(response.headers.get('content-type'),type);
    assert.ok((await response.arrayBuffer()).byteLength>100);
  }
  await stop();
  origin = await start();
  assert.equal((await call('/lots/'+lot)).available,20);
  assert.equal((await call('/me',buyer.cookie)).id,buyer.result.id);
  assert.equal((await call('/admin',admin.cookie)).stats.deliveries,3);
});
