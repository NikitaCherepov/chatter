[English](../../README.MD) | [Русский](README_RU.MD) | [Deutsch](README_DE.MD) | **Español** | [Français](README_FR.MD) | [Italiano](README_IT.MD) | [日本語](README_JA.MD) | [한국어](README_KO.MD) | [Polski](README_PL.MD) | [Português (BR)](README_PT-BR.MD) | [中文（简体）](README_ZH-CN.MD) | [Türkçe](README_TR.MD) | [Čeština](README_CS.MD)

---

# Que es Chatter?

Chatter es un sistema multiplataforma con un agente de IA que se ejecuta en un servidor y puede compartirse con amigos o familiares con un solo clic. Tambien puedes implementar tu propio servicio con planes, limites y una gestion comoda.

Los precios de los modelos se obtienen automaticamente. Todo lo que necesitas es establecer un presupuesto para la suscripcion.

> **El sistema de pago aun no esta integrado.**

![Chatter conecta Telegram y Desktop](../assets/chatter-telegram-desktop.gif)

Querias compartir IA con tu mama pero ella encuentra la tecnologia demasiado complicada? Dale tu bot de Telegram. Curva de aprendizaje cero.

Querias tu propio Jarvis que encienda las luces, responda a comandos de voz y baje las persianas por la noche? Despues de conectar la integracion del hogar inteligente, Chatter puede hacerlo sin codigo adicional ni tokens desperdiciados.

O tal vez solo querias interpretar un papel con un bot pero no tenias ganas de revisar configuraciones, levantar un servidor local y descifrar los ajustes? Chatter tiene la interfaz mas facil de usar y un panel de administracion comodo (en la medida de lo posible).

El agente de IA se ejecuta en el servidor (backend) y conecta Telegram y tu PC.

```
Telegram <-> Backend <-> Desktop
```

Un usuario de Telegram puede continuar los mismos chats y controlar su PC mientras el Desktop esta conectado. La mayoria de las funciones estan disponibles independientemente de donde se haya enviado el mensaje.

---

## Como esta estructurado el proyecto?

- **backend-api** — toda la logica del lado del servidor de Chatter. El agente, las herramientas, la memoria, los chats, los limites, los usuarios y toda la logica compartida viven aqui.
- **desktop-app** — aplicacion Electron para comunicarse con el agente y controlar tu PC.
- **Telegram bot** — una segunda interfaz completa para la misma cuenta, los mismos chats y funciones. Se encuentra en la raiz del proyecto (incomodo, pero ahi fue donde todo empezo).
- **admin-panel** — gestion de modelos, claves, usuarios, limites, copias de seguridad y estado del servidor.
- **chatter-manager** — conecta el panel de administracion con Docker, permitiendote iniciar, detener y actualizar componentes.
- **webapp-notes** — miniaplicacion de Telegram para notas.
- **voice-service** — transcripcion local y sintesis de voz opcionales.

Todos los componentes del servidor se ejecutan en contenedores Docker separados y estan vinculados a traves de Docker Compose. Asi que puedes conservar solo lo que realmente necesitas.

---

## Como se instala?

