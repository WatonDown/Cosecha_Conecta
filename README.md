# Cosecha Conecta

Plataforma piloto para comercializar y rescatar cosechas en Chile. Incluye una aplicación web en español, una API HTTP y una base relacional SQLite. El proyecto utiliza Node.js 24, SQLite nativo y Nodemailer para Gmail.

## Ejecutar en Windows

```powershell
node --version
npm.cmd ci
node server.mjs
```

Abre [la portada de Cosecha Conecta](http://127.0.0.1:3000/) o [Mi Cuenta del prototipo](http://127.0.0.1:3000/#cuenta). La portada incorpora el rediseño visual y las fotografías suministradas en `public/img`. Los datos de demostración y del registro local se guardan en el navegador. Los mapas, gráficos y tipografías del prototipo cargan recursos externos.

La [plataforma con SQLite](http://127.0.0.1:3000/plataforma/) tiene sus propios formularios, permisos y sesiones. Allí puedes crear cuentas de productor, comprador y organización social con correos distintos. Usa perfiles de navegador separados para probar los intercambios conservando las sesiones. El catálogo comienza vacío y se alimenta con las publicaciones de los productores. Las fotos se cargan en JPEG, PNG o WebP de hasta 700 KB.

La base se crea en `data/cosecha.sqlite`. La configuración admite `DATA_DIR`, `PORT` y `HOST`. Para HTTPS detrás de un proxy, conserva el encabezado `Host` y configura `SECURE_COOKIES=1`. En cada arranque SQLite habilita claves foráneas y WAL y aplica de forma transaccional los cambios de esquema compatibles con la base existente.

### Respaldar y recuperar SQLite

Ejecuta desde la carpeta del proyecto y usa un nombre de respaldo diferente cada vez. El comando de respaldo toma una instantánea consistente mediante SQLite con el servidor activo, comprueba la integridad y guarda un único archivo. Para recuperar, apunta `DATA_DIR` a un directorio nuevo. El comando protege las bases existentes y la copia recuperada invalida sesiones antiguas y omite correos pendientes para evitar reenvíos de eventos ya procesados después del respaldo.

```powershell
node database.mjs backup data/backups/antes-del-cambio.sqlite
$env:DATA_DIR = 'data/recuperado'
node database.mjs restore data/backups/antes-del-cambio.sqlite
node server.mjs
```

Conserva los respaldos en almacenamiento privado, ya que contienen datos de usuarios. Verifica la copia recuperada antes de cambiar el directorio de datos de una instalación en uso.

### Crear el administrador

Define `ADMIN_EMAIL` y `ADMIN_PASSWORD` en el entorno de ejecución antes del primer arranque administrativo. Node permite cargar un archivo local ignorado por Git con `node --env-file=.env server.mjs`. Usa una contraseña propia de al menos 12 caracteres. El arranque crea la cuenta si el correo aún está libre. La contraseña existente se conserva en arranques posteriores.

## Flujos disponibles

| Área | Flujo |
| --- | --- |
| Cuenta | Registro, fotografía opcional, edición de perfil y teléfono, preferencias de correo, cambio de correo y contraseña con autenticación actual, cierre y rotación de sesiones. |
| Catálogo | Publicaciones frescas, futuras y para donación, filtros, favoritos, ubicación aproximada y orden por distancia con permiso. |
| Operaciones | Pedido con control de inventario, depósito del 25 %, saldo desde la cosecha, entrega, comisión del 5 % e historial de movimientos. |
| Imprevistos | Cambio de fecha con aviso, propuesta y aceptación de entrega parcial, cancelación y retiro completo por fuerza mayor con reembolso registrado. |
| Agrupaciones | Aportes y aprobación, oferta conjunta por el volumen completo y distribución contable por aportes. La compatibilidad compara producto, categoría, condición y comuna. |
| Pérdidas | Registro con fotos, mapas individuales, historial, indicadores, gráfico por causa y aviso a productores de la misma comuna. |
| Comunicación | Chat persistente con fotos, indicadores de lectura y actualización cada 2,5 segundos. Alertas dentro de la plataforma. |
| Administración | Indicadores, listado de usuarios, auditoría, cotización y entrega de despachos, configuración de planes Premium. |

Los avisos de 48 y 24 horas se aproximan con fechas de calendario de Chile y se revisan cada minuto mientras el servidor está activo. La coincidencia de zona se realiza por comuna. Los umbrales de recomendaciones son configurables con `SMALL_LOT_KG` (300) e `INDUSTRIAL_LOT_KG` (1000). Las recomendaciones se calculan por reglas.

«Mi predio» y «Mapa de pérdidas» muestran la capa estándar de OpenStreetMap en Leaflet. Se carga desde `https://tile.openstreetmap.org/{z}/{x}/{y}.png` sin clave y requiere conexión a internet. Al alojar la portada, conserva su encabezado `Referrer-Policy: strict-origin-when-cross-origin` y la atribución visible para cumplir la [política de teselas de OpenStreetMap](https://operations.osmfoundation.org/policies/tiles/).

En `/plataforma/`, los productores pueden guardar las coordenadas exactas de su predio en su perfil. El formulario de publicación propone esa ubicación y permite modificarla. El mapa público muestra publicaciones activas con coordenadas aproximadas a dos decimales y enlaces al productor y al lote. Los formularios también permiten ingresar las coordenadas manualmente.

### Gmail

Define en `.env` las siguientes variables del servidor y ejecuta `node --env-file=.env server.mjs`. Gmail utiliza SMTP con TLS por el puerto 465. Activa la verificación en dos pasos y genera una [contraseña de aplicación de Google](https://support.google.com/accounts/answer/185833) para la cuenta remitente.

```dotenv
GMAIL_USER=
GMAIL_APP_PASSWORD=
```

Los correos de bienvenida y seguridad se encolan automáticamente. Cada usuario puede activar desde su perfil los correos de publicaciones, pedidos, recordatorios y eventos de cosecha. Las alertas internas siguen disponibles. La cola conserva su estado en SQLite, aplica reintentos espaciados y descarta envíos opcionales si se desactivó su categoría. Los cambios de dirección se notifican al correo anterior y al nuevo. Sin credenciales, la cola permanece pendiente.

Para verificar el envío con la cuenta configurada, registra una cuenta con un buzón de prueba propio y comprueba la recepción del mensaje de bienvenida. La tabla `email_queue` conserva el estado de entrega SMTP, cantidad de intentos y último código de error. El estado `sent` confirma aceptación por Gmail. Si la conexión se corta después de que Gmail acepta el mensaje y antes de registrar el resultado, un reintento con el mismo identificador puede duplicarlo.

### INIA Agromet

La sección Meteorología enlaza al portal oficial, donde se pueden consultar estaciones, observaciones, históricos y pronósticos. La integración directa y las alertas meteorológicas requieren la documentación técnica oficial y, según el acceso asignado a la aplicación, credenciales. INIA ofrece un [formulario de solicitud de acceso a la API](https://forms.gle/DVGvuqEharVqRtDMA) desde su [curso de agrometeorología](https://sitios.inia.cl/agrometeorologia/curso/).

### Llamadas y videollamadas

Configura `MEETING_BASE_URL` con la URL HTTPS base de un servicio de reuniones compatible con un identificador de sala en la ruta, por ejemplo un servidor Jitsi Meet administrado por tu organización. El chat genera una sala aleatoria por conversación y la muestra a las dos partes. Configura la autenticación y el control de invitados en el proveedor, ya que la posesión del enlace puede dar acceso a la sala según su configuración. El botón aparece al configurar la URL. Las llamadas dependen del proveedor y requieren una prueba entre dos usuarios con micrófono y cámara.

### Pagos y publicación

Todos los movimientos financieros son de prueba. El sistema registra importes, depósitos, saldos y reembolsos en SQLite. Para habilitar dinero real falta contratar una pasarela compatible con Chile, configurar credenciales del comercio del lado del servidor e implementar checkout y verificación de eventos de la pasarela con idempotencia, conciliación y reembolsos. `payments` es el registro contable del piloto. El código se ejecuta en un servidor Node con disco persistente.

## Pruebas

```powershell
node --test
node --check public/app.js
```

La prueba de integración inicia el servidor con una base desechable. Recorre acceso administrativo, filtros, favoritos, privacidad de ubicaciones, chat, alertas, compras, donaciones, reservas, reembolsos, despachos y agrupaciones. Reinicia el servidor para verificar la persistencia.

## Trabajo pendiente

- Moderación y edición administrativa de usuarios, fotos, publicaciones y denuncias. El panel actual ofrece consulta, auditoría y las acciones de despachos y planes.
- Verificación de identidad o autenticidad de fotografías, recuperación de cuenta y verificación de correo.
- Pasarela de producción, cobro recurrente, activación de suscripciones, analítica Premium y predicción de cosechas.
- Notificaciones push, integración directa con INIA y verificación de llamadas con un proveedor configurado.
- Planificación logística dentro de la plataforma y compatibilidad estructurada por variedad, madurez y conservación.
- Gestión completa del ciclo de publicaciones y conciliación de inventario en operaciones que se resuelven con varias compras. Los pedidos en espera de pago o depósito inicial liberan el inventario pasados 30 minutos.
- Pruebas de navegador, accesibilidad, carga y operación en un entorno publicado.
