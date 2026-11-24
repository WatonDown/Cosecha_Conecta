const main = document.querySelector('#main');
const nav = document.querySelector('#navigation');
const money = new Intl.NumberFormat('es-CL',{style:'currency',currency:'CLP'});
const number = new Intl.NumberFormat('es-CL');
const types = {fresh:'Recién cosechado',future:'Cosecha anticipada',donation:'Donación'};
const roles = {productor:'Productor',comprador:'Comprador',organizacion:'Organización social',admin:'Administración'};
const statuses = {pending:'Pendiente de pago',reserved:'Reserva confirmada',paid:'Pago registrado',requested:'Donación solicitada',accepted:'Donación aprobada',completed:'Entregado',cancelled:'Cancelado'};
let user, generation = 0, chatTimer;
let nearbyPosition;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key,value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2),value);
    else if (key === 'class') node.className = value;
    else node.setAttribute(key,value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child !== null && child !== undefined && child !== false) node.append(child);
  }
  return node;
}
const a = (label,href,style) => el('a',{href,class:style},label);
const p = (content,style) => el('p',{class:style},content);
const box = (...children) => el('section',{class:'panel stack'},children);
const empty = message => el('div',{class:'empty'},message);
const heading = text => el('h1',{},text);
const badge = text => el('span',{class:'badge'},text);
const image = (src,alt,style) => src && el('img',{src,alt,class:style,loading:'lazy'});
const action = (label,handler,style = 'secondary') => el('button',{type:'button',class:style,onclick:handler},label);
const group = (...children) => el('div',{class:'actions'},children);
const section = (title,...children) => el('section',{class:'section stack'},el('h2',{},title),children);
const metric = (title,value) => el('div',{class:'metric'},el('strong',{},value),el('span',{},title));
const localDate = () => new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Santiago'}).format(new Date());