1. Alquila un servidor y asegurate de instalar fail2ban en el. El instalador configurara UFW automaticamente: preservara el acceso al puerto SSH real del servidor y abrira los puertos 80/443 para Chatter.
2. Abre una consola y ejecuta:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/NikitaCherepov/chatter/main/install.sh | sudo bash
   ```
3. **ASEGURATE** de guardar el nombre de usuario y la contrasena que se muestran al final de la instalacion.
4. Ve al panel de administracion en la direccion de tu servidor e ingresa el nombre de usuario y la contrasena mostrados en la consola.
5. Completa los pasos necesarios para el primer inicio:
   - Agrega un modelo y una clave de API para el Auto mode.
   - Agrega un modelo y una clave de API para el Lite mode.
   - Obten un token de Telegram de [BotFather](https://t.me/BotFather) y agregalo al panel.
   - Opcionalmente, copia el enlace de Webapp-Notes proporcionado en el panel y agregalo a tu bot.
6. Envia un mensaje al bot y aprueba tu perfil a traves del panel de administracion, luego concedete derechos de administrador.

**Listo!**

---

## Como conectar la aplicacion de Desktop?

1. Descarga la aplicacion desde Releases e instalala. Windows puede advertir sobre la falta de una firma digital: la compilacion actualmente no esta firmada con un certificado.
2. Ve a la seccion de Claves de Acceso en el panel de administracion.
3. Crea una nueva clave y pegala en la aplicacion de Desktop.
4. Registrate.

**Listo!**

---

## Como vincular tu cuenta de PC con Telegram?

1. Ve a la configuracion en el escritorio.
2. Selecciona "Cuentas vinculadas".
3. Haz clic en "Telegram".
4. Envia en el bot de Telegram: `/link`
5. Ingresa el codigo que se muestra en la pantalla.

**Listo!**

---

## Como compartirlo con un amigo?

**A traves de Telegram:**
1. Enviales el bot de Telegram y espera a que te escriban.
2. Aprueba su cuenta desde el panel de administracion.

**A traves de Desktop:**
1. Enviales la aplicacion de Desktop y comparte una Clave de Acceso para conectarse a tu servidor.

**Listo!**

Siempre puedes ver si alguien ha compartido tu clave, y puedes revocarla en cualquier momento.

---

## Que puede hacer el panel de administracion?

![Panel de administracion de Chatter - resumen del servidor](../assets/admin-overview.png)

1. **Monitorear el estado de los componentes** y reiniciarlos.
2. **Quieres agregar un nuevo modelo?** No es necesario volver a ingresar una clave de API guardada ni buscar en todo OpenRouter el nombre de un modelo.
   - Las claves de API se pueden guardar y reutilizar.
   - Un buscador de modelos para OpenRouter esta integrado en el panel de administracion.
   - La lista de proveedores se completa automaticamente cuando seleccionas un modelo. Quieres que las solicitudes vayan solo a un proveedor especifico? Solo seleccionalo del menu desplegable.
   - Los precios de tokens de entrada/salida/cache se establecen automaticamente al seleccionar un modelo.
   - Un modelo Vision esta disponible por separado. Si el modelo principal no es multimodal, le pedira a Vision que describa la imagen que adjuntaste.

   ![Seleccion de modelo, proveedor y precio en el panel de administracion](../assets/admin-model-selection.gif)

3. **Gestion comoda de limites.**
   - Simplemente establece el presupuesto que un usuario puede gastar.
   - Limites personalizables para imagenes y busqueda web para todos los usuarios, ademas de la posibilidad de deshabilitar los archivos adjuntos de imagenes.

   ![Configuracion de planes, presupuestos y limites](../assets/admin-plans-limits.png)

4. **Analisis** de que modelos estan usando los usuarios, si los subagentes estan involucrados, que tan bien se estan almacenando en cache los mensajes y mucho mas.

   ![Estadisticas de usuario, conexiones y uso de modelos](../assets/admin-user-usage.png)

5. Registros del backend y graficos de rendimiento del servidor.
6. Integracion comoda de servicios disponibles. Pega una clave, ingresa los datos y todo funciona de inmediato.
7. **Compilacion personalizada:**
   - No quieres la miniaplicacion de Telegram? No la habilites.
   - No tienes capacidad para TTS del lado del servidor y transcripcion de voz? No hay problema.
   - Puedes configurar tantos prompts preestablecidos para tus usuarios como quieras.
8. Necesitas banear a un usuario? Un clic, e inmediatamente pierde el acceso a tu servidor a traves de Telegram y la aplicacion de Desktop. La clave de acceso tambien se puede revocar en cualquier momento.

---

## Que puede hacer Chatter?

1. Usar memoria vectorial. Cada usuario obtiene un registro aislado separado por defecto. Actualmente solo esta disponible la integracion con [Pinecone](https://app.pinecone.io/).
2. Activarse con "Alexa", "Hey, Jarvis", "Hey Mycroft" o "Hey Rhasspy", con soporte para reconocimiento de voz y respuestas de voz.

   ![Activacion por voz de Chatter y control de la interfaz de usuario](../assets/chatter-voice-activation.gif)

3. Integrado en la aplicacion de Desktop:
   - modelo local Piper para TTS;
   - modelo nativo Chrome TTS;
   - integracion con [Cartesia](https://www.cartesia.ai/).
4. Ejecutar comandos en el PC, asi como editar y leer archivos. Puede usarse como CLI.

   ![Chatter crea y abre un sitio web por si mismo](../assets/chatter-site-creation.gif)

5. Leer y enviar correos electronicos desde las bandejas de entrada que hayas agregado. Actualmente, la integracion guiada comoda esta disponible para [Gmail](https://mail.google.com/mail/) y [Yandex](https://mail.yandex.ru/), asi como cualquier otro correo electronico que puedas configurar manualmente. El envio de correos requiere confirmacion del usuario.
6. Usar la busqueda web a traves del servicio [Tavily](https://www.tavily.com/).
7. Leer y analizar sitios web usando [Browserless](https://www.browserless.io/pricing).
8. Generar imagenes a partir de una referencia o de texto a traves de OpenRouter.
9. Usar subagentes para cualquier tarea.

   ![Subagentes paralelos de Chatter en accion](../assets/chatter-parallel-subagents.gif)

10. Invocar agentes especializados. Por ejemplo: comprimir y convertir videos a otros formatos.
11. Gestionar tus servidores. El bot nunca ve tu clave SSH ni tu contrasena de sudo. Para la ejecucion de comandos, se abre una sesion SSH directamente en tu servidor. La clave SSH se puede obtener con un solo boton directamente desde tu computadora.
12. Guardar y usar instrucciones de Runbook para su uso posterior, y compartirlas con otros.
13. Guardar macros para control dramatico (*Alexa, es hora de trabajar!*).
14. Prompts personalizados, ademas de un editor de IA integrado directamente en el panel para una edicion comoda.
15. Establecer tareas y recordatorios. Por ejemplo: encender la luz, recordarte que deseches las gotas para los ojos en un mes, o revisar el servidor (solo si los comandos estan en la lista permitida) mientras duermes.
16. Controlar tu avatar de pixeles y ajustar su estado de animo a la conversacion directamente en la pantalla. Tambien muestra cualquier imagen y GIF que haya encontrado en internet.
17. Crear pixel art y mostrarlo directamente en el avatar de pixeles.
18. Guardar chats como DOCX, enviar mensajes de un chat directamente a una cuenta de Telegram vinculada, ademas de muchas otras funciones de Quality of Life.
19. Te gusta interpretar papeles con bots? El **Dice Mode** esta integrado, lanzando un d20 en cada mensaje que envias e influyendo en la historia!
20. Controlar el mapa integrado en la interfaz de la aplicacion, recordar puntos en el mapa y trazar rutas (pero verifica la informacion!).
21. Guardar notas en tu cuaderno, que tambien es accesible desde la aplicacion de Telegram.
22. Configurar el tamano del contexto, seleccionar modelos comodamente para los subagentes sin tocar configuraciones y establecer niveles de razonamiento (actualmente disponibles para los proveedores OpenRouter, DeepSeek y Xiaomi).
23. Controlar la camara web, tomar capturas de pantalla y hacer clic en la pantalla mientras el Desktop esta conectado. Cualquier accion de este tipo requiere tu confirmacion.
24. La mayoria de las funciones son accesibles desde Telegram con un menu comodo y botones en linea.
25. Controlar tu hogar inteligente y encender luces en un horario. La integracion con Yandex esta disponible; el soporte para Zigbee es actualmente experimental y necesita mas pruebas.
26. Adjuntar documentos y fotos incluso a un modelo sin vision (cuando un modelo de vision esta configurado por separado).
27. Transcribir mensajes de voz de Telegram! (requiere un servidor potente con al menos 2 nucleos, 2 GB de RAM y voice-api habilitado)
28. Creacion comoda y rapida de ramas de chat, ademas de regeneracion con instrucciones.
29. El bot sugiere un comando pero no sabes lo que hace? Presiona el boton Review y el modelo Lite evalua sus riesgos.

---

## En que se enfoca Chatter?

### 1. Operaciones seguras del agente

- Cada accion en el servidor/PC solo se permite con la aprobacion del usuario. Excepciones: Yolo mode activado, Allow Always o "trabajar en esta carpeta". "Trabajar en esta carpeta" encuentra el `.git` mas cercano y lo sugiere como predeterminado.
- El agente nunca ve tu clave SSH o contrasena: se sustituyen automaticamente y se almacenan encriptadas. **NO** le des tu contrasena al agente, incluso si la pide. Tiene un comando separado para crear un nuevo usuario en el servidor.
- En el escritorio, puedes deshabilitar funciones selectivamente por seguridad. Puedes prohibir la escritura de datos mientras permites solo lecturas, desactivar subagentes, internet o comandos del PC. O cortar su acceso a tu memoria por completo.
- Los correos electronicos, las claves SSH y los datos sensibles estan encriptados.
- Todas las solicitudes de API del panel de administracion pasan a traves de un proxy inverso y Chatter Manager, mientras que los intentos de inicio de sesion repetidos se bloquean automaticamente.
- La proteccion basica contra inyeccion de prompts esta integrada.
- Si no sabes lo que hace un comando sugerido por la red neuronal, presionas Review y otra red neuronal te lo explica, evaluando los riesgos.

   ![Verificacion de riesgos de comandos antes de la ejecucion](../assets/chatter-command-review.gif)

### 2. Optimizacion incansable

- Los prompts del sistema y otras partes repetidas del contexto permanecen estables para que el proveedor pueda almacenar en cache hasta el 90-95% de los tokens de entrada.
- Los chats, fotos y mensajes se cargan dinamicamente para evitar sobrecargar el DOM. No se utiliza virtualizacion (la odio): en su lugar, se utilizan un boton de "cargar mas" y un calculo basado en el numero de caracteres.
- OpenRouter te redirige a diferentes proveedores y rompe el cache, y no quieres profundizar y configurar claves? Simplemente selecciona un proveedor obtenido directamente de OpenRouter, y solo ese proveedor sera utilizado.
- Puedes ingresar multiples proveedores (OpenRouter/DeepSeek/Xiaomi/etc), y si el primero falla con un error, la tarea se redirige inmediatamente a otro.
- No tienes dinero para ejecutar un modelo de vision cada vez? No hay problema. Agrega un modelo de vision una vez, y tu bot de IA principal simplemente le pedira que describa la imagen que adjuntaste.
- No tienes dinero para TTS pero aun asi lo quieres? Los modelos locales estan integrados para eso. Muchas integraciones externas tambien ofrecen un nivel gratuito.
- No quieres que la IA genere codigo de utilidad para si misma una y otra vez, quemando tokens cada vez? Las herramientas integradas de Chatter estan implementadas en codigo de antemano. Parece una desventaja, verdad? Pero asi puedes trabajar en Chatter (si quieres) junto a suscripciones a servicios importantes, simplemente haciendo `git clone` en tu computadora.
- La aplicacion de Desktop en modo normal usa aproximadamente 300 MB de RAM y apenas carga la CPU. Los contenedores del servidor se cuentan por separado, mientras que TTS y Whisper naturalmente requieren mas recursos. El propio Codex puede ralentizarse y quedarse trabado tranquilamente en mi maquina.
- Para evitar romper el cache, cuando el contexto se desborda, se archiva el 50% de la conversacion (se agregara un breve resumen para compresion en el futuro).
- Si un documento no cabe, Chatter recorta automaticamente su contenido, manteniendo hasta el 90% del limite de contexto seleccionado.
- Se utiliza un modelo Lite dedicado para generar titulos de chat, revisiones y otras solicitudes ligeras.

### 3. Comodidad

- Quieres reenviar imagenes o mensajes generados por la IA a tu Telegram para que esten en tu telefono? Presiona un boton.
- Quieres mejorar un prompt? Presiona un boton y aplica los cambios que la IA sugiere.
- No quieres completar macros o escribir algo en el cuaderno? Pidele a la IA que lo haga.
- No quieres buscar tu clave SSH en todo tu PC? Presiona un boton :D
- Saliste de casa y quieres continuar la conversacion desde tu telefono? Todos los chats, la seleccion de prompts y la eleccion de modelos estan disponibles directamente desde Telegram.
- No quieres luchar y buscar tu clave de API nuevamente, elegir un modelo en OpenRouter o descubrir como analizar el razonamiento de un modelo nuevo? Las claves de API se pueden guardar, los modelos se obtienen automaticamente y muestran inmediatamente el costo, los limites de contexto y los proveedores disponibles para preservar el cache! Y DeepSeek y Xiaomi estan codificados como proveedores externos (si aparecen nuevos como Mistral, escribeme, los agregare).
- No quieres calcular manualmente cuanto cuesta cada modelo? OpenRouter completa sus propios valores y hay valores preestablecidos para otros.
- Tus usuarios no quieren molestarse en elegir modelos? El Auto mode esta siempre ahi.
- Todas las integraciones obtendran descripciones y guias de inicio rapido mas adelante. Estas ya existen para la integracion del hogar inteligente.

### 4. Personalizacion

- Los parametros de cada modelo se pueden configurar. Temperatura, Top P y otros.
- La funcionalidad de la aplicacion de Desktop se puede deshabilitar y personalizar.

---

## Traducir el proyecto a tu idioma

Has decidido traducir el proyecto a tu idioma? Es rapido y facil:

1. Agrega tu idioma a `shared/languages.ts`: esta es la unica fuente de verdad para la lista de idiomas en todos los componentes.
2. Ejecuta:
   ```bash
   npm run sync:languages
   ```
   para actualizar las copias locales de la lista.
3. Agrega tu clave de API a `.env.i18n`:
   ```
   I18N_TRANSLATE_API_URL=url
   I18N_TRANSLATE_API_KEY=your_key
   I18N_TRANSLATE_MODEL=your_model
   ```
4. Ejecuta:
   ```bash
   npm run i18n:translate:all
   ```
   Este comando traducira por separado los archivos del bot de Telegram, el Desktop, la API del Backend, Webapp Notes, el panel de administracion y el registro de cambios.
5. Disfruta.

---

## Importante

- El servicio puede contener errores que aun no he encontrado. Si encuentras uno, enviarlo a Issues y lo resolveremos. Los errores que ya conozco estan en la lista de correcciones pendientes. Trabajo solo en el proyecto, asi que la ayuda es bienvenida.
- Los planes futuros incluyen la refactorizacion tanto de la aplicacion de escritorio como de la API del backend.
- Al usar Chatter como CLI para trabajar, aun pueden ocurrir problemas (por ejemplo, podria confundir una cadena y no verificar tipos, dejando un error). Estoy trabajando para mejorar esto.
- **Aviso de seguridad:** Chatter esta en desarrollo activo y tiene una superficie de ataque amplia debido a sus integraciones, herramientas de control remoto y arquitectura self-hosted. Aunque la seguridad es una prioridad, no se puede garantizar que ningun software sea completamente seguro. Revisa la configuracion antes de exponer una instancia a Internet, mantenla actualizada e informa de las vulnerabilidades de forma responsable. La seguridad seguira reforzandose a medida que evolucione el proyecto.