async function api(path, body) {
  const response = await fetch('/api'+path, body === undefined ? {} : {
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data;
}
function input(label,name,type='text',attrs={}) {
  return el('label',{},label,el('input',{name,type,...attrs}));
}
function select(label,name,options) {
  return el('label',{},label,el('select',{name},Object.entries(options).map(([key,value]) => el('option',{value:key},value))));
}
function area(label,name,value='',required=false) {
  return el('label',{},label,el('textarea',{name,maxlength:1500,required},value));
}
const photoField = (required=false) => input('Fotografía','photo','file',{accept:'image/jpeg,image/png,image/webp',required});
const required = {required:true,maxlength:120};
function fileData(file) {
  if (file.size > 700_000) throw new Error('La fotografía debe pesar menos de 700 KB.');
  return new Promise((resolve,reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('No se pudo leer la fotografía.'));
    reader.readAsDataURL(file);
  });
}
function form(label, fields, submit) {
  const message = p('','feedback');
  message.setAttribute('role','status');
  const button = el('button',{type:'submit'},label);
  return el('form',{onsubmit:async event => {
    event.preventDefault();
    const target = event.currentTarget;
    button.disabled = true;
    message.textContent = '';
    try {
      const data = {};
      for (const [key,value] of new FormData(target)) {
        if (value instanceof File) {
          if (value.size) data[key] = await fileData(value);
        } else data[key] = value;
      }
      await submit(data,target);
    } catch (error) {
      message.textContent = error.message;
    } finally { button.disabled = false; }
  }},fields,group(button),message);
}
function coordinates(initialLat,initialLon) {
  const lat = input('Latitud','lat','number',{step:'any',min:-90,max:90,value:initialLat});
  const lon = input('Longitud','lon','number',{step:'any',min:-180,max:180,value:initialLon});
  const status = p('','feedback');
  status.setAttribute('role','status');
  const picker = interactiveMap(initialLat == null || initialLon == null ? [] : [{lat:initialLat,lon:initialLon}], (latValue,lonValue) => {
    lat.lastChild.value = latValue.toFixed(5);
    lon.lastChild.value = lonValue.toFixed(5);
    status.textContent = '';
  });
  const sync = () => picker.dispatchEvent(new CustomEvent('coordinatechange',{detail:[
    lat.lastChild.valueAsNumber, lon.lastChild.valueAsNumber
  ]}));
  lat.lastChild.addEventListener('input',sync);
  lon.lastChild.addEventListener('input',sync);
  return [el('div',{class:'fields'},lat,lon),group(action('Usar mi ubicación',() => {
    if (!navigator.geolocation) { status.textContent = 'Geolocalización no disponible.'; return; }
    status.textContent = 'Solicitando permiso de ubicación…';
    navigator.geolocation.getCurrentPosition(({coords}) => {
      lat.lastChild.value = coords.latitude.toFixed(5);
      lon.lastChild.value = coords.longitude.toFixed(5);
      sync();
      status.textContent = '';
    },() => { status.textContent = 'No se pudo obtener la ubicación. Puedes ingresar las coordenadas.'; });
  })),status,p('Selecciona un punto en el mapa o escribe las coordenadas.','muted'),picker];
}
function map(lat,lon) {
  return lat == null || lon == null ? null : interactiveMap([{lat,lon}]);
}
const maps = new Set();
function interactiveMap(points,onSelect) {
  const canvas = el('div',{class:'map','aria-label':'Mapa de OpenStreetMap'});
  const status = p('','feedback');
  status.setAttribute('role','status');
  const container = el('div',{},canvas,status);
  requestAnimationFrame(() => {
    if (!container.isConnected) return;
    const L = window.L;
    if (!L) {
      canvas.textContent = 'El mapa no se pudo cargar.';
      return;
    }
    const view = L.map(canvas,{scrollWheelZoom:false}).setView([-33.47,-70.65],5);
    maps.add(view);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{
      maxZoom:19, attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
      referrerPolicy:'strict-origin-when-cross-origin'
    }).on('tileerror',() => { status.textContent = 'Algunas imágenes del mapa no están disponibles.'; })
      .on('tileload',() => { status.textContent = ''; }).addTo(view);
    const markers = L.layerGroup().addTo(view);
    const show = (items,center) => {
      markers.clearLayers();
      const locations = new Map();
      for (const point of items) {
        const key = point.lat+','+point.lon;
        if (!locations.has(key)) locations.set(key,[]);
        locations.get(key).push(point);
      }
      const bounds = [];
      for (const entries of locations.values()) {
        const [{lat,lon,id,product}] = entries;
        bounds.push([lat,lon]);
        const alt = entries.length > 1 ? entries.length+' publicaciones' : product ?? 'Ubicación seleccionada';
        const marker = L.marker([lat,lon],{alt}).addTo(markers);
        if (id) marker.bindPopup(el('div',{},entries.map(point => el('div',{class:'list-item'},
          el('strong',{},point.product), p(point.comuna+' · '+types[point.kind]),
          a(point.name,'#productor/'+point.producer),el('br'),a('Ver publicación','#lote/'+point.id)))),{maxHeight:220});
      }
      if (center && bounds.length) view.fitBounds(bounds,{padding:[28,28],maxZoom:12});
    };
    show(points,true);
    if (onSelect) {
      view.on('click',({latlng}) => {
        const {lat,lng:lon} = latlng.wrap();
        show([{lat,lon}],false);
        onSelect(lat,lon);
      });
      container.addEventListener('coordinatechange',({detail:[lat,lon]}) => {
        const valid = Math.abs(lat)<=90 && Math.abs(lon)<=180;
        show(valid ? [{lat,lon}] : [],true);
      });
    }
  });
  return container;
}
function navigation(page) {
  const links = [['Catálogo','catalogo'],['Mapa','mapa'],['Meteorología','meteorologia']];
  if (user) links.push(['Mi panel','panel'],['Mensajes','mensajes'],['Alertas','alertas'],['Perfil','perfil']);
  else links.push(['Ingresar','ingresar'],['Crear cuenta','registro']);
  nav.replaceChildren(...links.map(([label,key]) => el('a',{href:'#'+key,'aria-current':page === key ? 'page':null},label)));
}
function auth(register) {
  const fields = register ? [
    input('Nombre o razón social','name','text',required),input('Comuna','comuna','text',required),
    select('Tipo de cuenta','role',Object.fromEntries(Object.entries(roles).filter(([role]) => role !== 'admin'))),
    photoField()
  ] : [];
  return el('div',{class:'narrow stack'},heading(register ? 'Crea tu cuenta' : 'Ingresa a tu cuenta'),box(
    form(register ? 'Registrarme' : 'Ingresar',[
      ...fields,input('Correo electrónico','email','email',{required:true,autocomplete:'email'}),
      input('Contraseña','password','password',{required:true,minlength:12,maxlength:128,autocomplete:register?'new-password':'current-password'})
    ],async data => {
      user = await api(register?'/register':'/login',data);
      location.hash = '#panel';
    }),
    a(register ? 'Ya tengo una cuenta' : 'Crear cuenta',register ? '#ingresar' : '#registro')
  ));
}
function lotGrid(lots) {
  return lots.length ? el('div',{class:'grid'}, lots.map(lot => el('article',{class:'card'},
    image(lot.photo,lot.product),badge(types[lot.kind]),el('h3',{},a(lot.product,'#lote/'+lot.id)),
    p(lot.name+' · '+lot.comuna,'muted compact'),p(number.format(lot.available)+' kg disponibles · Hasta '+lot.deadline,'compact'),
    el('span',{class:'price'},lot.kind === 'donation' ? 'Sin costo' : money.format(lot.price)+' / kg')
  ))) : empty('No hay publicaciones para mostrar.');
}
async function catalogPage(params) {
  const request = new URLSearchParams(params);
  if (request.get('sort') === 'nearby') {
    if (nearbyPosition) {
      request.set('lat',nearbyPosition.latitude.toFixed(2));
      request.set('lon',nearbyPosition.longitude.toFixed(2));
    } else request.delete('sort');
  }
  const lots = await api('/lots?'+request);
  const current = params.get('kind') || '';
  const filters = form('Buscar',[
    el('div',{class:'fields'},
      input('Producto','q'),input('Categoría','category'),input('Comuna','comuna'),
      input('Precio máximo por kg','price','number',{min:0}),input('Cantidad mínima (kg)','kg','number',{min:1}),
      input('Disponible hasta','deadline','date'),
      select('Ordenar por','sort',{'':'Más recientes',price:'Menor precio',kg:'Mayor cantidad',deadline:'Próximo vencimiento'})
    )
  ],data => {
    const next = new URLSearchParams(Object.entries(data).filter(([,value]) => value));
    if (current) next.set('kind',current);
    location.hash = '#catalogo?'+next;
  });
  const geoStatus = p('','feedback');
  geoStatus.setAttribute('role','status');
  const nearby = action('Ordenar desde mi ubicación',()=>{
    if (!navigator.geolocation) {geoStatus.textContent='Geolocalización no disponible.'; return;}
    navigator.geolocation.getCurrentPosition(({coords})=>{
      nearbyPosition = coords;
      const next = new URLSearchParams(params);
      next.set('sort','nearby');
      next.delete('page');
      if (location.hash === '#catalogo?'+next) void render();
      else location.hash='#catalogo?'+next;
    },()=>{geoStatus.textContent='No se pudo obtener el permiso o la ubicación.';});
  });
  for (const [key,value] of params) if (filters.elements.namedItem(key)) filters.elements.namedItem(key).value = value;
  const page = Number(params.get('page') || 1);
  const pageLink = offset => {
    const next = new URLSearchParams(params);
    next.set('page',page+offset);
    return '#catalogo?'+next;
  };
  return [
    el('section',{class:'hero'},
      el('div',{class:'hero-copy'},el('div',{class:'eyebrow'},'Mercado agrícola · Chile'),
        heading('Más destinos para cada cosecha'),
        p('Compra, reserva o rescata productos directamente de quienes los cultivan.'),
        a(user?.role === 'productor' ? 'Publicar un lote' : 'Ver cosechas frescas',user?.role === 'productor' ? '#publicar' : '#catalogo?kind=fresh','button')),
      el('figure',{class:'hero-photo'},image('/img/frutas/tomate.webp','Tomates en una cesta'),
        el('figcaption',{},'George Chernilevsky · CC BY 4.0 · Wikimedia Commons'))),
    section('Catálogo agrícola',
      el('div',{class:'tabs'},Object.entries({'':'Todos',...types}).map(([key,title]) =>
        el('a',{href:key?'#catalogo?kind='+key:'#catalogo','aria-current':key===current?'page':null},title))),
      box(filters,group(nearby),geoStatus,nearbyPosition && params.get('sort')==='nearby' && p('Ordenado por distancia aproximada.','muted')),lotGrid(lots),
      group(page>1 && a('Página anterior',pageLink(-1),'button secondary'),
        lots.length === 12 && a('Página siguiente',pageLink(1),'button secondary')))
  ];
}
async function detail(id) {
  const lot = await api('/lots/'+id);
  const eligible = lot.kind === 'donation' ? user?.role === 'organizacion' : user?.role === 'comprador';
  const live = lot.available > 0 && lot.deadline >= localDate();
  const favoriteStatus = p('','muted');
  favoriteStatus.setAttribute('role','status');
  const operation = lot.kind === 'future' ? 'Solicitar reserva' : lot.kind === 'donation' ? 'Solicitar donación' : 'Crear pedido';
  return [a('Volver al catálogo','#catalogo'),el('div',{class:'layout section'},
    box(badge(types[lot.kind]),heading(lot.product),image(lot.photo,lot.product,'detail-img'),p(lot.description),
      p(lot.category+' · '+lot.quality),p('Cosecha '+lot.harvest+' · Aprovechamiento hasta '+lot.deadline,'muted'),
      el('h2',{},'Origen en '+lot.comuna),lot.lat !== null && p('Ubicación aproximada','muted'),map(lot.lat,lot.lon),
      lot.lat !== null && el('a',{href:'https://www.openstreetmap.org/directions?to='+lot.lat+'%2C'+lot.lon,
        target:'_blank',rel:'noopener noreferrer'},'Planificar ruta a la ubicación aproximada'),
      user?.id === lot.producer && lot.destinations.length > 0 && section('Destinos sugeridos por reglas',el('ul',{},lot.destinations.map(item=>el('li',{},item)))),
      user?.id === lot.producer && lot.kind === 'future' && !lot.withdrawn && section('Actualizar fecha de cosecha',form('Notificar actualización',[
        input('Nueva cosecha','harvest','date',{required:true,value:lot.harvest}),
        input('Nueva fecha límite','deadline','date',{required:true,value:lot.deadline}),input('Motivo','reason','text',required)
      ],async data => {await api('/lots/'+id+'/reschedule',data); await render();})),
      user?.id === lot.producer && lot.kind === 'future' && !lot.withdrawn &&
        el('details',{},el('summary',{},'Retirar cosecha por fuerza mayor'),
          form('Retirar y cancelar reservas',[
            input('Motivo','reason','text',required),
            el('label',{class:'check'},el('input',{type:'checkbox',required:true}),'Confirmo la pérdida total de la cosecha')
          ],async data => {await api('/lots/'+id+'/force-majeure',data); await render();}))),
    box(el('h2',{},'Disponibilidad'),p(live ? number.format(lot.available)+' kg' : 'Lote no disponible'),
      el('span',{class:'price'},lot.kind === 'donation' ? 'Donación' : money.format(lot.price)+' / kg'),
      a(lot.name,'#productor/'+lot.producer),
      lot.rating != null && p('★ '+lot.rating.toFixed(1)),
      !user && a('Ingresar para continuar','#ingresar','button'),
      eligible && live && form(operation,[input('Cantidad (kg)','kg','number',{min:lot.collaborative?lot.available:1,max:lot.available,required:true,value:lot.collaborative?lot.available:null}),
        lot.kind === 'future' && p('La reserva requiere un depósito de prueba del 25 %.','muted')],async data => {
        await api('/lots/'+id+'/order',data); location.hash='#pedidos';
      }),
      (user?.role === 'comprador' || user?.role === 'organizacion') && a('Contactar al productor','#chat/'+id+'/'+lot.producer,'button secondary'),
      user && action('Cambiar favorito',async () => {
        try {
          const result = await api('/lots/'+id+'/favorite',{});
          favoriteStatus.textContent = result.saved ? 'Guardado en favoritos.' : 'Eliminado de favoritos.';
        } catch (error) { favoriteStatus.textContent = error.message; }
      }),favoriteStatus)
  )];
}
async function dashboard() {
  if (user.role === 'admin') {
    const data = await api('/admin');
    const labels = {users:'Usuarios',lots:'Lotes publicados',producers:'Productores',buyers:'Compradores',
      deliveries:'Entregas completadas',donations:'Donaciones entregadas',rescued:'Kilogramos entregados',
      lost:'Kilogramos perdidos',commission:'Comisión de prueba'};
    return [heading('Administración'),el('div',{class:'grid'},Object.entries(data.stats).map(([key,value]) =>
      metric(labels[key],key==='commission'?money.format(value):number.format(value)))),
    section('Usuarios',box(data.users.map(item => p(item.name+' · '+roles[item.role]+' · '+item.email,'list-item')))),
    section('Despachos',data.dispatches.length ? data.dispatches.map(item => {
      const submit = async (key,fields) => {await api('/orders/'+item.order_id+'/dispatch',{...fields,action:key}); await render();};
      return box(p(item.note),p(dispatchLabels[item.status]+' · '+money.format(item.cost)),
        item.status==='requested' && form('Cotizar despacho',[input('Costo (CLP)','cost','number',{required:true,min:0})],fields=>submit('quote',fields)),
        item.status==='quoted' && form('Registrar entrega del despacho',[],()=>submit('deliver',{})));
    }) : empty('No hay solicitudes de despacho.')),
    section('Planes Premium',box(data.plans.map(plan=>p(plan.name+' · '+money.format(plan.monthly_clp)+' al mes · '+plan.benefits)),
      form('Guardar plan',[input('Nombre','name','text',required),input('Precio mensual (CLP)','monthly_clp','number',{required:true,min:0}),
        area('Beneficios','benefits','',true)],async data => {await api('/admin/plans',data); await render();}))),
    section('Auditoría',box(data.activity.map(item => p(item.created+' · '+item.action+' · '+item.subject,'list-item'))))];
  }
  const producer = user.role === 'productor';
  const [summary,notices,extra] = await Promise.all([api('/summary'),api('/notices'),
    producer ? [] : api('/lots?'+(user.role === 'organizacion' ? 'kind=donation' : 'favorites=1'))]);
  return [badge(roles[user.role]),heading('Hola, '+user.name),
    group(a('Ver operaciones','#pedidos','button'),producer && a('Publicar lote','#publicar','button secondary'),
      producer && a('Mapa de pérdidas','#perdidas','button secondary'),producer && a('Mis lotes','#mis-lotes','button secondary'),
      producer && a('Lote Colaborativo','#grupos','button secondary')),
    section('Resumen',el('div',{class:'grid'},
      metric('Operaciones registradas',summary.orders),metric('Entregas completadas',summary.completed),
      metric('Reservas confirmadas',summary.reserved),metric('Pedidos pendientes',summary.pending),
      producer && metric('Lotes publicados',summary.lots),producer && metric('Lotes disponibles',summary.active),
      producer && metric('Lotes colaborativos',summary.groups),
      producer && metric('Ingresos de prueba',money.format(summary.direct+summary.group_income)),
      producer && metric('Pérdidas registradas',summary.losses))),
    !producer && section(user.role === 'organizacion'?'Donaciones disponibles':'Favoritos',lotGrid(extra)),
    section('Alertas recientes',notices.length ? box(notices.slice(0,4).map(item => p(item.body,'list-item'))) : empty('Todavía no tienes alertas.'))
  ];
}
function publish() {
  return [heading('Publicar lote'),box(form('Publicar',[
    el('div',{class:'fields'},input('Producto','product','text',required),input('Categoría','category','text',required),
      select('Tipo de publicación','kind',types),input('Comuna','comuna','text',{...required,value:user.comuna}),
      input('Cantidad (kg)','kg','number',{min:1,required:true}),input('Precio por kg (CLP)','price','number',{min:0,value:0}),
      input('Fecha de cosecha','harvest','date',{required:true,value:localDate()}),
      input('Fecha límite','deadline','date',{required:true,min:localDate()})),
    input('Condición, variedad y madurez','quality','text',required),area('Descripción','description','',true),photoField(),
    p('El catálogo muestra una ubicación aproximada cuando compartes coordenadas.','muted'),coordinates(user.lat,user.lon)
  ],async data => { const result = await api('/lots',data); location.hash='#lote/'+result.id; }))];
}
async function ordersPage() {
  const orders = await api('/orders');
  return [heading('Mis operaciones'),p('Los pagos, depósitos y reembolsos se registran en modo de prueba. El pago inicial debe registrarse dentro de 30 minutos.','muted'),
    orders.length ? el('div',{class:'stack'},orders.map(item => {
      const buyer = user.id === item.buyer;
      const submit = async data => { await api('/orders/'+item.id+'/action',data); await render(); };
      const formAction = (title,key) => form(title,[],() => submit({action:key}));
      const canPay = buyer && !item.proposed_kg && (item.status === 'pending' || (item.status === 'reserved' && item.harvest <= localDate()));
      const payLabel = item.kind === 'future' && item.status === 'pending' ? 'Registrar depósito de prueba' : 'Registrar pago de prueba';
      const payAmount = item.kind === 'future' && item.status === 'pending' ? item.deposit : item.total-item.deposit;
      return box(badge(statuses[item.status]),el('h2',{},a(item.product,'#lote/'+item.lot)),
        p(item.kg+' kg · '+money.format(item.total)+' · '+(buyer?item.seller_name:item.buyer_name)),
        a('Ver historial de la operación','#historial/'+item.id),
        item.kind === 'future' && p('Cosecha '+item.harvest+' · Depósito '+money.format(item.deposit),'muted'),
        item.proposed_kg && p('Entrega parcial propuesta · '+item.proposed_kg+' kg · '+item.adjustment_reason),
        buyer && item.proposed_kg && group(a('Buscar lotes para completar el volumen','#catalogo?q='+encodeURIComponent(item.product))),
        buyer && item.proposed_kg && formAction('Aceptar volumen ajustado','accept-partial'),
        !buyer && item.kind === 'future' && item.status === 'reserved' && item.kg > 1 && el('details',{},el('summary',{},'Proponer entrega parcial'),
          form('Enviar propuesta',[input('Cantidad disponible (kg)','kg','number',{required:true,min:1,max:item.kg-1}),
            input('Motivo','reason','text',required)],data=>submit({...data,action:'partial'}))),
        canPay && form(payLabel,[el('label',{class:'check'},el('input',{type:'checkbox',required:true}), 'Confirmo el registro de '+money.format(payAmount)+' en modo de prueba')],() => submit({action:'pay',test:true})),
        !buyer && item.status === 'requested' && formAction('Aprobar donación','accept'),
        !buyer && ['paid','accepted'].includes(item.status) && formAction('Registrar entrega','deliver'),
        item.dispatch_status && p('Despacho · '+dispatchLabels[item.dispatch_status]+' · '+money.format(item.dispatch_cost)),
        !item.dispatch_status && ['reserved','paid','accepted'].includes(item.status) && el('details',{},el('summary',{},'Solicitar despacho'),
          form('Enviar solicitud',[area('Instrucciones','note','',true)],async data => {
            await api('/orders/'+item.id+'/dispatch',{...data,action:'request'}); await render();
          })),
        !['completed','cancelled'].includes(item.status) && el('details',{},el('summary',{},'Cancelar operación'),
          form('Confirmar cancelación',[input('Motivo','reason','text',required)],data => submit({...data,action:'cancel'}))),
        buyer && item.status === 'completed' && !item.stars && form('Guardar evaluación',[
          select('Estrellas','stars',{5:'5',4:'4',3:'3',2:'2',1:'1'}),area('Comentario','comment')
        ],async data => { await api('/orders/'+item.id+'/review',data); await render(); }),
        item.stars && p('Evaluación registrada · ★ '+item.stars));
    })) : empty('Todavía no tienes operaciones.')];
}
const dispatchLabels = {requested:'Solicitado',quoted:'Cotizado',delivered:'Entregado',cancelled:'Cancelado'};
async function history(id) {
  const data = await api('/orders/'+id+'/history');
  const labels = {
    'order.create':'Operación creada','order.reserved':'Reserva confirmada','order.paid':'Pago registrado',
    'order.partial.propose':'Ajuste de volumen propuesto','order.partial.accept':'Ajuste de volumen aceptado',
    'order.cancelled':'Operación cancelada','order.force-majeure':'Cancelación por fuerza mayor',
    'order.expired':'Plazo de pago vencido',
    'order.accepted':'Donación aprobada','order.completed':'Entrega registrada',
    'dispatch.request':'Despacho solicitado','dispatch.quote':'Despacho cotizado','dispatch.deliver':'Despacho entregado'
  };
  const payments = {deposit:'Depósito',payment:'Pago',refund:'Reembolso'};
  return [a('Volver a operaciones','#pedidos'),heading('Historial de la operación'),
    section('Actividad',box(data.events.map(item=>p(labels[item.action]+' · '+item.created+(item.note ? ' · '+item.note : ''),'list-item')))),
    section('Movimientos de prueba',data.payments.length ? box(data.payments.map(item=>
      p(payments[item.kind]+' · '+money.format(item.amount)+' · '+item.created,'list-item'))) : empty('Todavía no hay movimientos.'))];
}
async function groupsPage() {
  const [groups,lots,allocations] = await Promise.all([api('/groups'),api('/lots?mine=1'),api('/allocations')]);
  const choices = Object.fromEntries(lots.filter(item=>item.kind==='fresh' && item.available>0 && item.deadline>=localDate())
    .map(item=>[item.id,item.product+' · '+item.available+' kg']));
  const canContribute = Object.keys(choices).length > 0;
  const contribution = () => [select('Cosecha propia','lot',choices),input('Aporte (kg)','kg','number',{required:true,min:1})];
  return [heading('Lote Colaborativo'),
    section('Crear agrupación',canContribute ? box(form('Crear agrupación',[
      ...contribution(),input('Cantidad objetivo (kg)','target','number',{required:true,min:1}),
      input('Fecha límite','deadline','date',{required:true,min:localDate()})
    ],async data=>{await api('/groups',data); await render();})) : empty('Publica una cosecha disponible para aportar.')),
    section('Agrupaciones',groups.length ? groups.map(item=>{
      const manages = item.owner===user.id;
      const open = item.status==='open' && item.deadline>=localDate();
      const submit = async (key,fields={})=>{await api('/groups/'+item.id+'/action',{...fields,action:key}); await render();};
      return box(el('h3',{},item.product),p(item.name+' · '+item.comuna+' · '+item.quality),
        p(item.total+' de '+item.target+' kg · Hasta '+item.deadline),
        item.status==='offered' ? a('Ver oferta conjunta','#lote/'+item.offer) :
          badge(item.status==='cancelled'?'Cerrada':open?'Recibe aportes':'Vencida'),
        item.participants.map(entry=>el('div',{class:'list-item'},
          p(entry.name+' · '+entry.comuna+' · '+entry.kg+' kg · '+{accepted:'Aprobado',pending:'Pendiente',rejected:'Rechazado'}[entry.status]),
          manages && open && entry.status==='pending' && group(
            form('Aprobar aporte',[],()=>submit('accept',{lot:entry.lot})),
            form('Rechazar aporte',[],()=>submit('reject',{lot:entry.lot}))))),
        !manages && open && canContribute && form('Solicitar aporte',contribution(),data=>submit('join',data)),
        manages && open && form('Publicar oferta conjunta',[input('Precio por kg (CLP)','price','number',{required:true,min:1})],data=>submit('offer',data)),
        manages && item.status==='open' && form('Cancelar y liberar existencias',[],()=>submit('cancel')));
    }) : empty('Todavía no hay agrupaciones.')),
    section('Distribución de ingresos de prueba',allocations.length ? box(allocations.map(item=>
      p(item.product+' · '+item.kg+' kg · Neto '+money.format(item.gross-item.commission),'list-item'))) : empty('Todavía no tienes liquidaciones colaborativas.'))];
}
async function losses() {
  const records = await api('/losses');
  const byCause = new Map();
  const byCrop = new Map();
  for (const item of records) {
    byCause.set(item.cause,(byCause.get(item.cause)||0)+item.kg);
    byCrop.set(item.crop,(byCrop.get(item.crop)||0)+item.kg);
  }
  const total = records.reduce((sum,item)=>sum+item.kg,0);
  const bars = (title,buckets) => buckets.size > 0 && section(title,box([...buckets].map(([label,kg]) => el('label',{},
    label+' · '+number.format(kg)+' kg',el('progress',{value:kg,max:total})))));
  return [heading('Mapa de pérdidas agrícolas'),
    el('div',{class:'grid'},metric('Kilogramos perdidos',number.format(total)),
      metric('Impacto económico',money.format(records.reduce((sum,item)=>sum+item.value,0)))),
    user.role === 'productor' && section('Registrar pérdida',box(form('Guardar registro',[
      el('div',{class:'fields'},input('Cultivo','crop','text',required),input('Comuna','comuna','text',{...required,value:user.comuna}),
        select('Causa','cause',Object.fromEntries(['Heladas','Sequía','Inundación','Plagas','Enfermedades','Problemas climáticos','Problemas de producción','Fuerza mayor','Otra'].map(item=>[item,item]))),
        input('Fecha del incidente','incident','date',{required:true,max:localDate()}),
        input('Kilogramos perdidos','kg','number',{required:true,min:1}),input('Valor estimado (CLP)','value','number',{required:true,min:0})),
      area('Descripción','description','',true),photoField(),coordinates()
    ],async data => {await api('/losses',data); await render();}))),
    bars('Pérdidas por causa',byCause),bars('Pérdidas por cultivo',byCrop),
    section('Historial',records.length ? records.map(item => box(el('h3',{},item.crop),
      p(item.cause+' · '+item.incident+' · '+item.comuna),p(number.format(item.kg)+' kg · '+money.format(item.value)),
      p(item.description),image(item.photo,item.crop,'detail-img'),map(item.lat,item.lon))) : empty('Todavía no hay pérdidas registradas.'))];
}
async function threads() {
  const items = await api('/threads');
  return [heading('Mensajes'),items.length ? box(items.map(item => el('div',{class:'list-item'},
    a(item.name+' · '+item.product,'#chat/'+item.lot+'/'+item.peer),
    item.unread>0 && p(item.unread+' sin leer','muted')))) : empty('Contacta a un productor desde el detalle de un lote.')];
}
async function chat(id,peer,version) {
  const path = '/threads/'+id+'/'+peer;
  const thread = await api(path);
  const history = el('div',{class:'stack','aria-live':'polite'});
  const feedback = p('','feedback');
  let last;
  function show(messages) {
    const latest = messages.at(-1)?.id ?? 0;
    if (latest === last) return;
    last = latest;
    history.replaceChildren(...(messages.length ? messages.map(item => el('div',{
      class:'message'+(item.sender===user.id?' mine':'')},p(item.body),image(item.photo,'Fotografía adjunta'),
      el('small',{},item.created))) : [empty('Inicia la conversación sobre este lote.')]));
  }
  async function update() {
    const result = await api(path);
    if (generation !== version) return;
    show(result.messages);
    if (result.messages.some(item => item.recipient === user.id && !item.seen)) await api(path+'/read',{});
    feedback.textContent = '';
  }
  show(thread.messages);
  if (thread.messages.some(item => item.recipient === user.id && !item.seen)) await api(path+'/read',{});
  if (generation === version) chatTimer = setInterval(() => update().catch(error => { feedback.textContent=error.message; }),2500);
  return [a('Volver a mensajes','#mensajes'),heading(thread.peer.name),p(thread.lot.product,'muted'),
    thread.meetingEnabled && section('Llamada y videollamada',thread.meetingUrl
      ? el('a',{class:'button secondary',href:thread.meetingUrl,target:'_blank',rel:'noopener noreferrer'},'Abrir sala de llamada')
      : box(form('Crear sala',[],async ()=>{await api(path+'/meeting',{}); await render();}))),
    box(history,feedback,form('Enviar',[area('Mensaje','body'),photoField()],async (data,target) => {
      await api(path,data); target.reset(); await update();
    }))];
}
async function alerts() {
  const items = await api('/notices');
  return [heading('Alertas'),items.length ? box(
    form('Marcar todas como leídas',[],async () => {await api('/notices/read',{}); await render();}),
    items.map(item => el('div',{class:'list-item'},!item.seen && badge('Nueva'),p(item.body)))
  ) : empty('Todavía no tienes alertas.')];
}
function profile() {
  const preferences = {
    publications:'Publicaciones agrícolas',orders:'Pedidos y cambios de estado',
    reminders:'Recordatorios de fechas',harvest:'Eventos de cosecha'
  };
  return [heading('Mi perfil'),el('div',{class:'narrow'},box(image(user.photo,user.name,'avatar'),badge(roles[user.role]),
    form('Guardar perfil',[input('Nombre','name','text',{...required,value:user.name}),
      input('Comuna','comuna','text',{...required,value:user.comuna}),
      input('Teléfono','phone','tel',{value:user.phone,maxlength:30,autocomplete:'tel'}),
      area('Descripción','bio',user.bio),photoField(),
      user.photo && el('label',{class:'check'},el('input',{type:'checkbox',name:'removePhoto'}),'Quitar fotografía actual'),
      user.role === 'productor' && el('fieldset',{},el('legend',{},'Mi predio'),
        p('La ubicación del predio se guarda en tu cuenta. Las publicaciones muestran coordenadas aproximadas.','muted'),
        coordinates(user.lat,user.lon)),
      el('fieldset',{},el('legend',{},'Notificaciones por correo'),
        Object.entries(preferences).map(([key,label]) => el('label',{class:'check'},
          el('input',{type:'checkbox',name:key,checked:user.emailPreferences?.[key] || null}),label)))],
    async data => {
      if (data.removePhoto) data.photo = '';
      data.emailPreferences = Object.fromEntries(Object.keys(preferences).map(key => [key,Boolean(data[key])]));
      for (const key of [...Object.keys(preferences),'removePhoto']) delete data[key];
      user=await api('/profile',data);
      await render();
    }),
    section('Correo y contraseña',form('Actualizar seguridad',[
      input('Correo electrónico','email','email',{value:user.email,required:true,maxlength:254,autocomplete:'email'}),
      input('Contraseña actual','currentPassword','password',{required:true,minlength:12,maxlength:128,autocomplete:'current-password'}),
      input('Nueva contraseña','newPassword','password',{minlength:12,maxlength:128,autocomplete:'new-password'})
    ],async data => { user=await api('/account/security',data); await render(); })),
    form('Cerrar sesión',[],async () => { await api('/logout',{}); user=null; location.hash='#catalogo'; })
  ))];
}
async function harvestMap(params) {
  const cursor = params.get('after');
  const items = await api('/harvest-map'+(cursor ? '?'+new URLSearchParams({after:cursor}) : ''));
  return [heading('Mapa de cosechas'),p('Las ubicaciones de las publicaciones son aproximadas.','muted'),
    items.length ? box(interactiveMap(items),el('ul',{class:'harvest-map-list'},
      items.map(item => el('li',{},a(item.product,'#lote/'+item.id),' · ',a(item.name,'#productor/'+item.producer),' · '+item.comuna))))
      : empty('No hay publicaciones disponibles con ubicación en esta página.'),
    group(cursor && a('Volver al inicio del mapa','#mapa','button secondary'),
      items.length === 250 && a('Ver más ubicaciones','#mapa?after='+items.at(-1).id,'button secondary'))];
}
function weatherPage() {
  return [heading('Meteorología agrícola'),box(
    p('La consulta dentro de Cosecha Conecta está pendiente de acceso a la API de INIA.'),
    a('Consultar estaciones, datos y pronóstico en INIA','https://agrometeorologia.cl/','button'))];
}
async function seller(id) {
  const item = await api('/profiles/'+id);
  return [heading(item.name),box(image(item.photo,item.name,'avatar'),p(item.comuna),p(item.bio)),
    section('Evaluaciones',item.reviews.length ? box(item.reviews.map(review => p('★ '+review.stars+' · '+review.comment,'list-item'))) : empty('Todavía no hay evaluaciones.'))];
}
const privatePages = new Set(['panel','publicar','mis-lotes','perfil','mensajes','chat','alertas','pedidos','perdidas','grupos','historial']);
async function render() {
  const version = ++generation;
  clearInterval(chatTimer);
  for (const view of maps) view.remove();
  maps.clear();
  const [path,query] = location.hash.slice(1).split('?');
  const [page='catalogo',id,peer] = (path || 'catalogo').split('/');
  navigation(page);
  main.replaceChildren(p('Cargando…','muted'));
  try {
    let content;
    if (privatePages.has(page) && !user) content = auth(false);
    else if (['publicar','mis-lotes','grupos'].includes(page) && user.role !== 'productor') content = empty('Esta sección está disponible para productores.');
    else switch (page) {
      case 'catalogo': content = await catalogPage(new URLSearchParams(query)); break;
      case 'mapa': content = await harvestMap(new URLSearchParams(query)); break;
      case 'meteorologia': content = weatherPage(); break;
      case 'ingresar': content = auth(false); break;
      case 'registro': content = auth(true); break;
      case 'lote': content = await detail(Number(id)); break;
      case 'productor': content = await seller(Number(id)); break;
      case 'panel': content = await dashboard(); break;
      case 'publicar': content = publish(); break;
      case 'mis-lotes': content = [heading('Mis lotes'),a('Publicar lote','#publicar','button'),section('Publicaciones',lotGrid(await api('/lots?mine=1')))]; break;
      case 'pedidos': content = await ordersPage(); break;
      case 'historial': content = await history(id); break;
      case 'perdidas': content = await losses(); break;
      case 'grupos': content = await groupsPage(); break;
      case 'mensajes': content = await threads(); break;
      case 'chat': content = await chat(Number(id),Number(peer),version); break;
      case 'alertas': content = await alerts(); break;
      case 'perfil': content = profile(); break;
      default: content = [empty('Página inexistente.'),a('Volver al catálogo','#catalogo')];
    }
    if (generation === version) main.replaceChildren(...[content].flat(Infinity).filter(Boolean));
  } catch (error) {
    if (generation === version) main.replaceChildren(heading('No se pudo cargar la página'),empty(error.message),a('Volver al catálogo','#catalogo'));
  }
}
try {
  user = await api('/me');
  window.addEventListener('hashchange',() => { window.scrollTo(0,0); void render(); });
  await render();
} catch (error) { main.replaceChildren(heading('No se pudo conectar'),empty(error.message)); }
